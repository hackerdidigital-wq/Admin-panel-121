import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import {
  adConfigs,
  apiLogs,
  appAnnouncements,
  appApiKeys,
  appCollections,
  appEvents,
  appHeartbeats,
  appModules,
  appReleases,
  appRemoteConfigs,
  appUsers,
  connectedApps,
  contentItems,
  featureFlags,
  notifications,
  roles,
  supportTickets,
  transactions,
  userAppPermissions,
  users,
  webhookDeliveries,
  webhooks,
} from '../../db/schema.ts';
import { ensureSystemSeeded } from '../../db/seed.ts';
import {
  buildBackendNamespace,
  generateCollectionMigrationSql,
  inspectAppSpecification,
  type CollectionFieldSpec,
  type IntegrationMode,
} from '../../lib/appDiscovery.ts';
import { toCsv } from '../../lib/csv.ts';
import { derivePackageNameFromInput, normalizePackageName } from '../../lib/packageSync.ts';
import { computeSha256, generateSessionToken, generateUid, sanitizeText } from '../../lib/security.ts';
import { parsePaginationQuery, slugify } from '../../lib/validation.ts';
import {
  buildRemoteConfigPayload,
  formatAnnouncementRow,
} from './packageSync.ts';
import { writeAuditLog } from '../audit.ts';
import { requireAppAccess, requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

export const VALID_PLATFORMS = ['android', 'unity', 'game', 'website', 'ios', 'api'] as const;
const VALID_APP_STATUSES = ['connected', 'disconnected', 'maintenance'] as const;
export const VALID_KEY_SCOPES = [
  'config:read',
  'users:write',
  'events:write',
  'commerce:write',
  'data:read',
  'data:write',
  'storage:write',
  'admin:sync',
  '*',
] as const;
export const DEFAULT_KEY_SCOPES = [
  'config:read',
  'users:write',
  'events:write',
  'commerce:write',
  'data:read',
  'data:write',
  'storage:write',
] as const;
const VALID_APP_USER_STATUSES = ['active', 'banned', 'suspended'] as const;
const VALID_ROLE_SCOPES = ['owner', 'admin', 'editor', 'viewer'] as const;

async function computeHmacSha256(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function isValidWebhookUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost') ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.startsWith('169.254.') ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function deliverSingleWebhook(
  ctx: WorkerContext,
  hook: typeof webhooks.$inferSelect,
  eventType: string,
  payload: Record<string, unknown>,
  appUid = 'global'
): Promise<{
  success: boolean;
  statusCode: number;
  durationMs: number;
  responseBody: string;
  errorMessage: string;
}> {
  const started = Date.now();
  const bodyStr = JSON.stringify({
    event: eventType,
    appId: hook.appId,
    appUid,
    timestamp: new Date().toISOString(),
    data: payload,
  });

  let statusCode = 0;
  let responseBody = '';
  let success = false;
  let errorMessage = '';

  if (!isValidWebhookUrl(hook.targetUrl)) {
    return {
      success: false,
      statusCode: 0,
      durationMs: 0,
      responseBody: '',
      errorMessage: 'Blocked non-public or invalid webhook target URL.',
    };
  }

  try {
    const signature = await computeHmacSha256(hook.signingSecret, bodyStr);
    const res = await fetch(hook.targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Aegis-Webhook-Dispatcher/1.0',
        'X-Aegis-Event': eventType,
        'X-Aegis-App-Id': appUid,
        'X-Aegis-Signature': `sha256=${signature}`,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(8000),
    });
    statusCode = res.status;
    success = res.ok;
    responseBody = (await res.text()).slice(0, 500);
    if (!res.ok) {
      errorMessage = `HTTP ${res.status}`;
    }
  } catch (err) {
    errorMessage = err instanceof Error ? err.message.slice(0, 300) : 'Webhook request failed';
  }

  const durationMs = Date.now() - started;
  const now = new Date();

  await ctx.db
    .insert(webhookDeliveries)
    .values({
      webhookId: hook.id,
      appId: hook.appId,
      eventType,
      payload,
      statusCode,
      responseBody,
      durationMs,
      success,
      errorMessage,
    })
    .catch(() => {});

  await ctx.db
    .update(webhooks)
    .set({
      lastStatusCode: statusCode,
      lastTriggeredAt: now,
      updatedAt: now,
    })
    .where(eq(webhooks.id, hook.id))
    .catch(() => {});

  return { success, statusCode, durationMs, responseBody, errorMessage };
}

export async function dispatchWebhooksForEvent(
  ctx: WorkerContext,
  appId: number | null,
  eventType: string,
  payload: Record<string, unknown>,
  appUid = 'global'
): Promise<void> {
  const candidates = await ctx.db
    .select()
    .from(webhooks)
    .where(
      appId !== null
        ? and(eq(webhooks.isActive, true), sql`(${webhooks.appId} = ${appId} OR ${webhooks.appId} IS NULL)`)
        : and(eq(webhooks.isActive, true), sql`${webhooks.appId} IS NULL`)
    );

  const matched = candidates.filter((hook) => {
    const events = Array.isArray(hook.events) ? hook.events : ['*'];
    return events.includes('*') || events.includes(eventType);
  });

  if (matched.length === 0) return;

  const job = Promise.all(
    matched.map((hook) => deliverSingleWebhook(ctx, hook, eventType, payload, appUid))
  ).catch(() => {});

  if (ctx.executionCtx && typeof ctx.executionCtx.waitUntil === 'function') {
    ctx.executionCtx.waitUntil(job);
  } else {
    await job;
  }
}

function generateLiveApiKey(): string {
  return `aegis_live_${generateSessionToken().slice(0, 40)}`;
}

export async function authenticateSdkRequest(
  ctx: WorkerContext,
  requiredScope: (typeof VALID_KEY_SCOPES)[number],
  packageNameHint = ''
): Promise<
  | { ok: true; app: typeof connectedApps.$inferSelect; apiKeyRow: typeof appApiKeys.$inferSelect }
  | { ok: false; response: Response }
> {
  await ensureSystemSeeded(ctx.env.DB, ctx.env.GITHUB_DEFAULT_REPO || '');

  const rawAppUid = sanitizeText(
    ctx.request.headers.get('x-app-id') || ctx.url.searchParams.get('appId') || '',
    100
  );
  const rawPkgHeaderOrQuery = sanitizeText(
    packageNameHint ||
      ctx.request.headers.get('x-package-name') ||
      ctx.url.searchParams.get('package_name') ||
      ctx.url.searchParams.get('packageName') ||
      '',
    180
  );
  const normalizedPkg = normalizePackageName(rawPkgHeaderOrQuery);
  const authHeader = ctx.request.headers.get('authorization') || '';
  const bearerKey = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const rawApiKey = (ctx.request.headers.get('x-api-key') || bearerKey).trim();

  if ((!rawAppUid && !normalizedPkg) || !rawApiKey) {
    return {
      ok: false,
      response: errorResponse(
        401,
        'Unauthorized: X-App-Id (or X-Package-Name) header and API key (X-API-Key or Authorization: Bearer) are required.',
        { code: 'MISSING_CREDENTIALS', requiredScope }
      ),
    };
  }

  let app: typeof connectedApps.$inferSelect | undefined;
  if (rawAppUid) {
    const appRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(
        sql`(${connectedApps.appUid} = ${rawAppUid} OR ${connectedApps.slug} = ${rawAppUid} OR lower(${connectedApps.packageName}) = ${rawAppUid.toLowerCase()})`
      )
      .limit(1);
    app = appRows[0];
  } else if (normalizedPkg) {
    const pkgRows = await ctx.db
      .select()
      .from(connectedApps)
      .where(
        sql`(lower(${connectedApps.packageName}) = ${normalizedPkg} OR lower(trim(${connectedApps.packageOrDomain})) = ${normalizedPkg})`
      )
      .limit(1);
    app = pkgRows[0];
  }

  if (!app) {
    return {
      ok: false,
      response: errorResponse(404, 'Application not found for supplied X-App-Id or package_name.', {
        code: 'APP_NOT_FOUND',
        appUid: rawAppUid || undefined,
        package_name: normalizedPkg || undefined,
      }),
    };
  }

  if (rawAppUid && normalizedPkg) {
    const appPkg = normalizePackageName(app.packageName || app.packageOrDomain);
    if (appPkg && appPkg !== normalizedPkg) {
      return {
        ok: false,
        response: errorResponse(403, 'Forbidden: Supplied package_name does not match X-App-Id.', {
          code: 'APP_PACKAGE_MISMATCH',
          appUid: app.appUid,
          package_name: normalizedPkg,
        }),
      };
    }
  }

  ctx.sdkAppId = app.id;

  const keyHash = await computeSha256(rawApiKey);
  const keyRows = await ctx.db
    .select()
    .from(appApiKeys)
    .where(and(eq(appApiKeys.appId, app.id), eq(appApiKeys.keyHash, keyHash)))
    .limit(1);
  const apiKeyRow = keyRows[0];

  if (!apiKeyRow || !apiKeyRow.isActive || apiKeyRow.revokedAt) {
    return {
      ok: false,
      response: errorResponse(401, 'Invalid or revoked API key for this application.', {
        code: 'INVALID_OR_REVOKED_KEY',
        appUid: app.appUid,
      }),
    };
  }
  if (apiKeyRow.expiresAt && new Date(apiKeyRow.expiresAt).getTime() <= Date.now()) {
    return {
      ok: false,
      response: errorResponse(401, 'API key has expired.', {
        code: 'KEY_EXPIRED',
        appUid: app.appUid,
      }),
    };
  }

  const scopes = Array.isArray(apiKeyRow.scopes) ? apiKeyRow.scopes : [];
  if (!scopes.includes(requiredScope) && !scopes.includes('*')) {
    return {
      ok: false,
      response: errorResponse(403, `Forbidden: API key is missing required scope "${requiredScope}".`, {
        code: 'MISSING_SCOPE',
        requiredScope,
        availableScopes: scopes,
        appUid: app.appUid,
      }),
    };
  }

  if (app.status === 'disconnected') {
    return {
      ok: false,
      response: errorResponse(403, 'Application connection is currently disabled (disconnected).', {
        code: 'APP_DISCONNECTED',
        appUid: app.appUid,
      }),
    };
  }

  const now = new Date();
  await ctx.db
    .update(appApiKeys)
    .set({ lastUsedAt: now })
    .where(eq(appApiKeys.id, apiKeyRow.id))
    .catch(() => {});

  return { ok: true, app, apiKeyRow };
}

export function registerMultiAppAndSdkRoutes(router: WorkerRouter): void {
  // ---- COMBINED MULTI-APP OVERVIEW ----
  router.get('/api/apps/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'apps.read');
    if (permFail) return permFail;

    const cutoff24h = new Date(Date.now() - 86_400_000);
    const [apps, allEndUsers, txRows, adRows, ticketRows, keyRows, errEvents] = await Promise.all([
      ctx.db.select().from(connectedApps).orderBy(desc(connectedApps.updatedAt)),
      ctx.db
        .select({
          appId: appUsers.appId,
          status: appUsers.status,
          lastActiveAt: appUsers.lastActiveAt,
        })
        .from(appUsers),
      ctx.db
        .select({
          appId: transactions.appId,
          amountCents: transactions.amountCents,
          status: transactions.status,
          type: transactions.type,
        })
        .from(transactions),
      ctx.db
        .select({
          appId: adConfigs.appId,
          revenueCents: adConfigs.revenueCents,
          impressions: adConfigs.impressions,
          clicks: adConfigs.clicks,
        })
        .from(adConfigs),
      ctx.db
        .select({
          appId: supportTickets.appId,
          status: supportTickets.status,
        })
        .from(supportTickets),
      ctx.db
        .select({
          appId: appApiKeys.appId,
          isActive: appApiKeys.isActive,
        })
        .from(appApiKeys),
      ctx.db
        .select({
          appId: appEvents.appId,
          severity: appEvents.severity,
        })
        .from(appEvents)
        .where(and(gte(appEvents.createdAt, cutoff24h), sql`${appEvents.severity} IN ('error', 'critical')`)),
    ]);

    const perApp = apps.map((app) => {
      const usersForApp = allEndUsers.filter((u) => u.appId === app.id);
      const activeForApp = usersForApp.filter((u) => u.status === 'active').length;
      const bannedForApp = usersForApp.filter((u) => u.status === 'banned').length;
      const revForApp = txRows
        .filter((t) => t.appId === app.id && t.status === 'succeeded' && t.type === 'payment')
        .reduce((sum, t) => sum + t.amountCents, 0);
      const adRevForApp = adRows
        .filter((a) => a.appId === app.id)
        .reduce((sum, a) => sum + a.revenueCents, 0);
      const openTicketsForApp = ticketRows.filter(
        (t) => t.appId === app.id && (t.status === 'open' || t.status === 'pending')
      ).length;
      const activeKeysCount = keyRows.filter((k) => k.appId === app.id && k.isActive).length;
      const errors24h = errEvents.filter((e) => e.appId === app.id).length;

      return {
        ...app,
        stats: {
          totalUsers: usersForApp.length,
          activeUsers: activeForApp,
          bannedUsers: bannedForApp,
          revenueCents: revForApp,
          adRevenueCents: adRevForApp,
          openTickets: openTicketsForApp,
          activeKeysCount,
          errors24h,
        },
      };
    });

    const summary = {
      totalApps: apps.length,
      connectedApps: apps.filter((a) => a.status === 'connected').length,
      maintenanceApps: apps.filter((a) => a.status === 'maintenance').length,
      disconnectedApps: apps.filter((a) => a.status === 'disconnected').length,
      totalEndUsers: allEndUsers.length,
      activeEndUsers: allEndUsers.filter((u) => u.status === 'active').length,
      bannedEndUsers: allEndUsers.filter((u) => u.status === 'banned').length,
      totalRevenueCents: txRows
        .filter((t) => t.status === 'succeeded' && t.type === 'payment')
        .reduce((s, t) => s + t.amountCents, 0),
      totalAdRevenueCents: adRows.reduce((s, a) => s + a.revenueCents, 0),
      errors24h: errEvents.length,
    };

    return jsonResponse({ summary, apps: perApp });
  });

  // ---- CONNECTED APPS DIRECTORY & CRUD ----
  router.get('/api/apps', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'apps.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const platform = sanitizeText(q.platform || 'all', 30);
    const status = sanitizeText(q.status || 'all', 30);
    const search = sanitizeText(q.search || '', 100).toLowerCase();
    const pkgFilter = normalizePackageName(q.package_name || q.packageName || '');

    const conditions: SQL[] = [];
    if (platform !== 'all' && VALID_PLATFORMS.includes(platform as (typeof VALID_PLATFORMS)[number])) {
      conditions.push(eq(connectedApps.platform, platform));
    }
    if (status !== 'all' && VALID_APP_STATUSES.includes(status as (typeof VALID_APP_STATUSES)[number])) {
      conditions.push(eq(connectedApps.status, status));
    }
    if (pkgFilter) {
      conditions.push(
        sql`(lower(${connectedApps.packageName}) = ${pkgFilter} OR lower(trim(${connectedApps.packageOrDomain})) = ${pkgFilter})`
      );
    }
    if (search) {
      const pattern = `%${search}%`;
      conditions.push(
        sql`(lower(${connectedApps.name}) LIKE ${pattern} OR lower(${connectedApps.appUid}) LIKE ${pattern} OR lower(${connectedApps.packageName}) LIKE ${pattern} OR lower(${connectedApps.packageOrDomain}) LIKE ${pattern})`
      );
    }

    const apps = await ctx.db
      .select()
      .from(connectedApps)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(connectedApps.updatedAt));

    const [userCounts, keyCounts] = await Promise.all([
      ctx.db
        .select({
          appId: appUsers.appId,
          count: sql<number>`cast(count(*) as integer)`,
        })
        .from(appUsers)
        .groupBy(appUsers.appId),
      ctx.db
        .select({
          appId: appApiKeys.appId,
          count: sql<number>`cast(count(*) as integer)`,
        })
        .from(appApiKeys)
        .where(eq(appApiKeys.isActive, true))
        .groupBy(appApiKeys.appId),
    ]);

    const userCountMap = new Map(userCounts.map((r) => [r.appId, Number(r.count)]));
    const keyCountMap = new Map(keyCounts.map((r) => [r.appId, Number(r.count)]));

    return jsonResponse({
      data: apps.map((a) => ({
        ...a,
        webhookSecret: undefined,
        hasWebhookSecret: Boolean(a.webhookSecret),
        endUsersCount: userCountMap.get(a.id) ?? 0,
        activeKeysCount: keyCountMap.get(a.id) ?? 0,
      })),
    });
  });

  router.post('/api/apps', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'apps.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      platform?: string;
      packageName?: string;
      package_name?: string;
      packageOrDomain?: string;
      description?: string;
      currentVersion?: string;
      minSupportedVersion?: string;
      forceUpdate?: boolean;
      admobAppId?: string;
      adsEnabled?: boolean;
      maintenanceMessage?: string;
      createInitialKey?: boolean;
      initialKeyName?: string;
      scopes?: string[];
      integrationMode?: string;
      backendBaseUrl?: string;
      manifestUrl?: string;
      modelsText?: string;
      enabledModules?: string[];
      discoveredCapabilities?: Record<string, unknown>;
      proposedCollections?: Array<{
        slug: string;
        name: string;
        description?: string;
        fields?: CollectionFieldSpec[];
      }>;
    }>(ctx.request);

    const name = sanitizeText(body.name, 120);
    if (!name) {
      return errorResponse(400, 'Application name is required.');
    }

    const pkgResolved = derivePackageNameFromInput(
      body.package_name ?? body.packageName,
      body.packageOrDomain
    );
    if (pkgResolved.error) {
      return errorResponse(400, pkgResolved.error);
    }
    if (pkgResolved.packageName) {
      const dupPkg = await ctx.db
        .select({ id: connectedApps.id, appUid: connectedApps.appUid })
        .from(connectedApps)
        .where(sql`lower(${connectedApps.packageName}) = ${pkgResolved.packageName}`)
        .limit(1);
      if (dupPkg[0]) {
        return errorResponse(409, `An application with package_name "${pkgResolved.packageName}" already exists.`, {
          code: 'PACKAGE_NAME_CONFLICT',
          package_name: pkgResolved.packageName,
          existingAppId: dupPkg[0].id,
        });
      }
    }

    const platform = VALID_PLATFORMS.includes((body.platform || '') as (typeof VALID_PLATFORMS)[number])
      ? (body.platform as string)
      : 'android';
    const baseSlug = slugify(name) || `app-${Date.now()}`;
    const existingSlug = await ctx.db
      .select({ id: connectedApps.id })
      .from(connectedApps)
      .where(eq(connectedApps.slug, baseSlug))
      .limit(1);
    const slug = existingSlug.length > 0 ? `${baseSlug}-${Date.now().toString(36)}` : baseSlug;
    const appUid = generateUid('app');
    const webhookSecret = `whsec_${generateSessionToken().slice(0, 32)}`;
    const backendNamespace = buildBackendNamespace(slug, appUid);

    const integrationMode: IntegrationMode =
      body.integrationMode === 'external_backend' || body.integrationMode === 'hybrid'
        ? body.integrationMode
        : body.backendBaseUrl
          ? 'hybrid'
          : 'aegis_managed';

    const discovery = inspectAppSpecification({
      name,
      platform,
      packageOrDomain: pkgResolved.packageOrDomain,
      integrationMode,
      backendBaseUrl: sanitizeText(body.backendBaseUrl, 300),
      manifestUrl: sanitizeText(body.manifestUrl, 300),
      modelsText: typeof body.modelsText === 'string' ? body.modelsText.slice(0, 6000) : '',
    });

    const finalCapabilities =
      body.discoveredCapabilities && typeof body.discoveredCapabilities === 'object'
        ? body.discoveredCapabilities
        : (discovery as unknown as Record<string, unknown>);

    const finalEnabledModules =
      Array.isArray(body.enabledModules) && body.enabledModules.length > 0
        ? body.enabledModules.map((m) => sanitizeText(m, 50)).filter(Boolean)
        : discovery.recommendedModules;

    const fullCtrl =
      typeof (finalCapabilities as { fullControlAvailable?: unknown }).fullControlAvailable === 'boolean'
        ? Boolean((finalCapabilities as { fullControlAvailable?: boolean }).fullControlAvailable)
        : discovery.fullControlAvailable;

    const syncStatus =
      integrationMode === 'aegis_managed'
        ? 'verified'
        : fullCtrl
          ? 'verified'
          : 'partial';

    const created = await ctx.db
      .insert(connectedApps)
      .values({
        appUid,
        slug,
        name,
        platform,
        packageName: pkgResolved.packageName,
        packageOrDomain: pkgResolved.packageOrDomain,
        description: sanitizeText(body.description, 500),
        status: 'connected',
        currentVersion: sanitizeText(body.currentVersion || '1.0.0', 40) || '1.0.0',
        minSupportedVersion: sanitizeText(body.minSupportedVersion || '1.0.0', 40) || '1.0.0',
        forceUpdate: Boolean(body.forceUpdate),
        maintenanceMessage:
          sanitizeText(body.maintenanceMessage, 300) || 'Scheduled maintenance is in progress.',
        admobAppId: sanitizeText(body.admobAppId, 120),
        adsEnabled: body.adsEnabled !== undefined ? Boolean(body.adsEnabled) : true,
        webhookSecret,
        healthStatus: 'healthy',
        backendNamespace,
        integrationMode,
        backendBaseUrl: sanitizeText(body.backendBaseUrl, 300),
        manifestUrl: sanitizeText(body.manifestUrl, 300),
        discoveredCapabilities: finalCapabilities,
        enabledModules: finalEnabledModules,
        syncStatus,
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    const app = created[0];

    await ctx.db
      .insert(appRemoteConfigs)
      .values({
        appId: app.id,
        packageName: app.packageName || app.packageOrDomain,
        maintenance: false,
        killSwitch: false,
        maintenanceMessage: app.maintenanceMessage,
        bannerJson: {},
        flagsJson: {},
        updatedBy: ctx.adminUser!.id,
      })
      .onConflictDoNothing()
      .catch(() => {});

    // Provision isolated collections and custom module bindings for the new app
    const collectionsToProvision =
      Array.isArray(body.proposedCollections) && body.proposedCollections.length > 0
        ? body.proposedCollections
        : discovery.proposedCollections;

    const provisionedCollections: Array<{ id: number; slug: string; name: string }> = [];
    for (const col of collectionsToProvision.slice(0, 12)) {
      const colSlug = sanitizeText(col.slug, 50).toLowerCase().replace(/[^a-z0-9_]+/g, '_');
      if (!colSlug) continue;
      const fields = Array.isArray(col.fields) ? col.fields : [];
      const migrationSql = generateCollectionMigrationSql(backendNamespace, colSlug, fields);
      const insertedCol = await ctx.db
        .insert(appCollections)
        .values({
          appId: app.id,
          slug: colSlug,
          name: sanitizeText(col.name, 100) || colSlug,
          description: sanitizeText(col.description || '', 300),
          fieldsJson: fields,
          permissionsJson: { read: 'sdk', write: 'sdk' },
          migrationSql,
          createdBy: ctx.adminUser!.id,
        })
        .onConflictDoNothing()
        .returning({ id: appCollections.id, slug: appCollections.slug, name: appCollections.name });
      if (insertedCol[0]) {
        provisionedCollections.push(insertedCol[0]);
        await ctx.db
          .insert(appModules)
          .values({
            appId: app.id,
            moduleKey: `col_${colSlug}`,
            name: insertedCol[0].name,
            category: 'collection',
            status: 'active',
            configJson: { collectionSlug: colSlug },
            migrationSql,
            apiEndpoints: [
              { method: 'GET', path: `/api/v1/sdk/data/${colSlug}`, scope: 'data:read' },
              { method: 'POST', path: `/api/v1/sdk/data/${colSlug}`, scope: 'data:write' },
            ],
            uiSchema: { fields },
            createdBy: ctx.adminUser!.id,
          })
          .onConflictDoNothing()
          .catch(() => {});
      }
    }

    let initialApiKey: string | null = null;
    let initialKeyRecord: Record<string, unknown> | null = null;

    if (body.createInitialKey !== false && ctx.adminUser!.permissions.has('apps.keys')) {
      initialApiKey = generateLiveApiKey();
      const keyHash = await computeSha256(initialApiKey);
      const requestedScopes = Array.isArray(body.scopes)
        ? body.scopes.filter((s) => VALID_KEY_SCOPES.includes(s as (typeof VALID_KEY_SCOPES)[number]))
        : [...DEFAULT_KEY_SCOPES];
      const scopes = requestedScopes.length > 0 ? requestedScopes : [...DEFAULT_KEY_SCOPES];
      const keyRows = await ctx.db
        .insert(appApiKeys)
        .values({
          appId: app.id,
          name: sanitizeText(body.initialKeyName, 80) || 'Primary Production Key',
          keyPrefix: initialApiKey.slice(0, 18),
          keyHash,
          scopes,
          isActive: true,
          createdBy: ctx.adminUser!.id,
        })
        .returning({
          id: appApiKeys.id,
          appId: appApiKeys.appId,
          name: appApiKeys.name,
          keyPrefix: appApiKeys.keyPrefix,
          scopes: appApiKeys.scopes,
          isActive: appApiKeys.isActive,
          createdAt: appApiKeys.createdAt,
        });
      initialKeyRecord = keyRows[0];
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.connected',
      module: 'apps',
      targetType: 'connected_app',
      targetId: app.id,
      details: {
        appUid: app.appUid,
        name: app.name,
        platform: app.platform,
        backendNamespace,
        integrationMode,
        collectionsProvisioned: provisionedCollections.length,
      },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse(
      {
        app: { ...app, webhookSecret: undefined },
        initialApiKey,
        initialKeyRecord,
        provisionedCollections,
      },
      201
    );
  });

  router.get('/api/apps/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, id, 'apps.read');
    if (permFail) return permFail;

    const rows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, id)).limit(1);
    const app = rows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const [keys, recentEvents, endUsersCount, activeUsersCount, bannedUsersCount, flags, releases, ads] =
      await Promise.all([
        ctx.db
          .select({
            id: appApiKeys.id,
            name: appApiKeys.name,
            keyPrefix: appApiKeys.keyPrefix,
            scopes: appApiKeys.scopes,
            isActive: appApiKeys.isActive,
            lastUsedAt: appApiKeys.lastUsedAt,
            expiresAt: appApiKeys.expiresAt,
            createdAt: appApiKeys.createdAt,
          })
          .from(appApiKeys)
          .where(eq(appApiKeys.appId, id))
          .orderBy(desc(appApiKeys.createdAt)),
        ctx.db
          .select()
          .from(appEvents)
          .where(eq(appEvents.appId, id))
          .orderBy(desc(appEvents.createdAt))
          .limit(30),
        ctx.db
          .select({ c: sql<number>`cast(count(*) as integer)` })
          .from(appUsers)
          .where(eq(appUsers.appId, id)),
        ctx.db
          .select({ c: sql<number>`cast(count(*) as integer)` })
          .from(appUsers)
          .where(and(eq(appUsers.appId, id), eq(appUsers.status, 'active'))),
        ctx.db
          .select({ c: sql<number>`cast(count(*) as integer)` })
          .from(appUsers)
          .where(and(eq(appUsers.appId, id), eq(appUsers.status, 'banned'))),
        ctx.db.select().from(featureFlags).where(eq(featureFlags.appId, id)),
        ctx.db.select().from(appReleases).where(eq(appReleases.appId, id)).orderBy(desc(appReleases.createdAt)),
        ctx.db.select().from(adConfigs).where(eq(adConfigs.appId, id)),
      ]);

    return jsonResponse({
      app: { ...app, webhookSecret: undefined },
      stats: {
        endUsersCount: Number(endUsersCount[0]?.c ?? 0),
        activeUsersCount: Number(activeUsersCount[0]?.c ?? 0),
        bannedUsersCount: Number(bannedUsersCount[0]?.c ?? 0),
      },
      keys,
      recentEvents,
      flags,
      releases,
      ads,
    });
  });

  router.patch('/api/apps/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, id, 'apps.manage');
    if (permFail) return permFail;

    const existingRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, id)).limit(1);
    const existing = existingRows[0];
    if (!existing) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      name?: string;
      platform?: string;
      packageName?: string;
      package_name?: string;
      packageOrDomain?: string;
      description?: string;
      status?: string;
      currentVersion?: string;
      minSupportedVersion?: string;
      forceUpdate?: boolean;
      maintenanceMessage?: string;
      admobAppId?: string;
      adsEnabled?: boolean;
      healthStatus?: string;
      integrationMode?: string;
      backendBaseUrl?: string;
      manifestUrl?: string;
      enabledModules?: string[];
      settingsJson?: Record<string, unknown>;
      rotateWebhookSecret?: boolean;
    }>(ctx.request);

    let nextPackageName = existing.packageName;
    let nextPackageOrDomain =
      body.packageOrDomain !== undefined
        ? sanitizeText(body.packageOrDomain, 200)
        : existing.packageOrDomain;

    const suppliedPkgRaw = body.package_name ?? body.packageName;
    if (suppliedPkgRaw !== undefined || body.packageOrDomain !== undefined) {
      const resolvedPkg = derivePackageNameFromInput(
        suppliedPkgRaw !== undefined ? suppliedPkgRaw : undefined,
        nextPackageOrDomain
      );
      if (resolvedPkg.error) {
        return errorResponse(400, resolvedPkg.error);
      }
      if (suppliedPkgRaw !== undefined) {
        nextPackageName = resolvedPkg.packageName;
        if (!nextPackageOrDomain && nextPackageName) {
          nextPackageOrDomain = nextPackageName;
        }
      } else if (resolvedPkg.packageName) {
        nextPackageName = resolvedPkg.packageName;
      }
      if (nextPackageName) {
        const dup = await ctx.db
          .select({ id: connectedApps.id })
          .from(connectedApps)
          .where(sql`lower(${connectedApps.packageName}) = ${nextPackageName} AND ${connectedApps.id} != ${id}`)
          .limit(1);
        if (dup[0]) {
          return errorResponse(409, `Another application already owns package_name "${nextPackageName}".`, {
            code: 'PACKAGE_NAME_CONFLICT',
            package_name: nextPackageName,
          });
        }
      }
    }

    const nextStatus = VALID_APP_STATUSES.includes((body.status || '') as (typeof VALID_APP_STATUSES)[number])
      ? (body.status as string)
      : existing.status;

    const nextPlatform = VALID_PLATFORMS.includes((body.platform || '') as (typeof VALID_PLATFORMS)[number])
      ? (body.platform as string)
      : existing.platform;

    const nextIntegrationMode = ['aegis_managed', 'external_backend', 'hybrid'].includes(body.integrationMode || '')
      ? (body.integrationMode as string)
      : existing.integrationMode;

    const nextMaintenanceMessage =
      body.maintenanceMessage !== undefined
        ? sanitizeText(body.maintenanceMessage, 300)
        : existing.maintenanceMessage;

    const updated = await ctx.db
      .update(connectedApps)
      .set({
        name: body.name !== undefined ? sanitizeText(body.name, 120) || existing.name : existing.name,
        platform: nextPlatform,
        packageName: nextPackageName,
        packageOrDomain: nextPackageOrDomain,
        description:
          body.description !== undefined ? sanitizeText(body.description, 500) : existing.description,
        status: nextStatus,
        currentVersion:
          body.currentVersion !== undefined
            ? sanitizeText(body.currentVersion, 40) || existing.currentVersion
            : existing.currentVersion,
        minSupportedVersion:
          body.minSupportedVersion !== undefined
            ? sanitizeText(body.minSupportedVersion, 40) || existing.minSupportedVersion
            : existing.minSupportedVersion,
        forceUpdate:
          typeof body.forceUpdate === 'boolean' ? body.forceUpdate : existing.forceUpdate,
        maintenanceMessage: nextMaintenanceMessage,
        admobAppId:
          body.admobAppId !== undefined ? sanitizeText(body.admobAppId, 120) : existing.admobAppId,
        adsEnabled: typeof body.adsEnabled === 'boolean' ? body.adsEnabled : existing.adsEnabled,
        healthStatus: ['healthy', 'degraded', 'offline'].includes(body.healthStatus || '')
          ? (body.healthStatus as string)
          : existing.healthStatus,
        integrationMode: nextIntegrationMode,
        backendBaseUrl:
          body.backendBaseUrl !== undefined ? sanitizeText(body.backendBaseUrl, 300) : existing.backendBaseUrl,
        manifestUrl:
          body.manifestUrl !== undefined ? sanitizeText(body.manifestUrl, 300) : existing.manifestUrl,
        enabledModules: Array.isArray(body.enabledModules)
          ? body.enabledModules.map((m) => sanitizeText(m, 50)).filter(Boolean)
          : existing.enabledModules,
        settingsJson:
          body.settingsJson && typeof body.settingsJson === 'object'
            ? body.settingsJson
            : existing.settingsJson,
        webhookSecret: body.rotateWebhookSecret
          ? `whsec_${generateSessionToken().slice(0, 32)}`
          : existing.webhookSecret,
        updatedAt: new Date(),
      })
      .where(eq(connectedApps.id, id))
      .returning();

    // Cascade package_name & maintenance sync cleanly to per-app sync tables
    const effectivePkg = nextPackageName || nextPackageOrDomain;
    if (nextPackageName !== existing.packageName) {
      await Promise.all([
        ctx.db
          .update(appAnnouncements)
          .set({ packageName: effectivePkg })
          .where(eq(appAnnouncements.appId, id))
          .catch(() => {}),
        ctx.db
          .update(appRemoteConfigs)
          .set({ packageName: effectivePkg })
          .where(eq(appRemoteConfigs.appId, id))
          .catch(() => {}),
        ctx.db
          .update(appHeartbeats)
          .set({ packageName: effectivePkg })
          .where(eq(appHeartbeats.appId, id))
          .catch(() => {}),
      ]);
    }
    if (nextStatus !== existing.status || nextMaintenanceMessage !== existing.maintenanceMessage) {
      await ctx.db
        .update(appRemoteConfigs)
        .set({
          maintenance: nextStatus === 'maintenance',
          maintenanceMessage: nextMaintenanceMessage,
          updatedAt: new Date(),
        })
        .where(eq(appRemoteConfigs.appId, id))
        .catch(() => {});
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.updated',
      module: 'apps',
      targetType: 'connected_app',
      targetId: id,
      details: {
        name: updated[0].name,
        package_name: updated[0].packageName,
        status: updated[0].status,
        version: updated[0].currentVersion,
      },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    if (nextStatus !== existing.status) {
      await dispatchWebhooksForEvent(
        ctx,
        id,
        'app.status_changed',
        { previousStatus: existing.status, status: nextStatus, appName: updated[0].name },
        updated[0].appUid
      );
    }

    return jsonResponse({ app: { ...updated[0], webhookSecret: undefined } });
  });

  router.delete('/api/apps/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, id, 'apps.manage');
    if (permFail) return permFail;

    const existing = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, id)).limit(1);
    if (!existing[0]) return errorResponse(404, 'Connected app not found.');

    await ctx.db.delete(connectedApps).where(eq(connectedApps.id, id));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.deleted',
      module: 'apps',
      targetType: 'connected_app',
      targetId: id,
      details: { appUid: existing[0].appUid, name: existing[0].name },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ deleted: true });
  });

  // ---- APP API KEYS MANAGEMENT ----
  router.get('/api/apps/:id/keys', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, ['apps.keys', 'apps.read']);
    if (permFail) return permFail;

    const keys = await ctx.db
      .select({
        id: appApiKeys.id,
        appId: appApiKeys.appId,
        name: appApiKeys.name,
        keyPrefix: appApiKeys.keyPrefix,
        scopes: appApiKeys.scopes,
        isActive: appApiKeys.isActive,
        lastUsedAt: appApiKeys.lastUsedAt,
        expiresAt: appApiKeys.expiresAt,
        revokedAt: appApiKeys.revokedAt,
        createdAt: appApiKeys.createdAt,
      })
      .from(appApiKeys)
      .where(eq(appApiKeys.appId, appId))
      .orderBy(desc(appApiKeys.createdAt));

    return jsonResponse({ data: keys });
  });

  router.post('/api/apps/:id/keys', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.keys');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    if (!appRows[0]) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      name?: string;
      scopes?: string[];
      expiresInDays?: number;
    }>(ctx.request);

    const name = sanitizeText(body.name, 80) || `API Key ${new Date().toISOString().slice(0, 10)}`;
    const requestedScopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s) => VALID_KEY_SCOPES.includes(s as (typeof VALID_KEY_SCOPES)[number]))
      : [...DEFAULT_KEY_SCOPES];
    const scopes = requestedScopes.length > 0 ? requestedScopes : [...DEFAULT_KEY_SCOPES];

    const expiresInDays = Number(body.expiresInDays);
    const expiresAt =
      Number.isFinite(expiresInDays) && expiresInDays > 0
        ? new Date(Date.now() + Math.min(3650, expiresInDays) * 86_400_000)
        : null;

    const rawApiKey = generateLiveApiKey();
    const keyHash = await computeSha256(rawApiKey);

    const inserted = await ctx.db
      .insert(appApiKeys)
      .values({
        appId,
        name,
        keyPrefix: rawApiKey.slice(0, 18),
        keyHash,
        scopes,
        isActive: true,
        expiresAt,
        createdBy: ctx.adminUser!.id,
      })
      .returning({
        id: appApiKeys.id,
        appId: appApiKeys.appId,
        name: appApiKeys.name,
        keyPrefix: appApiKeys.keyPrefix,
        scopes: appApiKeys.scopes,
        isActive: appApiKeys.isActive,
        expiresAt: appApiKeys.expiresAt,
        createdAt: appApiKeys.createdAt,
      });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.api_key_created',
      module: 'apps',
      targetType: 'app_api_key',
      targetId: inserted[0].id,
      details: { appId, appUid: appRows[0].appUid, scopes },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ apiKey: rawApiKey, key: inserted[0] }, 201);
  });

  router.post('/api/apps/:id/keys/:keyId/rotate', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.keys');
    if (permFail) return permFail;

    const keyId = Number(ctx.params.keyId);
    const existingRows = await ctx.db
      .select()
      .from(appApiKeys)
      .where(and(eq(appApiKeys.id, keyId), eq(appApiKeys.appId, appId)))
      .limit(1);
    const existing = existingRows[0];
    if (!existing) return errorResponse(404, 'API key not found for this application.');

    await ctx.db
      .update(appApiKeys)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(appApiKeys.id, keyId));

    const rawApiKey = generateLiveApiKey();
    const keyHash = await computeSha256(rawApiKey);
    const inserted = await ctx.db
      .insert(appApiKeys)
      .values({
        appId,
        name: `${existing.name} (Rotated)`,
        keyPrefix: rawApiKey.slice(0, 18),
        keyHash,
        scopes: existing.scopes,
        isActive: true,
        expiresAt: existing.expiresAt,
        createdBy: ctx.adminUser!.id,
      })
      .returning({
        id: appApiKeys.id,
        appId: appApiKeys.appId,
        name: appApiKeys.name,
        keyPrefix: appApiKeys.keyPrefix,
        scopes: appApiKeys.scopes,
        isActive: appApiKeys.isActive,
        expiresAt: appApiKeys.expiresAt,
        createdAt: appApiKeys.createdAt,
      });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.api_key_rotated',
      module: 'apps',
      targetType: 'app_api_key',
      targetId: inserted[0].id,
      details: { appId, rotatedFromId: keyId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ apiKey: rawApiKey, key: inserted[0] });
  });

  router.delete('/api/apps/:id/keys/:keyId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.keys');
    if (permFail) return permFail;

    const keyId = Number(ctx.params.keyId);
    const existingRows = await ctx.db
      .select()
      .from(appApiKeys)
      .where(and(eq(appApiKeys.id, keyId), eq(appApiKeys.appId, appId)))
      .limit(1);
    if (!existingRows[0]) return errorResponse(404, 'API key not found.');

    await ctx.db
      .update(appApiKeys)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(appApiKeys.id, keyId));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.api_key_revoked',
      module: 'apps',
      targetType: 'app_api_key',
      targetId: keyId,
      details: { appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ revoked: true });
  });

  // ---- PER-APP & COMBINED END-USER MANAGEMENT ----
  const listAppUsersHandler = async (ctx: WorkerContext, forcedAppId?: number) => {
    const appIdScope =
      forcedAppId ??
      (ctx.url.searchParams.get('appId') && ctx.url.searchParams.get('appId') !== 'all'
        ? Number(ctx.url.searchParams.get('appId'))
        : null);
    const permFail =
      appIdScope && Number.isFinite(appIdScope)
        ? await requireAppAccess(ctx, appIdScope, 'apps.read')
        : await requirePermission(ctx, 'apps.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['lastActiveAt', 'createdAt', 'displayName', 'status'], 'lastActiveAt');
    const appIdParam = forcedAppId ?? (q.appId && q.appId !== 'all' ? Number(q.appId) : null);
    const statusFilter = sanitizeText(q.status || 'all', 20);

    const conditions: SQL[] = [];
    if (appIdParam && Number.isFinite(appIdParam)) {
      conditions.push(eq(appUsers.appId, appIdParam));
    }
    if (statusFilter !== 'all' && VALID_APP_USER_STATUSES.includes(statusFilter as (typeof VALID_APP_USER_STATUSES)[number])) {
      conditions.push(eq(appUsers.status, statusFilter));
    }
    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${appUsers.externalUserId}) LIKE ${pattern} OR lower(${appUsers.email}) LIKE ${pattern} OR lower(${appUsers.displayName}) LIKE ${pattern})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [totalRows, rows] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`cast(count(*) as integer)` })
        .from(appUsers)
        .where(whereClause),
      ctx.db
        .select({
          id: appUsers.id,
          appId: appUsers.appId,
          appName: connectedApps.name,
          appUid: connectedApps.appUid,
          platform: connectedApps.platform,
          externalUserId: appUsers.externalUserId,
          email: appUsers.email,
          displayName: appUsers.displayName,
          status: appUsers.status,
          appVersion: appUsers.appVersion,
          deviceModel: appUsers.deviceModel,
          osVersion: appUsers.osVersion,
          country: appUsers.country,
          ipAddress: appUsers.ipAddress,
          totalSessions: appUsers.totalSessions,
          lastActiveAt: appUsers.lastActiveAt,
          createdAt: appUsers.createdAt,
        })
        .from(appUsers)
        .innerJoin(connectedApps, eq(appUsers.appId, connectedApps.id))
        .where(whereClause)
        .orderBy(desc(appUsers.lastActiveAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
    ]);

    return jsonResponse({
      data: rows,
      total: Number(totalRows[0]?.total ?? 0),
      page: params.page,
      pageSize: params.pageSize,
    });
  };

  router.get('/api/app-users', (ctx) => listAppUsersHandler(ctx));
  router.get('/api/apps/:id/users', (ctx) => listAppUsersHandler(ctx, Number(ctx.params.id)));

  router.post('/api/apps/:id/users', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    if (!appRows[0]) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      externalUserId?: string;
      email?: string;
      displayName?: string;
      appVersion?: string;
      deviceModel?: string;
      osVersion?: string;
      country?: string;
    }>(ctx.request);

    const externalUserId = sanitizeText(body.externalUserId, 120) || generateUid('endusr');
    const now = new Date();

    const upserted = await ctx.db
      .insert(appUsers)
      .values({
        appId,
        externalUserId,
        email: sanitizeText(body.email, 160).toLowerCase(),
        displayName: sanitizeText(body.displayName, 120),
        status: 'active',
        appVersion: sanitizeText(body.appVersion, 40),
        deviceModel: sanitizeText(body.deviceModel, 80),
        osVersion: sanitizeText(body.osVersion, 60),
        country: sanitizeText(body.country, 40),
        ipAddress: ctx.clientIp,
        lastActiveAt: now,
      })
      .onConflictDoUpdate({
        target: [appUsers.appId, appUsers.externalUserId],
        set: {
          email: sanitizeText(body.email, 160).toLowerCase(),
          displayName: sanitizeText(body.displayName, 120),
          appVersion: sanitizeText(body.appVersion, 40),
          lastActiveAt: now,
          updatedAt: now,
        },
      })
      .returning();

    return jsonResponse({ appUser: upserted[0] }, 201);
  });

  router.patch('/api/app-users/:userId', async (ctx: WorkerContext) => {
    const userId = Number(ctx.params.userId);
    const existingRows = await ctx.db.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1);
    const existing = existingRows[0];
    if (!existing) {
      const permFail = await requirePermission(ctx, 'apps.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'App user not found.');
    }
    const permFail = await requireAppAccess(ctx, existing.appId, 'apps.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      status?: string;
      displayName?: string;
      email?: string;
      appVersion?: string;
    }>(ctx.request);

    const nextStatus = VALID_APP_USER_STATUSES.includes(
      (body.status || '') as (typeof VALID_APP_USER_STATUSES)[number]
    )
      ? (body.status as string)
      : existing.status;

    const updated = await ctx.db
      .update(appUsers)
      .set({
        status: nextStatus,
        displayName:
          body.displayName !== undefined ? sanitizeText(body.displayName, 120) : existing.displayName,
        email: body.email !== undefined ? sanitizeText(body.email, 160).toLowerCase() : existing.email,
        appVersion:
          body.appVersion !== undefined ? sanitizeText(body.appVersion, 40) : existing.appVersion,
        updatedAt: new Date(),
      })
      .where(eq(appUsers.id, userId))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.end_user_updated',
      module: 'apps',
      targetType: 'app_user',
      targetId: userId,
      details: { appId: existing.appId, externalUserId: existing.externalUserId, status: nextStatus },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    if (nextStatus !== existing.status) {
      const appRow = await ctx.db
        .select({ appUid: connectedApps.appUid })
        .from(connectedApps)
        .where(eq(connectedApps.id, existing.appId))
        .limit(1);
      await dispatchWebhooksForEvent(
        ctx,
        existing.appId,
        nextStatus === 'banned' ? 'app_user.banned' : 'app_user.status_changed',
        { externalUserId: existing.externalUserId, status: nextStatus },
        appRow[0]?.appUid || String(existing.appId)
      );
    }

    return jsonResponse({ appUser: updated[0] });
  });

  router.delete('/api/app-users/:userId', async (ctx: WorkerContext) => {
    const userId = Number(ctx.params.userId);
    const existingRows = await ctx.db.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1);
    if (!existingRows[0]) {
      const permFail = await requirePermission(ctx, 'apps.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'App user not found.');
    }
    const permFail = await requireAppAccess(ctx, existingRows[0].appId, 'apps.manage');
    if (permFail) return permFail;

    await ctx.db.delete(appUsers).where(eq(appUsers.id, userId));
    return jsonResponse({ deleted: true });
  });

  router.get('/api/app-users/:userId/activity', async (ctx: WorkerContext) => {
    const userId = Number(ctx.params.userId);
    const existingRows = await ctx.db.select().from(appUsers).where(eq(appUsers.id, userId)).limit(1);
    if (!existingRows[0]) {
      const permFail = await requirePermission(ctx, 'apps.read');
      if (permFail) return permFail;
      return errorResponse(404, 'App user not found.');
    }
    const permFail = await requireAppAccess(ctx, existingRows[0].appId, 'apps.read');
    if (permFail) return permFail;

    const events = await ctx.db
      .select()
      .from(appEvents)
      .where(eq(appEvents.appUserId, userId))
      .orderBy(desc(appEvents.createdAt))
      .limit(50);

    return jsonResponse({ data: events });
  });

  // ---- APP EVENTS, HEALTH & ERROR MONITORING ----
  router.get('/api/apps/:id/events', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const severity = sanitizeText(ctx.url.searchParams.get('severity') || 'all', 20);
    const conditions: SQL[] = [eq(appEvents.appId, appId)];
    if (severity !== 'all') {
      conditions.push(eq(appEvents.severity, severity));
    }

    const rows = await ctx.db
      .select()
      .from(appEvents)
      .where(and(...conditions))
      .orderBy(desc(appEvents.createdAt))
      .limit(100);

    return jsonResponse({ data: rows });
  });

  router.get('/api/errors', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'apps.read');
    if (permFail) return permFail;

    const appIdParam = ctx.url.searchParams.get('appId');
    const parsedAppId = appIdParam && appIdParam !== 'all' ? Number(appIdParam) : null;

    const eventConds: SQL[] = [sql`${appEvents.severity} IN ('warn', 'error', 'critical')`];
    const logConds: SQL[] = [sql`${apiLogs.statusCode} >= 400`];
    if (parsedAppId && Number.isFinite(parsedAppId)) {
      eventConds.push(eq(appEvents.appId, parsedAppId));
      logConds.push(eq(apiLogs.appId, parsedAppId));
    }

    const [sdkErrors, httpErrors, apps] = await Promise.all([
      ctx.db
        .select({
          id: appEvents.id,
          appId: appEvents.appId,
          appName: connectedApps.name,
          eventType: appEvents.eventType,
          eventName: appEvents.eventName,
          severity: appEvents.severity,
          latencyMs: appEvents.latencyMs,
          payload: appEvents.payload,
          createdAt: appEvents.createdAt,
        })
        .from(appEvents)
        .innerJoin(connectedApps, eq(appEvents.appId, connectedApps.id))
        .where(and(...eventConds))
        .orderBy(desc(appEvents.createdAt))
        .limit(60),
      ctx.db
        .select()
        .from(apiLogs)
        .where(and(...logConds))
        .orderBy(desc(apiLogs.createdAt))
        .limit(60),
      ctx.db
        .select({
          id: connectedApps.id,
          name: connectedApps.name,
          appUid: connectedApps.appUid,
          platform: connectedApps.platform,
          status: connectedApps.status,
          healthStatus: connectedApps.healthStatus,
          lastHeartbeatAt: connectedApps.lastHeartbeatAt,
          lastLatencyMs: connectedApps.lastLatencyMs,
          errorCount24h: connectedApps.errorCount24h,
        })
        .from(connectedApps)
        .orderBy(desc(connectedApps.updatedAt)),
    ]);

    return jsonResponse({ sdkErrors, httpErrors, apps });
  });

  // ---- ISOLATED PER-APP EXPORT (CSV OR JSON) ----
  router.get('/api/apps/:id/export', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const format = sanitizeText(ctx.url.searchParams.get('format') || 'json', 10).toLowerCase();

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const [endUsers, events, flags, releases, ads, txs, notifs, tickets] = await Promise.all([
      ctx.db.select().from(appUsers).where(eq(appUsers.appId, appId)),
      ctx.db.select().from(appEvents).where(eq(appEvents.appId, appId)).orderBy(desc(appEvents.createdAt)).limit(500),
      ctx.db.select().from(featureFlags).where(eq(featureFlags.appId, appId)),
      ctx.db.select().from(appReleases).where(eq(appReleases.appId, appId)),
      ctx.db.select().from(adConfigs).where(eq(adConfigs.appId, appId)),
      ctx.db.select().from(transactions).where(eq(transactions.appId, appId)),
      ctx.db.select().from(notifications).where(eq(notifications.appId, appId)),
      ctx.db.select().from(supportTickets).where(eq(supportTickets.appId, appId)),
    ]);

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: `apps.exported_${format}`,
      module: 'apps',
      targetType: 'connected_app',
      targetId: appId,
      details: { appUid: app.appUid, format },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    if (format === 'csv') {
      const csv = toCsv(
        [
          'externalUserId',
          'email',
          'displayName',
          'status',
          'appVersion',
          'deviceModel',
          'country',
          'totalSessions',
          'lastActiveAt',
        ],
        endUsers.map((u) => ({
          externalUserId: u.externalUserId,
          email: u.email,
          displayName: u.displayName,
          status: u.status,
          appVersion: u.appVersion,
          deviceModel: u.deviceModel,
          country: u.country,
          totalSessions: u.totalSessions,
          lastActiveAt: new Date(u.lastActiveAt).toISOString(),
        }))
      );
      return new Response(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${app.slug}-users-export.csv"`,
        },
      });
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      app: { ...app, webhookSecret: undefined },
      endUsers,
      events,
      flags,
      releases,
      ads,
      transactions: txs,
      notifications: notifs,
      supportTickets: tickets,
    };

    return new Response(JSON.stringify(payload, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${app.slug}-full-export.json"`,
      },
    });
  });

  // ---- WEBHOOKS & DELIVERY LOGS ----
  router.get('/api/webhooks', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, ['webhooks.manage', 'apps.read']);
    if (permFail) return permFail;

    const appIdParam = ctx.url.searchParams.get('appId');
    const parsedAppId = appIdParam && appIdParam !== 'all' ? Number(appIdParam) : null;

    const rows = await ctx.db
      .select({
        id: webhooks.id,
        appId: webhooks.appId,
        appName: connectedApps.name,
        name: webhooks.name,
        targetUrl: webhooks.targetUrl,
        events: webhooks.events,
        isActive: webhooks.isActive,
        lastStatusCode: webhooks.lastStatusCode,
        lastTriggeredAt: webhooks.lastTriggeredAt,
        createdAt: webhooks.createdAt,
      })
      .from(webhooks)
      .leftJoin(connectedApps, eq(webhooks.appId, connectedApps.id))
      .where(parsedAppId ? eq(webhooks.appId, parsedAppId) : undefined)
      .orderBy(desc(webhooks.createdAt));

    return jsonResponse({ data: rows });
  });

  router.post('/api/webhooks', async (ctx: WorkerContext) => {
    const body = await readJsonBody<{
      appId?: number | null;
      name?: string;
      targetUrl?: string;
      events?: string[];
    }>(ctx.request);

    const scopedAppId = body.appId ? Number(body.appId) : null;
    const permFail =
      scopedAppId && Number.isFinite(scopedAppId)
        ? await requireAppAccess(ctx, scopedAppId, ['webhooks.manage', 'apps.manage'])
        : await requirePermission(ctx, 'webhooks.manage');
    if (permFail) return permFail;

    const name = sanitizeText(body.name, 100);
    const targetUrl = sanitizeText(body.targetUrl, 400);
    if (!name || !isValidWebhookUrl(targetUrl)) {
      return errorResponse(400, 'Webhook name and a valid public http/https target URL are required.');
    }

    const events = Array.isArray(body.events) && body.events.length > 0
      ? body.events.map((e) => sanitizeText(e, 60)).filter(Boolean)
      : ['*'];
    const signingSecret = `whsec_${generateSessionToken().slice(0, 32)}`;

    const created = await ctx.db
      .insert(webhooks)
      .values({
        appId: scopedAppId,
        name,
        targetUrl,
        events,
        signingSecret,
        isActive: true,
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'webhooks.created',
      module: 'apps',
      targetType: 'webhook',
      targetId: created[0].id,
      details: { name, targetUrl, appId: created[0].appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ webhook: created[0], signingSecret }, 201);
  });

  router.patch('/api/webhooks/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    if (!existing[0]) {
      const permFail = await requirePermission(ctx, 'webhooks.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Webhook not found.');
    }
    const permFail = existing[0].appId
      ? await requireAppAccess(ctx, existing[0].appId, ['webhooks.manage', 'apps.manage'])
      : await requirePermission(ctx, 'webhooks.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      isActive?: boolean;
      targetUrl?: string;
      events?: string[];
    }>(ctx.request);

    if (body.targetUrl !== undefined && !isValidWebhookUrl(body.targetUrl)) {
      return errorResponse(400, 'Invalid or non-public target URL.');
    }

    const updated = await ctx.db
      .update(webhooks)
      .set({
        isActive: typeof body.isActive === 'boolean' ? body.isActive : existing[0].isActive,
        targetUrl: body.targetUrl !== undefined ? sanitizeText(body.targetUrl, 400) : existing[0].targetUrl,
        events:
          Array.isArray(body.events) && body.events.length > 0
            ? body.events.map((e) => sanitizeText(e, 60)).filter(Boolean)
            : existing[0].events,
        updatedAt: new Date(),
      })
      .where(eq(webhooks.id, id))
      .returning();

    return jsonResponse({ webhook: { ...updated[0], signingSecret: undefined } });
  });

  router.delete('/api/webhooks/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    if (!existing[0]) {
      const permFail = await requirePermission(ctx, 'webhooks.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Webhook not found.');
    }
    const permFail = existing[0].appId
      ? await requireAppAccess(ctx, existing[0].appId, ['webhooks.manage', 'apps.manage'])
      : await requirePermission(ctx, 'webhooks.manage');
    if (permFail) return permFail;

    await ctx.db.delete(webhooks).where(eq(webhooks.id, id));
    return jsonResponse({ deleted: true });
  });

  router.post('/api/webhooks/:id/test', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    const hook = rows[0];
    if (!hook) {
      const permFail = await requirePermission(ctx, 'webhooks.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Webhook not found.');
    }
    const permFail = hook.appId
      ? await requireAppAccess(ctx, hook.appId, ['webhooks.manage', 'apps.manage'])
      : await requirePermission(ctx, 'webhooks.manage');
    if (permFail) return permFail;

    let appUid = 'global';
    if (hook.appId) {
      const appRows = await ctx.db
        .select({ appUid: connectedApps.appUid })
        .from(connectedApps)
        .where(eq(connectedApps.id, hook.appId))
        .limit(1);
      if (appRows[0]) appUid = appRows[0].appUid;
    }

    const delivery = await deliverSingleWebhook(
      ctx,
      hook,
      'aegis.webhook.test',
      { message: 'Test event dispatched from Aegis Enterprise Console', triggeredBy: ctx.adminUser!.email },
      appUid
    );

    return jsonResponse({ delivery });
  });

  router.get('/api/webhooks/:id/deliveries', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(webhooks).where(eq(webhooks.id, id)).limit(1);
    const permFail = rows[0]?.appId
      ? await requireAppAccess(ctx, rows[0].appId, ['webhooks.manage', 'apps.read'])
      : await requirePermission(ctx, ['webhooks.manage', 'apps.read']);
    if (permFail) return permFail;

    const deliveries = await ctx.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, id))
      .orderBy(desc(webhookDeliveries.createdAt))
      .limit(30);

    return jsonResponse({ data: deliveries });
  });

  // ---- APP-WISE ADMIN TEAM PERMISSIONS ----
  router.get('/api/team/app-permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, ['roles.read', 'apps.read']);
    if (permFail) return permFail;

    const [teamUsers, apps, grants] = await Promise.all([
      ctx.db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          status: users.status,
          roleName: roles.name,
          roleSlug: roles.slug,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.isAdmin, true)),
      ctx.db
        .select({
          id: connectedApps.id,
          name: connectedApps.name,
          appUid: connectedApps.appUid,
          platform: connectedApps.platform,
        })
        .from(connectedApps)
        .orderBy(connectedApps.name),
      ctx.db.select().from(userAppPermissions).orderBy(desc(userAppPermissions.updatedAt)),
    ]);

    return jsonResponse({ users: teamUsers, apps, grants });
  });

  router.put('/api/apps/:id/permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const appId = Number(ctx.params.id);
    const body = await readJsonBody<{
      userId?: number;
      roleScope?: string;
      permissions?: string[];
    }>(ctx.request);

    const targetUserId = Number(body.userId);
    if (!Number.isFinite(targetUserId) || targetUserId <= 0) {
      return errorResponse(400, 'Valid admin userId is required.');
    }

    const roleScope = VALID_ROLE_SCOPES.includes((body.roleScope || '') as (typeof VALID_ROLE_SCOPES)[number])
      ? (body.roleScope as string)
      : 'admin';
    const perms = Array.isArray(body.permissions)
      ? body.permissions.map((p) => sanitizeText(p, 60)).filter(Boolean)
      : ['apps.read'];

    const upserted = await ctx.db
      .insert(userAppPermissions)
      .values({
        userId: targetUserId,
        appId,
        roleScope,
        permissions: perms,
        grantedBy: ctx.adminUser!.id,
      })
      .onConflictDoUpdate({
        target: [userAppPermissions.userId, userAppPermissions.appId],
        set: {
          roleScope,
          permissions: perms,
          grantedBy: ctx.adminUser!.id,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.team_permission_updated',
      module: 'roles',
      targetType: 'user_app_permission',
      targetId: `${appId}:${targetUserId}`,
      details: { appId, targetUserId, roleScope, permissions: perms },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ grant: upserted[0] });
  });

  router.delete('/api/apps/:id/permissions/:userId', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const appId = Number(ctx.params.id);
    const userId = Number(ctx.params.userId);
    await ctx.db
      .delete(userAppPermissions)
      .where(and(eq(userAppPermissions.appId, appId), eq(userAppPermissions.userId, userId)));

    return jsonResponse({ revoked: true });
  });

  // ---- PUBLIC APP SDK ENDPOINTS (/api/v1/sdk/*) ----
  router.get('/api/v1/sdk/config', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'config:read');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const latencyStart = Date.now();
    const [flags, ads, latestRelease, publishedNotices, collections, activeAnnouncements, remoteConfigRows] =
      await Promise.all([
        ctx.db
          .select({
            key: featureFlags.key,
            name: featureFlags.name,
            isEnabled: featureFlags.isEnabled,
            rolloutPercentage: featureFlags.rolloutPercentage,
            appId: featureFlags.appId,
          })
          .from(featureFlags)
          .where(sql`(${featureFlags.appId} = ${app.id} OR ${featureFlags.appId} IS NULL)`),
        ctx.db
          .select({
            id: adConfigs.id,
            name: adConfigs.name,
            network: adConfigs.network,
            adFormat: adConfigs.adFormat,
            placement: adConfigs.placement,
            admobUnitId: adConfigs.admobUnitId,
            frequencyCap: adConfigs.frequencyCap,
            visibilityRule: adConfigs.visibilityRule,
            isEnabled: adConfigs.isEnabled,
          })
          .from(adConfigs)
          .where(and(eq(adConfigs.appId, app.id), eq(adConfigs.isEnabled, true))),
        ctx.db
          .select()
          .from(appReleases)
          .where(and(eq(appReleases.appId, app.id), eq(appReleases.status, 'active')))
          .orderBy(desc(appReleases.createdAt))
          .limit(1),
        ctx.db
          .select({
            id: contentItems.id,
            title: contentItems.title,
            slug: contentItems.slug,
            excerpt: contentItems.excerpt,
            publishedAt: contentItems.publishedAt,
          })
          .from(contentItems)
          .where(and(eq(contentItems.appId, app.id), eq(contentItems.status, 'published')))
          .orderBy(desc(contentItems.publishedAt))
          .limit(10),
        ctx.db
          .select({
            slug: appCollections.slug,
            name: appCollections.name,
          })
          .from(appCollections)
          .where(eq(appCollections.appId, app.id)),
        ctx.db
          .select()
          .from(appAnnouncements)
          .where(and(eq(appAnnouncements.appId, app.id), eq(appAnnouncements.active, 1)))
          .orderBy(desc(appAnnouncements.priority), desc(appAnnouncements.createdAt))
          .limit(20),
        ctx.db
          .select()
          .from(appRemoteConfigs)
          .where(eq(appRemoteConfigs.appId, app.id))
          .limit(1),
      ]);

    const heartbeatLatency = Math.max(1, Date.now() - latencyStart);
    await ctx.db
      .update(connectedApps)
      .set({
        lastHeartbeatAt: new Date(),
        lastLatencyMs: heartbeatLatency,
        healthStatus: app.status === 'maintenance' ? 'degraded' : 'healthy',
      })
      .where(eq(connectedApps.id, app.id))
      .catch(() => {});

    const cleanFlags: Record<string, { enabled: boolean; rolloutPercentage: number; scoped: boolean }> = {};
    for (const f of flags) {
      const publicKey = f.appId ? f.key.replace(new RegExp(`@app${f.appId}$`), '') : f.key;
      if (!(publicKey in cleanFlags) || f.appId === app.id) {
        cleanFlags[publicKey] = {
          enabled: f.isEnabled,
          rolloutPercentage: f.rolloutPercentage,
          scoped: f.appId !== null,
        };
      }
    }

    const pkg = app.packageName || app.packageOrDomain;
    const remotePayload = buildRemoteConfigPayload({
      app,
      remoteConfig: remoteConfigRows[0] ?? null,
      flags,
      latestRelease: latestRelease[0] ?? null,
    });

    return jsonResponse({
      package_name: pkg,
      app: {
        appUid: app.appUid,
        slug: app.slug,
        name: app.name,
        platform: app.platform,
        packageName: app.packageName,
        package_name: pkg,
        backendNamespace: app.backendNamespace,
        integrationMode: app.integrationMode,
        status: app.status,
        maintenanceMode: remotePayload.maintenance,
        killSwitch: remotePayload.kill_switch,
        maintenanceMessage: remotePayload.maintenance_message,
        currentVersion: latestRelease[0]?.version || app.currentVersion,
        minSupportedVersion: latestRelease[0]?.minSupportedVersion || app.minSupportedVersion,
        forceUpdate: latestRelease[0]?.forceUpdate ?? app.forceUpdate,
      },
      ads: {
        enabled: app.adsEnabled,
        admobAppId: app.admobAppId,
        placements: app.adsEnabled ? ads : [],
      },
      featureFlags: cleanFlags,
      collections,
      notices: publishedNotices,
      announcements: activeAnnouncements.map((a) => formatAnnouncementRow(a, pkg)),
      remote_config: remotePayload,
    });
  });

  router.post('/api/v1/sdk/users/sync', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'users:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const body = await readJsonBody<{
      externalUserId?: string;
      email?: string;
      displayName?: string;
      appVersion?: string;
      deviceModel?: string;
      osVersion?: string;
      country?: string;
      metadata?: Record<string, unknown>;
    }>(ctx.request);

    const externalUserId = sanitizeText(body.externalUserId, 120);
    if (!externalUserId) {
      return errorResponse(400, 'externalUserId is required.');
    }

    const existingRows = await ctx.db
      .select()
      .from(appUsers)
      .where(and(eq(appUsers.appId, app.id), eq(appUsers.externalUserId, externalUserId)))
      .limit(1);
    const existing = existingRows[0];

    if (existing && existing.status === 'banned') {
      return errorResponse(403, 'User access is banned for this application.', { status: 'banned' });
    }

    const now = new Date();
    let appUser: typeof appUsers.$inferSelect;
    const isNew = !existing;

    if (existing) {
      const updated = await ctx.db
        .update(appUsers)
        .set({
          email: body.email !== undefined ? sanitizeText(body.email, 160).toLowerCase() : existing.email,
          displayName:
            body.displayName !== undefined ? sanitizeText(body.displayName, 120) : existing.displayName,
          appVersion:
            body.appVersion !== undefined ? sanitizeText(body.appVersion, 40) : existing.appVersion,
          deviceModel:
            body.deviceModel !== undefined ? sanitizeText(body.deviceModel, 80) : existing.deviceModel,
          osVersion:
            body.osVersion !== undefined ? sanitizeText(body.osVersion, 60) : existing.osVersion,
          country: body.country !== undefined ? sanitizeText(body.country, 40) : existing.country,
          ipAddress: ctx.clientIp,
          metadata:
            body.metadata && typeof body.metadata === 'object' ? body.metadata : existing.metadata,
          totalSessions: existing.totalSessions + 1,
          lastActiveAt: now,
          updatedAt: now,
        })
        .where(eq(appUsers.id, existing.id))
        .returning();
      appUser = updated[0];
    } else {
      const inserted = await ctx.db
        .insert(appUsers)
        .values({
          appId: app.id,
          externalUserId,
          email: sanitizeText(body.email, 160).toLowerCase(),
          displayName: sanitizeText(body.displayName, 120),
          status: 'active',
          appVersion: sanitizeText(body.appVersion, 40),
          deviceModel: sanitizeText(body.deviceModel, 80),
          osVersion: sanitizeText(body.osVersion, 60),
          country: sanitizeText(body.country, 40),
          ipAddress: ctx.clientIp,
          metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata : {},
          totalSessions: 1,
          lastActiveAt: now,
        })
        .returning();
      appUser = inserted[0];
    }

    await ctx.db
      .insert(appEvents)
      .values({
        appId: app.id,
        appUserId: appUser.id,
        eventType: 'session',
        eventName: isNew ? 'user.registered' : 'user.session_started',
        severity: 'info',
        payload: { appVersion: appUser.appVersion, deviceModel: appUser.deviceModel },
      })
      .catch(() => {});

    if (isNew) {
      await dispatchWebhooksForEvent(
        ctx,
        app.id,
        'app_user.created',
        { externalUserId: appUser.externalUserId, email: appUser.email, platform: app.platform },
        app.appUid
      );
    }

    return jsonResponse({ user: appUser, isNew }, isNew ? 201 : 200);
  });

  router.post('/api/v1/sdk/events', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'events:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const body = await readJsonBody<{
      externalUserId?: string;
      eventType?: string;
      eventName?: string;
      severity?: string;
      latencyMs?: number;
      adConfigId?: number;
      payload?: Record<string, unknown>;
    }>(ctx.request);

    const eventType = sanitizeText(body.eventType || 'analytics', 40) || 'analytics';
    const eventName = sanitizeText(body.eventName, 120);
    if (!eventName) {
      return errorResponse(400, 'eventName is required.');
    }

    const severity = ['info', 'warn', 'error', 'critical'].includes(body.severity || '')
      ? (body.severity as string)
      : 'info';
    const latencyMs = Math.max(0, Math.round(Number(body.latencyMs) || 0));

    let appUserId: number | null = null;
    if (body.externalUserId) {
      const u = await ctx.db
        .select({ id: appUsers.id })
        .from(appUsers)
        .where(
          and(
            eq(appUsers.appId, app.id),
            eq(appUsers.externalUserId, sanitizeText(body.externalUserId, 120))
          )
        )
        .limit(1);
      appUserId = u[0]?.id ?? null;
    }

    const inserted = await ctx.db
      .insert(appEvents)
      .values({
        appId: app.id,
        appUserId,
        eventType,
        eventName,
        severity,
        latencyMs,
        payload: body.payload && typeof body.payload === 'object' ? body.payload : {},
      })
      .returning();

    // Optional atomic AdMob impression/click tracking
    if (body.adConfigId && (eventType === 'ad_impression' || eventType === 'ad_click')) {
      const adId = Number(body.adConfigId);
      const adRows = await ctx.db
        .select()
        .from(adConfigs)
        .where(and(eq(adConfigs.id, adId), eq(adConfigs.appId, app.id)))
        .limit(1);
      if (adRows[0]) {
        const addedImpr = eventType === 'ad_impression' ? 1 : 0;
        const addedClicks = eventType === 'ad_click' ? 1 : 0;
        const addedRevCents =
          addedImpr > 0 && adRows[0].ecpmCents > 0
            ? Math.round(adRows[0].ecpmCents / 1000)
            : 0;
        await ctx.db
          .update(adConfigs)
          .set({
            impressions: sql`${adConfigs.impressions} + ${addedImpr}`,
            clicks: sql`${adConfigs.clicks} + ${addedClicks}`,
            revenueCents: sql`${adConfigs.revenueCents} + ${addedRevCents}`,
            updatedAt: new Date(),
          })
          .where(eq(adConfigs.id, adId));
      }
    }

    // Update app health & heartbeat telemetry
    const isError = severity === 'error' || severity === 'critical';
    await ctx.db
      .update(connectedApps)
      .set({
        lastHeartbeatAt: new Date(),
        lastLatencyMs: latencyMs > 0 ? latencyMs : app.lastLatencyMs,
        errorCount24h: isError ? sql`${connectedApps.errorCount24h} + 1` : app.errorCount24h,
        healthStatus: severity === 'critical' ? 'degraded' : app.healthStatus,
      })
      .where(eq(connectedApps.id, app.id))
      .catch(() => {});

    if (isError) {
      await dispatchWebhooksForEvent(
        ctx,
        app.id,
        'app.error',
        { eventName, severity, payload: body.payload ?? {} },
        app.appUid
      );
    }

    return jsonResponse({ event: inserted[0] }, 201);
  });

  router.post('/api/v1/sdk/transactions', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'commerce:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const body = await readJsonBody<{
      reference?: string;
      amountCents?: number;
      currency?: string;
      type?: string;
      status?: string;
      paymentMethodLabel?: string;
      externalUserId?: string;
      metadata?: Record<string, unknown>;
    }>(ctx.request);

    const amountCents = Math.round(Number(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return errorResponse(400, 'amountCents must be a positive integer.');
    }

    const reference =
      sanitizeText(body.reference, 80) ||
      `SDK-${app.id}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    const created = await ctx.db
      .insert(transactions)
      .values({
        appId: app.id,
        reference,
        amountCents,
        currency: sanitizeText(body.currency || 'USD', 8).toUpperCase(),
        type: ['payment', 'refund', 'payout'].includes(body.type || '') ? body.type! : 'payment',
        status: ['succeeded', 'pending', 'failed', 'refunded', 'flagged'].includes(body.status || '')
          ? body.status!
          : 'succeeded',
        paymentMethodLabel: sanitizeText(body.paymentMethodLabel || `${app.platform.toUpperCase()} SDK`, 64),
        metadata: {
          ...(body.metadata && typeof body.metadata === 'object' ? body.metadata : {}),
          externalUserId: body.externalUserId ? sanitizeText(body.externalUserId, 120) : undefined,
        },
      })
      .returning();

    await dispatchWebhooksForEvent(
      ctx,
      app.id,
      'transaction.recorded',
      { reference: created[0].reference, amountCents, currency: created[0].currency, status: created[0].status },
      app.appUid
    );

    return jsonResponse({ transaction: created[0] }, 201);
  });
}
