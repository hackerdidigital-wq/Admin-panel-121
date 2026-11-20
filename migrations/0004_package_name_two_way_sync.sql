-- Aegis Enterprise Console — Standardized package_name Two-Way App Sync Migration
-- Adds canonical package_name identification on connected_apps plus dedicated
-- app_announcements, app_remote_configs, and app_heartbeats tables (39 tables total).

ALTER TABLE connected_apps ADD COLUMN package_name TEXT NOT NULL DEFAULT '';

-- Backfill package_name safely from legacy package_or_domain without creating duplicates
UPDATE connected_apps
SET package_name = lower(trim(package_or_domain))
WHERE package_name = ''
  AND trim(package_or_domain) != ''
  AND trim(package_or_domain) NOT LIKE '%://%'
  AND instr(trim(package_or_domain), '.') > 0
  AND id = (
    SELECT MIN(c2.id)
    FROM connected_apps c2
    WHERE lower(trim(c2.package_or_domain)) = lower(trim(connected_apps.package_or_domain))
  );

CREATE UNIQUE INDEX IF NOT EXISTS connected_apps_package_name_unique_idx
  ON connected_apps(lower(package_name))
  WHERE package_name != '';

CREATE TABLE IF NOT EXISTS app_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  action_url TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS app_announcements_pkg_active_idx
  ON app_announcements(lower(package_name), active, priority);
CREATE INDEX IF NOT EXISTS app_announcements_app_idx
  ON app_announcements(app_id);

CREATE TABLE IF NOT EXISTS app_remote_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL DEFAULT '',
  maintenance INTEGER NOT NULL DEFAULT 0,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  maintenance_message TEXT NOT NULL DEFAULT 'Scheduled maintenance is in progress.',
  banner_json TEXT NOT NULL DEFAULT '{}',
  flags_json TEXT NOT NULL DEFAULT '{}',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_remote_configs_app_unique_idx
  ON app_remote_configs(app_id);
CREATE INDEX IF NOT EXISTS app_remote_configs_pkg_idx
  ON app_remote_configs(lower(package_name));

CREATE TABLE IF NOT EXISTS app_heartbeats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL DEFAULT '',
  version_name TEXT NOT NULL DEFAULT '',
  version_code INTEGER NOT NULL DEFAULT 0,
  platform TEXT NOT NULL DEFAULT 'android',
  status TEXT NOT NULL DEFAULT 'online',
  event TEXT NOT NULL DEFAULT 'heartbeat',
  payload_json TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS app_heartbeats_pkg_seen_idx
  ON app_heartbeats(lower(package_name), last_seen_at);
CREATE INDEX IF NOT EXISTS app_heartbeats_app_seen_idx
  ON app_heartbeats(app_id, last_seen_at);
