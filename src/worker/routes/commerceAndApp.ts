import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import {
  adConfigs,
  appReleases,
  featureFlags,
  systemSettings,
  transactions,
} from '../../db/schema.ts';
import { sanitizeText } from '../../lib/security.ts';
import { parsePaginationQuery } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

export function registerCommerceAndAppRoutes(router: WorkerRouter): void {
  // ---- MODULE F: FINANCIAL MANAGEMENT ----
  router.get('/api/finance/transactions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['createdAt', 'amountCents', 'status'], 'createdAt');
    const statusFilter = sanitizeText(q.status || 'all', 20);
    const typeFilter = sanitizeText(q.type || 'all', 20);

    const conditions: SQL[] = [];
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
    const [totalRows, rows, allTxRows] = await Promise.all([
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
        .from(transactions),
    ]);

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
      data: rows,
      total: Number(totalRows[0]?.total ?? 0),
      summary,
    });
  });

  router.post('/api/finance/transactions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'finance.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
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

    const reference = `TX-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const created = await ctx.db
      .insert(transactions)
      .values({
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
      details: { reference, amountCents, type: created[0].type },
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
    const rows = await ctx.db.select().from(adConfigs).orderBy(desc(adConfigs.updatedAt));
    return jsonResponse({ data: rows });
  });

  router.post('/api/ads', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'ads.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      network?: string;
      adFormat?: string;
      placement?: string;
      frequencyCap?: number;
      isEnabled?: boolean;
      visibilityRule?: string;
    }>(ctx.request);

    const name = sanitizeText(body.name, 100);
    const network = sanitizeText(body.network, 60);
    const placement = sanitizeText(body.placement, 80);
    if (!name || !network || !placement) {
      return errorResponse(400, 'Ad configuration name, network, and placement are required.');
    }

    const created = await ctx.db
      .insert(adConfigs)
      .values({
        name,
        network,
        adFormat: ['banner', 'interstitial', 'rewarded', 'native'].includes(body.adFormat || '')
          ? body.adFormat!
          : 'banner',
        placement,
        frequencyCap: Math.max(1, Number(body.frequencyCap) || 3),
        isEnabled: Boolean(body.isEnabled),
        visibilityRule: sanitizeText(body.visibilityRule || 'all_users', 80),
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
      details: { name, network, placement },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ adConfig: created[0] }, 201);
  });

  router.patch('/api/ads/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'ads.manage');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const existing = await ctx.db.select().from(adConfigs).where(eq(adConfigs.id, id)).limit(1);
    if (!existing[0]) return errorResponse(404, 'Ad configuration not found.');

    const body = await readJsonBody<{ isEnabled?: boolean; frequencyCap?: number; visibilityRule?: string }>(
      ctx.request
    );
    const updated = await ctx.db
      .update(adConfigs)
      .set({
        isEnabled: typeof body.isEnabled === 'boolean' ? body.isEnabled : existing[0].isEnabled,
        frequencyCap: body.frequencyCap ? Math.max(1, Number(body.frequencyCap)) : existing[0].frequencyCap,
        visibilityRule: body.visibilityRule
          ? sanitizeText(body.visibilityRule, 80)
          : existing[0].visibilityRule,
        updatedBy: ctx.adminUser!.id,
        updatedAt: new Date(),
      })
      .where(eq(adConfigs.id, id))
      .returning();

    return jsonResponse({ adConfig: updated[0] });
  });

  // ---- MODULE H: APPLICATION MANAGEMENT ----
  router.get('/api/app/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'app.read');
    if (permFail) return permFail;

    const [flags, releases, appSettings] = await Promise.all([
      ctx.db.select().from(featureFlags).orderBy(featureFlags.key),
      ctx.db.select().from(appReleases).orderBy(desc(appReleases.createdAt)),
      ctx.db
        .select()
        .from(systemSettings)
        .where(sql`${systemSettings.category} IN ('app', 'maintenance')`),
    ]);

    return jsonResponse({ flags, releases, settings: appSettings });
  });

  router.post('/api/app/flags', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      key?: string;
      name?: string;
      description?: string;
      isEnabled?: boolean;
      rolloutPercentage?: number;
    }>(ctx.request);

    const key = sanitizeText(body.key, 80).toLowerCase().replace(/[^a-z0-9._-]/g, '-');
    const name = sanitizeText(body.name, 100);
    if (!key || !name) {
      return errorResponse(400, 'Feature flag key and name are required.');
    }

    const created = await ctx.db
      .insert(featureFlags)
      .values({
        key,
        name,
        description: sanitizeText(body.description, 240),
        isEnabled: Boolean(body.isEnabled),
        rolloutPercentage: Math.min(100, Math.max(0, Number(body.rolloutPercentage) || 100)),
        updatedBy: ctx.adminUser!.id,
      })
      .onConflictDoUpdate({
        target: featureFlags.key,
        set: {
          name,
          isEnabled: Boolean(body.isEnabled),
          rolloutPercentage: Math.min(100, Math.max(0, Number(body.rolloutPercentage) || 100)),
          updatedBy: ctx.adminUser!.id,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.flag_upserted',
      module: 'app',
      targetType: 'feature_flag',
      targetId: key,
      details: { isEnabled: Boolean(body.isEnabled) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ flag: created[0] }, 201);
  });

  router.patch('/api/app/flags/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const body = await readJsonBody<{ isEnabled?: boolean; rolloutPercentage?: number }>(ctx.request);
    const existing = await ctx.db.select().from(featureFlags).where(eq(featureFlags.id, id)).limit(1);
    if (!existing[0]) return errorResponse(404, 'Feature flag not found.');

    const updated = await ctx.db
      .update(featureFlags)
      .set({
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

  router.post('/api/app/releases', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'app.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      version?: string;
      minSupportedVersion?: string;
      forceUpdate?: boolean;
      platform?: string;
      releaseNotes?: string;
    }>(ctx.request);

    const version = sanitizeText(body.version, 40);
    const minSupportedVersion = sanitizeText(body.minSupportedVersion || version, 40);
    if (!version) return errorResponse(400, 'Version string is required.');

    const created = await ctx.db
      .insert(appReleases)
      .values({
        version,
        minSupportedVersion,
        forceUpdate: Boolean(body.forceUpdate),
        platform: sanitizeText(body.platform || 'web', 20),
        releaseNotes: sanitizeText(body.releaseNotes, 2000),
        status: 'active',
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    await ctx.db
      .update(systemSettings)
      .set({ value: version, updatedAt: new Date() })
      .where(eq(systemSettings.key, 'app.version'));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'app.release_published',
      module: 'app',
      targetType: 'release',
      targetId: version,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ release: created[0] }, 201);
  });
}
