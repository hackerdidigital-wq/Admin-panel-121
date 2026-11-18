import { and, desc, eq, gte, sql, type SQL } from 'drizzle-orm';
import {
  adConfigs,
  apiLogs,
  appEvents,
  appUsers,
  auditLogs,
  backgroundJobs,
  connectedApps,
  contentItems,
  supportTickets,
  systemSettings,
  transactions,
  userSessions,
  users,
} from '../../db/schema.ts';
import { toCsv } from '../../lib/csv.ts';
import { sanitizeText } from '../../lib/security.ts';
import { parsePaginationQuery } from '../../lib/validation.ts';
import { verifyAuditChain, writeAuditLog } from '../audit.ts';
import { requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';
import { createFullBackupSnapshot } from './devDbFilesAi.ts';

function toDayKey(val: Date | number | null | undefined): string {
  if (!val) return '';
  const d = val instanceof Date ? val : new Date(val);
  return d.toISOString().slice(0, 10);
}

function parseOptionalAppId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '' || raw === 'all') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function registerOpsAndSecurityRoutes(router: WorkerRouter): void {
  // ---- MODULE J: ANALYTICS & REPORTS ----
  router.get('/api/analytics/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'analytics.read');
    if (permFail) return permFail;

    const days = Math.min(90, Math.max(7, Number(ctx.url.searchParams.get('days')) || 30));
    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const cutoff = new Date(Date.now() - days * 86_400_000);

    const [
      userRows,
      txRows,
      contentRows,
      ticketRows,
      sessionRows,
      endUsersRows,
      eventRows,
      adRows,
    ] = await Promise.all([
      ctx.db
        .select({
          status: users.status,
          country: users.country,
          createdAt: users.createdAt,
        })
        .from(users),
      ctx.db
        .select({
          amountCents: transactions.amountCents,
          type: transactions.type,
          status: transactions.status,
          createdAt: transactions.createdAt,
        })
        .from(transactions)
        .where(
          appIdFilter
            ? and(gte(transactions.createdAt, cutoff), eq(transactions.appId, appIdFilter))
            : gte(transactions.createdAt, cutoff)
        ),
      ctx.db
        .select({ status: contentItems.status })
        .from(contentItems)
        .where(appIdFilter ? eq(contentItems.appId, appIdFilter) : undefined),
      ctx.db
        .select({ status: supportTickets.status })
        .from(supportTickets)
        .where(appIdFilter ? eq(supportTickets.appId, appIdFilter) : undefined),
      ctx.db
        .select({ browser: userSessions.browser, os: userSessions.os })
        .from(userSessions)
        .where(gte(userSessions.createdAt, cutoff)),
      ctx.db
        .select({
          status: appUsers.status,
          country: appUsers.country,
          createdAt: appUsers.createdAt,
        })
        .from(appUsers)
        .where(appIdFilter ? eq(appUsers.appId, appIdFilter) : undefined),
      ctx.db
        .select({
          severity: appEvents.severity,
          eventType: appEvents.eventType,
          createdAt: appEvents.createdAt,
        })
        .from(appEvents)
        .where(
          appIdFilter
            ? and(gte(appEvents.createdAt, cutoff), eq(appEvents.appId, appIdFilter))
            : gte(appEvents.createdAt, cutoff)
        ),
      ctx.db
        .select({ revenueCents: adConfigs.revenueCents, impressions: adConfigs.impressions, clicks: adConfigs.clicks })
        .from(adConfigs)
        .where(appIdFilter ? eq(adConfigs.appId, appIdFilter) : undefined),
    ]);

    const userDayMap = new Map<string, number>();
    for (const u of userRows) {
      if (new Date(u.createdAt).getTime() < cutoff.getTime()) continue;
      const day = toDayKey(u.createdAt);
      userDayMap.set(day, (userDayMap.get(day) ?? 0) + 1);
    }
    for (const au of endUsersRows) {
      if (new Date(au.createdAt).getTime() < cutoff.getTime()) continue;
      const day = toDayKey(au.createdAt);
      userDayMap.set(day, (userDayMap.get(day) ?? 0) + 1);
    }

    const revDayMap = new Map<string, number>();
    for (const t of txRows) {
      if (t.status !== 'succeeded' || t.type !== 'payment') continue;
      const day = toDayKey(t.createdAt);
      revDayMap.set(day, (revDayMap.get(day) ?? 0) + t.amountCents);
    }

    const contentCounts = new Map<string, number>();
    for (const c of contentRows) {
      contentCounts.set(c.status, (contentCounts.get(c.status) ?? 0) + 1);
    }

    const ticketCounts = new Map<string, number>();
    for (const t of ticketRows) {
      ticketCounts.set(t.status, (ticketCounts.get(t.status) ?? 0) + 1);
    }

    const deviceCounts = new Map<string, { browser: string; os: string; count: number }>();
    for (const s of sessionRows) {
      const k = `${s.browser}::${s.os}`;
      const existing = deviceCounts.get(k) ?? { browser: s.browser, os: s.os, count: 0 };
      existing.count += 1;
      deviceCounts.set(k, existing);
    }

    const geoCounts = new Map<string, number>();
    for (const u of [...userRows, ...endUsersRows]) {
      if (!u.country) continue;
      geoCounts.set(u.country, (geoCounts.get(u.country) ?? 0) + 1);
    }

    const geoConsentRows = await ctx.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'privacy.geoTrackingConsent'))
      .limit(1);
    const geoConsentEnabled = Boolean(geoConsentRows[0]?.value);

    const revenueSeries = Array.from(revDayMap.entries())
      .map(([day, amount_cents]) => ({ day, amount_cents }))
      .sort((a, b) => a.day.localeCompare(b.day));
    const contentSummary = Array.from(contentCounts.entries()).map(([status, count]) => ({
      status,
      count,
    }));
    const ticketSummary = Array.from(ticketCounts.entries()).map(([status, count]) => ({
      status,
      priority: 'all',
      count,
    }));

    return jsonResponse({
      days,
      appId: appIdFilter,
      sdkSummary: {
        appUsersCount: endUsersRows.length,
        activeAppUsersCount: endUsersRows.filter((u) => u.status === 'active').length,
        bannedAppUsersCount: endUsersRows.filter((u) => u.status === 'banned').length,
        appEventsCount: eventRows.length,
        errorEventsCount: eventRows.filter((e) => e.severity === 'error' || e.severity === 'critical').length,
        adRevenueCents: adRows.reduce((s, a) => s + a.revenueCents, 0),
        adImpressions: adRows.reduce((s, a) => s + a.impressions, 0),
        adClicks: adRows.reduce((s, a) => s + a.clicks, 0),
      },
      userGrowth: Array.from(userDayMap.entries())
        .map(([day, count]) => ({ day, count }))
        .sort((a, b) => a.day.localeCompare(b.day)),
      revenueSeries,
      revenueTrend: revenueSeries,
      contentSummary,
      contentBreakdown: contentSummary,
      ticketSummary,
      ticketBreakdown: ticketSummary,
      deviceBreakdown: Array.from(deviceCounts.values()).slice(0, 12),
      geoConsentEnabled,
      geoBreakdown: geoConsentEnabled
        ? Array.from(geoCounts.entries())
            .map(([country, count]) => ({ country, count }))
            .slice(0, 15)
        : [],
    });
  });

  router.get('/api/analytics/export.csv', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'analytics.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const [allUsers, allAppUsers, allTx, allAds] = await Promise.all([
      ctx.db.select({ status: users.status }).from(users),
      ctx.db
        .select({ status: appUsers.status })
        .from(appUsers)
        .where(appIdFilter ? eq(appUsers.appId, appIdFilter) : undefined),
      ctx.db
        .select({ status: transactions.status, amountCents: transactions.amountCents })
        .from(transactions)
        .where(appIdFilter ? eq(transactions.appId, appIdFilter) : undefined),
      ctx.db
        .select({ revenueCents: adConfigs.revenueCents, impressions: adConfigs.impressions })
        .from(adConfigs)
        .where(appIdFilter ? eq(adConfigs.appId, appIdFilter) : undefined),
    ]);

    const csv = toCsv(
      ['metric', 'value'],
      [
        { metric: 'scope_app_id', value: appIdFilter ?? 'all' },
        { metric: 'total_admin_users', value: allUsers.length },
        { metric: 'total_app_end_users', value: allAppUsers.length },
        { metric: 'active_app_end_users', value: allAppUsers.filter((u) => u.status === 'active').length },
        { metric: 'banned_app_end_users', value: allAppUsers.filter((u) => u.status === 'banned').length },
        { metric: 'total_transactions', value: allTx.length },
        {
          metric: 'succeeded_revenue_cents',
          value: allTx.filter((t) => t.status === 'succeeded').reduce((a, b) => a + b.amountCents, 0),
        },
        { metric: 'ad_impressions', value: allAds.reduce((a, b) => a + b.impressions, 0) },
        { metric: 'ad_revenue_cents', value: allAds.reduce((a, b) => a + b.revenueCents, 0) },
      ]
    );

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'analytics.exported_csv',
      module: 'analytics',
      details: { appId: appIdFilter },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-analytics-summary.csv"',
      },
    });
  });

  router.get('/api/analytics/export.json', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'analytics.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const [apps, endUsers, txs, ads, events] = await Promise.all([
      ctx.db
        .select({
          id: connectedApps.id,
          appUid: connectedApps.appUid,
          name: connectedApps.name,
          platform: connectedApps.platform,
          status: connectedApps.status,
          healthStatus: connectedApps.healthStatus,
        })
        .from(connectedApps)
        .where(appIdFilter ? eq(connectedApps.id, appIdFilter) : undefined),
      ctx.db
        .select()
        .from(appUsers)
        .where(appIdFilter ? eq(appUsers.appId, appIdFilter) : undefined),
      ctx.db
        .select()
        .from(transactions)
        .where(appIdFilter ? eq(transactions.appId, appIdFilter) : undefined),
      ctx.db
        .select()
        .from(adConfigs)
        .where(appIdFilter ? eq(adConfigs.appId, appIdFilter) : undefined),
      ctx.db
        .select()
        .from(appEvents)
        .where(appIdFilter ? eq(appEvents.appId, appIdFilter) : undefined)
        .orderBy(desc(appEvents.createdAt))
        .limit(500),
    ]);

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'analytics.exported_json',
      module: 'analytics',
      details: { appId: appIdFilter },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    const report = {
      exportedAt: new Date().toISOString(),
      scopeAppId: appIdFilter ?? 'all',
      apps,
      summary: {
        totalApps: apps.length,
        totalEndUsers: endUsers.length,
        totalTransactions: txs.length,
        succeededRevenueCents: txs
          .filter((t) => t.status === 'succeeded')
          .reduce((a, b) => a + b.amountCents, 0),
        adRevenueCents: ads.reduce((a, b) => a + b.revenueCents, 0),
      },
      endUsers,
      transactions: txs,
      adConfigs: ads,
      recentEvents: events,
    };

    return new Response(JSON.stringify(report, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-analytics-report.json"',
      },
    });
  });

  // ---- MODULE K: SECURITY CENTER ----
  router.get('/api/security/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, ['security.read', 'dashboard.read']);
    if (permFail) return permFail;

    const [sessions, securityEvents, secSettings, chainCheck] = await Promise.all([
      ctx.db
        .select({
          id: userSessions.id,
          userId: userSessions.userId,
          email: users.email,
          deviceName: userSessions.deviceName,
          browser: userSessions.browser,
          os: userSessions.os,
          ipAddress: userSessions.ipAddress,
          isActive: userSessions.isActive,
          lastActivityAt: userSessions.lastActivityAt,
          createdAt: userSessions.createdAt,
        })
        .from(userSessions)
        .innerJoin(users, eq(userSessions.userId, users.id))
        .where(eq(userSessions.isActive, true))
        .orderBy(desc(userSessions.lastActivityAt))
        .limit(40),
      ctx.db
        .select()
        .from(auditLogs)
        .where(sql`${auditLogs.module} = 'security' OR ${auditLogs.status} != 'success'`)
        .orderBy(desc(auditLogs.createdAt))
        .limit(30),
      ctx.db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.category, 'security')),
      verifyAuditChain(ctx.db, 200),
    ]);

    return jsonResponse({
      activeSessions: sessions.map((s) => ({
        ...s,
        userEmail: s.email,
      })),
      securityEvents,
      policies: secSettings,
      settings: secSettings,
      auditChainIntegrity: chainCheck,
    });
  });

  router.post('/api/security/sessions/:id/revoke', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'security.manage');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    await ctx.db
      .update(userSessions)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(userSessions.id, id));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'security.session_revoked',
      module: 'security',
      targetType: 'session',
      targetId: id,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ revoked: true });
  });

  // ---- MODULE L: SYSTEM MANAGEMENT ----
  router.get('/api/system/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'system.read');
    if (permFail) return permFail;

    const start = Date.now();
    await ctx.env.DB.prepare('SELECT 1 AS ok').first();
    const dbLatencyMs = Date.now() - start;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));

    const [recentApi, errorLogs, jobs, activeSessRows, sdkErrorEvents] = await Promise.all([
      ctx.db
        .select()
        .from(apiLogs)
        .where(appIdFilter ? eq(apiLogs.appId, appIdFilter) : undefined)
        .orderBy(desc(apiLogs.createdAt))
        .limit(40),
      ctx.db
        .select()
        .from(apiLogs)
        .where(
          appIdFilter
            ? and(sql`${apiLogs.statusCode} >= 400`, eq(apiLogs.appId, appIdFilter))
            : sql`${apiLogs.statusCode} >= 400`
        )
        .orderBy(desc(apiLogs.createdAt))
        .limit(30),
      ctx.db.select().from(backgroundJobs).orderBy(desc(backgroundJobs.createdAt)).limit(30),
      ctx.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(userSessions)
        .where(eq(userSessions.isActive, true)),
      ctx.db
        .select()
        .from(appEvents)
        .where(
          appIdFilter
            ? and(eq(appEvents.appId, appIdFilter), sql`${appEvents.severity} IN ('error', 'critical')`)
            : sql`${appEvents.severity} IN ('error', 'critical')`
        )
        .orderBy(desc(appEvents.createdAt))
        .limit(20),
    ]);

    const activeConnections = Number(activeSessRows[0]?.count ?? 0);
    const uptimeSeconds =
      typeof process !== 'undefined' && typeof process.uptime === 'function'
        ? Math.floor(process.uptime())
        : 0;

    return jsonResponse({
      host: {
        platform: 'Cloudflare Workers',
        arch: 'v8-isolate',
        nodeVersion:
          typeof process !== 'undefined' && process.version ? process.version : 'Workers V8',
        cpus: 1,
        totalMemMb: 128,
        freeMemMb: 128,
        uptimeSeconds,
        loadAvg: [0, 0, 0],
      },
      database: {
        status: dbLatencyMs < 1000 ? 'healthy' : 'slow',
        latencyMs: dbLatencyMs,
        engine: 'Cloudflare D1 SQLite',
      },
      api: {
        activeConnections,
        recentLogs: recentApi,
        errorLogs,
      },
      sdkErrors: sdkErrorEvents,
      jobs,
    });
  });

  router.post('/api/system/jobs', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'system.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{ jobType?: string; appId?: number | null }>(ctx.request);
    const rawJobType = sanitizeText(body.jobType || '', 60);
    const normalizedJobType =
      rawJobType === 'audit_integrity_check'
        ? 'audit_verify'
        : rawJobType === 'session_prune'
          ? 'session_cleanup'
          : rawJobType === 'api_log_retention'
            ? 'log_prune'
            : rawJobType;

    if (!['session_cleanup', 'log_prune', 'audit_verify', 'auto_backup'].includes(normalizedJobType)) {
      return errorResponse(400, 'Supported jobs: session_cleanup, log_prune, audit_verify, auto_backup.');
    }

    const startedAt = new Date();
    const jobRows = await ctx.db
      .insert(backgroundJobs)
      .values({
        jobType: normalizedJobType,
        status: 'running',
        startedAt,
        attempts: 1,
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    let result: Record<string, unknown> = {};
    if (normalizedJobType === 'session_cleanup') {
      const now = new Date();
      await ctx.db
        .update(userSessions)
        .set({ isActive: false, revokedAt: now })
        .where(and(eq(userSessions.isActive, true), sql`${userSessions.expiresAt} < ${now.getTime()}`));
      result = { action: 'expired_sessions_revoked', executedAt: now.toISOString() };
    } else if (normalizedJobType === 'log_prune') {
      const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
      await ctx.db
        .delete(apiLogs)
        .where(sql`${apiLogs.createdAt} < ${thirtyDaysAgo}`);
      result = { action: 'pruned_api_logs_older_than_30d' };
    } else if (normalizedJobType === 'audit_verify') {
      result = await verifyAuditChain(ctx.db, 500);
    } else if (normalizedJobType === 'auto_backup') {
      const appId = parseOptionalAppId(body.appId);
      const snap = await createFullBackupSnapshot(
        ctx.db,
        ctx.env.DB,
        ctx.adminUser!.id,
        'scheduled',
        appId
      );
      result = { action: 'scheduled_backup_created', ...snap };
    }

    const completed = await ctx.db
      .update(backgroundJobs)
      .set({
        status: 'completed',
        result,
        completedAt: new Date(),
      })
      .where(eq(backgroundJobs.id, jobRows[0].id))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: `system.job_${normalizedJobType}`,
      module: 'system',
      targetType: 'job',
      targetId: jobRows[0].id,
      details: result,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ job: completed[0] }, 201);
  });

  // ---- MODULE P: SETTINGS ----
  router.get('/api/settings', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'settings.read');
    if (permFail) return permFail;

    const category = sanitizeText(ctx.url.searchParams.get('category') || 'all', 40);
    const rows =
      category !== 'all'
        ? await ctx.db.select().from(systemSettings).where(eq(systemSettings.category, category))
        : await ctx.db.select().from(systemSettings).orderBy(systemSettings.category, systemSettings.key);

    return jsonResponse({
      settings: rows.map((r) => ({
        ...r,
        value: r.isSecret ? '***' : r.value,
      })),
    });
  });

  router.put('/api/settings/:key', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'settings.manage');
    if (permFail) return permFail;

    const key = sanitizeText(ctx.params.key || '', 80);
    if (!key) return errorResponse(400, 'Setting key is required.');

    const body = await readJsonBody<{ value?: unknown; category?: string; description?: string }>(
      ctx.request
    );
    const existing = await ctx.db.select().from(systemSettings).where(eq(systemSettings.key, key)).limit(1);

    const updated = await ctx.db
      .insert(systemSettings)
      .values({
        key,
        category: sanitizeText(body.category || existing[0]?.category || 'general', 40),
        value: body.value ?? null,
        isSecret: false,
        description: sanitizeText(body.description || existing[0]?.description || '', 240),
        updatedBy: ctx.adminUser!.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: {
          value: body.value ?? null,
          updatedBy: ctx.adminUser!.id,
          updatedAt: new Date(),
        },
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'settings.updated',
      module: 'settings',
      targetType: 'setting',
      targetId: key,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ setting: updated[0] });
  });

  // ---- MODULE Q: AUDIT & ACTIVITY LOGS ----
  router.get('/api/audit/logs', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'audit.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['createdAt', 'module', 'action', 'status'], 'createdAt');
    const moduleFilter = sanitizeText(q.module || 'all', 40);

    const conditions: SQL[] = [];
    if (moduleFilter === 'exports') {
      conditions.push(sql`lower(${auditLogs.action}) LIKE '%export%'`);
    } else if (moduleFilter !== 'all') {
      conditions.push(eq(auditLogs.module, moduleFilter));
    }
    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${auditLogs.action}) LIKE ${pattern} OR lower(${auditLogs.actorEmail}) LIKE ${pattern})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [totalRows, rows] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`cast(count(*) as integer)` })
        .from(auditLogs)
        .where(whereClause),
      ctx.db
        .select()
        .from(auditLogs)
        .where(whereClause)
        .orderBy(desc(auditLogs.id))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
    ]);

    return jsonResponse({
      data: rows,
      total: Number(totalRows[0]?.total ?? 0),
      page: params.page,
      pageSize: params.pageSize,
    });
  });

  router.get('/api/audit/api-logs', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'audit.read');
    if (permFail) return permFail;

    const appIdFilter = parseOptionalAppId(ctx.url.searchParams.get('appId'));
    const rows = await ctx.db
      .select()
      .from(apiLogs)
      .where(appIdFilter ? eq(apiLogs.appId, appIdFilter) : undefined)
      .orderBy(desc(apiLogs.createdAt))
      .limit(100);

    return jsonResponse({ data: rows });
  });

  router.get('/api/audit/export.csv', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'audit.read');
    if (permFail) return permFail;

    const rows = await ctx.db.select().from(auditLogs).orderBy(desc(auditLogs.id)).limit(1000);
    const csv = toCsv(
      ['id', 'actorEmail', 'action', 'module', 'targetType', 'targetId', 'status', 'ipAddress', 'createdAt'],
      rows.map((r) => ({
        id: r.id,
        actorEmail: r.actorEmail,
        action: r.action,
        module: r.module,
        targetType: r.targetType,
        targetId: r.targetId,
        status: r.status,
        ipAddress: r.ipAddress,
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    );

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'audit.exported_csv',
      module: 'audit',
      details: { count: rows.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-audit-logs.csv"',
      },
    });
  });

  router.get('/api/audit/verify', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'audit.read');
    if (permFail) return permFail;

    const result = await verifyAuditChain(ctx.db, 1000);
    return jsonResponse(result);
  });
}
