-- Aegis Enterprise Console — Unlimited Multi-App Platform Migration
-- Adds 7 multi-app, SDK, webhook, and app-level RBAC tables (33 tables total)
-- and adds nullable app_id foreign keys for strict multi-app data isolation.

CREATE TABLE IF NOT EXISTS connected_apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_uid TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android', -- android | game | website | ios | api
  package_or_domain TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected', -- connected | disconnected | maintenance
  current_version TEXT NOT NULL DEFAULT '1.0.0',
  min_supported_version TEXT NOT NULL DEFAULT '1.0.0',
  force_update INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT NOT NULL DEFAULT 'Scheduled maintenance is in progress.',
  admob_app_id TEXT NOT NULL DEFAULT '',
  ads_enabled INTEGER NOT NULL DEFAULT 1,
  webhook_secret TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'healthy', -- healthy | degraded | offline
  last_heartbeat_at INTEGER,
  last_latency_ms INTEGER NOT NULL DEFAULT 0,
  error_count_24h INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS connected_apps_status_idx ON connected_apps(status);
CREATE INDEX IF NOT EXISTS connected_apps_platform_idx ON connected_apps(platform);

CREATE TABLE IF NOT EXISTS app_api_keys (
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
);
CREATE INDEX IF NOT EXISTS app_api_keys_app_idx ON app_api_keys(app_id);
CREATE INDEX IF NOT EXISTS app_api_keys_active_idx ON app_api_keys(is_active);

CREATE TABLE IF NOT EXISTS app_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  external_user_id TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active', -- active | banned | suspended
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
);
CREATE UNIQUE INDEX IF NOT EXISTS app_users_app_ext_unique_idx ON app_users(app_id, external_user_id);
CREATE INDEX IF NOT EXISTS app_users_app_status_idx ON app_users(app_id, status);
CREATE INDEX IF NOT EXISTS app_users_last_active_idx ON app_users(last_active_at);

CREATE TABLE IF NOT EXISTS app_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  app_user_id INTEGER REFERENCES app_users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL, -- analytics | error | health | ad_impression | ad_click | session
  event_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info', -- info | warn | error | critical
  latency_ms INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX IF NOT EXISTS app_events_app_created_idx ON app_events(app_id, created_at);
CREATE INDEX IF NOT EXISTS app_events_severity_idx ON app_events(severity);
CREATE INDEX IF NOT EXISTS app_events_user_idx ON app_events(app_user_id);

CREATE TABLE IF NOT EXISTS webhooks (
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
);
CREATE INDEX IF NOT EXISTS webhooks_app_idx ON webhooks(app_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
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
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_idx ON webhook_deliveries(webhook_id, created_at);

CREATE TABLE IF NOT EXISTS user_app_permissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  role_scope TEXT NOT NULL DEFAULT 'admin', -- owner | admin | editor | viewer
  permissions TEXT NOT NULL DEFAULT '[]',
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS user_app_perm_unique_idx ON user_app_permissions(user_id, app_id);

-- Multi-app isolation foreign keys on shared operational tables
ALTER TABLE feature_flags ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE app_releases ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE ad_configs ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE ad_configs ADD COLUMN admob_unit_id TEXT NOT NULL DEFAULT '';
ALTER TABLE ad_configs ADD COLUMN ecpm_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE transactions ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE support_tickets ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE content_items ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE backups ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE api_logs ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS feature_flags_app_idx ON feature_flags(app_id);
CREATE INDEX IF NOT EXISTS app_releases_app_idx ON app_releases(app_id);
CREATE INDEX IF NOT EXISTS ad_configs_app_idx ON ad_configs(app_id);
CREATE INDEX IF NOT EXISTS transactions_app_idx ON transactions(app_id);
CREATE INDEX IF NOT EXISTS notifications_app_idx ON notifications(app_id);
CREATE INDEX IF NOT EXISTS support_tickets_app_idx ON support_tickets(app_id);
CREATE INDEX IF NOT EXISTS content_items_app_idx ON content_items(app_id);
CREATE INDEX IF NOT EXISTS backups_app_idx ON backups(app_id);
CREATE INDEX IF NOT EXISTS api_logs_app_idx ON api_logs(app_id);
