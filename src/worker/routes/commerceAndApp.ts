import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  adConfigs,
  appReleases,
  connectedApps,
  featureFlags,
  systemSettings,
  transactions,
} from '../../db/schema.ts';
import { toCsv } from '../../lib/csv.ts';
import { sanitizeText } from '../../lib/security.ts';
import { parsePaginationQuery } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requireAppAccess, requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

function parseOptionalAppId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function registerCommerceAndAppRoutes(router: WorkerRouter): void {
  // ---- MODULE F: FINANCIAL MANAGEMENT ----
  router.get('/api/finance/transactions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['createdAt', 'amountCents', 'status'], 'createdAt');
    const statusFilter = sanitizeText(q.status || 'all', 20);
    const typeFilter = sanitizeText(q.type || 'all', 20);
    const appIdFilter = parseOptionalAppId(q.appId);

    const conditions: SQL[] = [];
    if (appIdFilter) conditions.push(eq(transactions.appId, appIdFilter));
    if (statusFilter !== 'all') {
      if (statusFilter === 'fraud') {
        conditions.push(sql`(${transactions.status} = 'flagged' OR ${transactions.fraudScore} >= 70)`);
      } else {
        conditions.push(eq(transactions.status, statusFilter));
      }
    }
    if (typeFilter !== 'all' && ['payment', 'payout', 'refund'].includes(typeFilter)) {
      conditions.push(eq(transactions.type, typeFilter));
    }
    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(sql`lower(${transactions.reference}) LIKE ${pattern}`);
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const summaryWhere = appIdFilter ? eq(transactions.appId, appIdFilter) : undefined;
    const [totalRows, rows, allTxRows, apps] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`cast(count(*) as integer)` })
        .from(transactions)
        .where(whereClause),
      ctx.db
        .select()
        .from(transactions)
        .where(whereClause)
        .orderBy(desc(transactions.createdAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      ctx.db
        .select({
          amountCents: transactions.amountCents,
          type: transactions.type,
          status: transactions.status,
          fraudScore: transactions.fraudScore,
        })
        .from(transactions)
        .where(summaryWhere),
      ctx.db.select({ id: connectedApps.id, name: connectedApps.name }).from(connectedApps),
    ]);

    const appNameById = new Map(apps.map((a) => [a.id, a.name]));

    const summary = {
      succeededCents: allTxRows
        .filter((t) => t.status === 'succeeded' && t.type === 'payment')
        .reduce((a, b) => a + b.amountCents, 0),
      refundedCents: allTxRows
        .filter((t) => t.status === 'refunded' || t.type === 'refund')
        .reduce((a, b) => a + b.amountCents, 0),
      payoutsCents: allTxRows
        .filter((t) => t.type === 'payout' && t.status === 'succeeded')
        .reduce((a, b) => a + b.amountCents, 0),
      failedCount: allTxRows.filter((t) => t.status === 'failed').length,
      flaggedCount: allTxRows.filter((t) => t.status === 'flagged' || t.fraudScore >= 70).length,
    };

    return jsonResponse({
      data: rows.map((r) => ({
        ...r,
        appName: r.appId ? (appNameById.get(r.appId) ?? null) : null,
      })),
      total: Number(totalRows[0]?.total ?? 0),
      summary,
    });
  });

  router.get('/api/finance/export.csv', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const rows = await ctx.db
      .select()
      .from(transactions)
      .where(appIdFilter ? eq(transactions.appId, appIdFilter) : undefined)
      .orderBy(desc(transactions.createdAt))
      .limit(1000);

    const csv = toCsv(
      ['id', 'reference', 'appId', 'type', 'status', 'amountCents', 'currency', 'paymentMethodLabel', 'fraudScore', 'createdAt'],
      rows.map((r) => ({
        id: r.id,
        reference: r.reference,
        appId: r.appId ?? 'global',
        type: r.type,
        status: r.status,
        amountCents: r.amountCents,
        currency: r.currency,
        paymentMethodLabel: r.paymentMethodLabel,
        fraudScore: r.fraudScore,
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    );

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'finance.exported_csv',
      module: 'finance',
      details: { appId: appIdFilter, count: rows.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-transactions-export.csv"',
      },
    });
  });

  router.get('/api/finance/export.json', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const rows = await ctx.db
      .select()
      .from(transactions)
      .where(appIdFilter ? eq(transactions.appId, appIdFilter) : undefined)
      .orderBy(desc(transactions.createdAt))
      .limit(1000);

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'finance.exported_json',
      module: 'finance',
      details: { appId: appIdFilter, count: rows.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return new Response(JSON.stringify({ exportedAt: new Date().toISOString(), count: rows.length, transactions: rows }, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-transactions-export.json"',
      },
    });
  });

  router.post('/api/finance/transactions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      appId?: number | null;
      amountCents?: number;
      currency?: string;
      type?: string;
      status?: string;
      paymentMethodLabel?: string;
      userId?: number;
      fraudScore?: number;
      failureReason?: string;
    }>(ctx.request);

    const amountCents = Math.round(Number(body.amountCents));
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      return errorResponse(400, 'Amount in cents must be a positive integer.');
    }

    const appId = parseOptionalAppId(body.appId);
    const reference = `TX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created = await ctx.db
      .insert(transactions)
      .values({
        appId,
        reference,
        userId: body.userId ? Number(body.userId) : ctx.adminUser!.id,
        amountCents,
        currency: sanitizeText(body.currency || 'USD', 8).toUpperCase(),
        type: ['payment', 'refund', 'payout'].includes(body.type || '') ? body.type! : 'payment',
        status: ['succeeded', 'pending', 'failed', 'refunded', 'flagged'].includes(body.status || '')
          ? body.status!
          : 'succeeded',
        paymentMethodLabel: sanitizeText(body.paymentMethodLabel || 'Manual Ledger Entry', 64),
        failureReason: sanitizeText(body.failureReason || '', 240),
        fraudScore: Math.min(100, Math.max(0, Number(body.fraudScore) || 0)),
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'finance.transaction_recorded',
      module: 'finance',
      targetType: 'transaction',
      targetId: created[0].id,
      details: { reference, amountCents, type: created[0].type, appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ transaction: created[0] }, 201);
  });

  router.post('/api/finance/transactions/:id/refund', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.manage');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    if (!existing[0]) return errorResponse(404, 'Transaction not found.');

    const updated = await ctx.db
      .update(transactions)
      .set({ status: 'refunded' })
      .where(eq(transactions.id, id))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'finance.refund_processed',
      module: 'finance',
      targetType: 'transaction',
      targetId: id,
      details: { reference: existing[0].reference, amountCents: existing[0].amountCents },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ transaction: updated[0] });
  });

  // ---- MODULE G: ADVERTISEMENT MANAGEMENT ----
  router.get('/api/ads', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'ads.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const [rows, apps] = await Promise.all([
      ctx.db
        .select()
        .from(adConfigs)
        .where(appIdFilter ? eq(adConfigs.appId, appIdFilter) : undefined)
        .orderBy(desc(adConfigs.updatedAt)),
      ctx.db.select({ id: connectedApps.id, name: connectedApps.name, admobAppId: connectedApps.admobAppId }).from(connectedApps),
    ]);
    const appMap = new Map(apps.map((a) => [a.id, a]));
    return jsonResponse({
      data: rows.map((r) => ({
        ...r,
        appName: r.appId ? (appMap.get(r.appId)?.name ?? null) : null,
      })),
    });
  });

  router.post('/api/ads', async (ctx: WorkerContext) => {
    const body = await readJsonBody<{
      appId?: number | null;
      name?: string;
      network?: string;
      adFormat?: string;
      placement?: string;
      admobUnitId?: string;
      ecpmCents?: number;
      frequencyCap?: number;
      isEnabled?: boolean;
      visibilityRule?: string;
      errorMessage?: string;
    }>(ctx.request);

    const appId = parseOptionalAppId(body.appId);
    const permFail = appId
      ? await requireAppAccess(ctx, appId, ['ads.manage', 'apps.manage'])
      : await requirePermission(ctx, 'ads.manage');
    if (permFail) return permFail;

    const name = sanitizeText(body.name, 100);
    const network = sanitizeText(body.network, 60);
    const placement = sanitizeText(body.placement, 80);
    if (!name || !network || !placement) {
      return errorResponse(400, 'Ad configuration name, network, and placement are required.');
    }
    const created = await ctx.db
      .insert(adConfigs)
      .values({
        appId,
        name,
        network,
        adFormat: ['banner', 'interstitial', 'rewarded', 'native'].includes(body.adFormat || '')
          ? body.adFormat!
          : 'banner',
        placement,
        admobUnitId: sanitizeText(body.admobUnitId, 120),
        ecpmCents: Math.max(0, Math.round(Number(body.ecpmCents) || 0)),
        frequencyCap: Math.max(1, Number(body.frequencyCap) || 3),
        isEnabled: Boolean(body.isEnabled),
        visibilityRule: sanitizeText(body.visibilityRule || 'all_users', 80),
        errorMessage: sanitizeText(body.errorMessage, 240),
        updatedBy: ctx.adminUser!.id,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'ads.config_created',
      module: 'ads',
      targetType: 'ad_config',
      targetId: created[0].id,
      details: { name, network, placement, appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ adConfig: created[0] }, 201);
  });

  router.patch('/api/ads/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(adConfigs).where(eq(adConfigs.id, id)).limit(1);
    if (!existing[0]) {
      const permFail = await requirePermission(ctx, 'ads.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Ad configuration not found.');
    }
    const permFail = existing[0].appId
      ? await requireAppAccess(ctx, existing[0].appId, ['ads.manage', 'apps.manage'])
      : await requirePermission(ctx, 'ads.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      placement?: string;
      admobUnitId?: string;
      ecpmCents?: number;
      isEnabled?: boolean;
      frequencyCap?: number;
      visibilityRule?: string;
      errorMessage?: string;
    }>(ctx.request);
    const updated = await ctx.db
      .update(adConfigs)
      .set({
        name: body.name !== undefined ? sanitizeText(body.name, 100) || existing[0].name : existing[0].name,
        placement:
          body.placement !== undefined
            ? sanitizeText(body.placement, 80) || existing[0].placement
            : existing[0].placement,
        admobUnitId:
          body.admobUnitId !== undefined
            ? sanitizeText(body.admobUnitId, 120)
            : existing[0].admobUnitId,
        ecpmCents:
          body.ecpmCents !== undefined
            ? Math.max(0, Math.round(Number(body.ecpmCents) || 0))
            : existing[0].ecpmCents,
        isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : existing[0].isEnabled,
        frequencyCap: body.frequencyCap ? Math.max(1, Number(body.frequencyCap)) : existing[0].frequencyCap,
        visibilityRule: body.visibilityRule
          ? sanitizeText(body.visibilityRule, 80)
          : existing[0].visibilityRule,
        errorMessage:
          body.errorMessage !== undefined ? sanitizeText(body.errorMessage, 240) : existing[0].errorMessage,
        updatedBy: ctx.adminUser!.id,
        updatedAt: new Date(),
      })
      .where(eq(adConfigs.id, id))
      .returning();

    return jsonResponse({ adConfig: updated[0] });
  });

  router.delete('/api/ads/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(adConfigs).where(eq(adConfigs.id, id)).limit(1);
    const permFail = existing[0]?.appId
      ? await requireAppAccess(ctx, existing[0].appId, ['ads.manage', 'apps.manage'])
      : await requirePermission(ctx, 'ads.manage');
    if (permFail) return permFail;

    await ctx.db.delete(adConfigs).where(eq(adConfigs.id, id));
    return jsonResponse({ deleted: true });
  });

  // ---- MODULE H: APPLICATION MANAGEMENT ----
  router.get('/api/app/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'app.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const [flags, releases, appSettings, apps] = await Promise.all([
      ctx.db
        .select()
        .from(featureFlags)
        .where(appIdFilter ? sql`(${featureFlags.appId} = ${appIdFilter} OR ${featureFlags.appId} IS NULL)` : undefined)
        .orderBy(featureFlags.key),
      ctx.db
        .select()
        .from(appReleases)
        .where(appIdFilter ? eq(appReleases.appId, appIdFilter) : undefined)
        .orderBy(desc(appReleases.createdAt)),
      ctx.db
        .select()
        .from(systemSettings)
        .where(sql`${systemSettings.category} IN ('app', 'maintenance')`),
      ctx.db.select({ id: connectedApps.id, name: connectedApps.name }).from(connectedApps),
    ]);

    const appNameById = new Map(apps.map((a) => [a.id, a.name]));

    return jsonResponse({
      flags: flags.map((f) => ({
        ...f,
        key: f.appId ? f.key.replace(new RegExp(`@app${f.appId}$`), '') : f.key,
        appName: f.appId ? (appNameById.get(f.appId) ?? null) : null,
      })),
      releases: releases.map((r) => ({ ...r, appName: r.appId ? (appNameById.get(r.appId) ?? null) : null })),
      settings: appSettings,
    });
  });

  router.post('/api/app/flags', async (ctx: WorkerContext) => {
    const body = await readJsonBody<{
      appId?: number | null;
      key?: string;
      name?: string;
      description?: string;
      isEnabled?: boolean;
      rolloutPercentage?: number;
    }>(ctx.request);

    const appId = parseOptionalAppId(body.appId);
    const permFail = appId
      ? await requireAppAccess(ctx, appId, ['app.manage', 'apps.manage'])
      : await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const rawKey = sanitizeText(body.key, 80).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const name = sanitizeText(body.name, 100);
    if (!rawKey || !name) {
      return errorResponse(400, 'Feature flag key and name are required.');
    }

    const scopedKey = appId ? `${rawKey}@app${appId}` : rawKey;
    const candidates = await ctx.db
      .select()
      .from(featureFlags)
      .where(sql`${featureFlags.key} IN (${rawKey}, ${scopedKey})`);

    const sameScopeExisting = candidates.find((c) => (c.appId ?? null) === (appId ?? null));
    const otherScopeConflict = candidates.find(
      (c) => c.key === rawKey && (c.appId ?? null) !== (appId ?? null)
    );

    let savedFlag: typeof featureFlags.$inferSelect;
    const rollout = Math.min(100, Math.max(0, Number(body.rolloutPercentage) || 100));
    const descText = sanitizeText(body.description, 240);

    if (sameScopeExisting) {
      const updated = await ctx.db
        .update(featureFlags)
        .set({
          name,
          description: descText,
          isEnabled: Boolean(body.isEnabled),
          rolloutPercentage: rollout,
          updatedBy: ctx.adminUser!.id,
          updatedAt: new Date(),
        })
        .where(eq(featureFlags.id, sameScopeExisting.id))
        .returning();
      savedFlag = updated[0];
    } else {
      const storageKey = otherScopeConflict || appId ? scopedKey : rawKey;
      const inserted = await ctx.db
        .insert(featureFlags)
        .values({
          appId,
          key: storageKey,
          name,
          description: descText,
          isEnabled: Boolean(body.isEnabled),
          rolloutPercentage: rollout,
          updatedBy: ctx.adminUser!.id,
        })
        .returning();
      savedFlag = inserted[0];
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.flag_upserted',
      module: 'app',
      targetType: 'feature_flag',
      targetId: rawKey,
      details: { isEnabled: Boolean(body.isEnabled), appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse(
      {
        flag: {
          ...savedFlag,
          key: savedFlag.appId ? savedFlag.key.replace(new RegExp(`@app${savedFlag.appId}$`), '') : savedFlag.key,
        },
      },
      201
    );
  });

  router.patch('/api/app/flags/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(featureFlags).where(eq(featureFlags.id, id)).limit(1);
    if (!existing[0]) {
      const permFail = await requirePermission(ctx, 'app.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Feature flag not found.');
    }
    const permFail = existing[0].appId
      ? await requireAppAccess(ctx, existing[0].appId, ['app.manage', 'apps.manage'])
      : await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      isEnabled?: boolean;
      rolloutPercentage?: number;
    }>(ctx.request);

    const updated = await ctx.db
      .update(featureFlags)
      .set({
        name: body.name !== undefined ? sanitizeText(body.name, 100) || existing[0].name : existing[0].name,
        description:
          body.description !== undefined ? sanitizeText(body.description, 240) : existing[0].description,
        isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : existing[0].isEnabled,
        rolloutPercentage:
          body.rolloutPercentage !== undefined
            ? Math.min(100, Math.max(0, Number(body.rolloutPercentage)))
            : existing[0].rolloutPercentage,
        updatedBy: ctx.adminUser!.id,
        updatedAt: new Date(),
      })
      .where(eq(featureFlags.id, id))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.flag_toggled',
      module: 'app',
      targetType: 'feature_flag',
      targetId: existing[0].key,
      details: { isEnabled: updated[0].isEnabled },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ flag: updated[0] });
  });

  router.delete('/api/app/flags/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(featureFlags).where(eq(featureFlags.id, id)).limit(1);
    const permFail = existing[0]?.appId
      ? await requireAppAccess(ctx, existing[0].appId, ['app.manage', 'apps.manage'])
      : await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;
    await ctx.db.delete(featureFlags).where(eq(featureFlags.id, id));
    return jsonResponse({ deleted: true });
  });

  router.post('/api/app/releases', async (ctx: WorkerContext) => {
    const body = await readJsonBody<{
      appId?: number | null;
      version?: string;
      minSupportedVersion?: string;
      forceUpdate?: boolean;
      platform?: string;
      releaseNotes?: string;
    }>(ctx.request);

    const appId = parseOptionalAppId(body.appId);
    const permFail = appId
      ? await requireAppAccess(ctx, appId, ['app.manage', 'apps.manage'])
      : await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const version = sanitizeText(body.version, 40);
    const minSupportedVersion = sanitizeText(body.minSupportedVersion || version, 40);
    if (!version) return errorResponse(400, 'Version string is required.');

    const created = await ctx.db
      .insert(appReleases)
      .values({
        appId,
        version,
        minSupportedVersion,
        forceUpdate: Boolean(body.forceUpdate),
        platform: sanitizeText(body.platform || 'web', 20),
        releaseNotes: sanitizeText(body.releaseNotes, 2000),
        status: 'active',
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    if (appId) {
      await ctx.db
        .update(connectedApps)
        .set({
          currentVersion: version,
          minSupportedVersion,
          forceUpdate: Boolean(body.forceUpdate),
          updatedAt: new Date(),
        })
        .where(eq(connectedApps.id, appId));
    } else {
      await ctx.db
        .update(systemSettings)
        .set({ value: version, updatedAt: new Date() })
        .where(eq(systemSettings.key, 'app.version'));
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.release_published',
      module: 'app',
      targetType: 'release',
      targetId: version,
      details: { appId, forceUpdate: Boolean(body.forceUpdate) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ release: created[0] }, 201);
  });

  router.patch('/api/app/releases/:id', async (ctx: WorkerContext) => {
    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(appReleases).where(eq(appReleases.id, id)).limit(1);
    if (!existing[0]) {
      const permFail = await requirePermission(ctx, 'app.manage');
      if (permFail) return permFail;
      return errorResponse(404, 'Release not found.');
    }
    const permFail = existing[0].appId
      ? await requireAppAccess(ctx, existing[0].appId, ['app.manage', 'apps.manage'])
      : await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{ status?: string; forceUpdate?: boolean }>(ctx.request);

    const nextStatus = ['draft', 'active', 'rolled_back'].includes(body.status || '')
      ? body.status!
      : existing[0].status;
    const updated = await ctx.db
      .update(appReleases)
      .set({
        status: nextStatus,
        forceUpdate: typeof body.forceUpdate === 'boolean' ? body.forceUpdate : existing[0].forceUpdate,
      })
      .where(eq(appReleases.id, id))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.release_updated',
      module: 'app',
      targetType: 'release',
      targetId: id,
      details: { status: nextStatus },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ release: updated[0] });
  });
}
