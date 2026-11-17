import { and, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  categories,
  contentItems,
  contentVersions,
  notificationTemplates,
  notifications,
  supportTemplates,
  supportTickets,
  ticketMessages,
  users,
} from '../../db/schema.ts';
import { sanitizeText } from '../../lib/security.ts';
import {
  isValidTicketPriority,
  isValidTicketStatus,
  parsePaginationQuery,
  slugify,
} from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requireAuth, requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, queryRecord, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { WorkerContext } from '../types.ts';

export function registerContentAndCommsRoutes(router: WorkerRouter): void {
  // ---- MODULE D: CONTENT MANAGEMENT ----
  router.get('/api/content', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['createdAt', 'updatedAt', 'title', 'status'], 'updatedAt');
    const statusFilter = sanitizeText(q.status || 'all', 30);

    const conditions: SQL[] = [];
    if (statusFilter !== 'all') {
      conditions.push(eq(contentItems.status, statusFilter));
    } else {
      conditions.push(sql`${contentItems.status} != 'trash'`);
    }
    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${contentItems.title}) LIKE ${pattern} OR lower(${contentItems.slug}) LIKE ${pattern})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [totalRows, rows, catRows] = await Promise.all([
      ctx.db
        .select({ total: sql<number>`cast(count(*) as integer)` })
        .from(contentItems)
        .where(whereClause),
      ctx.db
        .select()
        .from(contentItems)
        .where(whereClause)
        .orderBy(desc(contentItems.updatedAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      ctx.db.select().from(categories).orderBy(categories.name),
    ]);

    const categoryNameById = new Map(catRows.map((c) => [c.id, c.name]));

    return jsonResponse({
      data: rows.map((r) => ({
        ...r,
        categoryName: r.categoryId ? (categoryNameById.get(r.categoryId) ?? null) : null,
      })),
      categories: catRows,
      total: Number(totalRows[0]?.total ?? 0),
      page: params.page,
      pageSize: params.pageSize,
    });
  });

  router.post('/api/content', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.write');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      title?: string;
      slug?: string;
      excerpt?: string;
      body?: string;
      status?: string;
      categoryId?: number;
      tags?: string[];
      scheduledFor?: string;
    }>(ctx.request);

    const title = sanitizeText(body.title, 200);
    if (!title) {
      return errorResponse(400, 'Content title is required.');
    }

    let status = sanitizeText(body.status || 'draft', 30);
    if ((status === 'published' || status === 'scheduled') && !ctx.adminUser!.permissions.has('content.publish')) {
      status = 'pending_approval';
    }

    const baseSlug = slugify(body.slug || title) || `content-${Date.now()}`;
    const existing = await ctx.db.select().from(contentItems).where(eq(contentItems.slug, baseSlug)).limit(1);
    const finalSlug = existing.length > 0 ? `${baseSlug}-${Date.now().toString().slice(-4)}` : baseSlug;

    const created = await ctx.db
      .insert(contentItems)
      .values({
        title,
        slug: finalSlug,
        excerpt: sanitizeText(body.excerpt, 400),
        body: typeof body.body === 'string' ? body.body.slice(0, 100_000) : '',
        status,
        categoryId: body.categoryId ? Number(body.categoryId) : null,
        tags: Array.isArray(body.tags) ? body.tags.map((t) => sanitizeText(t, 40)).filter(Boolean) : [],
        authorId: ctx.adminUser!.id,
        publishedAt: status === 'published' ? new Date() : null,
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        version: 1,
      })
      .returning();

    await ctx.db.insert(contentVersions).values({
      contentId: created[0].id,
      version: 1,
      title: created[0].title,
      body: created[0].body,
      editedBy: ctx.adminUser!.id,
      changeSummary: 'Initial version',
    });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'content.created',
      module: 'content',
      targetType: 'content',
      targetId: created[0].id,
      details: { title, status },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ item: created[0] }, 201);
  });

  router.patch('/api/content/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.write');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const existingRows = await ctx.db.select().from(contentItems).where(eq(contentItems.id, id)).limit(1);
    const target = existingRows[0];
    if (!target) {
      return errorResponse(404, 'Content item not found.');
    }

    const body = await readJsonBody<{
      title?: string;
      excerpt?: string;
      body?: string;
      status?: string;
      categoryId?: number | null;
      tags?: string[];
      changeSummary?: string;
    }>(ctx.request);

    const nextStatus = body.status ? sanitizeText(body.status, 30) : target.status;
    if (
      (nextStatus === 'published' || nextStatus === 'scheduled') &&
      nextStatus !== target.status &&
      !ctx.adminUser!.permissions.has('content.publish')
    ) {
      return errorResponse(403, 'Publishing requires content.publish permission.');
    }

    const nextVersion = target.version + 1;
    const nextTitle = body.title !== undefined ? sanitizeText(body.title, 200) : target.title;
    const nextBody = body.body !== undefined ? String(body.body).slice(0, 100_000) : target.body;

    const updated = await ctx.db
      .update(contentItems)
      .set({
        title: nextTitle,
        excerpt: body.excerpt !== undefined ? sanitizeText(body.excerpt, 400) : target.excerpt,
        body: nextBody,
        status: nextStatus,
        categoryId: body.categoryId !== undefined ? body.categoryId : target.categoryId,
        tags: Array.isArray(body.tags) ? body.tags.map((t) => sanitizeText(t, 40)) : target.tags,
        approvedBy: nextStatus === 'published' ? ctx.adminUser!.id : target.approvedBy,
        publishedAt: nextStatus === 'published' && !target.publishedAt ? new Date() : target.publishedAt,
        deletedAt: nextStatus === 'trash' ? new Date() : null,
        version: nextVersion,
        updatedAt: new Date(),
      })
      .where(eq(contentItems.id, id))
      .returning();

    await ctx.db.insert(contentVersions).values({
      contentId: id,
      version: nextVersion,
      title: nextTitle,
      body: nextBody,
      editedBy: ctx.adminUser!.id,
      changeSummary: sanitizeText(body.changeSummary || `Updated to v${nextVersion}`, 200),
    });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'content.updated',
      module: 'content',
      targetType: 'content',
      targetId: id,
      details: { version: nextVersion, status: nextStatus },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ item: updated[0] });
  });

  router.get('/api/content/:id/versions', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.read');
    if (permFail) return permFail;
    const id = Number(ctx.params.id);
    const versions = await ctx.db
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.contentId, id))
      .orderBy(desc(contentVersions.version));
    return jsonResponse({ versions });
  });

  router.post('/api/content/bulk-publish', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.publish');
    if (permFail) return permFail;

    const body = await readJsonBody<{ ids?: number[] }>(ctx.request);
    const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter((n) => n > 0) : [];
    if (ids.length === 0) {
      return errorResponse(400, 'No content IDs selected.');
    }

    await ctx.db
      .update(contentItems)
      .set({
        status: 'published',
        approvedBy: ctx.adminUser!.id,
        publishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(contentItems.id, ids));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'content.bulk_published',
      module: 'content',
      details: { ids },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ publishedCount: ids.length });
  });

  router.get('/api/categories', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.read');
    if (permFail) return permFail;
    const rows = await ctx.db.select().from(categories).orderBy(categories.name);
    return jsonResponse({ categories: rows });
  });

  router.post('/api/categories', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'content.write');
    if (permFail) return permFail;
    const body = await readJsonBody<{ name?: string; description?: string }>(ctx.request);
    const name = sanitizeText(body.name, 80);
    if (!name) return errorResponse(400, 'Category name is required.');
    const slug = slugify(name);
    const created = await ctx.db
      .insert(categories)
      .values({ slug, name, description: sanitizeText(body.description, 240) })
      .onConflictDoNothing()
      .returning();
    return jsonResponse({ category: created[0] ?? null }, 201);
  });

  // ---- MODULE E: NOTIFICATIONS CENTER ----
  router.get('/api/notifications', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'notifications.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const channel = sanitizeText(q.channel || 'all', 20);
    const status = sanitizeText(q.status || 'all', 20);

    const conditions: SQL[] = [];
    if (channel !== 'all') conditions.push(eq(notifications.channel, channel));
    if (status !== 'all') conditions.push(eq(notifications.status, status));

    const [rows, tplRows] = await Promise.all([
      ctx.db
        .select()
        .from(notifications)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(notifications.createdAt))
        .limit(100),
      ctx.db.select().from(notificationTemplates).orderBy(notificationTemplates.name),
    ]);

    return jsonResponse({
      data: rows,
      templates: tplRows,
      providers: {
        in_app: { configured: true, provider: 'cloudflare-d1-sqlite' },
        email: { configured: Boolean(ctx.env.EMAIL_PROVIDER_URL), provider: ctx.env.EMAIL_PROVIDER_URL ? 'webhook' : 'none' },
        push: { configured: Boolean(ctx.env.PUSH_PROVIDER_URL), provider: ctx.env.PUSH_PROVIDER_URL ? 'webhook' : 'none' },
      },
    });
  });

  router.post('/api/notifications', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'notifications.send');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      title?: string;
      message?: string;
      channel?: string;
      targetType?: string;
      targetUserId?: number;
      scheduledFor?: string;
    }>(ctx.request);

    const title = sanitizeText(body.title, 160);
    const message = sanitizeText(body.message, 2000);
    const channel = ['in_app', 'email', 'push'].includes(body.channel || '') ? body.channel! : 'in_app';
    const targetType = ['all', 'role', 'user'].includes(body.targetType || '') ? body.targetType! : 'all';

    if (!title || !message) {
      return errorResponse(400, 'Notification title and message are required.');
    }

    const isScheduled = Boolean(body.scheduledFor);
    let deliveryStatus = 'delivered';
    let providerStatus = 'in_app_persisted';

    if (isScheduled) {
      deliveryStatus = 'scheduled';
      providerStatus = 'awaiting_schedule';
    } else if (channel === 'email' && !ctx.env.EMAIL_PROVIDER_URL) {
      deliveryStatus = 'failed';
      providerStatus = 'email_provider_unconfigured';
    } else if (channel === 'push' && !ctx.env.PUSH_PROVIDER_URL) {
      deliveryStatus = 'failed';
      providerStatus = 'push_provider_unconfigured';
    }

    const created = await ctx.db
      .insert(notifications)
      .values({
        title,
        message,
        channel,
        targetType,
        targetUserId: body.targetUserId ? Number(body.targetUserId) : null,
        status: deliveryStatus,
        deliveryProviderStatus: providerStatus,
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        sentAt: deliveryStatus === 'delivered' ? new Date() : null,
        createdBy: ctx.adminUser!.id,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'notification.created',
      module: 'notifications',
      targetType: 'notification',
      targetId: created[0].id,
      details: { channel, deliveryStatus, providerStatus },
      status: deliveryStatus === 'failed' ? 'failure' : 'success',
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ notification: created[0] }, 201);
  });

  router.post('/api/notifications/templates', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'notifications.send');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      name?: string;
      channel?: string;
      subject?: string;
      body?: string;
    }>(ctx.request);

    const name = sanitizeText(body.name, 100);
    const subject = sanitizeText(body.subject, 200);
    const tplBody = sanitizeText(body.body, 4000);
    if (!name || !subject || !tplBody) {
      return errorResponse(400, 'Template name, subject, and body are required.');
    }

    const key = slugify(name);
    const created = await ctx.db
      .insert(notificationTemplates)
      .values({
        key,
        name,
        channel: ['in_app', 'email', 'push'].includes(body.channel || '') ? body.channel! : 'in_app',
        subject,
        body: tplBody,
      })
      .onConflictDoUpdate({
        target: notificationTemplates.key,
        set: { name, subject, body: tplBody, updatedAt: new Date() },
      })
      .returning();

    return jsonResponse({ template: created[0] }, 201);
  });

  // ---- MODULE I: SUPPORT & COMMUNICATION ----
  router.get('/api/support/tickets', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'support.read');
    if (permFail) return permFail;

    const q = queryRecord(ctx);
    const params = parsePaginationQuery(q, ['createdAt', 'updatedAt', 'priority', 'status'], 'updatedAt');
    const statusFilter = sanitizeText(q.status || 'all', 20);

    const conditions: SQL[] = [];
    if (statusFilter !== 'all' && isValidTicketStatus(statusFilter)) {
      conditions.push(eq(supportTickets.status, statusFilter));
    }
    if (params.search) {
      const pattern = `%${params.search.toLowerCase()}%`;
      conditions.push(
        sql`(lower(${supportTickets.ticketNumber}) LIKE ${pattern} OR lower(${supportTickets.subject}) LIKE ${pattern})`
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    const [rows, tplRows] = await Promise.all([
      ctx.db
        .select({
          id: supportTickets.id,
          ticketNumber: supportTickets.ticketNumber,
          userId: supportTickets.userId,
          userEmail: users.email,
          assignedTo: supportTickets.assignedTo,
          category: supportTickets.category,
          priority: supportTickets.priority,
          status: supportTickets.status,
          subject: supportTickets.subject,
          description: supportTickets.description,
          createdAt: supportTickets.createdAt,
          updatedAt: supportTickets.updatedAt,
          resolvedAt: supportTickets.resolvedAt,
        })
        .from(supportTickets)
        .leftJoin(users, eq(supportTickets.userId, users.id))
        .where(whereClause)
        .orderBy(desc(supportTickets.updatedAt))
        .limit(params.pageSize)
        .offset((params.page - 1) * params.pageSize),
      ctx.db.select().from(supportTemplates).orderBy(supportTemplates.title),
    ]);

    return jsonResponse({ data: rows, templates: tplRows });
  });

  router.post('/api/support/tickets', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'support.write');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      subject?: string;
      description?: string;
      category?: string;
      priority?: string;
      userId?: number;
    }>(ctx.request);

    const subject = sanitizeText(body.subject, 200);
    const description = sanitizeText(body.description, 4000);
    const priority = isValidTicketPriority(body.priority || '') ? body.priority! : 'medium';

    if (!subject || !description) {
      return errorResponse(400, 'Ticket subject and description are required.');
    }

    const ticketNumber = `TKT-${Date.now().toString().slice(-6)}`;
    const created = await ctx.db
      .insert(supportTickets)
      .values({
        ticketNumber,
        userId: body.userId ? Number(body.userId) : ctx.adminUser!.id,
        category: sanitizeText(body.category || 'general', 60),
        priority,
        status: 'open',
        subject,
        description,
      })
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'support.ticket_created',
      module: 'support',
      targetType: 'ticket',
      targetId: created[0].id,
      details: { ticketNumber, priority },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ ticket: created[0] }, 201);
  });

  router.get('/api/support/tickets/:id/messages', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'support.read');
    if (permFail) return permFail;
    const id = Number(ctx.params.id);
    const messages = await ctx.db
      .select({
        id: ticketMessages.id,
        body: ticketMessages.body,
        isInternalNote: ticketMessages.isInternalNote,
        createdAt: ticketMessages.createdAt,
        senderEmail: users.email,
        senderName: users.displayName,
      })
      .from(ticketMessages)
      .leftJoin(users, eq(ticketMessages.senderId, users.id))
      .where(eq(ticketMessages.ticketId, id))
      .orderBy(ticketMessages.createdAt);

    return jsonResponse({ messages });
  });

  router.post('/api/support/tickets/:id/messages', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'support.write');
    if (permFail) return permFail;
    const id = Number(ctx.params.id);
    const body = await readJsonBody<{ body?: string; isInternalNote?: boolean }>(ctx.request);
    const text = sanitizeText(body.body, 4000);
    if (!text) return errorResponse(400, 'Reply text is required.');

    const created = await ctx.db
      .insert(ticketMessages)
      .values({
        ticketId: id,
        senderId: ctx.adminUser!.id,
        body: text,
        isInternalNote: Boolean(body.isInternalNote),
      })
      .returning();

    await ctx.db
      .update(supportTickets)
      .set({ updatedAt: new Date() })
      .where(eq(supportTickets.id, id));

    return jsonResponse({ message: created[0] }, 201);
  });

  router.patch('/api/support/tickets/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'support.write');
    if (permFail) return permFail;
    const id = Number(ctx.params.id);
    const body = await readJsonBody<{ status?: string; priority?: string; assignedTo?: number | null }>(
      ctx.request
    );

    const existing = await ctx.db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
    if (!existing[0]) return errorResponse(404, 'Ticket not found.');

    const nextStatus = body.status && isValidTicketStatus(body.status) ? body.status : existing[0].status;
    const nextPriority =
      body.priority && isValidTicketPriority(body.priority) ? body.priority : existing[0].priority;

    const updated = await ctx.db
      .update(supportTickets)
      .set({
        status: nextStatus,
        priority: nextPriority,
        assignedTo: body.assignedTo !== undefined ? body.assignedTo : existing[0].assignedTo,
        resolvedAt: nextStatus === 'resolved' || nextStatus === 'closed' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(supportTickets.id, id))
      .returning();

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'support.ticket_updated',
      module: 'support',
      targetType: 'ticket',
      targetId: id,
      details: { status: nextStatus, priority: nextPriority },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ ticket: updated[0] });
  });

  // Self-service mark-as-read helper for in-app notifications
  router.post('/api/notifications/:id/read', async (ctx: WorkerContext) => {
    const authFail = await requireAuth(ctx);
    if (authFail) return authFail;
    const id = Number(ctx.params.id);
    await ctx.db
      .update(notifications)
      .set({ status: 'read', readAt: new Date() })
      .where(eq(notifications.id, id));
    return jsonResponse({ read: true });
  });
}
