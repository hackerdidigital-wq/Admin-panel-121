import { relations, sql } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

const nowMs = () => new Date();

// 1. Roles & Permissions (RBAC)
export const roles = sqliteTable('roles', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').default('').notNull(),
  hierarchyLevel: integer('hierarchy_level').default(10).notNull(),
  isSystem: integer('is_system', { mode: 'boolean' }).default(false).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const permissions = sqliteTable(
  'permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    key: text('key').notNull().unique(),
    module: text('module').notNull(),
    page: text('page').notNull(),
    action: text('action').notNull(), // read | write | delete | manage
    description: text('description').default('').notNull(),
  },
  (table) => [index('permissions_module_idx').on(table.module)]
);

export const rolePermissions = sqliteTable(
  'role_permissions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    roleId: integer('role_id')
      .references(() => roles.id, { onDelete: 'cascade' })
      .notNull(),
    permissionId: integer('permission_id')
      .references(() => permissions.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    uniqueIndex('role_permissions_unique_idx').on(table.roleId, table.permissionId),
  ]
);

// 2. Users & Administrators
export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    uid: text('uid').notNull().unique(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash'),
    passwordUpdatedAt: integer('password_updated_at', { mode: 'timestamp_ms' }),
    displayName: text('display_name').default('').notNull(),
    avatarUrl: text('avatar_url').default('').notNull(),
    phone: text('phone').default('').notNull(),
    department: text('department').default('').notNull(),
    jobTitle: text('job_title').default('').notNull(),
    roleId: integer('role_id').references(() => roles.id, { onDelete: 'set null' }),
    status: text('status').default('active').notNull(), // active | inactive | suspended | banned | deleted
    isAdmin: integer('is_admin', { mode: 'boolean' }).default(false).notNull(),
    emailVerified: integer('email_verified', { mode: 'boolean' }).default(false).notNull(),
    twoFactorEnabled: integer('two_factor_enabled', { mode: 'boolean' }).default(false).notNull(),
    twoFactorSecret: text('two_factor_secret'),
    failedLoginAttempts: integer('failed_login_attempts').default(0).notNull(),
    lockedUntil: integer('locked_until', { mode: 'timestamp_ms' }),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    lastIp: text('last_ip').default('').notNull(),
    country: text('country').default('').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
    restrictions: text('restrictions', { mode: 'json' })
      .$type<{
        apiDisabled?: boolean;
        readOnly?: boolean;
        ipAllowlist?: string[];
        reason?: string;
      }>()
      .default(sql`'{}'`)
      .notNull(),
    preferences: text('preferences', { mode: 'json' })
      .$type<{
        theme?: 'light' | 'dark' | 'system';
        language?: string;
        timezone?: string;
        dateFormat?: string;
        sidebarCollapsed?: boolean;
      }>()
      .default(sql`'{}'`)
      .notNull(),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('users_status_idx').on(table.status),
    index('users_role_idx').on(table.roleId),
    index('users_last_seen_idx').on(table.lastSeenAt),
  ]
);

export const userPermissionOverrides = sqliteTable(
  'user_permission_overrides',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    permissionId: integer('permission_id')
      .references(() => permissions.id, { onDelete: 'cascade' })
      .notNull(),
    granted: integer('granted', { mode: 'boolean' }).notNull(),
    grantedBy: integer('granted_by').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason').default('').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    uniqueIndex('user_perm_override_unique_idx').on(table.userId, table.permissionId),
  ]
);

export const userSessions = sqliteTable(
  'user_sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    sessionHash: text('session_hash').notNull().unique(),
    deviceName: text('device_name').default('Browser').notNull(),
    browser: text('browser').default('Unknown').notNull(),
    os: text('os').default('Unknown').notNull(),
    ipAddress: text('ip_address').default('').notNull(),
    userAgent: text('user_agent').default('').notNull(),
    isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),
    lastActivityAt: integer('last_activity_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('user_sessions_user_idx').on(table.userId),
    index('user_sessions_active_idx').on(table.isActive),
  ]
);

export const userNotes = sqliteTable(
  'user_notes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    note: text('note').notNull(),
    isInternal: integer('is_internal', { mode: 'boolean' }).default(true).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('user_notes_user_idx').on(table.userId)]
);

// 3. Content Management
export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').default('').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const contentItems = sqliteTable(
  'content_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    slug: text('slug').notNull().unique(),
    excerpt: text('excerpt').default('').notNull(),
    body: text('body').default('').notNull(),
    status: text('status').default('draft').notNull(), // draft | pending_approval | published | scheduled | archived | trash
    categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
    tags: text('tags', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
    authorId: integer('author_id').references(() => users.id, { onDelete: 'set null' }),
    approvedBy: integer('approved_by').references(() => users.id, { onDelete: 'set null' }),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    version: integer('version').default(1).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('content_status_idx').on(table.status),
    index('content_category_idx').on(table.categoryId),
  ]
);

export const contentVersions = sqliteTable(
  'content_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    contentId: integer('content_id')
      .references(() => contentItems.id, { onDelete: 'cascade' })
      .notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    editedBy: integer('edited_by').references(() => users.id, { onDelete: 'set null' }),
    changeSummary: text('change_summary').default('').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('content_versions_content_idx').on(table.contentId)]
);

// 4. Notifications Center
export const notificationTemplates = sqliteTable('notification_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  channel: text('channel').default('in_app').notNull(), // in_app | email | push
  subject: text('subject').notNull(),
  body: text('body').notNull(),
  variables: text('variables', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const notifications = sqliteTable(
  'notifications',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    message: text('message').notNull(),
    channel: text('channel').default('in_app').notNull(), // in_app | email | push
    targetType: text('target_type').default('user').notNull(), // all | role | user
    targetUserId: integer('target_user_id').references(() => users.id, { onDelete: 'cascade' }),
    templateKey: text('template_key'),
    status: text('status').default('delivered').notNull(), // queued | scheduled | delivered | failed | read
    deliveryProviderStatus: text('delivery_provider_status').default('in_app_persisted').notNull(),
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    readAt: integer('read_at', { mode: 'timestamp_ms' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('notifications_user_idx').on(table.targetUserId),
    index('notifications_status_idx').on(table.status),
  ]
);

// 5. Financial Management
export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    reference: text('reference').notNull().unique(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').default('USD').notNull(),
    type: text('type').default('payment').notNull(), // payment | refund | payout
    status: text('status').default('succeeded').notNull(), // succeeded | pending | failed | refunded | flagged
    paymentMethodLabel: text('payment_method_label').default('').notNull(),
    failureReason: text('failure_reason').default('').notNull(),
    fraudScore: integer('fraud_score').default(0).notNull(),
    metadata: text('metadata', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`)
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('transactions_user_idx').on(table.userId),
    index('transactions_status_idx').on(table.status),
  ]
);

// 6. Advertisement Management
export const adConfigs = sqliteTable('ad_configs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  network: text('network').notNull(),
  adFormat: text('ad_format').notNull(), // banner | interstitial | rewarded | native
  placement: text('placement').notNull(),
  frequencyCap: integer('frequency_cap').default(3).notNull(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(false).notNull(),
  visibilityRule: text('visibility_rule').default('all_users').notNull(),
  impressions: integer('impressions').default(0).notNull(),
  clicks: integer('clicks').default(0).notNull(),
  revenueCents: integer('revenue_cents').default(0).notNull(),
  errorMessage: text('error_message').default('').notNull(),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

// 7. Support & Communication
export const supportTickets = sqliteTable(
  'support_tickets',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketNumber: text('ticket_number').notNull().unique(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    assignedTo: integer('assigned_to').references(() => users.id, { onDelete: 'set null' }),
    category: text('category').default('general').notNull(),
    priority: text('priority').default('medium').notNull(), // low | medium | high | urgent
    status: text('status').default('open').notNull(), // open | pending | resolved | closed
    subject: text('subject').notNull(),
    description: text('description').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (table) => [
    index('tickets_status_idx').on(table.status),
    index('tickets_user_idx').on(table.userId),
    index('tickets_assigned_idx').on(table.assignedTo),
  ]
);

export const ticketMessages = sqliteTable(
  'ticket_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ticketId: integer('ticket_id')
      .references(() => supportTickets.id, { onDelete: 'cascade' })
      .notNull(),
    senderId: integer('sender_id').references(() => users.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    isInternalNote: integer('is_internal_note', { mode: 'boolean' }).default(false).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('ticket_messages_ticket_idx').on(table.ticketId)]
);

export const supportTemplates = sqliteTable('support_templates', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  category: text('category').default('general').notNull(),
  body: text('body').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

// 8. Application & System Management
export const systemSettings = sqliteTable('system_settings', {
  key: text('key').primaryKey(),
  category: text('category').notNull(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  isSecret: integer('is_secret', { mode: 'boolean' }).default(false).notNull(),
  description: text('description').default('').notNull(),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const featureFlags = sqliteTable('feature_flags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  description: text('description').default('').notNull(),
  isEnabled: integer('is_enabled', { mode: 'boolean' }).default(false).notNull(),
  rolloutPercentage: integer('rollout_percentage').default(100).notNull(),
  targetRoles: text('target_roles', { mode: 'json' }).$type<string[]>().default(sql`'[]'`).notNull(),
  updatedBy: integer('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const appReleases = sqliteTable('app_releases', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  version: text('version').notNull(),
  minSupportedVersion: text('min_supported_version').notNull(),
  forceUpdate: integer('force_update', { mode: 'boolean' }).default(false).notNull(),
  platform: text('platform').default('web').notNull(),
  releaseNotes: text('release_notes').default('').notNull(),
  status: text('status').default('active').notNull(), // draft | active | rolled_back
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

// 9. File & Media Management
export const files = sqliteTable(
  'files',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    filename: text('filename').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    category: text('category').default('other').notNull(), // image | document | backup | other
    storagePath: text('storage_path').notNull(),
    contentBase64: text('content_base64'),
    checksumSha256: text('checksum_sha256').notNull(),
    isPublic: integer('is_public', { mode: 'boolean' }).default(false).notNull(),
    usageCount: integer('usage_count').default(0).notNull(),
    uploadedBy: integer('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('files_category_idx').on(table.category)]
);

// 10. Audit, API Logs, Background Jobs & Backups
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    actorId: integer('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorEmail: text('actor_email').default('system').notNull(),
    action: text('action').notNull(),
    module: text('module').notNull(),
    targetType: text('target_type').default('').notNull(),
    targetId: text('target_id').default('').notNull(),
    details: text('details', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`)
      .notNull(),
    ipAddress: text('ip_address').default('').notNull(),
    userAgent: text('user_agent').default('').notNull(),
    status: text('status').default('success').notNull(), // success | failure | denied
    prevHash: text('prev_hash').default('').notNull(),
    entryHash: text('entry_hash').default('').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('audit_logs_module_idx').on(table.module),
    index('audit_logs_actor_idx').on(table.actorId),
    index('audit_logs_created_idx').on(table.createdAt),
  ]
);

export const apiLogs = sqliteTable(
  'api_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    method: text('method').notNull(),
    path: text('path').notNull(),
    statusCode: integer('status_code').notNull(),
    durationMs: integer('duration_ms').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    ipAddress: text('ip_address').default('').notNull(),
    errorMessage: text('error_message').default('').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [
    index('api_logs_status_idx').on(table.statusCode),
    index('api_logs_created_idx').on(table.createdAt),
  ]
);

export const backgroundJobs = sqliteTable(
  'background_jobs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    jobType: text('job_type').notNull(),
    status: text('status').default('queued').notNull(), // queued | running | completed | failed
    payload: text('payload', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`)
      .notNull(),
    result: text('result', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`)
      .notNull(),
    errorMessage: text('error_message').default('').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    scheduledAt: integer('scheduled_at', { mode: 'timestamp_ms' }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('jobs_status_idx').on(table.status)]
);

export const backups = sqliteTable('backups', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  filename: text('filename').notNull(),
  type: text('type').default('manual').notNull(), // manual | scheduled | export
  status: text('status').default('completed').notNull(), // completed | verified | failed
  sizeBytes: integer('size_bytes').notNull(),
  checksumSha256: text('checksum_sha256').notNull(),
  tablesIncluded: text('tables_included', { mode: 'json' })
    .$type<string[]>()
    .default(sql`'[]'`)
    .notNull(),
  rowCount: integer('row_count').default(0).notNull(),
  snapshotData: text('snapshot_data', { mode: 'json' })
    .$type<Record<string, unknown[]>>()
    .default(sql`'{}'`)
    .notNull(),
  verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
  createdBy: integer('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
});

export const savedViews = sqliteTable(
  'saved_views',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    scope: text('scope').notNull(), // dashboard_layout | table_filter
    name: text('name').notNull(),
    config: text('config', { mode: 'json' })
      .$type<Record<string, unknown>>()
      .default(sql`'{}'`)
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(nowMs).notNull(),
  },
  (table) => [index('saved_views_user_scope_idx').on(table.userId, table.scope)]
);

// Relations
export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
  rolePermissions: many(rolePermissions),
}));

export const permissionsRelations = relations(permissions, ({ many }) => ({
  rolePermissions: many(rolePermissions),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
  sessions: many(userSessions),
  notes: many(userNotes),
  overrides: many(userPermissionOverrides),
}));
