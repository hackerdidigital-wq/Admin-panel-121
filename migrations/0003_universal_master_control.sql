-- Aegis Enterprise Console — Universal Multi-App Master Control Migration
-- Upgrades connected_apps with backend namespace, discovery metadata, and sync status,
-- isolates files per appId, and adds app_modules, app_collections, and app_records (36 tables total).

ALTER TABLE connected_apps ADD COLUMN backend_namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE connected_apps ADD COLUMN integration_mode TEXT NOT NULL DEFAULT 'aegis_managed';
ALTER TABLE connected_apps ADD COLUMN backend_base_url TEXT NOT NULL DEFAULT '';
ALTER TABLE connected_apps ADD COLUMN manifest_url TEXT NOT NULL DEFAULT '';
ALTER TABLE connected_apps ADD COLUMN discovered_capabilities TEXT NOT NULL DEFAULT '{}';
ALTER TABLE connected_apps ADD COLUMN enabled_modules TEXT NOT NULL DEFAULT '[]';
ALTER TABLE connected_apps ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'unverified';

ALTER TABLE files ADD COLUMN app_id INTEGER REFERENCES connected_apps(id) ON DELETE CASCADE;
ALTER TABLE files ADD COLUMN storage_namespace TEXT NOT NULL DEFAULT 'global';
CREATE INDEX IF NOT EXISTS files_app_idx ON files(app_id);

CREATE TABLE IF NOT EXISTS app_modules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'custom',
  status TEXT NOT NULL DEFAULT 'active',
  config_json TEXT NOT NULL DEFAULT '{}',
  generated_code TEXT NOT NULL DEFAULT '',
  migration_sql TEXT NOT NULL DEFAULT '',
  api_endpoints TEXT NOT NULL DEFAULT '[]',
  ui_schema TEXT NOT NULL DEFAULT '{}',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS app_modules_app_key_unique_idx ON app_modules(app_id, module_key);
CREATE INDEX IF NOT EXISTS app_modules_app_idx ON app_modules(app_id);

CREATE TABLE IF NOT EXISTS app_collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '{"read":"sdk","write":"sdk"}',
  migration_sql TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS app_collections_app_slug_unique_idx ON app_collections(app_id, slug);
CREATE INDEX IF NOT EXISTS app_collections_app_idx ON app_collections(app_id);

CREATE TABLE IF NOT EXISTS app_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES connected_apps(id) ON DELETE CASCADE,
  collection_id INTEGER NOT NULL REFERENCES app_collections(id) ON DELETE CASCADE,
  record_uid TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE UNIQUE INDEX IF NOT EXISTS app_records_col_uid_unique_idx ON app_records(collection_id, record_uid);
CREATE INDEX IF NOT EXISTS app_records_app_col_idx ON app_records(app_id, collection_id);
