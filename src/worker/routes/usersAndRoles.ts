import { and, asc, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  auditLogs,
  notifications,
  permissions,
  rolePermissions,
  roles,
  supportTickets,
  transactions,
  userNotes,
  userPermissionOverrides,
  userSessions,
  users,
} from '../../db/schema.ts';
import { parseCsv, toCsv } from '../../lib/csv.ts';
import { canManageRole } from '../../lib/rbac.ts';
import {
  generateUid,
  hashPassword,
  sanitizeText,
  validatePasswordStrength,
} from '../../lib/security.ts';
import { isValidEmail, isValidUserStatus, parsePaginationQuery, slugify } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

export function registerUsersAndRolesRoutes(router: WorkerRouter): void {
  // List users with real pagination, filtering, sorting
  router.get('/api/users', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(
      q,
      ['createdAt', 'email', 'displayName', 'status', 'lastSeenAt'],
      'createdAt'
    );
    const segment = sanitizeText(
      q.segment ||
        (q.online === 'true'
          ? 'online'
          : q.newToday === 'true'
            ? 'new'
            : q.status || 'all'),
      30
    );

    const conditions: SQL[] = [];
    if (segment === 'deleted') {
      conditions.push(eq(users.status, 'deleted'));
    } else {
      conditions.push(sql`${users.status} != 'deleted'`);
      if (segment === 'active' || segment === 'inactive' || segment === 'suspended' || segment === 'banned') {
        conditions.push(eq(users.status, segment));
      } else if (segment === 'new') {
        const now = new Date();
        const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
        conditions.push(sql`${users.createdAt} >= ${todayStartMs}`);
      } else if (segment === 'online') {
        const cutoffMs = Date.now() - 2 * 60_000;
        conditions.push(and(eq(users.status, 'active'), sql`${users.lastSeenAt} >= ${cutoffMs}`)!);
      } else if (segment === 'unverified') {
        conditions.push(eq(users.emailVerified, false));
      }
    }

    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${users.email}) LIKE ${pattern} OR lower(${users.displayName}) LIKE ${pattern} OR lower(${users.department}) LIKE ${pattern})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const orderCol =
      params.sortBy === 'email'
        ? users.email
        : params.sortBy === 'displayName'
          ? users.displayName
          : params.sortBy === 'status'
            ? users.status
            : params.sortBy === 'lastSeenAt'
              ? users.lastSeenAt
              : users.createdAt;
    const orderExpr = params.sortDir === 'asc' ? asc(orderCol) : desc(orderCol);

    const [totalRows, dataRows] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`cast(count(*) as integer)` })
        .from(users)
        .where(whereClause),
      ctx.db
        .select({
          id: users.id,
          uid: users.uid,
          email: users.email,
          displayName: users.displayName,
          department: users.department,
          jobTitle: users.jobTitle,
          status: users.status,
          roleId: users.roleId,
          roleName: roles.name,
          roleSlug: roles.slug,
          emailVerified: users.emailVerified,
          twoFactorEnabled: users.twoFactorEnabled,
          lastSeenAt: users.lastSeenAt,
          lastLoginAt: users.lastLoginAt,
          lastIp: users.lastIp,
          country: users.country,
          tags: users.tags,
          createdAt: users.createdAt,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .where(whereClause)
        .orderBy(orderExpr)
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
    ]);

    const twoMinsAgo = Date.now() - 2 * 60_000;
    const onlineIds = dataRows
      .filter((u) => u.lastSeenAt && new Date(u.lastSeenAt).getTime() >= twoMinsAgo)
      .map((u) => u.id);

    return jsonResponse({
      data: dataRows,
      total: Number(totalRows[0]?.total ?? 0),
      page: params.page,
      pageSize: params.pageSize,
      onlineUserIds: onlineIds,
    });
  });

  // CSV Export with formula injection mitigation
  router.get('/api/users/export.csv', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.export');
    if (permFail) return permFail;

    const rows = await ctx.db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        department: users.department,
        jobTitle: users.jobTitle,
        status: users.status,
        roleSlug: roles.slug,
        emailVerified: users.emailVerified,
        twoFactorEnabled: users.twoFactorEnabled,
        lastLoginAt: users.lastLoginAt,
        createdAt: users.createdAt,
      })
      .from(users)
      .leftJoin(roles, eq(users.roleId, roles.id))
      .orderBy(desc(users.createdAt));

    const csv = toCsv(
      ['id', 'email', 'displayName', 'department', 'jobTitle', 'status', 'role', 'emailVerified', 'twoFactorEnabled', 'lastLoginAt', 'createdAt'],
      rows.map((r) => ({
        id: r.id,
        email: r.email,
        displayName: r.displayName,
        department: r.department,
        jobTitle: r.jobTitle,
        status: r.status,
        role: r.roleSlug || '',
        emailVerified: r.emailVerified,
        twoFactorEnabled: r.twoFactorEnabled,
        lastLoginAt: r.lastLoginAt ? new Date(r.lastLoginAt).toISOString() : '',
        createdAt: new Date(r.createdAt).toISOString(),
      }))
    );

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'users.exported_csv',
      module: 'users',
      details: { count: rows.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return new Response(csv, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="aegis-users-export.csv"',
      },
    });
  });

  // Create user record (with optional password hashed via PBKDF2)
  router.post('/api/users', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.write');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      email?: string;
      displayName?: string;
      password?: string;
      department?: string;
      jobTitle?: string;
      roleId?: number;
      phone?: string;
      country?: string;
    }>(ctx.request);

    const email = sanitizeText(body.email, 160).toLowerCase();
    if (!isValidEmail(email)) {
      return errorResponse(400, 'Please enter a valid email address.');
    }

    const existing = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return errorResponse(409, 'A user with this email already exists.');
    }

    let passwordHash: string | null = null;
    if (typeof body.password === 'string' && body.password.length > 0) {
      const check = validatePasswordStrength(body.password);
      if (!check.valid) {
        return errorResponse(400, check.errors[0]);
      }
      passwordHash = await hashPassword(body.password);
    }

    let roleId: number | null = Number(body.roleId) || null;
    if (roleId) {
      const targetRole = await ctx.db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
      if (!targetRole[0]) {
        return errorResponse(400, 'Selected role does not exist.');
      }
      if (
        !canManageRole(
          ctx.adminUser!.hierarchyLevel,
          targetRole[0].hierarchyLevel,
          ctx.adminUser!.roleSlug === 'super_admin'
        )
      ) {
        return errorResponse(403, 'Cannot assign a role equal to or higher than your own.');
      }
    } else {
      const defaultRole = await ctx.db.select().from(roles).where(eq(roles.slug, 'support_agent')).limit(1);
      roleId = defaultRole[0]?.id ?? null;
    }

    const created = await ctx.db
      .insert(users)
      .values({
        uid: generateUid('usr'),
        email,
        passwordHash,
        passwordUpdatedAt: passwordHash ? new Date() : null,
        displayName: sanitizeText(body.displayName, 120) || email.split('@')[0],
        department: sanitizeText(body.department, 80),
        jobTitle: sanitizeText(body.jobTitle, 80),
        phone: sanitizeText(body.phone, 40),
        country: sanitizeText(body.country, 64),
        roleId,
        status: 'active',
        isAdmin: false,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'user.created',
      module: 'users',
      targetType: 'user',
      targetId: created[0].id,
      details: { email, roleId, passwordSet: Boolean(passwordHash) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ user: created[0] }, 201);
  });

  // Bulk Import Users from CSV
  router.post('/api/users/import', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.import');
    if (permFail) return permFail;

    const body = await readJsonBody<{ csvText?: string; csv?: string }>(ctx.request);
    const csvText =
      typeof body.csvText === 'string'
        ? body.csvText
        : typeof body.csv === 'string'
          ? body.csv
          : '';
    const parsed = parseCsv(csvText);
    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      return errorResponse(400, 'CSV must include a header row and at least one data row.');
    }

    const headerMap = new Map(parsed.headers.map((h) => [h.trim().toLowerCase(), h]));
    const emailCol = headerMap.get('email');
    if (!emailCol) {
      return errorResponse(400, 'CSV header must include an "email" column.');
    }
    const nameCol = headerMap.get('displayname') ?? headerMap.get('name');
    const deptCol = headerMap.get('department');
    const roleCol = headerMap.get('role');

    const allRoles = await ctx.db.select().from(roles);
    const roleBySlug = new Map(allRoles.map((r) => [r.slug, r]));

    let imported = 0;
    const errors: string[] = [];

    for (let i = 0; i < parsed.rows.length; i++) {
      const r = parsed.rows[i];
      const email = sanitizeText(r[emailCol] || '', 160).toLowerCase();
      if (!isValidEmail(email)) {
        errors.push(`Row ${i + 2}: invalid email "${email}"`);
        continue;
      }
      const existing = await ctx.db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
      if (existing.length > 0) {
        errors.push(`Row ${i + 2}: duplicate email "${email}"`);
        continue;
      }
      const reqRoleSlug = roleCol ? sanitizeText(r[roleCol] || '', 50) : 'support_agent';
      const targetRole = roleBySlug.get(reqRoleSlug) ?? roleBySlug.get('support_agent');
      if (
        targetRole &&
        !canManageRole(
          ctx.adminUser!.hierarchyLevel,
          targetRole.hierarchyLevel,
          ctx.adminUser!.roleSlug === 'super_admin'
        )
      ) {
        errors.push(`Row ${i + 2}: insufficient hierarchy for role "${reqRoleSlug}"`);
        continue;
      }

      await ctx.db.insert(users).values({
        uid: generateUid('imp'),
        email,
        displayName: nameCol ? sanitizeText(r[nameCol], 120) : email.split('@')[0],
        department: deptCol ? sanitizeText(r[deptCol], 80) : '',
        roleId: targetRole?.id ?? null,
        status: 'active',
      });
      imported++;
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'users.imported_csv',
      module: 'users',
      details: { imported, errorCount: errors.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ imported, errors });
  });

  // Bulk Actions on Users
  router.post('/api/users/bulk', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, ['users.suspend', 'users.delete']);
    if (permFail) return permFail;

    const body = await readJsonBody<{ userIds?: number[]; action?: string }>(ctx.request);
    const userIds = Array.isArray(body.userIds)
      ? body.userIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];
    const action = sanitizeText(body.action || '', 30);

    if (userIds.length === 0) {
      return errorResponse(400, 'No user IDs selected.');
    }

    const filteredIds = userIds.filter((id) => id !== ctx.adminUser!.id);
    if (filteredIds.length === 0) {
      return errorResponse(400, 'Cannot apply destructive bulk actions to your own active account.');
    }

    const statusMap: Record<string, string> = {
      activate: 'active',
      deactivate: 'inactive',
      suspend: 'suspended',
      ban: 'banned',
      delete: 'deleted',
      restore: 'active',
    };

    const nextStatus = statusMap[action];
    if (!nextStatus) {
      return errorResponse(400, 'Invalid bulk action.');
    }

    await ctx.db
      .update(users)
      .set({
        status: nextStatus,
        deletedAt: nextStatus === 'deleted' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(inArray(users.id, filteredIds));

    if (nextStatus === 'suspended' || nextStatus === 'banned' || nextStatus === 'deleted') {
      await ctx.db
        .update(userSessions)
        .set({ isActive: false, revokedAt: new Date() })
        .where(and(inArray(userSessions.userId, filteredIds), eq(userSessions.isActive, true)));
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: `users.bulk_${action}`,
      module: 'users',
      details: { count: filteredIds.length, userIds: filteredIds },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ updatedCount: filteredIds.length, status: nextStatus });
  });

  // Get single user complete 14-tab profile & telemetry
  router.get('/api/users/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.read');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    if (!Number.isInteger(userId) || userId <= 0) {
      return errorResponse(400, 'Invalid user ID.');
    }

    const userRows = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const userRow = userRows[0];
    if (!userRow) {
      return errorResponse(404, 'User not found.');
    }

    const [
      roleRows,
      sessions,
      notes,
      activity,
      userNotifs,
      userTickets,
      userTx,
      overrides,
    ] = await Promise.all([
      userRow.roleId
        ? ctx.db.select().from(roles).where(eq(roles.id, userRow.roleId)).limit(1)
        : Promise.resolve([]),
      ctx.db
        .select()
        .from(userSessions)
        .where(eq(userSessions.userId, userId))
        .orderBy(desc(userSessions.createdAt))
        .limit(25),
      ctx.db
        .select()
        .from(userNotes)
        .where(eq(userNotes.userId, userId))
        .orderBy(desc(userNotes.createdAt))
        .limit(50),
      ctx.db
        .select()
        .from(auditLogs)
        .where(sql`${auditLogs.actorId} = ${userId} OR ${auditLogs.targetId} = ${String(userId)}`)
        .orderBy(desc(auditLogs.createdAt))
        .limit(50),
      ctx.db
        .select()
        .from(notifications)
        .where(eq(notifications.targetUserId, userId))
        .orderBy(desc(notifications.createdAt))
        .limit(25),
      ctx.db
        .select()
        .from(supportTickets)
        .where(eq(supportTickets.userId, userId))
        .orderBy(desc(supportTickets.createdAt))
        .limit(25),
      ctx.db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, userId))
        .orderBy(desc(transactions.createdAt))
        .limit(25),
      ctx.db
        .select({
          permissionId: userPermissionOverrides.permissionId,
          key: permissions.key,
          granted: userPermissionOverrides.granted,
          reason: userPermissionOverrides.reason,
        })
        .from(userPermissionOverrides)
        .innerJoin(permissions, eq(userPermissionOverrides.permissionId, permissions.id))
        .where(eq(userPermissionOverrides.userId, userId)),
    ]);

    const rolePermRows = roleRows[0]
      ? await ctx.db
          .select({ key: permissions.key })
          .from(rolePermissions)
          .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
          .where(eq(rolePermissions.roleId, roleRows[0].id))
      : [];

    const safeUser = {
      id: userRow.id,
      uid: userRow.uid,
      email: userRow.email,
      displayName: userRow.displayName,
      avatarUrl: userRow.avatarUrl,
      phone: userRow.phone,
      department: userRow.department,
      jobTitle: userRow.jobTitle,
      roleId: userRow.roleId,
      roleName: roleRows[0]?.name ?? null,
      roleSlug: roleRows[0]?.slug ?? null,
      status: userRow.status,
      isAdmin: userRow.isAdmin,
      emailVerified: userRow.emailVerified,
      twoFactorEnabled: userRow.twoFactorEnabled,
      failedLoginAttempts: userRow.failedLoginAttempts,
      lastSeenAt: userRow.lastSeenAt,
      lastLoginAt: userRow.lastLoginAt,
      lastIp: userRow.lastIp,
      country: userRow.country,
      tags: userRow.tags,
      restrictions: userRow.restrictions,
      preferences: userRow.preferences,
      createdAt: userRow.createdAt,
      updatedAt: userRow.updatedAt,
    };

    const isOnline = Boolean(
      userRow.status === 'active' &&
        userRow.lastSeenAt &&
        Date.now() - new Date(userRow.lastSeenAt).getTime() < 2 * 60_000
    );

    const noteAuthorIds = Array.from(
      new Set(notes.map((n) => n.authorId).filter((id): id is number => typeof id === 'number'))
    );
    const noteAuthors =
      noteAuthorIds.length > 0
        ? await ctx.db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(inArray(users.id, noteAuthorIds))
        : [];
    const authorEmailById = new Map(noteAuthors.map((a) => [a.id, a.email]));

    const loginHistory = activity.filter((a) => a.module === 'auth' || a.action.includes('login'));

    return jsonResponse({
      user: safeUser,
      isOnline,
      role: roleRows[0] ?? null,
      sessions,
      notes: notes.map((n) => ({
        ...n,
        authorEmail: n.authorId ? (authorEmailById.get(n.authorId) ?? null) : null,
      })),
      activity,
      activityHistory: activity,
      auditHistory: activity,
      loginHistory,
      notifications: userNotifs,
      tickets: userTickets,
      transactions: userTx,
      overrides: overrides.map((o) => ({
        id: o.permissionId,
        permissionId: o.permissionId,
        permissionKey: o.key,
        key: o.key,
        granted: o.granted,
        reason: o.reason,
      })),
      rolePermissions: rolePermRows.map((r) => r.key),
    });
  });

  // Update user details, role, restrictions, tags, verification, or admin password reset
  router.patch('/api/users/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.write');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    const existingRows = await ctx.db.select().from(users).where(eq(users.id, userId)).limit(1);
    const target = existingRows[0];
    if (!target) {
      return errorResponse(404, 'User not found.');
    }

    const body = await readJsonBody<{
      displayName?: string;
      department?: string;
      jobTitle?: string;
      phone?: string;
      country?: string;
      emailVerified?: boolean;
      tags?: string[];
      restrictions?: Record<string, unknown>;
      roleId?: number;
      newPassword?: string;
    }>(ctx.request);

    let nextRoleId = target.roleId;
    if (body.roleId !== undefined && Number(body.roleId) !== target.roleId) {
      const rolePermCheck = await requirePermission(ctx, 'roles.manage');
      if (rolePermCheck) return rolePermCheck;

      const roleRows = await ctx.db.select().from(roles).where(eq(roles.id, Number(body.roleId))).limit(1);
      if (!roleRows[0]) {
        return errorResponse(400, 'Target role not found.');
      }
      if (
        !canManageRole(
          ctx.adminUser!.hierarchyLevel,
          roleRows[0].hierarchyLevel,
          ctx.adminUser!.roleSlug === 'super_admin'
        )
      ) {
        return errorResponse(403, 'Cannot assign a role at or above your hierarchy level.');
      }
      nextRoleId = roleRows[0].id;
    }

    let passwordUpdate: { passwordHash?: string; passwordUpdatedAt?: Date } = {};
    if (typeof body.newPassword === 'string' && body.newPassword.length > 0) {
      const policyCheck = validatePasswordStrength(body.newPassword);
      if (!policyCheck.valid) {
        return errorResponse(400, policyCheck.errors[0]);
      }
      passwordUpdate = {
        passwordHash: await hashPassword(body.newPassword),
        passwordUpdatedAt: new Date(),
      };
    }

    const updated = await ctx.db
      .update(users)
      .set({
        displayName: body.displayName !== undefined ? sanitizeText(body.displayName, 120) : target.displayName,
        department: body.department !== undefined ? sanitizeText(body.department, 80) : target.department,
        jobTitle: body.jobTitle !== undefined ? sanitizeText(body.jobTitle, 80) : target.jobTitle,
        phone: body.phone !== undefined ? sanitizeText(body.phone, 40) : target.phone,
        country: body.country !== undefined ? sanitizeText(body.country, 64) : target.country,
        emailVerified: typeof body.emailVerified === 'boolean' ? body.emailVerified : target.emailVerified,
        tags: Array.isArray(body.tags) ? body.tags.map((t) => sanitizeText(t, 40)).filter(Boolean) : target.tags,
        restrictions: body.restrictions ? (body.restrictions as typeof target.restrictions) : target.restrictions,
        roleId: nextRoleId,
        ...passwordUpdate,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: passwordUpdate.passwordHash ? 'user.password_reset_by_admin' : 'user.updated',
      module: 'users',
      targetType: 'user',
      targetId: userId,
      details: { roleChanged: nextRoleId !== target.roleId, passwordReset: Boolean(passwordUpdate.passwordHash) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ user: updated[0] });
  });

  // Change account status
  router.post('/api/users/:id/status', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.suspend');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    if (userId === ctx.adminUser!.id) {
      return errorResponse(400, 'You cannot suspend, ban, or delete your own active session account.');
    }

    const body = await readJsonBody<{ status?: string; reason?: string }>(ctx.request);
    const status = sanitizeText(body.status || '', 30);
    if (!isValidUserStatus(status)) {
      return errorResponse(400, 'Invalid account status.');
    }
    if (status === 'deleted') {
      const delPermFail = await requirePermission(ctx, 'users.delete');
      if (delPermFail) return delPermFail;
    }

    const updated = await ctx.db
      .update(users)
      .set({
        status,
        deletedAt: status === 'deleted' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId))
      .returning();

    if (updated.length === 0) {
      return errorResponse(404, 'User not found.');
    }

    if (status === 'suspended' || status === 'banned' || status === 'deleted') {
      await ctx.db
        .update(userSessions)
        .set({ isActive: false, revokedAt: new Date() })
        .where(and(eq(userSessions.userId, userId), eq(userSessions.isActive, true)));
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: `user.status_${status}`,
      module: 'users',
      targetType: 'user',
      targetId: userId,
      details: { reason: sanitizeText(body.reason, 300) },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ user: updated[0] });
  });

  // Force logout
  router.post('/api/users/:id/force-logout', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.suspend');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    await ctx.db
      .update(userSessions)
      .set({ isActive: false, revokedAt: new Date() })
      .where(and(eq(userSessions.userId, userId), eq(userSessions.isActive, true)));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'user.force_logout',
      module: 'security',
      targetType: 'user',
      targetId: userId,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ revoked: true });
  });

  // Add internal user note
  router.post('/api/users/:id/notes', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'users.write');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    const body = await readJsonBody<{ note?: string }>(ctx.request);
    const note = sanitizeText(body.note, 2000);
    if (!note) {
      return errorResponse(400, 'Note text is required.');
    }

    const created = await ctx.db
      .insert(userNotes)
      .values({ userId, authorId: ctx.adminUser!.id, note, isInternal: true })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'user.note_added',
      module: 'users',
      targetType: 'user',
      targetId: userId,
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ note: created[0] }, 201);
  });

  // Single permission override (used by UserDetailPage)
  router.post('/api/users/:id/permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    const body = await readJsonBody<{
      permissionId?: number;
      granted?: boolean | null;
      reason?: string;
    }>(ctx.request);
    const permissionId = Number(body.permissionId);
    if (!Number.isInteger(permissionId) || permissionId <= 0) {
      return errorResponse(400, 'Valid permissionId is required.');
    }

    await ctx.db
      .delete(userPermissionOverrides)
      .where(
        and(
          eq(userPermissionOverrides.userId, userId),
          eq(userPermissionOverrides.permissionId, permissionId)
        )
      );

    if (typeof body.granted === 'boolean') {
      await ctx.db.insert(userPermissionOverrides).values({
        userId,
        permissionId,
        granted: body.granted,
        grantedBy: ctx.adminUser!.id,
        reason: sanitizeText(body.reason || '', 200),
      });
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'user.permission_override_updated',
      module: 'roles',
      targetType: 'user',
      targetId: userId,
      details: { permissionId, granted: body.granted ?? null },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ saved: true });
  });

  // Bulk user-specific permission overrides
  router.put('/api/users/:id/permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const userId = Number(ctx.params.id);
    const body = await readJsonBody<{
      overrides?: Array<{ permissionKey: string; granted: boolean; reason?: string }>;
    }>(ctx.request);

    const overrides = Array.isArray(body.overrides) ? body.overrides : [];
    const allPerms = await ctx.db.select().from(permissions);
    const permByKey = new Map(allPerms.map((p) => [p.key, p.id]));

    await ctx.db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId));

    for (const ov of overrides) {
      const permId = permByKey.get(ov.permissionKey);
      if (permId) {
        await ctx.db.insert(userPermissionOverrides).values({
          userId,
          permissionId: permId,
          granted: Boolean(ov.granted),
          grantedBy: ctx.adminUser!.id,
          reason: sanitizeText(ov.reason || '', 200),
        });
      }
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'user.permissions_overridden',
      module: 'roles',
      targetType: 'user',
      targetId: userId,
      details: { count: overrides.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ saved: true });
  });

  // Roles & Permissions CRUD
  router.get('/api/roles', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.read');
    if (permFail) return permFail;

    const [roleRows, permRows, rpRows] = await Promise.all([
      ctx.db.select().from(roles).orderBy(desc(roles.hierarchyLevel)),
      ctx.db.select().from(permissions).orderBy(permissions.module, permissions.key),
      ctx.db.select().from(rolePermissions),
    ]);

    const permsByRole = new Map<number, number[]>();
    for (const rp of rpRows) {
      const arr = permsByRole.get(rp.roleId) ?? [];
      arr.push(rp.permissionId);
      permsByRole.set(rp.roleId, arr);
    }

    return jsonResponse({
      roles: roleRows.map((r) => ({
        ...r,
        permissionIds: permsByRole.get(r.id) ?? [],
      })),
      permissions: permRows,
    });
  });

  router.post('/api/roles', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      description?: string;
      hierarchyLevel?: number;
      permissionIds?: number[];
    }>(ctx.request);

    const name = sanitizeText(body.name, 60);
    if (!name) {
      return errorResponse(400, 'Role name is required.');
    }
    const slug = slugify(name);
    const hierarchyLevel = Math.min(90, Math.max(1, Number(body.hierarchyLevel) || 30));

    const existing = await ctx.db.select().from(roles).where(eq(roles.slug, slug)).limit(1);
    if (existing.length > 0) {
      return errorResponse(409, 'A role with this slug already exists.');
    }

    const created = await ctx.db
      .insert(roles)
      .values({
        slug,
        name,
        description: sanitizeText(body.description, 240),
        hierarchyLevel,
        isSystem: false,
      })
      .returning();

    const permissionIds = Array.isArray(body.permissionIds) ? body.permissionIds : [];
    for (const pid of permissionIds) {
      await ctx.db
        .insert(rolePermissions)
        .values({ roleId: created[0].id, permissionId: Number(pid) })
        .onConflictDoNothing();
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'role.created',
      module: 'roles',
      targetType: 'role',
      targetId: created[0].id,
      details: { slug, permissionCount: permissionIds.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ role: created[0] }, 201);
  });

  router.put('/api/roles/:id/permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.manage');
    if (permFail) return permFail;

    const roleId = Number(ctx.params.id);
    const roleRows = await ctx.db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
    if (!roleRows[0]) {
      return errorResponse(404, 'Role not found.');
    }
    if (roleRows[0].slug === 'super_admin') {
      return errorResponse(400, 'Super Admin always retains full system permissions.');
    }

    const body = await readJsonBody<{ permissionIds?: number[] }>(ctx.request);
    const permissionIds = Array.isArray(body.permissionIds)
      ? body.permissionIds.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : [];

    await ctx.db.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    for (const pid of permissionIds) {
      await ctx.db
        .insert(rolePermissions)
        .values({ roleId, permissionId: pid })
        .onConflictDoNothing();
    }

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'role.permissions_updated',
      module: 'roles',
      targetType: 'role',
      targetId: roleId,
      details: { permissionCount: permissionIds.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ saved: true });
  });

  router.get('/api/permissions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'roles.read');
    if (permFail) return permFail;
    const rows = await ctx.db
      .select()
      .from(permissions)
      .orderBy(permissions.module, permissions.key);
    return jsonResponse({ permissions: rows });
  });
}
