import { eq } from 'drizzle-orm';
import type { AegisDatabase } from '../db/index.ts';
import {
  permissions,
  rolePermissions,
  roles,
  systemSettings,
  userPermissionOverrides,
  userSessions,
  users,
} from '../db/schema.ts';
import { ensureSystemSeeded } from '../db/seed.ts';
import { hasPermission, resolveEffectivePermissions } from '../lib/rbac.ts';
import { computeSha256, generateSessionToken, isIpAllowed } from '../lib/security.ts';
import { writeAuditLog } from './audit.ts';
import { errorResponse, parseCookies, SESSION_COOKIE_NAME } from './http.ts';
import type { AuthenticatedAdmin, WorkerContext } from './types.ts';

export function parseUserAgent(ua: string): { deviceName: string; browser: string; os: string } {
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : ua.includes('Chrome/')
      ? 'Chrome'
      : ua.includes('Firefox/')
        ? 'Firefox'
        : ua.includes('Safari/')
          ? 'Safari'
          : 'Unknown';
  const os = ua.includes('Windows')
    ? 'Windows'
    : ua.includes('Mac OS')
      ? 'macOS'
      : ua.includes('Linux')
        ? 'Linux'
        : ua.includes('Android')
          ? 'Android'
          : ua.includes('iPhone') || ua.includes('iPad')
            ? 'iOS'
            : 'Unknown';
  const deviceName = ua.includes('Mobile') ? 'Mobile Browser' : 'Desktop Browser';
  return { deviceName, browser, os };
}

export function extractSessionToken(request: Request): string | null {
  const cookies = parseCookies(request);
  if (cookies[SESSION_COOKIE_NAME]) {
    return cookies[SESSION_COOKIE_NAME];
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token) return token;
  }
  return null;
}

export async function createUserSession(
  db: AegisDatabase,
  userId: number,
  clientIp: string,
  userAgent: string,
  timeoutMinutes = 480
): Promise<{ rawToken: string; sessionId: number; expiresAt: Date }> {
  const rawToken = generateSessionToken();
  const sessionHash = await computeSha256(rawToken);
  const { deviceName, browser, os } = parseUserAgent(userAgent);
  const expiresAt = new Date(Date.now() + Math.max(15, timeoutMinutes) * 60_000);

  const inserted = await db
    .insert(userSessions)
    .values({
      userId,
      sessionHash,
      deviceName,
      browser,
      os,
      ipAddress: clientIp,
      userAgent: userAgent.slice(0, 300),
      isActive: true,
      lastActivityAt: new Date(),
      expiresAt,
    })
    .returning();

  return { rawToken, sessionId: inserted[0].id, expiresAt };
}

export async function loadAuthenticatedAdmin(ctx: WorkerContext): Promise<AuthenticatedAdmin> {
  await ensureSystemSeeded(ctx.db, ctx.env.GITHUB_DEFAULT_REPO || '');
  const rawToken = extractSessionToken(ctx.request);
  if (!rawToken) {
    throw new Error('MISSING_SESSION');
  }

  const sessionHash = await computeSha256(rawToken);
  const sessionRows = await ctx.db
    .select()
    .from(userSessions)
    .where(eq(userSessions.sessionHash, sessionHash))
    .limit(1);

  const session = sessionRows[0];
  if (!session) {
    throw new Error('INVALID_SESSION');
  }
  if (!session.isActive || session.revokedAt) {
    throw new Error('SESSION_REVOKED');
  }
  if (new Date(session.expiresAt).getTime() <= Date.now()) {
    await ctx.db
      .update(userSessions)
      .set({ isActive: false, revokedAt: new Date() })
      .where(eq(userSessions.id, session.id));
    throw new Error('SESSION_EXPIRED');
  }

  const userRows = await ctx.db
    .select()
    .from(users)
    .where(eq(users.id, session.userId))
    .limit(1);

  const userRow = userRows[0];
  if (!userRow) {
    throw new Error('USER_NOT_FOUND');
  }

  if (
    userRow.status === 'suspended' ||
    userRow.status === 'banned' ||
    userRow.status === 'deleted' ||
    userRow.status === 'inactive'
  ) {
    throw new Error(`ACCOUNT_${userRow.status.toUpperCase()}`);
  }

  // Enforce global IP allowlist
  const ipSettingRows = await ctx.db
    .select()
    .from(systemSettings)
    .where(eq(systemSettings.key, 'security.ipAllowlist'))
    .limit(1);
  const globalAllowlist = Array.isArray(ipSettingRows[0]?.value)
    ? (ipSettingRows[0].value as string[])
    : [];
  if (!isIpAllowed(ctx.clientIp, globalAllowlist)) {
    await writeAuditLog(ctx.db, {
      actorId: userRow.id,
      actorEmail: userRow.email,
      action: 'auth.ip_denied',
      module: 'security',
      status: 'denied',
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });
    throw new Error('IP_RESTRICTED');
  }

  // Enforce user-level IP allowlist
  const userIpAllow = userRow.restrictions?.ipAllowlist;
  if (userIpAllow && userIpAllow.length > 0 && !isIpAllowed(ctx.clientIp, userIpAllow)) {
    throw new Error('IP_RESTRICTED');
  }

  // Load role permissions & user overrides
  let roleSlug = 'support_agent';
  let roleName = 'Support Agent';
  let hierarchyLevel = 20;
  let rolePerms: string[] = [];

  if (userRow.roleId) {
    const roleRows = await ctx.db
      .select()
      .from(roles)
      .where(eq(roles.id, userRow.roleId))
      .limit(1);
    const roleRow = roleRows[0];
    if (roleRow) {
      roleSlug = roleRow.slug;
      roleName = roleRow.name;
      hierarchyLevel = roleRow.hierarchyLevel;
      const rpRows = await ctx.db
        .select({ key: permissions.key })
        .from(rolePermissions)
        .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
        .where(eq(rolePermissions.roleId, roleRow.id));
      rolePerms = rpRows.map((r) => r.key);
    }
  }

  const overrideRows = await ctx.db
    .select({
      key: permissions.key,
      granted: userPermissionOverrides.granted,
    })
    .from(userPermissionOverrides)
    .innerJoin(permissions, eq(userPermissionOverrides.permissionId, permissions.id))
    .where(eq(userPermissionOverrides.userId, userRow.id));

  const effective = resolveEffectivePermissions(rolePerms, overrideRows, roleSlug);

  // Update presence & activity timestamps
  const now = new Date();
  await ctx.db
    .update(users)
    .set({ lastSeenAt: now, lastIp: ctx.clientIp || userRow.lastIp })
    .where(eq(users.id, userRow.id));
  await ctx.db
    .update(userSessions)
    .set({ lastActivityAt: now })
    .where(eq(userSessions.id, session.id));

  return {
    id: userRow.id,
    uid: userRow.uid,
    email: userRow.email,
    displayName: userRow.displayName || userRow.email.split('@')[0],
    avatarUrl: userRow.avatarUrl || '',
    status: userRow.status,
    roleId: userRow.roleId,
    roleSlug,
    roleName,
    hierarchyLevel,
    twoFactorEnabled: Boolean(userRow.twoFactorEnabled),
    permissions: effective,
    preferences: (userRow.preferences ?? {}) as Record<string, unknown>,
    sessionId: session.id,
  };
}

export async function requireAuth(ctx: WorkerContext): Promise<Response | null> {
  try {
    ctx.adminUser = await loadAuthenticatedAdmin(ctx);
    return null;
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'UNAUTHORIZED';
    if (msg.startsWith('ACCOUNT_')) {
      return errorResponse(403, `Account access blocked (${msg.replace('ACCOUNT_', '').toLowerCase()}).`);
    }
    if (msg === 'IP_RESTRICTED') {
      return errorResponse(403, 'Access denied: Client IP address is not in the allowlist.');
    }
    if (msg === 'SESSION_REVOKED') {
      return errorResponse(401, 'Session has been revoked. Please sign in again.');
    }
    if (msg === 'SESSION_EXPIRED') {
      return errorResponse(401, 'Session expired. Please sign in again.');
    }
    return errorResponse(401, 'Unauthorized: Active administrator session required.');
  }
}

export async function requirePermission(
  ctx: WorkerContext,
  required: string | string[]
): Promise<Response | null> {
  if (!ctx.adminUser) {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
  }
  const admin = ctx.adminUser!;
  if (!hasPermission(admin.permissions, required)) {
    await writeAuditLog(ctx.db, {
      actorId: admin.id,
      actorEmail: admin.email,
      action: 'permission.denied',
      module: 'security',
      targetType: 'endpoint',
      targetId: ctx.url.pathname,
      details: { required },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
      status: 'denied',
    });
    return errorResponse(403, 'Forbidden: Insufficient permissions for this operation.');
  }
  return null;
}
