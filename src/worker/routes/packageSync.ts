import { and, desc, eq, sql } from 'drizzle-orm';
import {
  appAnnouncements,
  appCollections,
  appEvents,
  appHeartbeats,
  appModules,
  appReleases,
  appRemoteConfigs,
  connectedApps,
  featureFlags,
} from '../../db/schema.ts';
import { ensureSystemSeeded } from '../../db/seed.ts';
import {
  buildBackendNamespace,
  generateCollectionMigrationSql,
  inspectAppSpecification,
} from '../../lib/appDiscovery.ts';
import {
  deriveAppNameFromPackage,
  isValidPackageNameFormat,
  normalizePackageName,
  parseFlexibleTimestampMs,
  sanitizeBannerUrl,
  sanitizeRemoteBanner,
  sanitizeRemoteFlags,
  toActiveBinary,
  type RemoteFlagScalar,
} from '../../lib/packageSync.ts';
import { generateSessionToken, generateUid, sanitizeText } from '../../lib/security.ts';
import { slugify } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requireAppAccess } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';
import {
  authenticateSdkRequest,
  dispatchWebhooksForEvent,
  VALID_PLATFORMS,
} from './multiAppAndSdk.ts';

export function formatAnnouncementRow(
  row: typeof appAnnouncements.$inferSelect,
  fallbackPackageName = ''
): {
  id: number;
  appId: number;
  package_name: string;
  title: string;
  body: string;
  active: 0 | 1;
  priority: number;
  action_url: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
} {
  return {
    id: row.id,
    appId: row.appId,
    package_name: row.packageName || fallbackPackageName,
    title: row.title,
    body: row.body,
    active: row.active === 1 ? 1 : 0,
    priority: row.priority,
    action_url: row.actionUrl || '',
    expires_at: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
    created_at: new Date(row.createdAt).toISOString(),
    updated_at: new Date(row.updatedAt).toISOString(),
  };
}

export function buildRemoteConfigPayload(params: {
  app: typeof connectedApps.$inferSelect;
  remoteConfig: typeof appRemoteConfigs.$inferSelect | null;
  flags: Array<{
    key: string;
    isEnabled: boolean;
    rolloutPercentage: number;
    appId: number | null;
  }>;
  latestRelease?: typeof appReleases.$inferSelect | null;
}) {
  const { app, remoteConfig, flags, latestRelease } = params;
  const canonicalPkg = app.packageName || app.packageOrDomain || '';

  const structuredFlags: Record<
    string,
    { enabled: boolean; rollout_percentage: number; scoped: boolean }
  > = {};
  const scalarFlags: Record<string, RemoteFlagScalar> = {};

  for (const f of flags) {
    const publicKey = f.appId ? f.key.replace(new RegExp(`@app${f.appId}$`), '') : f.key;
    if (!(publicKey in structuredFlags) || f.appId === app.id) {
      structuredFlags[publicKey] = {
        enabled: f.isEnabled,
        rollout_percentage: f.rolloutPercentage,
        scoped: f.appId !== null,
      };
      scalarFlags[publicKey] = f.isEnabled;
    }
  }

  const customFlags = sanitizeRemoteFlags(remoteConfig?.flagsJson);
  for (const [k, v] of Object.entries(customFlags)) {
    scalarFlags[k] = v;
  }

  const banner = sanitizeRemoteBanner(remoteConfig?.bannerJson);
  const maintenance = Boolean(app.status === 'maintenance' || remoteConfig?.maintenance);
  const killSwitch = Boolean(remoteConfig?.killSwitch || app.status === 'disconnected');
  const maintenanceMessage =
    remoteConfig?.maintenanceMessage ||
    app.maintenanceMessage ||
    'Scheduled maintenance is in progress.';
  const requireSdkKey = Boolean(
    (app.settingsJson as Record<string, unknown> | undefined)?.requireSdkKeyForPackageSync
  );

  const updatedAtMs = Math.max(
    new Date(app.updatedAt).getTime(),
    remoteConfig ? new Date(remoteConfig.updatedAt).getTime() : 0
  );

  return {
    appId: app.id,
    package_name: canonicalPkg,
    app_uid: app.appUid,
    app_name: app.name,
    platform: app.platform,
    status: app.status,
    maintenance,
    kill_switch: killSwitch,
    maintenance_message: maintenanceMessage,
    require_sdk_key: requireSdkKey,
    version_gate: {
      current_version: latestRelease?.version || app.currentVersion,
      min_supported_version: latestRelease?.minSupportedVersion || app.minSupportedVersion,
      force_update: Boolean(latestRelease?.forceUpdate ?? app.forceUpdate),
    },
    banner,
    ads: {
      enabled: Boolean(app.adsEnabled),
      admob_app_id: app.admobAppId || '',
    },
    flags: scalarFlags,
    feature_flags: structuredFlags,
    updated_at: new Date(updatedAtMs || Date.now()).toISOString(),
  };
}

async function resolveAppByPackageName(
  ctx: WorkerContext,
  rawPkg: string
): Promise<typeof connectedApps.$inferSelect | null> {
  const pkg = normalizePackageName(rawPkg);
  if (!pkg) return null;

  const exactRows = await ctx.db
    .select()
    .from(connectedApps)
    .where(sql`lower(${connectedApps.packageName}) = ${pkg}`)
    .limit(1);
  if (exactRows[0]) return exactRows[0];

  const legacyRows = await ctx.db
    .select()
    .from(connectedApps)
    .where(sql`lower(trim(${connectedApps.packageOrDomain})) = ${pkg}`)
    .limit(1);
  const legacy = legacyRows[0];
  if (!legacy) return null;

  // Auto-backfill legacy package_or_domain -> canonical package_name if not yet set
  if (!legacy.packageName && isValidPackageNameFormat(pkg)) {
    await ctx.db
      .update(connectedApps)
      .set({ packageName: pkg })
      .where(eq(connectedApps.id, legacy.id))
      .catch(() => {});
    return { ...legacy, packageName: pkg };
  }

  return legacy;
}

async function resolveSdkAppForPackageRead(
  ctx: WorkerContext
): Promise<
  | { ok: true; app: typeof connectedApps.$inferSelect; packageName: string }
  | { ok: false; response: Response }
> {
  await ensureSystemSeeded(ctx.env.DB, ctx.env.GITHUB_DEFAULT_REPO || '');

  const q = queryRecord(ctx);
  const headerPkg = sanitizeText(ctx.request.headers.get('x-package-name') || '', 180);
  const queryPkg = sanitizeText(q.package_name || q.packageName || '', 180);
  const pkgCandidate = headerPkg || queryPkg;
  const authHeader = ctx.request.headers.get('authorization') || '';
  const hasApiKey = Boolean(
    (ctx.request.headers.get('x-api-key') || '').trim() || authHeader.startsWith('Bearer ')
  );
  const hasAppId = Boolean((ctx.request.headers.get('x-app-id') || q.appId || '').trim());

  if (hasApiKey || hasAppId) {
    const auth = await authenticateSdkRequest(ctx, 'config:read', pkgCandidate);
    if (!auth.ok) return auth;
    return {
      ok: true,
      app: auth.app,
      packageName: auth.app.packageName || normalizePackageName(pkgCandidate) || auth.app.packageOrDomain,
    };
  }

  if (!pkgCandidate) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'package_name query parameter or X-Package-Name header is required (e.g. ?package_name=com.cyberking.candymindmatch).'
      ),
    };
  }

  if (!isValidPackageNameFormat(pkgCandidate)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'Invalid package_name format. Expected reverse-DNS package like com.cyberking.candymindmatch.'
      ),
    };
  }

  const app = await resolveAppByPackageName(ctx, pkgCandidate);
  if (!app) {
    return {
      ok: false,
      response: errorResponse(404, 'No connected application found for this package_name.', {
        code: 'APP_NOT_FOUND',
        package_name: normalizePackageName(pkgCandidate),
      }),
    };
  }

  ctx.sdkAppId = app.id;

  const settings = (app.settingsJson || {}) as Record<string, unknown>;
  if (settings.requireSdkKeyForPackageSync) {
    return {
      ok: false,
      response: errorResponse(
        401,
        'Unauthorized: This application requires an X-API-Key (or Authorization: Bearer) header.',
        { code: 'API_KEY_REQUIRED', package_name: app.packageName || normalizePackageName(pkgCandidate) }
      ),
    };
  }

  if (app.status === 'disconnected') {
    return {
      ok: false,
      response: errorResponse(403, 'Application connection is currently disabled (disconnected).', {
        code: 'APP_DISCONNECTED',
        appUid: app.appUid,
        package_name: app.packageName || normalizePackageName(pkgCandidate),
      }),
    };
  }

  return {
    ok: true,
    app,
    packageName: app.packageName || normalizePackageName(pkgCandidate),
  };
}

export function registerPackageSyncRoutes(router: WorkerRouter): void {
  // =========================================================================
  // APP -> ADMIN PANEL: Two-way registration & heartbeat by package_name
  // =========================================================================
  router.post('/api/v1/sdk/heartbeat', async (ctx: WorkerContext) => {
    await ensureSystemSeeded(ctx.env.DB, ctx.env.GITHUB_DEFAULT_REPO || '');

    const body = await readJsonBody<{
      package_name?: string;
      packageName?: string;
      version_name?: string;
      versionName?: string;
      version_code?: number | string;
      versionCode?: number | string;
      platform?: string;
      last_seen_at?: number | string;
      lastSeenAt?: number | string;
      event?: string;
      status?: string;
      app_name?: string;
      name?: string;
      payload?: Record<string, unknown>;
    }>(ctx.request);

    const q = queryRecord(ctx);
    const rawPkg =
      sanitizeText(
        body.package_name ||
          body.packageName ||
          ctx.request.headers.get('x-package-name') ||
          q.package_name ||
          q.packageName ||
          '',
        180
      );

    const authHeader = ctx.request.headers.get('authorization') || '';
    const hasApiKey = Boolean(
      (ctx.request.headers.get('x-api-key') || '').trim() || authHeader.startsWith('Bearer ')
    );
    const hasAppId = Boolean((ctx.request.headers.get('x-app-id') || q.appId || '').trim());

    let app: typeof connectedApps.$inferSelect | null;
    let authenticatedWithKey = false;
    let registered = false;

    if (hasApiKey || hasAppId) {
      if (rawPkg && !isValidPackageNameFormat(rawPkg)) {
        return errorResponse(
          400,
          'Invalid package_name format. Expected reverse-DNS package like com.cyberking.candymindmatch.'
        );
      }
      const auth = await authenticateSdkRequest(ctx, 'events:write', rawPkg);
      if (!auth.ok) return auth.response;
      app = auth.app;
      authenticatedWithKey = true;
    } else {
      if (!rawPkg) {
        return errorResponse(
          400,
          'package_name is required (e.g. "com.cyberking.candymindmatch").'
        );
      }
      if (!isValidPackageNameFormat(rawPkg)) {
        return errorResponse(
          400,
          'Invalid package_name format. Expected reverse-DNS package like com.cyberking.candymindmatch.'
        );
      }
      app = await resolveAppByPackageName(ctx, rawPkg);

      if (app) {
        const settings = (app.settingsJson || {}) as Record<string, unknown>;
        if (settings.requireSdkKeyForPackageSync) {
          return errorResponse(
            401,
            'Unauthorized: X-API-Key is required for heartbeats on this application.',
            { code: 'API_KEY_REQUIRED', package_name: app.packageName || normalizePackageName(rawPkg) }
          );
        }
        if (app.status === 'disconnected') {
          return errorResponse(403, 'Application connection is currently disabled (disconnected).', {
            code: 'APP_DISCONNECTED',
            appUid: app.appUid,
            package_name: app.packageName || normalizePackageName(rawPkg),
          });
        }
      }
    }

    const versionName = sanitizeText(body.version_name ?? body.versionName ?? '', 40);
    const rawVerCode = Number(body.version_code ?? body.versionCode ?? 0);
    const versionCode = Number.isFinite(rawVerCode) && rawVerCode >= 0 ? Math.floor(rawVerCode) : 0;
    const rawPlatform = sanitizeText(body.platform || app?.platform || 'android', 30).toLowerCase();
    const platform = VALID_PLATFORMS.includes(rawPlatform as (typeof VALID_PLATFORMS)[number])
      ? rawPlatform
      : 'android';
    const lastSeenAtMs = parseFlexibleTimestampMs(body.last_seen_at ?? body.lastSeenAt, Date.now());
    const lastSeenDate = new Date(lastSeenAtMs);
    const heartbeatStatus = sanitizeText(body.status || 'online', 40) || 'online';
    const heartbeatEvent = sanitizeText(body.event || 'heartbeat', 80) || 'heartbeat';
    const payloadObj =
      body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};

    const normalizedPkg =
      normalizePackageName(rawPkg) ||
      app?.packageName ||
      normalizePackageName(app?.packageOrDomain || '');

    // Auto-register first-time valid Android/client app by package_name safely
    if (!app) {
      const displayName =
        sanitizeText(body.app_name || body.name || '', 120) ||
        deriveAppNameFromPackage(normalizedPkg);
      const baseSlug = slugify(normalizedPkg.replace(/\./g, '-')) || `app-${Date.now()}`;
      const existingSlug = await ctx.db
        .select({ id: connectedApps.id })
        .from(connectedApps)
        .where(eq(connectedApps.slug, baseSlug))
        .limit(1);
      const slug = existingSlug.length > 0 ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
      const appUid = generateUid('app');
      const webhookSecret = `whsec_${generateSessionToken().slice(0, 32)}`;
      const backendNamespace = buildBackendNamespace(slug, appUid);

      const discovery = inspectAppSpecification({
        name: displayName,
        platform,
        packageOrDomain: normalizedPkg,
        integrationMode: 'aegis_managed',
      });

      const insertedApps = await ctx.db
        .insert(connectedApps)
        .values({
          appUid,
          slug,
          name: displayName,
          platform,
          packageName: normalizedPkg,
          packageOrDomain: normalizedPkg,
          description: `Auto-registered via package_name heartbeat (${normalizedPkg}).`,
          status: 'connected',
          currentVersion: versionName || '1.0.0',
          minSupportedVersion: versionName || '1.0.0',
          forceUpdate: false,
          maintenanceMessage: 'Scheduled maintenance is in progress.',
          adsEnabled: true,
          webhookSecret,
          healthStatus:
            heartbeatStatus === 'error' || heartbeatStatus === 'degraded' ? 'degraded' : 'healthy',
          lastHeartbeatAt: lastSeenDate,
          backendNamespace,
          integrationMode: 'aegis_managed',
          discoveredCapabilities: discovery as unknown as Record<string, unknown>,
          enabledModules: discovery.recommendedModules,
          syncStatus: 'verified',
          settingsJson: {
            lastClientVersionName: versionName || '1.0.0',
            lastClientVersionCode: versionCode,
          },
        })
        .returning();

      app = insertedApps[0];
      registered = true;

      // Provision default announcements collection + remote config record
      for (const col of discovery.proposedCollections.slice(0, 4)) {
        const migrationSql = generateCollectionMigrationSql(backendNamespace, col.slug, col.fields);
        await ctx.db
          .insert(appCollections)
          .values({
            appId: app.id,
            slug: col.slug,
            name: col.name,
            description: col.description,
            fieldsJson: col.fields,
            permissionsJson: { read: 'sdk', write: 'sdk' },
            migrationSql,
          })
          .onConflictDoNothing()
          .catch(() => {});
        await ctx.db
          .insert(appModules)
          .values({
            appId: app.id,
            moduleKey: `col_${col.slug}`,
            name: col.name,
            category: 'collection',
            status: 'active',
            configJson: { collectionSlug: col.slug },
            migrationSql,
            apiEndpoints: [
              { method: 'GET', path: `/api/v1/sdk/data/${col.slug}`, scope: 'data:read' },
              { method: 'POST', path: `/api/v1/sdk/data/${col.slug}`, scope: 'data:write' },
            ],
            uiSchema: { fields: col.fields },
          })
          .onConflictDoNothing()
          .catch(() => {});
      }

      await ctx.db
        .insert(appRemoteConfigs)
        .values({
          appId: app.id,
          packageName: normalizedPkg,
          maintenance: false,
          killSwitch: false,
          maintenanceMessage: app.maintenanceMessage,
          bannerJson: {},
          flagsJson: {},
        })
        .onConflictDoNothing()
        .catch(() => {});
    }

    ctx.sdkAppId = app.id;
    const effectivePkg = normalizedPkg || app.packageName || app.packageOrDomain;

    const insertedHb = await ctx.db
      .insert(appHeartbeats)
      .values({
        appId: app.id,
        packageName: effectivePkg,
        versionName: versionName || app.currentVersion,
        versionCode,
        platform,
        status: heartbeatStatus,
        event: heartbeatEvent,
        payloadJson: payloadObj,
        ipAddress: ctx.clientIp,
        userAgent: sanitizeText(ctx.userAgent, 250),
        lastSeenAt: lastSeenDate,
      })
      .returning();

    if (!registered) {
      const nextSettings: Record<string, unknown> = {
        ...((app.settingsJson as Record<string, unknown>) || {}),
        lastClientVersionName: versionName || app.currentVersion,
        lastClientVersionCode: versionCode,
        lastClientPlatform: platform,
      };
      const nextHealth =
        heartbeatStatus === 'error' || heartbeatStatus === 'degraded' || heartbeatStatus === 'critical'
          ? 'degraded'
          : app.status === 'maintenance'
            ? 'degraded'
            : 'healthy';

      await ctx.db
        .update(connectedApps)
        .set({
          packageName: app.packageName || effectivePkg,
          packageOrDomain: app.packageOrDomain || effectivePkg,
          // Only overwrite admin-managed currentVersion when request carries an authenticated API key
          currentVersion: authenticatedWithKey && versionName ? versionName : app.currentVersion,
          lastHeartbeatAt: lastSeenDate,
          healthStatus: nextHealth,
          syncStatus: 'verified',
          settingsJson: nextSettings,
          updatedAt: new Date(),
        })
        .where(eq(connectedApps.id, app.id))
        .catch(() => {});
    }

    await ctx.db
      .insert(appEvents)
      .values({
        appId: app.id,
        eventType: 'heartbeat',
        eventName: heartbeatEvent,
        severity: heartbeatStatus === 'error' || heartbeatStatus === 'critical' ? 'error' : 'info',
        payload: {
          package_name: effectivePkg,
          version_name: versionName || app.currentVersion,
          version_code: versionCode,
          platform,
          status: heartbeatStatus,
          ...payloadObj,
        },
      })
      .catch(() => {});

    const hb = insertedHb[0];

    return jsonResponse(
      {
        ok: true,
        registered,
        appUid: app.appUid,
        package_name: effectivePkg,
        heartbeat: {
          id: hb.id,
          appId: hb.appId,
          package_name: hb.packageName,
          version_name: hb.versionName,
          version_code: hb.versionCode,
          platform: hb.platform,
          status: hb.status,
          event: hb.event,
          last_seen_at: new Date(hb.lastSeenAt).getTime(),
          last_seen_iso: new Date(hb.lastSeenAt).toISOString(),
        },
        server_time: Date.now(),
      },
      registered ? 201 : 200
    );
  });

  // =========================================================================
  // ADMIN PANEL -> APP: Announcements filtered by package_name (& active=1)
  // =========================================================================
  router.get('/api/v1/sdk/announcements', async (ctx: WorkerContext) => {
    const resolved = await resolveSdkAppForPackageRead(ctx);
    if (!resolved.ok) return resolved.response;
    const { app, packageName } = resolved;

    const q = queryRecord(ctx);
    const activeParam = q.active;
    const activeFilter =
      activeParam === '1' || activeParam === 'true'
        ? 1
        : activeParam === '0' || activeParam === 'false'
          ? 0
          : null;

    const rows = await ctx.db
      .select()
      .from(appAnnouncements)
      .where(
        activeFilter !== null
          ? and(eq(appAnnouncements.appId, app.id), eq(appAnnouncements.active, activeFilter))
          : eq(appAnnouncements.appId, app.id)
      )
      .orderBy(desc(appAnnouncements.priority), desc(appAnnouncements.createdAt));

    const nowMs = Date.now();
    const filteredRows =
      activeFilter === 1
        ? rows.filter((r) => !r.expiresAt || new Date(r.expiresAt).getTime() > nowMs)
        : rows;

    const items = filteredRows.map((row) => formatAnnouncementRow(row, packageName));

    return jsonResponse({
      package_name: packageName,
      app_uid: app.appUid,
      active_filter: activeFilter,
      count: items.length,
      announcements: items,
    });
  });

  // =========================================================================
  // ADMIN PANEL -> APP: Remote Config & Control Flags by package_name
  // =========================================================================
  router.get('/api/v1/sdk/remote-config', async (ctx: WorkerContext) => {
    const resolved = await resolveSdkAppForPackageRead(ctx);
    if (!resolved.ok) return resolved.response;
    const { app, packageName } = resolved;

    const [remoteRows, flagRows, releaseRows] = await Promise.all([
      ctx.db
        .select()
        .from(appRemoteConfigs)
        .where(eq(appRemoteConfigs.appId, app.id))
        .limit(1),
      ctx.db
        .select({
          key: featureFlags.key,
          isEnabled: featureFlags.isEnabled,
          rolloutPercentage: featureFlags.rolloutPercentage,
          appId: featureFlags.appId,
        })
        .from(featureFlags)
        .where(sql`(${featureFlags.appId} = ${app.id} OR ${featureFlags.appId} IS NULL)`),
      ctx.db
        .select()
        .from(appReleases)
        .where(and(eq(appReleases.appId, app.id), eq(appReleases.status, 'active')))
        .orderBy(desc(appReleases.createdAt))
        .limit(1),
    ]);

    const payload = buildRemoteConfigPayload({
      app: { ...app, packageName: packageName || app.packageName },
      remoteConfig: remoteRows[0] ?? null,
      flags: flagRows,
      latestRelease: releaseRows[0] ?? null,
    });

    return jsonResponse(payload);
  });

  // =========================================================================
  // ADMIN PANEL CRUD: Announcements, Remote Config, Heartbeats per App
  // =========================================================================
  router.get('/api/apps/:id/announcements', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(eq(connectedApps.id, appId))
      .limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const rows = await ctx.db
      .select()
      .from(appAnnouncements)
      .where(eq(appAnnouncements.appId, appId))
      .orderBy(desc(appAnnouncements.priority), desc(appAnnouncements.createdAt));

    const pkg = app.packageName || app.packageOrDomain;
    return jsonResponse({
      package_name: pkg,
      data: rows.map((r) => formatAnnouncementRow(r, pkg)),
    });
  });

  router.post('/api/apps/:id/announcements', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(eq(connectedApps.id, appId))
      .limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      title?: string;
      body?: string;
      active?: number | boolean | string;
      priority?: number | string;
      action_url?: string;
      actionUrl?: string;
      expires_at?: string | number | null;
      expiresAt?: string | number | null;
    }>(ctx.request);

    const title = sanitizeText(body.title, 160);
    const msgBody = sanitizeText(body.body, 2000);
    if (!title || !msgBody) {
      return errorResponse(400, 'Announcement title and body are required.');
    }

    const active = toActiveBinary(body.active, 1);
    const rawPriority = Number(body.priority ?? 0);
    const priority = Number.isFinite(rawPriority)
      ? Math.max(-999, Math.min(999, Math.round(rawPriority)))
      : 0;
    const actionUrl = sanitizeBannerUrl(body.action_url ?? body.actionUrl);
    const rawExp = body.expires_at ?? body.expiresAt;
    const expiresAt =
      rawExp !== undefined && rawExp !== null && String(rawExp).trim() !== ''
        ? new Date(parseFlexibleTimestampMs(rawExp))
        : null;

    const pkg = app.packageName || normalizePackageName(app.packageOrDomain) || app.appUid;

    const inserted = await ctx.db
      .insert(appAnnouncements)
      .values({
        appId,
        packageName: pkg,
        title,
        body: msgBody,
        active,
        priority,
        actionUrl,
        expiresAt,
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.announcement.created',
      module: 'apps',
      targetType: 'app_announcement',
      targetId: inserted[0].id,
      details: { appId, package_name: pkg, title, active, priority },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    const formatted = formatAnnouncementRow(inserted[0], pkg);
    if (active === 1) {
      await dispatchWebhooksForEvent(ctx, appId, 'app.announcement_published', formatted, app.appUid);
    }

    return jsonResponse({ announcement: formatted }, 201);
  });

  router.patch('/api/apps/:id/announcements/:annId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const annId = Number(ctx.params.annId);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const [appRows, existingRows] = await Promise.all([
      ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1),
      ctx.db
        .select()
        .from(appAnnouncements)
        .where(and(eq(appAnnouncements.id, annId), eq(appAnnouncements.appId, appId)))
        .limit(1),
    ]);
    const app = appRows[0];
    const existing = existingRows[0];
    if (!app || !existing) {
      return errorResponse(404, 'Announcement not found for this application.');
    }

    const body = await readJsonBody<{
      title?: string;
      body?: string;
      active?: number | boolean | string;
      priority?: number | string;
      action_url?: string;
      actionUrl?: string;
      expires_at?: string | number | null;
      expiresAt?: string | number | null;
    }>(ctx.request);

    const nextTitle =
      body.title !== undefined ? sanitizeText(body.title, 160) || existing.title : existing.title;
    const nextBody =
      body.body !== undefined ? sanitizeText(body.body, 2000) || existing.body : existing.body;
    const nextActive =
      body.active !== undefined ? toActiveBinary(body.active, existing.active ? 1 : 0) : existing.active ? 1 : 0;
    const rawPriority = body.priority !== undefined ? Number(body.priority) : existing.priority;
    const nextPriority = Number.isFinite(rawPriority)
      ? Math.max(-999, Math.min(999, Math.round(rawPriority)))
      : existing.priority;
    const nextActionUrl =
      body.action_url !== undefined || body.actionUrl !== undefined
        ? sanitizeBannerUrl(body.action_url ?? body.actionUrl)
        : existing.actionUrl;
    const rawExp = body.expires_at ?? body.expiresAt;
    const nextExpiresAt =
      body.expires_at !== undefined || body.expiresAt !== undefined
        ? rawExp !== null && String(rawExp || '').trim() !== ''
          ? new Date(parseFlexibleTimestampMs(rawExp))
          : null
        : existing.expiresAt;

    const pkg = app.packageName || existing.packageName || app.packageOrDomain;

    const updated = await ctx.db
      .update(appAnnouncements)
      .set({
        packageName: pkg,
        title: nextTitle,
        body: nextBody,
        active: nextActive,
        priority: nextPriority,
        actionUrl: nextActionUrl,
        expiresAt: nextExpiresAt,
        updatedAt: new Date(),
      })
      .where(and(eq(appAnnouncements.id, annId), eq(appAnnouncements.appId, appId)))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.announcement.updated',
      module: 'apps',
      targetType: 'app_announcement',
      targetId: annId,
      details: { appId, package_name: pkg, active: nextActive, priority: nextPriority },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ announcement: formatAnnouncementRow(updated[0], pkg) });
  });

  router.delete('/api/apps/:id/announcements/:annId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const annId = Number(ctx.params.annId);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const deleted = await ctx.db
      .delete(appAnnouncements)
      .where(and(eq(appAnnouncements.id, annId), eq(appAnnouncements.appId, appId)))
      .returning({ id: appAnnouncements.id, title: appAnnouncements.title });

    if (!deleted[0]) {
      return errorResponse(404, 'Announcement not found for this application.');
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.announcement.deleted',
      module: 'apps',
      targetType: 'app_announcement',
      targetId: annId,
      details: { appId, title: deleted[0].title },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ deleted: true, id: annId });
  });

  router.get('/api/apps/:id/remote-config', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(eq(connectedApps.id, appId))
      .limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const [remoteRows, flagRows, releaseRows] = await Promise.all([
      ctx.db.select().from(appRemoteConfigs).where(eq(appRemoteConfigs.appId, appId)).limit(1),
      ctx.db
        .select({
          key: featureFlags.key,
          isEnabled: featureFlags.isEnabled,
          rolloutPercentage: featureFlags.rolloutPercentage,
          appId: featureFlags.appId,
        })
        .from(featureFlags)
        .where(sql`(${featureFlags.appId} = ${appId} OR ${featureFlags.appId} IS NULL)`),
      ctx.db
        .select()
        .from(appReleases)
        .where(and(eq(appReleases.appId, appId), eq(appReleases.status, 'active')))
        .orderBy(desc(appReleases.createdAt))
        .limit(1),
    ]);

    return jsonResponse({
      remoteConfig: buildRemoteConfigPayload({
        app,
        remoteConfig: remoteRows[0] ?? null,
        flags: flagRows,
        latestRelease: releaseRows[0] ?? null,
      }),
    });
  });

  router.put('/api/apps/:id/remote-config', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(eq(connectedApps.id, appId))
      .limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const existingRemoteRows = await ctx.db
      .select()
      .from(appRemoteConfigs)
      .where(eq(appRemoteConfigs.appId, appId))
      .limit(1);
    const existingRemote = existingRemoteRows[0] ?? null;

    const body = await readJsonBody<{
      maintenance?: boolean;
      kill_switch?: boolean;
      killSwitch?: boolean;
      maintenance_message?: string;
      maintenanceMessage?: string;
      banner?: Record<string, unknown>;
      flags?: Record<string, unknown>;
      current_version?: string;
      currentVersion?: string;
      min_supported_version?: string;
      minSupportedVersion?: string;
      force_update?: boolean;
      forceUpdate?: boolean;
      ads_enabled?: boolean;
      adsEnabled?: boolean;
      require_sdk_key?: boolean;
      requireSdkKey?: boolean;
    }>(ctx.request);

    const nextMaintenance =
      typeof body.maintenance === 'boolean'
        ? body.maintenance
        : existingRemote
          ? existingRemote.maintenance
          : app.status === 'maintenance';
    const nextKillSwitch =
      typeof (body.kill_switch ?? body.killSwitch) === 'boolean'
        ? Boolean(body.kill_switch ?? body.killSwitch)
        : existingRemote
          ? existingRemote.killSwitch
          : app.status === 'disconnected';
    const nextMaintenanceMessage =
      body.maintenance_message !== undefined || body.maintenanceMessage !== undefined
        ? sanitizeText(body.maintenance_message ?? body.maintenanceMessage, 300) ||
          'Scheduled maintenance is in progress.'
        : existingRemote?.maintenanceMessage || app.maintenanceMessage;

    const nextBanner =
      body.banner !== undefined
        ? sanitizeRemoteBanner(body.banner)
        : sanitizeRemoteBanner(existingRemote?.bannerJson);
    const nextFlags =
      body.flags !== undefined
        ? sanitizeRemoteFlags(body.flags)
        : sanitizeRemoteFlags(existingRemote?.flagsJson);

    const pkg = app.packageName || app.packageOrDomain || '';
    const now = new Date();

    const savedRemoteRows = await ctx.db
      .insert(appRemoteConfigs)
      .values({
        appId,
        packageName: pkg,
        maintenance: nextMaintenance,
        killSwitch: nextKillSwitch,
        maintenanceMessage: nextMaintenanceMessage,
        bannerJson: nextBanner,
        flagsJson: nextFlags,
        updatedBy: ctx.adminUser!.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [appRemoteConfigs.appId],
        set: {
          packageName: pkg,
          maintenance: nextMaintenance,
          killSwitch: nextKillSwitch,
          maintenanceMessage: nextMaintenanceMessage,
          bannerJson: nextBanner,
          flagsJson: nextFlags,
          updatedBy: ctx.adminUser!.id,
          updatedAt: now,
        },
      })
      .returning();

    // Synchronize connected_apps status & version/ad fields cleanly
    const currentSettings = { ...((app.settingsJson as Record<string, unknown>) || {}) };
    if (body.require_sdk_key !== undefined || body.requireSdkKey !== undefined) {
      currentSettings.requireSdkKeyForPackageSync = Boolean(
        body.require_sdk_key ?? body.requireSdkKey
      );
    }

    const nextAppStatus =
      app.status === 'disconnected'
        ? 'disconnected'
        : nextMaintenance
          ? 'maintenance'
          : 'connected';

    const nextCurrentVersion =
      sanitizeText(body.current_version ?? body.currentVersion, 40) || app.currentVersion;
    const nextMinVersion =
      sanitizeText(body.min_supported_version ?? body.minSupportedVersion, 40) ||
      app.minSupportedVersion;
    const nextForceUpdate =
      typeof (body.force_update ?? body.forceUpdate) === 'boolean'
        ? Boolean(body.force_update ?? body.forceUpdate)
        : app.forceUpdate;
    const nextAdsEnabled =
      typeof (body.ads_enabled ?? body.adsEnabled) === 'boolean'
        ? Boolean(body.ads_enabled ?? body.adsEnabled)
        : app.adsEnabled;

    const updatedAppRows = await ctx.db
      .update(connectedApps)
      .set({
        status: nextAppStatus,
        maintenanceMessage: nextMaintenanceMessage,
        currentVersion: nextCurrentVersion,
        minSupportedVersion: nextMinVersion,
        forceUpdate: nextForceUpdate,
        adsEnabled: nextAdsEnabled,
        settingsJson: currentSettings,
        updatedAt: now,
      })
      .where(eq(connectedApps.id, appId))
      .returning();

    const updatedApp = updatedAppRows[0] || app;

    const [flagRows, releaseRows] = await Promise.all([
      ctx.db
        .select({
          key: featureFlags.key,
          isEnabled: featureFlags.isEnabled,
          rolloutPercentage: featureFlags.rolloutPercentage,
          appId: featureFlags.appId,
        })
        .from(featureFlags)
        .where(sql`(${featureFlags.appId} = ${appId} OR ${featureFlags.appId} IS NULL)`),
      ctx.db
        .select()
        .from(appReleases)
        .where(and(eq(appReleases.appId, appId), eq(appReleases.status, 'active')))
        .orderBy(desc(appReleases.createdAt))
        .limit(1),
    ]);

    const payload = buildRemoteConfigPayload({
      app: updatedApp,
      remoteConfig: savedRemoteRows[0],
      flags: flagRows,
      latestRelease: releaseRows[0] ?? null,
    });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.remote_config.updated',
      module: 'apps',
      targetType: 'app_remote_config',
      targetId: appId,
      details: {
        package_name: pkg,
        maintenance: nextMaintenance,
        kill_switch: nextKillSwitch,
        flagsCount: Object.keys(nextFlags).length,
      },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    await dispatchWebhooksForEvent(ctx, appId, 'app.remote_config_updated', payload, app.appUid);

    return jsonResponse({ remoteConfig: payload });
  });

  router.get('/api/apps/:id/heartbeats', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(eq(connectedApps.id, appId))
      .limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const q = queryRecord(ctx);
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));

    const [rows, countRows] = await Promise.all([
      ctx.db
        .select()
        .from(appHeartbeats)
        .where(eq(appHeartbeats.appId, appId))
        .orderBy(desc(appHeartbeats.lastSeenAt), desc(appHeartbeats.id))
        .limit(limit),
      ctx.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(appHeartbeats)
        .where(eq(appHeartbeats.appId, appId)),
    ]);

    return jsonResponse({
      package_name: app.packageName || app.packageOrDomain,
      total: Number(countRows[0]?.count ?? 0),
      data: rows.map((r) => ({
        id: r.id,
        appId: r.appId,
        package_name: r.packageName,
        version_name: r.versionName,
        version_code: r.versionCode,
        platform: r.platform,
        status: r.status,
        event: r.event,
        payload: r.payloadJson,
        ip_address: r.ipAddress,
        last_seen_at: new Date(r.lastSeenAt).toISOString(),
        created_at: new Date(r.createdAt).toISOString(),
      })),
    });
  });
}
