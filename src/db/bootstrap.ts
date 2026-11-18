import { generateUid } from '../lib/security.ts';
import type { D1Database, D1PreparedStatement } from '../worker/types.ts';

const bootstrappedDbs = new WeakSet<object>();
const inflightBootstraps = new WeakMap<object, Promise<void>>();

const REQUIRED_TABLES = [
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'user_permission_overrides',
  'user_sessions',
  'user_notes',
  'connected_apps',
  'app_api_keys',
  'app_users',
  'app_events',
  'webhooks',
  'webhook_deliveries',
  'user_app_permissions',
  'categories',
  'content_items',
  'content_versions',
  'notification_templates',
  'notifications',
  'transactions',
  'ad_configs',
  'support_tickets',
  'ticket_messages',
  'support_templates',
  'system_settings',
  'feature_flags',
  'app_releases',
  'files',
  'audit_logs',
  'api_logs',
  'background_jobs',
  'backups',
  'saved_views',
] as const;

const REQUIRED_USER_COLUMNS = [
  'id',
  'uid',
  'email',
  'password_hash',
  'password_updated_at',
  'display_name',
  'avatar_url',
  'phone',
  'department',
  'job_title',
  'role_id',
  'status',
  'is_admin',
  'email_verified',
  'two_factor_enabled',
  'two_factor_secret',
  'failed_login_attempts',
  'locked_until',
  'last_seen_at',
  'last_login_at',
  'last_ip',
  'country',
  'tags',
  'restrictions',
  'preferences',
  'deleted_at',
  'created_at',
  'updated_at',
] as const;

const BASE_ROLE_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    hierarchy_level INTEGER NOT NULL DEFAULT 10,
    is_system INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    module TEXT NOT NULL,
    page TEXT NOT NULL,
    action TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS permissions_module_idx ON permissions(module)`,
  `CREATE TABLE IF NOT EXISTS role_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS role_permissions_unique_idx ON role_permissions(role_id, permission_id)`,
];

function buildUsersTableDdl(tableName = 'users'): string {
  return `CREATE TABLE IF NOT EXISTS ${tableName} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT,
    password_updated_at INTEGER,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_url TEXT NOT NULL DEFAULT '',
    phone TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    job_title TEXT NOT NULL DEFAULT '',
    role_id INTEGER REFERENCES roles(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active',
    is_admin INTEGER NOT NULL DEFAULT 0,
    email_verified INTEGER NOT NULL DEFAULT 0,
    two_factor_enabled INTEGER NOT NULL DEFAULT 0,
    two_factor_secret TEXT,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER,
    last_seen_at INTEGER,
    last_login_at INTEGER,
    last_ip TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    restrictions TEXT NOT NULL DEFAULT '{}',
    preferences TEXT NOT NULL DEFAULT '{}',
    deleted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`;
}

const USERS_INDEX_DDL: string[] = [
  `CREATE INDEX IF NOT EXISTS users_status_idx ON users(status)`,
  `CREATE INDEX IF NOT EXISTS users_role_idx ON users(role_id)`,
  `CREATE INDEX IF NOT EXISTS users_last_seen_idx ON users(last_seen_at)`,
];

const REMAINING_SCHEMA_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS user_permission_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission_id INTEGER NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted INTEGER NOT NULL,
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reason TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_perm_override_unique_idx ON user_permission_overrides(user_id, permission_id)`,
  `CREATE TABLE IF NOT EXISTS user_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_hash TEXT NOT NULL UNIQUE,
    device_name TEXT NOT NULL DEFAULT 'Browser',
    browser TEXT NOT NULL DEFAULT 'Unknown',
    os TEXT NOT NULL DEFAULT 'Unknown',
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_activity_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS user_sessions_user_idx ON user_sessions(user_id)`,
  `CREATE INDEX IF NOT EXISTS user_sessions_active_idx ON user_sessions(is_active)`,
  `CREATE TABLE IF NOT EXISTS user_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    note TEXT NOT NULL,
    is_internal INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS user_notes_user_idx ON user_notes(user_id)`,
  `CREATE TABLE IF NOT EXISTS connected_apps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_uid TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    package_or_domain TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'connected',
    current_version TEXT NOT NULL DEFAULT '1.0.0',
    min_supported_version TEXT NOT NULL DEFAULT '1.0.0',
    force_update INTEGER NOT NULL DEFAULT 0,
    maintenance_message TEXT NOT NULL DEFAULT 'Scheduled maintenance is in progress.',
    admob_app_id TEXT NOT NULL DEFAULT '',
    ads_enabled INTEGER NOT NULL DEFAULT 1,
    webhook_secret TEXT NOT NULL DEFAULT '',
    health_status TEXT NOT NULL DEFAULT 'healthy',
    last_heartbeat_at INTEGER,
    last_latency_ms INTEGER NOT NULL DEFAULT 0,
    error_count_24h INTEGER NOT NULL DEFAULT 0,
    settings_json TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS connected_apps_status_idx ON connected_apps(status)`,
  `CREATE INDEX IF NOT EXISTS connected_apps_platform_idx ON connected_apps(platform)`,
  `CREATE TABLE IF NOT EXISTS app_api_keys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    scopes TEXT NOT NULL DEFAULT '["config:read","users:write","events:write","commerce:write"]',
    is_active INTEGER NOT NULL DEFAULT 1,
    last_used_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS app_api_keys_app_idx ON app_api_keys(app_id)`,
  `CREATE INDEX IF NOT EXISTS app_api_keys_active_idx ON app_api_keys(is_active)`,
  `CREATE TABLE IF NOT EXISTS app_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
    external_user_id TEXT NOT NULL,
    email TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    app_version TEXT NOT NULL DEFAULT '',
    device_model TEXT NOT NULL DEFAULT '',
    os_version TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    ip_address TEXT NOT NULL DEFAULT '',
    metadata TEXT NOT NULL DEFAULT '{}',
    total_sessions INTEGER NOT NULL DEFAULT 1,
    last_active_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS app_users_app_ext_unique_idx ON app_users(app_id, external_user_id)`,
  `CREATE INDEX IF NOT EXISTS app_users_app_status_idx ON app_users(app_id, status)`,
  `CREATE INDEX IF NOT EXISTS app_users_last_active_idx ON app_users(last_active_at)`,
  `CREATE TABLE IF NOT EXISTS app_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
    app_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    event_name TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'info',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS app_events_app_created_idx ON app_events(app_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS app_events_severity_idx ON app_events(severity)`,
  `CREATE INDEX IF NOT EXISTS app_events_user_idx ON app_events(app_user_id)`,
  `CREATE TABLE IF NOT EXISTS webhooks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    target_url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '["*"]',
    signing_secret TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    last_status_code INTEGER,
    last_triggered_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS webhooks_app_idx ON webhooks(app_id)`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    webhook_id INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    status_code INTEGER NOT NULL DEFAULT 0,
    response_body TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    success INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS user_app_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
    role_scope TEXT NOT NULL DEFAULT 'admin',
    permissions TEXT NOT NULL DEFAULT '[]',
    granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS user_app_perm_unique_idx ON user_app_permissions(user_id, app_id)`,
  `CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS content_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    excerpt TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    scheduled_for INTEGER,
    published_at INTEGER,
    deleted_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS content_status_idx ON content_items(status)`,
  `CREATE INDEX IF NOT EXISTS content_category_idx ON content_items(category_id)`,
  `CREATE TABLE IF NOT EXISTS content_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    content_id INTEGER NOT NULL REFERENCES content_items(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    edited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    change_summary TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS content_versions_content_idx ON content_versions(content_id)`,
  `CREATE TABLE IF NOT EXISTS notification_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'in_app',
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    variables TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    channel TEXT NOT NULL DEFAULT 'in_app',
    target_type TEXT NOT NULL DEFAULT 'user',
    target_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    template_key TEXT,
    status TEXT NOT NULL DEFAULT 'delivered',
    delivery_provider_status TEXT NOT NULL DEFAULT 'in_app_persisted',
    scheduled_for INTEGER,
    sent_at INTEGER,
    read_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(target_user_id)`,
  `CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications(status)`,
  `CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reference TEXT NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    amount_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    type TEXT NOT NULL DEFAULT 'payment',
    status TEXT NOT NULL DEFAULT 'succeeded',
    payment_method_label TEXT NOT NULL DEFAULT '',
    failure_reason TEXT NOT NULL DEFAULT '',
    fraud_score INTEGER NOT NULL DEFAULT 0,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS transactions_user_idx ON transactions(user_id)`,
  `CREATE INDEX IF NOT EXISTS transactions_status_idx ON transactions(status)`,
  `CREATE TABLE IF NOT EXISTS ad_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    network TEXT NOT NULL,
    ad_format TEXT NOT NULL,
    placement TEXT NOT NULL,
    frequency_cap INTEGER NOT NULL DEFAULT 3,
    is_enabled INTEGER NOT NULL DEFAULT 0,
    visibility_rule TEXT NOT NULL DEFAULT 'all_users',
    impressions INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    revenue_cents INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_number TEXT NOT NULL UNIQUE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
    category TEXT NOT NULL DEFAULT 'general',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    resolved_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS tickets_status_idx ON support_tickets(status)`,
  `CREATE INDEX IF NOT EXISTS tickets_user_idx ON support_tickets(user_id)`,
  `CREATE INDEX IF NOT EXISTS tickets_assigned_idx ON support_tickets(assigned_to)`,
  `CREATE TABLE IF NOT EXISTS ticket_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
    sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    is_internal_note INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS ticket_messages_ticket_idx ON ticket_messages(ticket_id)`,
  `CREATE TABLE IF NOT EXISTS support_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'general',
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    value TEXT NOT NULL,
    is_secret INTEGER NOT NULL DEFAULT 0,
    description TEXT NOT NULL DEFAULT '',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS feature_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_enabled INTEGER NOT NULL DEFAULT 0,
    rollout_percentage INTEGER NOT NULL DEFAULT 100,
    target_roles TEXT NOT NULL DEFAULT '[]',
    updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS app_releases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL,
    min_supported_version TEXT NOT NULL,
    force_update INTEGER NOT NULL DEFAULT 0,
    platform TEXT NOT NULL DEFAULT 'web',
    release_notes TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT 'other',
    storage_path TEXT NOT NULL,
    content_base64 TEXT,
    checksum_sha256 TEXT NOT NULL,
    is_public INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    deleted_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS files_category_idx ON files(category)`,
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    actor_email TEXT NOT NULL DEFAULT 'system',
    action TEXT NOT NULL,
    module TEXT NOT NULL,
    target_type TEXT NOT NULL DEFAULT '',
    target_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'success',
    prev_hash TEXT NOT NULL DEFAULT '',
    entry_hash TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS audit_logs_module_idx ON audit_logs(module)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_id)`,
  `CREATE INDEX IF NOT EXISTS audit_logs_created_idx ON audit_logs(created_at)`,
  `CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS api_logs_status_idx ON api_logs(status_code)`,
  `CREATE INDEX IF NOT EXISTS api_logs_created_idx ON api_logs(created_at)`,
  `CREATE TABLE IF NOT EXISTS background_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    payload TEXT NOT NULL DEFAULT '{}',
    result TEXT NOT NULL DEFAULT '{}',
    error_message TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0,
    scheduled_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS jobs_status_idx ON background_jobs(status)`,
  `CREATE TABLE IF NOT EXISTS backups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'completed',
    size_bytes INTEGER NOT NULL,
    checksum_sha256 TEXT NOT NULL,
    tables_included TEXT NOT NULL DEFAULT '[]',
    row_count INTEGER NOT NULL DEFAULT 0,
    snapshot_data TEXT NOT NULL DEFAULT '{}',
    verified_at INTEGER,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE TABLE IF NOT EXISTS saved_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
    updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
  )`,
  `CREATE INDEX IF NOT EXISTS saved_views_user_scope_idx ON saved_views(user_id, scope)`,
];

async function runStatementBatches(
  d1: D1Database,
  statements: D1PreparedStatement[],
  chunkSize = 40
): Promise<void> {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length > 0) {
      await d1.batch(chunk);
    }
  }
}

function parseEpochMs(rawValue: unknown, fallbackMs: number): number {
  if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
    return rawValue > 0 && rawValue < 1_000_000_000_000 ? Math.round(rawValue * 1000) : Math.round(rawValue);
  }
  if (typeof rawValue === 'string' && rawValue.trim()) {
    const asNum = Number(rawValue);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1_000_000_000_000 ? Math.round(asNum * 1000) : Math.round(asNum);
    }
    const parsed = Date.parse(rawValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackMs;
}

async function getUsersTableColumns(
  d1: D1Database
): Promise<Array<{ name: string; type: string }>> {
  try {
    const res = await d1
      .prepare("SELECT name, type FROM pragma_table_info('users')")
      .all<{ name: string; type: string }>();
    return res.results;
  } catch {
    const res = await d1
      .prepare('PRAGMA table_info(users)')
      .all<{ name: string; type: string }>();
    return res.results;
  }
}

function hasFullUsersSchema(cols: Array<{ name: string; type: string }>): boolean {
  if (cols.length === 0) return false;
  const colMap = new Map(cols.map((c) => [c.name.toLowerCase(), (c.type || '').toUpperCase()]));
  if (colMap.get('id') !== 'INTEGER') return false;
  return REQUIRED_USER_COLUMNS.every((col) => colMap.has(col));
}

async function migrateMinimalUsersTable(d1: D1Database): Promise<void> {
  const existingRowsRes = await d1.prepare('SELECT * FROM users').all<Record<string, unknown>>();
  const existingRows = existingRowsRes.results;
  const nowMs = Date.now();

  await d1.batch([
    d1.prepare('DROP TABLE IF EXISTS users_aegis_migrated'),
    d1.prepare(buildUsersTableDdl('users_aegis_migrated')),
  ]);

  if (existingRows.length > 0) {
    const usedUids = new Set<string>();
    const usedEmails = new Set<string>();
    const insertStmts: D1PreparedStatement[] = [];

    for (let idx = 0; idx < existingRows.length; idx++) {
      const row = existingRows[idx];
      const rawId = row.id;
      const numericId =
        typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0
          ? rawId
          : typeof rawId === 'string' && /^\d+$/.test(rawId.trim())
            ? Number(rawId.trim())
            : null;

      let uid =
        typeof row.uid === 'string' && row.uid.trim()
          ? row.uid.trim()
          : typeof rawId === 'string' && rawId.trim() && !/^\d+$/.test(rawId.trim())
            ? rawId.trim()
            : generateUid('adm');
      if (usedUids.has(uid)) {
        uid = generateUid('adm');
      }
      usedUids.add(uid);

      let email =
        typeof row.email === 'string' && row.email.trim()
          ? row.email.trim().toLowerCase()
          : idx === 0
            ? 'admin@aegis.local'
            : `admin-${idx + 1}@aegis.local`;
      if (usedEmails.has(email)) {
        email = `admin-${idx + 1}-${uid.slice(-6)}@aegis.local`;
      }
      usedEmails.add(email);

      const passwordHash =
        typeof row.password_hash === 'string' && row.password_hash.trim()
          ? row.password_hash.trim()
          : null;
      const displayName =
        typeof row.display_name === 'string' && row.display_name.trim()
          ? row.display_name.trim()
          : 'Administrator';
      const status =
        typeof row.status === 'string' && row.status.trim() ? row.status.trim() : 'active';
      const isAdmin = row.is_admin !== undefined ? (row.is_admin ? 1 : 0) : 1;
      const createdAt = parseEpochMs(row.created_at, nowMs);
      const updatedAt = parseEpochMs(row.updated_at, nowMs);
      const passwordUpdatedAt = passwordHash ? createdAt : null;

      if (numericId !== null) {
        insertStmts.push(
          d1
            .prepare(
              `INSERT INTO users_aegis_migrated (
                id, uid, email, password_hash, password_updated_at, display_name,
                status, is_admin, email_verified, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
            )
            .bind(
              numericId,
              uid,
              email,
              passwordHash,
              passwordUpdatedAt,
              displayName,
              status,
              isAdmin,
              createdAt,
              updatedAt
            )
        );
      } else {
        insertStmts.push(
          d1
            .prepare(
              `INSERT INTO users_aegis_migrated (
                uid, email, password_hash, password_updated_at, display_name,
                status, is_admin, email_verified, created_at, updated_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
            )
            .bind(
              uid,
              email,
              passwordHash,
              passwordUpdatedAt,
              displayName,
              status,
              isAdmin,
              createdAt,
              updatedAt
            )
        );
      }
    }

    await runStatementBatches(d1, insertStmts, 25);
  }

  await d1.batch([
    d1.prepare('DROP TABLE users'),
    d1.prepare('ALTER TABLE users_aegis_migrated RENAME TO users'),
    ...USERS_INDEX_DDL.map((sql) => d1.prepare(sql)),
  ]);
}

async function getTableColumns(d1: D1Database, tableName: string): Promise<Set<string>> {
  try {
    const res = await d1
      .prepare(`SELECT name FROM pragma_table_info('${tableName}')`)
      .all<{ name: string }>();
    return new Set(res.results.map((r) => r.name.toLowerCase()));
  } catch {
    const res = await d1
      .prepare(`PRAGMA table_info(${tableName})`)
      .all<{ name: string }>();
    return new Set(res.results.map((r) => r.name.toLowerCase()));
  }
}

const MULTI_APP_COLUMN_UPGRADES: Array<{
  table: string;
  column: string;
  alterSql: string;
  indexSql?: string;
}> = [
  {
    table: 'feature_flags',
    column: 'app_id',
    alterSql: 'ALTER TABLE feature_flags ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS feature_flags_app_idx ON feature_flags(app_id)',
  },
  {
    table: 'app_releases',
    column: 'app_id',
    alterSql: 'ALTER TABLE app_releases ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS app_releases_app_idx ON app_releases(app_id)',
  },
  {
    table: 'ad_configs',
    column: 'app_id',
    alterSql: 'ALTER TABLE ad_configs ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS ad_configs_app_idx ON ad_configs(app_id)',
  },
  {
    table: 'ad_configs',
    column: 'admob_unit_id',
    alterSql: "ALTER TABLE ad_configs ADD COLUMN admob_unit_id TEXT NOT NULL DEFAULT ''",
  },
  {
    table: 'ad_configs',
    column: 'ecpm_cents',
    alterSql: 'ALTER TABLE ad_configs ADD COLUMN ecpm_cents INTEGER NOT NULL DEFAULT 0',
  },
  {
    table: 'transactions',
    column: 'app_id',
    alterSql: 'ALTER TABLE transactions ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS transactions_app_idx ON transactions(app_id)',
  },
  {
    table: 'notifications',
    column: 'app_id',
    alterSql: 'ALTER TABLE notifications ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS notifications_app_idx ON notifications(app_id)',
  },
  {
    table: 'support_tickets',
    column: 'app_id',
    alterSql: 'ALTER TABLE support_tickets ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS support_tickets_app_idx ON support_tickets(app_id)',
  },
  {
    table: 'content_items',
    column: 'app_id',
    alterSql: 'ALTER TABLE content_items ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS content_items_app_idx ON content_items(app_id)',
  },
  {
    table: 'backups',
    column: 'app_id',
    alterSql: 'ALTER TABLE backups ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS backups_app_idx ON backups(app_id)',
  },
  {
    table: 'api_logs',
    column: 'app_id',
    alterSql: 'ALTER TABLE api_logs ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE',
    indexSql: 'CREATE INDEX IF NOT EXISTS api_logs_app_idx ON api_logs(app_id)',
  },
];

async function ensureMultiAppColumnsAndIndexes(d1: D1Database): Promise<void> {
  const uniqueTables = Array.from(new Set(MULTI_APP_COLUMN_UPGRADES.map((u) => u.table)));
  const colsByTable = new Map<string, Set<string>>();
  for (const tbl of uniqueTables) {
    colsByTable.set(tbl, await getTableColumns(d1, tbl));
  }

  const alterStmts: D1PreparedStatement[] = [];
  const indexStmts: D1PreparedStatement[] = [];
  for (const spec of MULTI_APP_COLUMN_UPGRADES) {
    const cols = colsByTable.get(spec.table);
    if (cols && !cols.has(spec.column.toLowerCase())) {
      alterStmts.push(d1.prepare(spec.alterSql));
      cols.add(spec.column.toLowerCase());
    }
    if (spec.indexSql) {
      indexStmts.push(d1.prepare(spec.indexSql));
    }
  }

  if (alterStmts.length > 0) {
    await runStatementBatches(d1, alterStmts, 20);
  }
  if (indexStmts.length > 0) {
    await runStatementBatches(d1, indexStmts, 20);
  }
}

async function runSchemaBootstrap(d1: D1Database): Promise<void> {
  const tableRes = await d1
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all<{ name: string }>();
  const existingTables = new Set(tableRes.results.map((r) => r.name));
  const usersExist = existingTables.has('users');
  const userCols = usersExist ? await getUsersTableColumns(d1) : [];
  const allTablesExist = REQUIRED_TABLES.every((t) => existingTables.has(t));

  if (allTablesExist && hasFullUsersSchema(userCols)) {
    const adCols = await getTableColumns(d1, 'ad_configs');
    const apiCols = await getTableColumns(d1, 'api_logs');
    if (adCols.has('app_id') && adCols.has('admob_unit_id') && apiCols.has('app_id')) {
      return;
    }
    await ensureMultiAppColumnsAndIndexes(d1);
    return;
  }

  // Ensure RBAC core tables exist before users (foreign-key target roles.id)
  await runStatementBatches(
    d1,
    BASE_ROLE_DDL.map((sql) => d1.prepare(sql))
  );

  if (!usersExist) {
    await d1.batch([
      d1.prepare(buildUsersTableDdl('users')),
      ...USERS_INDEX_DDL.map((sql) => d1.prepare(sql)),
    ]);
  } else if (!hasFullUsersSchema(userCols)) {
    await migrateMinimalUsersTable(d1);
  } else {
    await d1.batch(USERS_INDEX_DDL.map((sql) => d1.prepare(sql)));
  }

  await runStatementBatches(
    d1,
    REMAINING_SCHEMA_DDL.map((sql) => d1.prepare(sql)),
    40
  );

  await ensureMultiAppColumnsAndIndexes(d1);
}

export function isSchemaBootstrapped(d1: D1Database): boolean {
  return bootstrappedDbs.has(d1);
}

export async function ensureD1SchemaReady(d1: D1Database): Promise<void> {
  if (bootstrappedDbs.has(d1)) return;
  let pending = inflightBootstraps.get(d1);
  if (!pending) {
    pending = runSchemaBootstrap(d1)
      .then(() => {
        bootstrappedDbs.add(d1);
      })
      .catch((err) => {
        inflightBootstraps.delete(d1);
        console.error('Failed to bootstrap D1 schema:', err);
        throw err;
      });
    inflightBootstraps.set(d1, pending);
  }
  return pending;
}
