import { and, asc, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import {
  apiLogs,
  auditLogs,
  backgroundJobs,
  contentItems,
  notifications,
  roles,
  savedViews,
  supportTickets,
  systemSettings,
  transactions,
  userSessions,
  users,
} from '../../db/schema.ts';
import { ensureSystemSeeded } from '../../db/seed.ts';
import { hasPermission } from '../../lib/rbac.ts';
import {
  buildOtpAuthUri,
  computeSha256,
  generateTotpSecret,
  generateUid,
  hashPassword,
  sanitizeText,
  SlidingWindowLimiter,
  validatePasswordStrength,
  verifyPassword,
  verifyTotpToken,
} from '../../lib/security.ts';
import { isValidEmail } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { createUserSession, extractSessionToken, requireAuth, requirePermission } from '../auth.ts';
import {
  buildSessionCookieHeader,
  clearSessionCookieHeader,
  errorResponse,
  isHttpsRequest,
  jsonResponse,
  readJsonBody,
} from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

const loginLimiter = new SlidingWindowLimiter(20, 5 * 60_000); // 20 login attempts per 5 min per IP

function toDayKey(dateVal: Date | number | null | undefined): string {
  if (!dateVal) return '';
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  return d.toISOString().slice(0, 10);
}

export function registerAuthAndDashboardRoutes(router: WorkerRouter): void {
  // Public DB & API Health probe
  router.get('/api/health', async (ctx: WorkerContext) => {
    try {
      const start = Date.now();
      await ctx.env.DB.prepare('SELECT 1 AS ok').first();
      return jsonResponse({
        status: 'ok',
        database: 'connected',
        engine: 'cloudflare-d1-sqlite',
        dbLatencyMs: Date.now() - start,
      });
    } catch (err) {
      return jsonResponse(
        {
          status: 'degraded',
          database: 'unavailable',
          error: err instanceof Error ? err.message : 'Database unreachable',
        },
        503
      );
    }
  });

  // Public bootstrap/auth status check (never exposes user data)
  router.get('/api/auth/status', async (ctx: WorkerContext) => {
    try {
      await ensureSystemSeeded(ctx.db, ctx.env.GITHUB_DEFAULT_REPO || '');
      const configuredRows = await ctx.db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(users)
        .where(and(isNotNull(users.passwordHash), eq(users.status, 'active')));
      const configuredCount = Number(configuredRows[0]?.count ?? 0);

      let authenticated = false;
      const rawToken = extractSessionToken(ctx.request);
      if (rawToken && configuredCount > 0) {
        const tokenHash = await computeSha256(rawToken);
        const sessRows = await ctx.db
          .select({
            id: userSessions.id,
            userId: userSessions.userId,
            isActive: userSessions.isActive,
            revokedAt: userSessions.revokedAt,
            expiresAt: userSessions.expiresAt,
          })
          .from(userSessions)
          .where(eq(userSessions.sessionHash, tokenHash))
          .limit(1);
        const sess = sessRows[0];
        if (
          sess &&
          sess.isActive &&
          !sess.revokedAt &&
          new Date(sess.expiresAt).getTime() > Date.now()
        ) {
          const userRows = await ctx.db
            .select({ status: users.status })
            .from(users)
            .where(eq(users.id, sess.userId))
            .limit(1);
          if (userRows[0]?.status === 'active') {
            authenticated = true;
          }
        }
      }

      const emailSetting = await ctx.db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'notifications.emailProvider'))
        .limit(1);
      const emailCfg = emailSetting[0]?.value as { configured?: boolean } | undefined;

      return jsonResponse({
        authenticated,
        needsSetup: configuredCount === 0,
        databaseReady: true,
        emailProviderConfigured: Boolean(ctx.env.EMAIL_PROVIDER_URL || emailCfg?.configured),
      });
    } catch (err) {
      return errorResponse(503, err instanceof Error ? err.message : 'Database unavailable');
    }
  });

  // First-Time Administrator Password Setup (locked once an active admin password exists)
  router.post('/api/auth/setup', async (ctx: WorkerContext) => {
    await ensureSystemSeeded(ctx.db, ctx.env.GITHUB_DEFAULT_REPO || '');

    const configuredRows = await ctx.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(users)
      .where(and(isNotNull(users.passwordHash), eq(users.status, 'active')));
    if (Number(configuredRows[0]?.count ?? 0) > 0) {
      return errorResponse(
        409,
        'Initial administrator setup is locked because an administrator password has already been configured.'
      );
    }

    const body = await readJsonBody<{
      email?: string;
      displayName?: string;
      password?: string;
    }>(ctx.request);

    const password = typeof body.password === 'string' ? body.password : '';
    const policyCheck = validatePasswordStrength(password);
    if (!policyCheck.valid) {
      return errorResponse(400, policyCheck.errors[0]);
    }

    const roleRows = await ctx.db
      .select()
      .from(roles)
      .where(eq(roles.slug, 'super_admin'))
      .limit(1);
    const superAdminRole = roleRows[0];

    const passwordHash = await hashPassword(password);
    const now = new Date();

    // Preserve existing administrator records if any exist without a passwordHash
    const existingRows = await ctx.db
      .select()
      .from(users)
      .orderBy(desc(users.isAdmin), asc(users.id))
      .limit(1);

    let admin: typeof users.$inferSelect;
    if (existingRows[0]) {
      const updated = await ctx.db
        .update(users)
        .set({
          passwordHash,
          passwordUpdatedAt: now,
          roleId: existingRows[0].roleId ?? superAdminRole?.id ?? null,
          status: 'active',
          isAdmin: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
          lastSeenAt: now,
          lastLoginAt: now,
          lastIp: ctx.clientIp,
          updatedAt: now,
        })
        .where(eq(users.id, existingRows[0].id))
        .returning();
      admin = updated[0];
    } else {
      const requestedEmail = sanitizeText(body.email, 160).toLowerCase();
      const internalEmail = isValidEmail(requestedEmail) ? requestedEmail : 'admin@aegis.local';
      const displayName = sanitizeText(body.displayName, 120) || 'Administrator';
      const inserted = await ctx.db
        .insert(users)
        .values({
          uid: generateUid('adm'),
          email: internalEmail,
          passwordHash,
          passwordUpdatedAt: now,
          displayName,
          roleId: superAdminRole?.id ?? null,
          status: 'active',
          isAdmin: true,
          emailVerified: true,
          lastSeenAt: now,
          lastLoginAt: now,
          lastIp: ctx.clientIp,
        })
        .returning();
      admin = inserted[0];
    }

    const { rawToken } = await createUserSession(ctx.db, admin.id, ctx.clientIp, ctx.userAgent, 480);

    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'admin.bootstrap',
      module: 'auth',
      targetType: 'user',
      targetId: admin.id,
      details: { roleSlug: 'super_admin', authMode: 'password_only' },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    const secure = isHttpsRequest(ctx.request);
    return jsonResponse(
      { ok: true, userId: admin.id },
      201,
      { 'Set-Cookie': buildSessionCookieHeader(rawToken, 480 * 60, secure) }
    );
  });

  // Password-Only Administrator Sign-In (+ optional TOTP 2FA verification)
  router.post('/api/auth/login', async (ctx: WorkerContext) => {
    await ensureSystemSeeded(ctx.db, ctx.env.GITHUB_DEFAULT_REPO || '');

    const limitResult = loginLimiter.consume(`login:${ctx.clientIp}`);
    if (!limitResult.allowed) {
      return errorResponse(429, 'Too many login attempts. Please wait a few minutes and retry.', {
        retryAfterMs: limitResult.resetMs,
      });
    }

    const body = await readJsonBody<{
      email?: string;
      password?: string;
      totpCode?: string;
    }>(ctx.request);

    const optionalEmail = sanitizeText(body.email, 160).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';
    const totpCode = sanitizeText(body.totpCode, 16);

    if (!password) {
      return errorResponse(400, 'Administrator password is required.');
    }

    const candidates = optionalEmail
      ? await ctx.db
          .select()
          .from(users)
          .where(and(eq(users.email, optionalEmail), isNotNull(users.passwordHash)))
          .limit(1)
      : await ctx.db
          .select()
          .from(users)
          .where(isNotNull(users.passwordHash))
          .orderBy(desc(users.isAdmin), asc(users.id))
          .limit(25);

    let matchedUser: typeof users.$inferSelect | null = null;
    for (const candidate of candidates) {
      if (await verifyPassword(password, candidate.passwordHash)) {
        matchedUser = candidate;
        break;
      }
    }

    if (!matchedUser) {
      await writeAuditLog(ctx.db, {
        actorEmail: optionalEmail || 'administrator',
        action: 'auth.login_failed',
        module: 'security',
        details: { reason: 'invalid_password' },
        status: 'failure',
        ipAddress: ctx.clientIp,
        userAgent: ctx.userAgent,
      });
      return errorResponse(401, 'Invalid administrator password.');
    }

    if (
      matchedUser.status === 'suspended' ||
      matchedUser.status === 'banned' ||
      matchedUser.status === 'deleted' ||
      matchedUser.status === 'inactive'
    ) {
      return errorResponse(403, `Account access blocked (${matchedUser.status}).`);
    }

    // Optional TOTP 2FA verification when enabled
    if (matchedUser.twoFactorEnabled && matchedUser.twoFactorSecret) {
      if (!totpCode) {
        return jsonResponse({ requiresTwoFactor: true });
      }
      const validTotp = await verifyTotpToken(matchedUser.twoFactorSecret, totpCode);
      if (!validTotp) {
        await writeAuditLog(ctx.db, {
          actorId: matchedUser.id,
          actorEmail: matchedUser.email,
          action: 'auth.2fa_failed',
          module: 'security',
          status: 'failure',
          ipAddress: ctx.clientIp,
          userAgent: ctx.userAgent,
        });
        return errorResponse(401, 'Invalid 2FA verification code.');
      }
    }

    // Read session timeout setting
    const timeoutRow = await ctx.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'security.sessionTimeoutMinutes'))
      .limit(1);
    const timeoutMinutes = Number(timeoutRow[0]?.value) || 480;

    const now = new Date();
    await ctx.db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastLoginAt: now,
        lastSeenAt: now,
        lastIp: ctx.clientIp,
        updatedAt: now,
      })
      .where(eq(users.id, matchedUser.id));

    const { rawToken } = await createUserSession(
      ctx.db,
      matchedUser.id,
      ctx.clientIp,
      ctx.userAgent,
      timeoutMinutes
    );

    await writeAuditLog(ctx.db, {
      actorId: matchedUser.id,
      actorEmail: matchedUser.email,
      action: 'auth.login_success',
      module: 'auth',
      targetType: 'user',
      targetId: matchedUser.id,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    const secure = isHttpsRequest(ctx.request);
    return jsonResponse(
      { ok: true, requiresTwoFactor: false },
      200,
      { 'Set-Cookie': buildSessionCookieHeader(rawToken, timeoutMinutes * 60, secure) }
    );
  });

  // Honest password reset request (checks whether external email provider exists)
  router.post('/api/auth/forgot-password', async (ctx: WorkerContext) => {
    const body = await readJsonBody<{ email?: string }>(ctx.request);
    const email = sanitizeText(body.email, 160).toLowerCase();
    if (!isValidEmail(email)) {
      return errorResponse(400, 'Please enter a valid email address.');
    }

    await writeAuditLog(ctx.db, {
      actorEmail: email,
      action: 'auth.password_reset_requested',
      module: 'security',
      details: { emailProviderConfigured: Boolean(ctx.env.EMAIL_PROVIDER_URL) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    if (!ctx.env.EMAIL_PROVIDER_URL) {
      return jsonResponse({
        sent: false,
        providerConfigured: false,
        message:
          'Password reset email could not be sent because no external SMTP/email delivery provider (EMAIL_PROVIDER_URL) is configured. A Super Admin can set a new temporary password directly in User Management.',
      });
    }

    return jsonResponse({
      sent: false,
      providerConfigured: true,
      message:
        'External email provider webhook is configured, but automated reset token mailing requires configuring your provider template credentials.',
    });
  });

  // Current authenticated session profile
  router.get('/api/auth/session', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;

    const sessions = await ctx.db
      .select({
        id: userSessions.id,
        deviceName: userSessions.deviceName,
        browser: userSessions.browser,
        os: userSessions.os,
        ipAddress: userSessions.ipAddress,
        isActive: userSessions.isActive,
        lastActivityAt: userSessions.lastActivityAt,
        expiresAt: userSessions.expiresAt,
        createdAt: userSessions.createdAt,
      })
      .from(userSessions)
      .where(and(eq(userSessions.userId, admin.id), eq(userSessions.isActive, true)))
      .orderBy(desc(userSessions.lastActivityAt))
      .limit(10);

    return jsonResponse({
      user: {
        id: admin.id,
        uid: admin.uid,
        email: admin.email,
        displayName: admin.displayName,
        avatarUrl: admin.avatarUrl,
        status: admin.status,
        roleId: admin.roleId,
        roleSlug: admin.roleSlug,
        roleName: admin.roleName,
        hierarchyLevel: admin.hierarchyLevel,
        twoFactorEnabled: admin.twoFactorEnabled,
        preferences: admin.preferences,
      },
      permissions: Array.from(admin.permissions),
      sessions,
    });
  });

  // Update user preferences
  router.patch('/api/auth/preferences', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;
    const body = await readJsonBody<Record<string, unknown>>(ctx.request);

    const themeValue: 'light' | 'dark' | 'system' | undefined =
      body.theme === 'light' || body.theme === 'dark' || body.theme === 'system'
        ? body.theme
        : admin.preferences.theme === 'light' ||
            admin.preferences.theme === 'dark' ||
            admin.preferences.theme === 'system'
          ? (admin.preferences.theme as 'light' | 'dark' | 'system')
          : undefined;

    const nextPrefs = {
      ...admin.preferences,
      theme: themeValue,
      ...(typeof body.language === 'string' ? { language: body.language.slice(0, 16) } : {}),
      ...(typeof body.timezone === 'string' ? { timezone: body.timezone.slice(0, 64) } : {}),
      ...(typeof body.dateFormat === 'string' ? { dateFormat: body.dateFormat.slice(0, 32) } : {}),
      ...(typeof body.sidebarCollapsed === 'boolean' ? { sidebarCollapsed: body.sidebarCollapsed } : {}),
    };

    await ctx.db
      .update(users)
      .set({ preferences: nextPrefs, updatedAt: new Date() })
      .where(eq(users.id, admin.id));

    return jsonResponse({ preferences: nextPrefs });
  });

  // Change own password
  router.post('/api/auth/change-password', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;

    const body = await readJsonBody<{ currentPassword?: string; newPassword?: string }>(ctx.request);
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';

    const userRows = await ctx.db.select().from(users).where(eq(users.id, admin.id)).limit(1);
    const userRow = userRows[0];
    if (!userRow?.passwordHash || !(await verifyPassword(currentPassword, userRow.passwordHash))) {
      return errorResponse(400, 'Current password is incorrect.');
    }

    const strength = validatePasswordStrength(newPassword);
    if (!strength.valid) {
      return errorResponse(400, strength.errors[0]);
    }

    const passwordHash = await hashPassword(newPassword);
    await ctx.db
      .update(users)
      .set({ passwordHash, passwordUpdatedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, admin.id));

    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'auth.password_changed',
      module: 'security',
      targetType: 'user',
      targetId: admin.id,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ updated: true });
  });

  // 2FA TOTP Setup
  router.post('/api/auth/2fa/setup', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;
    const secret = generateTotpSecret();
    const otpauthUri = buildOtpAuthUri(admin.email, secret);

    await ctx.db
      .update(users)
      .set({ twoFactorSecret: secret, updatedAt: new Date() })
      .where(eq(users.id, admin.id));

    return jsonResponse({ secret, otpauthUri });
  });

  // 2FA Verification
  router.post('/api/auth/2fa/verify', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;
    const body = await readJsonBody<{ code?: string }>(ctx.request);
    const code = sanitizeText(body.code, 16);

    const rows = await ctx.db.select().from(users).where(eq(users.id, admin.id)).limit(1);
    const userRow = rows[0];
    if (!userRow?.twoFactorSecret) {
      return errorResponse(400, '2FA setup has not been initiated.');
    }

    if (!(await verifyTotpToken(userRow.twoFactorSecret, code))) {
      await writeAuditLog(ctx.db, {
        actorId: admin.id,
        actorEmail: admin.email,
        action: 'auth.2fa_verify_failed',
        module: 'security',
        status: 'failure',
        ipAddress: ctx.clientIp,
        userAgent: ctx.userAgent,
      });
      return errorResponse(400, 'Invalid 6-digit TOTP code.');
    }

    await ctx.db
      .update(users)
      .set({ twoFactorEnabled: true, updatedAt: new Date() })
      .where(eq(users.id, admin.id));

    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'auth.2fa_enabled',
      module: 'security',
      targetType: 'user',
      targetId: admin.id,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ enabled: true });
  });

  // 2FA Disable
  router.post('/api/auth/2fa/disable', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;

    await ctx.db
      .update(users)
      .set({ twoFactorEnabled: false, twoFactorSecret: null, updatedAt: new Date() })
      .where(eq(users.id, admin.id));

    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'auth.2fa_disabled',
      module: 'security',
      targetType: 'user',
      targetId: admin.id,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ enabled: false });
  });

  // Logout (revoke active session + clear HttpOnly cookie)
  router.post('/api/auth/logout', async (ctx: WorkerContext) => {
    const rawToken = extractSessionToken(ctx.request);
    let actorId: number | null = null;
    let actorEmail = 'anonymous';

    if (rawToken) {
      const tokenHash = await computeSha256(rawToken);
      const sessRows = await ctx.db
        .select()
        .from(userSessions)
        .where(eq(userSessions.sessionHash, tokenHash))
        .limit(1);
      if (sessRows[0]) {
        actorId = sessRows[0].userId;
        const userRows = await ctx.db
          .select({ email: users.email })
          .from(users)
          .where(eq(users.id, sessRows[0].userId))
          .limit(1);
        actorEmail = userRows[0]?.email || 'user';
        await ctx.db
          .update(userSessions)
          .set({ isActive: false, revokedAt: new Date() })
          .where(eq(userSessions.id, sessRows[0].id));
      }
    }

    await writeAuditLog(ctx.db, {
      actorId,
      actorEmail,
      action: 'auth.logout',
      module: 'auth',
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    const secure = isHttpsRequest(ctx.request);
    return jsonResponse(
      { loggedOut: true },
      200,
      { 'Set-Cookie': clearSessionCookieHeader(secure) }
    );
  });

  // Real-time presence & recent activity snapshot (Cloudflare Worker compatible)
  router.get('/api/realtime/snapshot', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;

    const twoMinsAgo = new Date(Date.now() - 2 * 60_000);
    const now = new Date();
    const onlineUsers = await ctx.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.status, 'active'), gte(users.lastSeenAt, twoMinsAgo)));

    const activeSessRows = await ctx.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(userSessions)
      .where(and(eq(userSessions.isActive, true), gte(userSessions.expiresAt, now)));

    const latestAudit = await ctx.db
      .select({
        id: auditLogs.id,
        actorEmail: auditLogs.actorEmail,
        action: auditLogs.action,
        module: auditLogs.module,
        status: auditLogs.status,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(12);

    return jsonResponse({
      onlineUserIds: onlineUsers.map((u) => u.id),
      activeConnections: Number(activeSessRows[0]?.count ?? 0),
      serverTime: now.toISOString(),
      recentEvents: latestAudit.map((a) => ({
        type: 'audit.created',
        payload: a,
        receivedAt: new Date(a.createdAt).toISOString(),
      })),
    });
  });

  // Main Operational Dashboard Overview (100% SQLite / D1 real records)
  router.get('/api/dashboard/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'dashboard.read');
    if (permFail) return permFail;

    const start = Date.now();
    await ctx.env.DB.prepare('SELECT 1 AS ok').first();
    const dbLatencyMs = Date.now() - start;

    const now = new Date();
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const twoMinsAgo = new Date(Date.now() - 2 * 60_000);
    const fourteenDaysAgo = new Date(Date.now() - 14 * 86_400_000);

    const [
      allUsersRows,
      txRows,
      allApiLogs,
      jobRows,
      ticketRows,
      recentAudit,
      recentAlerts,
      layoutRows,
    ] = await Promise.all([
      ctx.db
        .select({
          id: users.id,
          status: users.status,
          lastSeenAt: users.lastSeenAt,
          createdAt: users.createdAt,
        })
        .from(users),
      ctx.db
        .select({
          status: transactions.status,
          amountCents: transactions.amountCents,
        })
        .from(transactions),
      ctx.db
        .select({
          statusCode: apiLogs.statusCode,
          durationMs: apiLogs.durationMs,
          createdAt: apiLogs.createdAt,
        })
        .from(apiLogs)
        .where(gte(apiLogs.createdAt, fourteenDaysAgo)),
      ctx.db
        .select({
          status: backgroundJobs.status,
        })
        .from(backgroundJobs),
      ctx.db
        .select({
          status: supportTickets.status,
        })
        .from(supportTickets),
      ctx.db
        .select()
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(12),
      ctx.db
        .select()
        .from(auditLogs)
        .where(
          sql`${auditLogs.status} IN ('failure', 'denied') OR ${auditLogs.module} = 'security'`
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(8),
      ctx.db
        .select()
        .from(savedViews)
        .where(
          and(
            eq(savedViews.userId, ctx.adminUser!.id),
            eq(savedViews.scope, 'dashboard_layout')
          )
        )
        .limit(1),
    ]);

    const totalUsers = allUsersRows.length;
    const activeUsers = allUsersRows.filter((u) => u.status === 'active').length;
    const suspendedUsers = allUsersRows.filter((u) => u.status === 'suspended').length;
    const newUsersToday = allUsersRows.filter(
      (u) => new Date(u.createdAt).getTime() >= todayStart.getTime()
    ).length;
    const onlineUsers = allUsersRows.filter(
      (u) => u.status === 'active' && u.lastSeenAt && new Date(u.lastSeenAt).getTime() >= twoMinsAgo.getTime()
    ).length;

    const totalTransactions = txRows.length;
    const succeededRevenueCents = txRows
      .filter((t) => t.status === 'succeeded')
      .reduce((acc, t) => acc + t.amountCents, 0);

    const totalRequests = allApiLogs.length;
    const successfulOps = allApiLogs.filter((l) => l.statusCode < 400).length;
    const failedOps = allApiLogs.filter((l) => l.statusCode >= 400).length;
    const avgLatencyMs =
      totalRequests > 0
        ? Math.round(allApiLogs.reduce((acc, l) => acc + l.durationMs, 0) / totalRequests)
        : 0;

    const failedJobs = jobRows.filter((j) => j.status === 'failed').length;
    const runningJobs = jobRows.filter((j) => j.status === 'queued' || j.status === 'running').length;

    // 14-day series aggregation
    const opsMap = new Map<string, { day: string; successCount: number; errorCount: number }>();
    for (const log of allApiLogs) {
      const day = toDayKey(log.createdAt);
      if (!day) continue;
      const entry = opsMap.get(day) ?? { day, successCount: 0, errorCount: 0 };
      if (log.statusCode < 400) entry.successCount += 1;
      else entry.errorCount += 1;
      opsMap.set(day, entry);
    }

    const signupMap = new Map<string, number>();
    for (const u of allUsersRows) {
      if (new Date(u.createdAt).getTime() < fourteenDaysAgo.getTime()) continue;
      const day = toDayKey(u.createdAt);
      if (!day) continue;
      signupMap.set(day, (signupMap.get(day) ?? 0) + 1);
    }

    const activeSessRows = await ctx.db
      .select({ count: sql<number>`cast(count(*) as integer)` })
      .from(userSessions)
      .where(and(eq(userSessions.isActive, true), gte(userSessions.expiresAt, now)));

    const openTickets = ticketRows.filter((t) => t.status === 'open' || t.status === 'pending').length;
    const errorRate = totalRequests > 0 ? Math.round((failedOps / totalRequests) * 1000) / 10 : 0;
    const activeSessionsCount = Number(activeSessRows[0]?.count ?? 0);
    const uptimeSeconds =
      typeof process !== 'undefined' && typeof process.uptime === 'function'
        ? Math.floor(process.uptime())
        : 0;

    return jsonResponse({
      kpis: {
        totalUsers,
        activeUsers,
        newUsersToday,
        onlineUsers,
        onlinePresenceSupported: true,
        suspendedUsers,
        totalTransactions,
        revenueCents: succeededRevenueCents,
        successfulOperations: successfulOps,
        failedOperations: failedOps,
        openTickets,
      },
      health: {
        system: {
          status: failedJobs > 0 || errorRate > 15 ? 'degraded' : 'healthy',
          memoryUsedPct: 0,
          uptimeSeconds,
          loadAvg1m: 0,
        },
        api: {
          status: errorRate > 25 ? 'degraded' : 'healthy',
          avgLatencyMs,
          activeSseConnections: activeSessionsCount,
        },
        database: {
          status: dbLatencyMs < 1000 ? 'healthy' : 'slow',
          latencyMs: dbLatencyMs,
          engine: 'Cloudflare D1 SQLite',
        },
        jobs: {
          failedJobs,
          runningJobs,
        },
      },
      recentActivities: recentAudit,
      criticalAlerts: recentAlerts,
      charts: {
        operationsByDay: Array.from(opsMap.values())
          .sort((a, b) => a.day.localeCompare(b.day))
          .map((d) => ({
            day: d.day,
            success_count: d.successCount,
            error_count: d.errorCount,
          })),
        signupsByDay: Array.from(signupMap.entries())
          .map(([day, signups]) => ({ day, signups }))
          .sort((a, b) => a.day.localeCompare(b.day)),
      },
      layout: layoutRows[0]?.config ?? null,
    });
  });

  // Save dashboard layout
  router.put('/api/dashboard/layout', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'dashboard.customize');
    if (permFail) return permFail;
    const admin = ctx.adminUser!;
    const body = await readJsonBody<{
      config?: { order?: string[]; hidden?: string[] };
      order?: string[];
      hidden?: string[];
    }>(ctx.request);
    const raw = body.config ?? body;
    const config = {
      order: Array.isArray(raw.order) ? raw.order : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden : [],
    };

    const existing = await ctx.db
      .select()
      .from(savedViews)
      .where(
        and(eq(savedViews.userId, admin.id), eq(savedViews.scope, 'dashboard_layout'))
      )
      .limit(1);

    if (existing.length > 0) {
      await ctx.db
        .update(savedViews)
        .set({ config, updatedAt: new Date() })
        .where(eq(savedViews.id, existing[0].id));
    } else {
      await ctx.db.insert(savedViews).values({
        userId: admin.id,
        scope: 'dashboard_layout',
        name: 'Default Dashboard',
        config,
      });
    }

    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'dashboard.layout_saved',
      module: 'overview',
      details: config,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ saved: true, config });
  });

  // Global search across permitted entities (SQLite case-insensitive LIKE)
  router.get('/api/search', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const admin = ctx.adminUser!;

    const q = sanitizeText(ctx.url.searchParams.get('q') || '', 80).toLowerCase();
    const type = sanitizeText(ctx.url.searchParams.get('type') || 'all', 30);
    if (!q) {
      return jsonResponse({ results: [] });
    }

    const pattern = `%${q}%`;
    const results: Array<{
      id: string;
      entityId: string | number;
      type: string;
      title: string;
      subtitle: string;
      targetView: string;
    }> = [];

    if ((type === 'all' || type === 'users') && hasPermission(admin.permissions, 'users.read')) {
      const rows = await ctx.db
        .select({
          id: users.id,
          email: users.email,
          displayName: users.displayName,
          status: users.status,
        })
        .from(users)
        .where(
          sql`lower(${users.email}) LIKE ${pattern} OR lower(${users.displayName}) LIKE ${pattern}`
        )
        .limit(6);
      for (const u of rows) {
        results.push({
          id: `user-${u.id}`,
          entityId: u.id,
          type: 'user',
          title: u.displayName || u.email,
          subtitle: `${u.email} · ${u.status}`,
          targetView: `user-detail:${u.id}`,
        });
      }
    }

    if ((type === 'all' || type === 'content') && hasPermission(admin.permissions, 'content.read')) {
      const rows = await ctx.db
        .select({
          id: contentItems.id,
          title: contentItems.title,
          status: contentItems.status,
        })
        .from(contentItems)
        .where(
          sql`lower(${contentItems.title}) LIKE ${pattern} OR lower(${contentItems.slug}) LIKE ${pattern}`
        )
        .limit(6);
      for (const c of rows) {
        results.push({
          id: `content-${c.id}`,
          entityId: c.id,
          type: 'content',
          title: c.title,
          subtitle: `Status: ${c.status}`,
          targetView: 'content-all',
        });
      }
    }

    if ((type === 'all' || type === 'transactions') && hasPermission(admin.permissions, 'finance.read')) {
      const rows = await ctx.db
        .select({
          id: transactions.id,
          reference: transactions.reference,
          amountCents: transactions.amountCents,
          currency: transactions.currency,
          status: transactions.status,
        })
        .from(transactions)
        .where(sql`lower(${transactions.reference}) LIKE ${pattern}`)
        .limit(6);
      for (const t of rows) {
        results.push({
          id: `tx-${t.id}`,
          entityId: t.id,
          type: 'transaction',
          title: t.reference,
          subtitle: `${(t.amountCents / 100).toFixed(2)} ${t.currency} · ${t.status}`,
          targetView: 'finance-transactions',
        });
      }
    }

    if ((type === 'all' || type === 'tickets') && hasPermission(admin.permissions, 'support.read')) {
      const rows = await ctx.db
        .select({
          id: supportTickets.id,
          ticketNumber: supportTickets.ticketNumber,
          subject: supportTickets.subject,
          status: supportTickets.status,
        })
        .from(supportTickets)
        .where(
          sql`lower(${supportTickets.ticketNumber}) LIKE ${pattern} OR lower(${supportTickets.subject}) LIKE ${pattern}`
        )
        .limit(6);
      for (const tk of rows) {
        results.push({
          id: `ticket-${tk.id}`,
          entityId: tk.id,
          type: 'ticket',
          title: `${tk.ticketNumber}: ${tk.subject}`,
          subtitle: `Status: ${tk.status}`,
          targetView: 'support-tickets',
        });
      }
    }

    if ((type === 'all' || type === 'notifications') && hasPermission(admin.permissions, 'notifications.read')) {
      const rows = await ctx.db
        .select({
          id: notifications.id,
          title: notifications.title,
          channel: notifications.channel,
          status: notifications.status,
        })
        .from(notifications)
        .where(sql`lower(${notifications.title}) LIKE ${pattern}`)
        .limit(5);
      for (const n of rows) {
        results.push({
          id: `notif-${n.id}`,
          entityId: n.id,
          type: 'notification',
          title: n.title,
          subtitle: `${n.channel} · ${n.status}`,
          targetView: 'notifications-all',
        });
      }
    }

    if ((type === 'all' || type === 'settings') && hasPermission(admin.permissions, 'settings.read')) {
      const rows = await ctx.db
        .select({
          key: systemSettings.key,
          category: systemSettings.category,
          description: systemSettings.description,
        })
        .from(systemSettings)
        .where(
          sql`lower(${systemSettings.key}) LIKE ${pattern} OR lower(${systemSettings.description}) LIKE ${pattern}`
        )
        .limit(5);
      for (const s of rows) {
        results.push({
          id: `setting-${s.key}`,
          entityId: s.key,
          type: 'setting',
          title: s.key,
          subtitle: s.description || s.category,
          targetView: 'settings-general',
        });
      }
    }

    if ((type === 'all' || type === 'logs') && hasPermission(admin.permissions, 'audit.read')) {
      const rows = await ctx.db
        .select({
          id: auditLogs.id,
          action: auditLogs.action,
          actorEmail: auditLogs.actorEmail,
          module: auditLogs.module,
        })
        .from(auditLogs)
        .where(
          sql`lower(${auditLogs.action}) LIKE ${pattern} OR lower(${auditLogs.actorEmail}) LIKE ${pattern}`
        )
        .orderBy(desc(auditLogs.createdAt))
        .limit(5);
      for (const l of rows) {
        results.push({
          id: `audit-${l.id}`,
          entityId: l.id,
          type: 'audit',
          title: l.action,
          subtitle: `${l.actorEmail} · ${l.module}`,
          targetView: 'audit-admin',
        });
      }
    }

    return jsonResponse({ results });
  });
}
