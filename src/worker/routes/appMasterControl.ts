import { and, desc, eq, sql } from 'drizzle-orm';
import {
  adConfigs,
  appAnnouncements,
  appApiKeys,
  appCollections,
  appEvents,
  appHeartbeats,
  appModules,
  appRecords,
  appReleases,
  appRemoteConfigs,
  appUsers,
  backups,
  connectedApps,
  featureFlags,
  files,
  transactions,
  webhooks,
} from '../../db/schema.ts';
import {
  buildBackendNamespace,
  generateCollectionMigrationSql,
  generatePlatformIntegrationSnippets,
  inspectAppSpecification,
  type CollectionFieldSpec,
  type IntegrationMode,
} from '../../lib/appDiscovery.ts';
import { toCsv } from '../../lib/csv.ts';
import { computeSha256, generateUid, sanitizeText } from '../../lib/security.ts';
import { writeAuditLog } from '../audit.ts';
import { requireAppAccess, requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';
import { authenticateSdkRequest, dispatchWebhooksForEvent } from './multiAppAndSdk.ts';
import { buildRemoteConfigPayload, formatAnnouncementRow } from './packageSync.ts';

function isSafePublicUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
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

async function computeHmacSha256(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret || 'aegis-sync'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function cleanCollectionSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function parseCollectionFields(rawFields: unknown): CollectionFieldSpec[] {
  if (!Array.isArray(rawFields)) return [];
  return rawFields
    .map((f): CollectionFieldSpec | null => {
      if (!f || typeof f !== 'object') return null;
      const r = f as Record<string, unknown>;
      const name = cleanCollectionSlug(String(r.name || ''));
      if (!name) return null;
      const rawType = String(r.type || 'text').toLowerCase();
      const type: CollectionFieldSpec['type'] =
        rawType === 'number' || rawType === 'boolean' || rawType === 'json' ? rawType : 'text';
      return {
        name,
        label: sanitizeText(String(r.label || name), 80) || name,
        type,
        required: Boolean(r.required),
      };
    })
    .filter((x): x is CollectionFieldSpec => x !== null);
}

const ALLOWED_SDK_FILE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
]);

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function registerAppMasterControlRoutes(router: WorkerRouter): void {
  // ---- 1. AUTOMATIC CAPABILITY & API/SDK/MANIFEST INSPECTOR ----
  router.post('/api/apps/inspect', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'apps.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      platform?: string;
      packageOrDomain?: string;
      integrationMode?: IntegrationMode;
      backendBaseUrl?: string;
      manifestUrl?: string;
      openapiSpec?: string | Record<string, unknown>;
      manifestJson?: string | Record<string, unknown>;
      modelsText?: string;
    }>(ctx.request);

    let parsedOpenapi: Record<string, unknown> | null = null;
    if (typeof body.openapiSpec === 'string' && body.openapiSpec.trim()) {
      try {
        parsedOpenapi = JSON.parse(body.openapiSpec) as Record<string, unknown>;
      } catch {
        return errorResponse(400, 'Supplied OpenAPI/Swagger specification is not valid JSON.');
      }
    } else if (body.openapiSpec && typeof body.openapiSpec === 'object') {
      parsedOpenapi = body.openapiSpec;
    }

    let parsedManifest: Record<string, unknown> | null = null;
    if (typeof body.manifestJson === 'string' && body.manifestJson.trim()) {
      try {
        parsedManifest = JSON.parse(body.manifestJson) as Record<string, unknown>;
      } catch {
        return errorResponse(400, 'Supplied Aegis manifest JSON is not valid JSON.');
      }
    } else if (body.manifestJson && typeof body.manifestJson === 'object') {
      parsedManifest = body.manifestJson;
    }

    const inspectUrl = sanitizeText(body.manifestUrl || '', 300) || sanitizeText(body.backendBaseUrl || '', 300);
    let probeResult:
      | {
          attempted: boolean;
          reachable: boolean;
          httpStatus: number | null;
          errorMessage?: string;
          parsedJson?: Record<string, unknown> | null;
        }
      | undefined;

    if (inspectUrl && (body.manifestUrl || parsedOpenapi === null && parsedManifest === null && body.integrationMode !== 'aegis_managed')) {
      if (!isSafePublicUrl(inspectUrl)) {
        probeResult = {
          attempted: true,
          reachable: false,
          httpStatus: null,
          errorMessage: 'Blocked non-public, loopback, or invalid URL.',
        };
      } else {
        try {
          const resp = await fetch(inspectUrl, {
            method: 'GET',
            headers: { Accept: 'application/json', 'User-Agent': 'Aegis-Inspector/1.0' },
            signal: AbortSignal.timeout(5000),
          });
          let remoteJson: Record<string, unknown> | null = null;
          const contentType = resp.headers.get('content-type') || '';
          if (contentType.includes('json')) {
            remoteJson = (await resp.json().catch(() => null)) as Record<string, unknown> | null;
          }
          probeResult = {
            attempted: true,
            reachable: resp.ok,
            httpStatus: resp.status,
            errorMessage: resp.ok ? undefined : `Remote returned HTTP ${resp.status}`,
            parsedJson: remoteJson,
          };
        } catch (err) {
          probeResult = {
            attempted: true,
            reachable: false,
            httpStatus: null,
            errorMessage: err instanceof Error ? err.message : 'Remote probe timed out or failed',
          };
        }
      }
    }

    const report = inspectAppSpecification({
      name: sanitizeText(body.name || 'New App', 120) || 'New App',
      platform: sanitizeText(body.platform || 'android', 30),
      packageOrDomain: sanitizeText(body.packageOrDomain, 200),
      integrationMode: body.integrationMode,
      backendBaseUrl: sanitizeText(body.backendBaseUrl, 300),
      manifestUrl: sanitizeText(body.manifestUrl, 300),
      openapiSpec: parsedOpenapi,
      manifestJson: parsedManifest,
      modelsText: typeof body.modelsText === 'string' ? body.modelsText.slice(0, 6000) : '',
      probeResult,
    });

    const snippets = generatePlatformIntegrationSnippets({
      apiBaseUrl: new URL(ctx.request.url).origin,
      appUid: 'app_generated_on_connect',
      apiKey: 'aegis_live_ISSUED_ON_CONNECT',
      platform: report.platform,
      packageName: sanitizeText(body.packageOrDomain, 180) || 'com.cyberking.candymindmatch',
      collections: report.proposedCollections.map((c) => ({ slug: c.slug, name: c.name })),
    });

    return jsonResponse({ report, snippets });
  });

  // ---- 2. FULL DEDICATED PER-APP WORKSPACE STATE ----
  router.get('/api/apps/:id/workspace', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const [
      modulesList,
      collectionsList,
      recordCounts,
      keysList,
      endUsersList,
      flagsList,
      releasesList,
      adsList,
      filesList,
      webhooksList,
      backupsList,
      recentEventsList,
      txSummary,
      announcementsList,
      remoteConfigRows,
      heartbeatsList,
    ] = await Promise.all([
      ctx.db.select().from(appModules).where(eq(appModules.appId, appId)).orderBy(desc(appModules.updatedAt)),
      ctx.db.select().from(appCollections).where(eq(appCollections.appId, appId)).orderBy(appCollections.name),
      ctx.db
        .select({
          collectionId: appRecords.collectionId,
          count: sql<number>`cast(count(*) as integer)`,
        })
        .from(appRecords)
        .where(eq(appRecords.appId, appId))
        .groupBy(appRecords.collectionId),
      ctx.db
        .select({
          id: appApiKeys.id,
          appId: appApiKeys.appId,
          name: appApiKeys.name,
          keyPrefix: appApiKeys.keyPrefix,
          scopes: appApiKeys.scopes,
          isActive: appApiKeys.isActive,
          lastUsedAt: appApiKeys.lastUsedAt,
          expiresAt: appApiKeys.expiresAt,
          createdAt: appApiKeys.createdAt,
        })
        .from(appApiKeys)
        .where(eq(appApiKeys.appId, appId))
        .orderBy(desc(appApiKeys.createdAt)),
      ctx.db.select().from(appUsers).where(eq(appUsers.appId, appId)).orderBy(desc(appUsers.lastActiveAt)).limit(50),
      ctx.db.select().from(featureFlags).where(eq(featureFlags.appId, appId)).orderBy(featureFlags.key),
      ctx.db.select().from(appReleases).where(eq(appReleases.appId, appId)).orderBy(desc(appReleases.createdAt)).limit(20),
      ctx.db.select().from(adConfigs).where(eq(adConfigs.appId, appId)),
      ctx.db
        .select({
          id: files.id,
          originalName: files.originalName,
          mimeType: files.mimeType,
          sizeBytes: files.sizeBytes,
          category: files.category,
          storageNamespace: files.storageNamespace,
          checksumSha256: files.checksumSha256,
          createdAt: files.createdAt,
        })
        .from(files)
        .where(and(eq(files.appId, appId), sql`${files.deletedAt} IS NULL`))
        .orderBy(desc(files.createdAt))
        .limit(50),
      ctx.db
        .select({
          id: webhooks.id,
          appId: webhooks.appId,
          name: webhooks.name,
          targetUrl: webhooks.targetUrl,
          events: webhooks.events,
          isActive: webhooks.isActive,
          lastStatusCode: webhooks.lastStatusCode,
          lastTriggeredAt: webhooks.lastTriggeredAt,
        })
        .from(webhooks)
        .where(eq(webhooks.appId, appId)),
      ctx.db
        .select({
          id: backups.id,
          filename: backups.filename,
          status: backups.status,
          sizeBytes: backups.sizeBytes,
          rowCount: backups.rowCount,
          checksumSha256: backups.checksumSha256,
          createdAt: backups.createdAt,
        })
        .from(backups)
        .where(eq(backups.appId, appId))
        .orderBy(desc(backups.createdAt))
        .limit(15),
      ctx.db.select().from(appEvents).where(eq(appEvents.appId, appId)).orderBy(desc(appEvents.createdAt)).limit(40),
      ctx.db
        .select({
          revenueCents: sql<number>`cast(coalesce(sum(case when status = 'succeeded' and type = 'payment' then amount_cents else 0 end), 0) as integer)`,
          txCount: sql<number>`cast(count(*) as integer)`,
        })
        .from(transactions)
        .where(eq(transactions.appId, appId)),
      ctx.db
        .select()
        .from(appAnnouncements)
        .where(eq(appAnnouncements.appId, appId))
        .orderBy(desc(appAnnouncements.priority), desc(appAnnouncements.createdAt)),
      ctx.db.select().from(appRemoteConfigs).where(eq(appRemoteConfigs.appId, appId)).limit(1),
      ctx.db
        .select()
        .from(appHeartbeats)
        .where(eq(appHeartbeats.appId, appId))
        .orderBy(desc(appHeartbeats.lastSeenAt), desc(appHeartbeats.id))
        .limit(40),
    ]);

    const recCountMap = new Map(recordCounts.map((r) => [r.collectionId, Number(r.count)]));
    const enrichedCollections = collectionsList.map((c) => ({
      ...c,
      recordCount: recCountMap.get(c.id) ?? 0,
    }));

    const pkg = app.packageName || app.packageOrDomain;
    const namespace = app.backendNamespace || buildBackendNamespace(app.slug, app.appUid);
    const snippets = generatePlatformIntegrationSnippets({
      apiBaseUrl: new URL(ctx.request.url).origin,
      appUid: app.appUid,
      apiKey: keysList.find((k) => k.isActive)?.keyPrefix
        ? `${keysList.find((k) => k.isActive)!.keyPrefix}...`
        : 'aegis_live_YOUR_API_KEY',
      platform: app.platform,
      packageName: pkg,
      collections: enrichedCollections.map((c) => ({ slug: c.slug, name: c.name })),
    });

    const remoteConfig = buildRemoteConfigPayload({
      app,
      remoteConfig: remoteConfigRows[0] ?? null,
      flags: flagsList.map((f) => ({
        key: f.key,
        isEnabled: f.isEnabled,
        rolloutPercentage: f.rolloutPercentage,
        appId: f.appId,
      })),
      latestRelease: releasesList[0] ?? null,
    });

    return jsonResponse({
      app: {
        ...app,
        backendNamespace: namespace,
        webhookSecret: undefined,
        hasWebhookSecret: Boolean(app.webhookSecret),
      },
      stats: {
        endUsersCount: endUsersList.length,
        activeUsersCount: endUsersList.filter((u) => u.status === 'active').length,
        bannedUsersCount: endUsersList.filter((u) => u.status === 'banned').length,
        collectionsCount: enrichedCollections.length,
        modulesCount: modulesList.length,
        filesCount: filesList.length,
        activeKeysCount: keysList.filter((k) => k.isActive).length,
        announcementsCount: announcementsList.length,
        heartbeatsCount: heartbeatsList.length,
        revenueCents: Number(txSummary[0]?.revenueCents ?? 0),
        txCount: Number(txSummary[0]?.txCount ?? 0),
        adRevenueCents: adsList.reduce((s, a) => s + a.revenueCents, 0),
      },
      modules: modulesList,
      collections: enrichedCollections,
      keys: keysList,
      endUsers: endUsersList,
      flags: flagsList.map((f) => ({
        ...f,
        key: f.key.replace(new RegExp(`@app${appId}$`), ''),
      })),
      releases: releasesList,
      ads: adsList,
      files: filesList,
      webhooks: webhooksList,
      backups: backupsList,
      recentEvents: recentEventsList,
      announcements: announcementsList.map((a) => formatAnnouncementRow(a, pkg)),
      remoteConfig,
      heartbeats: heartbeatsList.map((hb) => ({
        id: hb.id,
        appId: hb.appId,
        package_name: hb.packageName,
        version_name: hb.versionName,
        version_code: hb.versionCode,
        platform: hb.platform,
        status: hb.status,
        event: hb.event,
        payload: hb.payloadJson,
        ip_address: hb.ipAddress,
        last_seen_at: new Date(hb.lastSeenAt).toISOString(),
      })),
      integrationSnippets: snippets,
    });
  });

  // ---- 3. DYNAMIC CUSTOM BACKEND & MODULE GENERATOR ----
  router.post('/api/apps/:id/modules/generate', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      name?: string;
      moduleKey?: string;
      category?: string;
      description?: string;
      createCollection?: boolean;
      collectionSlug?: string;
      fields?: CollectionFieldSpec[];
    }>(ctx.request);

    const name = sanitizeText(body.name, 100);
    if (!name) return errorResponse(400, 'Module name is required.');

    const moduleKey = cleanCollectionSlug(body.moduleKey || name);
    const collectionSlug = cleanCollectionSlug(body.collectionSlug || moduleKey);
    const namespace = app.backendNamespace || buildBackendNamespace(app.slug, app.appUid);
    const fields = parseCollectionFields(body.fields);
    const finalFields: CollectionFieldSpec[] =
      fields.length > 0
        ? fields
        : [
            { name: 'title', label: 'Title', type: 'text', required: true },
            { name: 'value', label: 'Value', type: 'text', required: false },
            { name: 'active', label: 'Active', type: 'boolean', required: false },
          ];

    const migrationSql = generateCollectionMigrationSql(namespace, collectionSlug, finalFields);
    const snippets = generatePlatformIntegrationSnippets({
      apiBaseUrl: new URL(ctx.request.url).origin,
      appUid: app.appUid,
      apiKey: 'aegis_live_YOUR_API_KEY',
      platform: app.platform,
      collections: [{ slug: collectionSlug, name }],
    });
    const generatedCode =
      app.platform === 'unity' || app.platform === 'game'
        ? snippets.unity
        : app.platform === 'android'
          ? snippets.android
          : app.platform === 'ios'
            ? snippets.ios
            : snippets.website;

    let createdCollection: typeof appCollections.$inferSelect | null = null;
    if (body.createCollection !== false) {
      const colRows = await ctx.db
        .insert(appCollections)
        .values({
          appId,
          slug: collectionSlug,
          name,
          description: sanitizeText(body.description || `Isolated collection for ${name}`, 300),
          fieldsJson: finalFields,
          permissionsJson: { read: 'sdk', write: 'sdk' },
          migrationSql,
          createdBy: ctx.adminUser!.id,
        })
        .onConflictDoUpdate({
          target: [appCollections.appId, appCollections.slug],
          set: {
            name,
            fieldsJson: finalFields,
            migrationSql,
            updatedAt: new Date(),
          },
        })
        .returning();
      createdCollection = colRows[0];
    }

    const endpoints = [
      { method: 'GET', path: `/api/v1/sdk/data/${collectionSlug}`, scope: 'data:read' },
      { method: 'POST', path: `/api/v1/sdk/data/${collectionSlug}`, scope: 'data:write' },
      { method: 'PATCH', path: `/api/v1/sdk/data/${collectionSlug}/:recordUid`, scope: 'data:write' },
      { method: 'DELETE', path: `/api/v1/sdk/data/${collectionSlug}/:recordUid`, scope: 'data:write' },
    ];

    const modRows = await ctx.db
      .insert(appModules)
      .values({
        appId,
        moduleKey,
        name,
        category: sanitizeText(body.category || 'custom', 40) || 'custom',
        status: 'active',
        configJson: { collectionSlug, description: sanitizeText(body.description || '', 300) },
        generatedCode,
        migrationSql,
        apiEndpoints: endpoints,
        uiSchema: { fields: finalFields },
        createdBy: ctx.adminUser!.id,
      })
      .onConflictDoUpdate({
        target: [appModules.appId, appModules.moduleKey],
        set: {
          name,
          generatedCode,
          migrationSql,
          apiEndpoints: endpoints,
          uiSchema: { fields: finalFields },
          updatedAt: new Date(),
        },
      })
      .returning();

    const currentEnabled = Array.isArray(app.enabledModules) ? app.enabledModules : [];
    const nextEnabled = Array.from(new Set([...currentEnabled, 'collections', moduleKey]));
    await ctx.db
      .update(connectedApps)
      .set({
        backendNamespace: namespace,
        enabledModules: nextEnabled,
        updatedAt: new Date(),
      })
      .where(eq(connectedApps.id, appId));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'apps.module_generated',
      module: 'apps',
      targetType: 'app_module',
      targetId: modRows[0].id,
      details: { appId, moduleKey, collectionSlug, fieldsCount: finalFields.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse(
      {
        module: modRows[0],
        collection: createdCollection,
        migrationSql,
        generatedCode,
        endpoints,
      },
      201
    );
  });

  router.delete('/api/apps/:id/modules/:moduleId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const moduleId = Number(ctx.params.moduleId);
    await ctx.db
      .delete(appModules)
      .where(and(eq(appModules.id, moduleId), eq(appModules.appId, appId)));
    return jsonResponse({ deleted: true });
  });

  // ---- 4. ISOLATED PER-APP COLLECTIONS & RECORD CRUD (ADMIN) ----
  router.get('/api/apps/:id/collections', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const cols = await ctx.db
      .select()
      .from(appCollections)
      .where(eq(appCollections.appId, appId))
      .orderBy(appCollections.name);

    return jsonResponse({ data: cols });
  });

  router.post('/api/apps/:id/collections', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const body = await readJsonBody<{
      slug?: string;
      name?: string;
      description?: string;
      fields?: CollectionFieldSpec[];
    }>(ctx.request);

    const name = sanitizeText(body.name, 100);
    const slug = cleanCollectionSlug(body.slug || name);
    if (!name || !slug) {
      return errorResponse(400, 'Collection name and valid slug are required.');
    }

    const fields = parseCollectionFields(body.fields);
    const finalFields: CollectionFieldSpec[] =
      fields.length > 0 ? fields : [{ name: 'name', label: 'Name', type: 'text', required: true }];
    const namespace = app.backendNamespace || buildBackendNamespace(app.slug, app.appUid);
    const migrationSql = generateCollectionMigrationSql(namespace, slug, finalFields);

    const inserted = await ctx.db
      .insert(appCollections)
      .values({
        appId,
        slug,
        name,
        description: sanitizeText(body.description || '', 300),
        fieldsJson: finalFields,
        permissionsJson: { read: 'sdk', write: 'sdk' },
        migrationSql,
        createdBy: ctx.adminUser!.id,
      })
      .onConflictDoUpdate({
        target: [appCollections.appId, appCollections.slug],
        set: {
          name,
          description: sanitizeText(body.description || '', 300),
          fieldsJson: finalFields,
          migrationSql,
          updatedAt: new Date(),
        },
      })
      .returning();

    return jsonResponse({ collection: inserted[0] }, 201);
  });

  router.delete('/api/apps/:id/collections/:collectionId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const collectionId = Number(ctx.params.collectionId);
    await ctx.db
      .delete(appCollections)
      .where(and(eq(appCollections.id, collectionId), eq(appCollections.appId, appId)));
    return jsonResponse({ deleted: true });
  });

  router.get('/api/apps/:id/collections/:slug/records', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.read');
    if (permFail) return permFail;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, appId), eq(appCollections.slug, slug)))
      .limit(1);
    const col = colRows[0];
    if (!col) return errorResponse(404, 'Collection not found for this application.');

    const rows = await ctx.db
      .select()
      .from(appRecords)
      .where(and(eq(appRecords.appId, appId), eq(appRecords.collectionId, col.id)))
      .orderBy(desc(appRecords.updatedAt))
      .limit(200);

    const format = sanitizeText(ctx.url.searchParams.get('format') || '', 10).toLowerCase();
    if (format === 'csv') {
      const csvRows = rows.map((r) => ({
        recordUid: r.recordUid,
        updatedAt: new Date(r.updatedAt).toISOString(),
        ...(r.dataJson as Record<string, unknown>),
      }));
      const fieldNames = Array.isArray(col.fieldsJson)
        ? (col.fieldsJson as Array<{ name: string }>).map((f) => f.name)
        : [];
      const extraKeys = new Set<string>();
      for (const row of csvRows) {
        for (const k of Object.keys(row)) extraKeys.add(k);
      }
      const headers = Array.from(new Set(['recordUid', 'updatedAt', ...fieldNames, ...extraKeys]));
      return new Response(toCsv(headers, csvRows), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="app-${appId}-${slug}.csv"`,
        },
      });
    }

    return jsonResponse({ collection: col, data: rows });
  });

  router.post('/api/apps/:id/collections/:slug/records', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, appId), eq(appCollections.slug, slug)))
      .limit(1);
    const col = colRows[0];
    if (!col) return errorResponse(404, 'Collection not found for this application.');

    const body = await readJsonBody<{ recordUid?: string; data?: Record<string, unknown> }>(ctx.request);
    const data = body.data && typeof body.data === 'object' ? body.data : {};
    const recordUid = sanitizeText(body.recordUid || '', 80) || generateUid('rec');

    const saved = await ctx.db
      .insert(appRecords)
      .values({
        appId,
        collectionId: col.id,
        recordUid,
        dataJson: data,
        createdByUserId: ctx.adminUser!.id,
      })
      .onConflictDoUpdate({
        target: [appRecords.collectionId, appRecords.recordUid],
        set: { dataJson: data, updatedAt: new Date() },
      })
      .returning();

    return jsonResponse({ record: saved[0] }, 201);
  });

  router.patch('/api/apps/:id/collections/:slug/records/:recordId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const recordId = Number(ctx.params.recordId);
    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, appId), eq(appCollections.slug, slug)))
      .limit(1);
    if (!colRows[0]) return errorResponse(404, 'Collection not found for this application.');

    const body = await readJsonBody<{ data?: Record<string, unknown> }>(ctx.request);
    const updated = await ctx.db
      .update(appRecords)
      .set({
        dataJson: body.data && typeof body.data === 'object' ? body.data : {},
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appRecords.id, recordId),
          eq(appRecords.appId, appId),
          eq(appRecords.collectionId, colRows[0].id)
        )
      )
      .returning();

    if (!updated[0]) return errorResponse(404, 'Record not found in this app collection.');
    return jsonResponse({ record: updated[0] });
  });

  router.delete('/api/apps/:id/collections/:slug/records/:recordId', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const recordId = Number(ctx.params.recordId);
    await ctx.db
      .delete(appRecords)
      .where(and(eq(appRecords.id, recordId), eq(appRecords.appId, appId)));
    return jsonResponse({ deleted: true });
  });

  // ---- 5. REAL CONTROL SYNC (PUSH CONFIG TO EXTERNAL BACKEND + WEBHOOKS) ----
  router.post('/api/apps/:id/control-sync', async (ctx: WorkerContext) => {
    const appId = Number(ctx.params.id);
    const permFail = await requireAppAccess(ctx, appId, 'apps.manage');
    if (permFail) return permFail;

    const appRows = await ctx.db.select().from(connectedApps).where(eq(connectedApps.id, appId)).limit(1);
    const app = appRows[0];
    if (!app) return errorResponse(404, 'Connected app not found.');

    const flags = await ctx.db.select().from(featureFlags).where(eq(featureFlags.appId, appId));
    const syncPayload = {
      appUid: app.appUid,
      status: app.status,
      maintenanceMode: app.status === 'maintenance',
      maintenanceMessage: app.maintenanceMessage,
      currentVersion: app.currentVersion,
      minSupportedVersion: app.minSupportedVersion,
      forceUpdate: app.forceUpdate,
      adsEnabled: app.adsEnabled,
      featureFlags: Object.fromEntries(
        flags.map((f) => [f.key.replace(new RegExp(`@app${appId}$`), ''), f.isEnabled])
      ),
      syncedAt: new Date().toISOString(),
    };

    let syncStatus = app.integrationMode === 'aegis_managed' ? 'verified' : 'partial';
    let externalSyncResult: { attempted: boolean; statusCode: number | null; ok: boolean; message: string } = {
      attempted: false,
      statusCode: null,
      ok: app.integrationMode === 'aegis_managed',
      message:
        app.integrationMode === 'aegis_managed'
          ? 'Aegis-managed isolated backend state & SDK config updated immediately.'
          : 'No external backend sync URL configured; state saved in Aegis & dispatched to webhooks.',
    };

    if (app.backendBaseUrl) {
      if (!isSafePublicUrl(app.backendBaseUrl)) {
        syncStatus = 'sync_failed';
        externalSyncResult = {
          attempted: true,
          statusCode: null,
          ok: false,
          message: 'Blocked non-public or invalid external backendBaseUrl.',
        };
      } else {
        try {
          const bodyStr = JSON.stringify(syncPayload);
          const signature = await computeHmacSha256(app.webhookSecret, bodyStr);
          const target = `${app.backendBaseUrl.replace(/\/+$/, '')}/aegis/sync`;
          const resp = await fetch(target, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Aegis-App-Id': app.appUid,
              'X-Aegis-Signature': `sha256=${signature}`,
            },
            body: bodyStr,
            signal: AbortSignal.timeout(6000),
          });
          syncStatus = resp.ok ? 'verified' : 'sync_failed';
          externalSyncResult = {
            attempted: true,
            statusCode: resp.status,
            ok: resp.ok,
            message: resp.ok
              ? `External backend acknowledged sync (HTTP ${resp.status}).`
              : `External backend rejected or missing sync endpoint (HTTP ${resp.status}). Remote full control is not guaranteed.`,
          };
        } catch (err) {
          syncStatus = 'sync_failed';
          externalSyncResult = {
            attempted: true,
            statusCode: null,
            ok: false,
            message: err instanceof Error ? err.message : 'External sync request failed.',
          };
        }
      }
    }

    await ctx.db
      .update(connectedApps)
      .set({ syncStatus, updatedAt: new Date() })
      .where(eq(connectedApps.id, appId));

    await dispatchWebhooksForEvent(ctx, appId, 'app.config_synced', syncPayload, app.appUid);

    return jsonResponse({ syncStatus, externalSyncResult, payload: syncPayload });
  });

  // ---- 6. PUBLIC APP SDK ISOLATED DATA & STORAGE ENDPOINTS (/api/v1/sdk/*) ----
  router.get('/api/v1/sdk/data/:slug', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'data:read');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, app.id), eq(appCollections.slug, slug)))
      .limit(1);
    const col = colRows[0];
    if (!col) {
      return errorResponse(404, `Collection "${slug}" does not exist on this application.`, {
        code: 'COLLECTION_NOT_FOUND',
        appUid: app.appUid,
      });
    }

    const rows = await ctx.db
      .select()
      .from(appRecords)
      .where(and(eq(appRecords.appId, app.id), eq(appRecords.collectionId, col.id)))
      .orderBy(desc(appRecords.updatedAt))
      .limit(200);

    const publishedFilter = ctx.url.searchParams.get('published');
    const categoryFilter = sanitizeText(ctx.url.searchParams.get('category') || '', 60).toLowerCase();
    const qFilter = sanitizeText(ctx.url.searchParams.get('q') || '', 80).toLowerCase();

    const filteredRows = rows.filter((r) => {
      const data = (r.dataJson || {}) as Record<string, unknown>;
      if (publishedFilter === 'true') {
        const isPub = data.published === true || String(data.status || '').toLowerCase() === 'published';
        if (!isPub) return false;
      } else if (publishedFilter === 'false') {
        const isPub = data.published === true || String(data.status || '').toLowerCase() === 'published';
        if (isPub) return false;
      }
      if (categoryFilter && String(data.category || '').toLowerCase() !== categoryFilter) {
        return false;
      }
      if (qFilter) {
        const serialized = JSON.stringify(data).toLowerCase();
        if (!serialized.includes(qFilter)) return false;
      }
      return true;
    });

    return jsonResponse({
      appUid: app.appUid,
      collection: { slug: col.slug, name: col.name, fields: col.fieldsJson },
      records: filteredRows.slice(0, 100).map((r) => ({
        id: r.id,
        recordUid: r.recordUid,
        data: r.dataJson,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
    });
  });

  router.post('/api/v1/sdk/data/:slug', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'data:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, app.id), eq(appCollections.slug, slug)))
      .limit(1);
    const col = colRows[0];
    if (!col) {
      return errorResponse(404, `Collection "${slug}" does not exist on this application.`, {
        code: 'COLLECTION_NOT_FOUND',
      });
    }

    const body = await readJsonBody<{ recordUid?: string; data?: Record<string, unknown> }>(ctx.request);
    if (!body.data || typeof body.data !== 'object' || Array.isArray(body.data)) {
      return errorResponse(400, 'JSON object "data" payload is required.');
    }

    const recordUid = sanitizeText(body.recordUid || '', 80) || generateUid('rec');
    const saved = await ctx.db
      .insert(appRecords)
      .values({
        appId: app.id,
        collectionId: col.id,
        recordUid,
        dataJson: body.data,
      })
      .onConflictDoUpdate({
        target: [appRecords.collectionId, appRecords.recordUid],
        set: { dataJson: body.data, updatedAt: new Date() },
      })
      .returning();

    return jsonResponse(
      {
        record: {
          id: saved[0].id,
          recordUid: saved[0].recordUid,
          data: saved[0].dataJson,
          createdAt: saved[0].createdAt,
          updatedAt: saved[0].updatedAt,
        },
      },
      201
    );
  });

  router.patch('/api/v1/sdk/data/:slug/:recordUid', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'data:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const recordUid = sanitizeText(ctx.params.recordUid || '', 80);
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, app.id), eq(appCollections.slug, slug)))
      .limit(1);
    if (!colRows[0]) return errorResponse(404, `Collection "${slug}" not found.`);

    const body = await readJsonBody<{ data?: Record<string, unknown> }>(ctx.request);
    const updated = await ctx.db
      .update(appRecords)
      .set({
        dataJson: body.data && typeof body.data === 'object' ? body.data : {},
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(appRecords.appId, app.id),
          eq(appRecords.collectionId, colRows[0].id),
          eq(appRecords.recordUid, recordUid)
        )
      )
      .returning();

    if (!updated[0]) return errorResponse(404, 'Record not found.');
    return jsonResponse({ record: updated[0] });
  });

  router.delete('/api/v1/sdk/data/:slug/:recordUid', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'data:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const slug = cleanCollectionSlug(ctx.params.slug || '');
    const recordUid = sanitizeText(ctx.params.recordUid || '', 80);
    const colRows = await ctx.db
      .select()
      .from(appCollections)
      .where(and(eq(appCollections.appId, app.id), eq(appCollections.slug, slug)))
      .limit(1);
    if (!colRows[0]) return errorResponse(404, `Collection "${slug}" not found.`);

    await ctx.db
      .delete(appRecords)
      .where(
        and(
          eq(appRecords.appId, app.id),
          eq(appRecords.collectionId, colRows[0].id),
          eq(appRecords.recordUid, recordUid)
        )
      );
    return jsonResponse({ deleted: true });
  });

  router.get('/api/v1/sdk/storage/files', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'data:read');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const rows = await ctx.db
      .select({
        id: files.id,
        originalName: files.originalName,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        storageNamespace: files.storageNamespace,
        checksumSha256: files.checksumSha256,
        createdAt: files.createdAt,
      })
      .from(files)
      .where(and(eq(files.appId, app.id), sql`${files.deletedAt} IS NULL`))
      .orderBy(desc(files.createdAt))
      .limit(100);

    return jsonResponse({ appUid: app.appUid, data: rows });
  });

  router.post('/api/v1/sdk/storage/files', async (ctx: WorkerContext) => {
    const auth = await authenticateSdkRequest(ctx, 'storage:write');
    if (!auth.ok) return auth.response;
    const { app } = auth;

    const body = await readJsonBody<{
      filename?: string;
      mimeType?: string;
      base64Data?: string;
      isPublic?: boolean;
    }>(ctx.request);

    const originalName = sanitizeText(body.filename, 140).replace(/[^A-Za-z0-9._-]/g, '_');
    const mimeType = sanitizeText(body.mimeType, 80);
    const rawBase64 = typeof body.base64Data === 'string' ? body.base64Data.replace(/^data:[^;]+;base64,/, '') : '';

    if (!originalName || !rawBase64) {
      return errorResponse(400, 'filename and base64Data are required.');
    }
    if (!ALLOWED_SDK_FILE_MIMES.has(mimeType)) {
      return errorResponse(400, `Unsupported MIME type "${mimeType}".`);
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(rawBase64);
    } catch {
      return errorResponse(400, 'Invalid base64Data payload.');
    }

    if (bytes.byteLength > 750 * 1024) {
      return errorResponse(400, 'File exceeds 750 KB D1 inline storage limit.');
    }

    const storageNamespace = app.backendNamespace || `app_${app.slug}`;
    const storedName = `${Date.now()}-${originalName}`;
    const checksumSha256 = await computeSha256(bytes);
    const category = mimeType.startsWith('image/')
      ? 'image'
      : mimeType === 'application/pdf' || mimeType.startsWith('text/')
        ? 'document'
        : 'other';

    const created = await ctx.db
      .insert(files)
      .values({
        appId: app.id,
        storageNamespace,
        filename: storedName,
        originalName,
        mimeType,
        sizeBytes: bytes.byteLength,
        category,
        storagePath: `d1://${storageNamespace}/${storedName}`,
        contentBase64: rawBase64,
        checksumSha256,
        isPublic: Boolean(body.isPublic),
      })
      .returning({
        id: files.id,
        appId: files.appId,
        storageNamespace: files.storageNamespace,
        originalName: files.originalName,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        checksumSha256: files.checksumSha256,
        createdAt: files.createdAt,
      });

    return jsonResponse({ file: created[0] }, 201);
  });
}
