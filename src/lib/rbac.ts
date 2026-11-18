export type PermissionAction = 'read' | 'write' | 'delete' | 'manage';

export interface PermissionDefinition {
  key: string;
  module: string;
  page: string;
  action: PermissionAction;
  description: string;
}

export interface RoleDefinition {
  slug: string;
  name: string;
  description: string;
  hierarchyLevel: number;
  isSystem: boolean;
  permissions: string[];
}

export const SYSTEM_PERMISSIONS: PermissionDefinition[] = [
  // Overview & Analytics
  { key: 'dashboard.read', module: 'overview', page: 'dashboard', action: 'read', description: 'View main operational dashboard' },
  { key: 'dashboard.customize', module: 'overview', page: 'dashboard', action: 'write', description: 'Customize and save dashboard widget layouts' },
  { key: 'analytics.read', module: 'analytics', page: 'analytics', action: 'read', description: 'View analytics and export reports' },

  // User Management
  { key: 'users.read', module: 'users', page: 'all_users', action: 'read', description: 'View user profiles, activity, devices, and sessions' },
  { key: 'users.write', module: 'users', page: 'all_users', action: 'write', description: 'Create, edit, verify, note, and restrict user accounts' },
  { key: 'users.suspend', module: 'users', page: 'all_users', action: 'manage', description: 'Activate, suspend, ban, unban, and force-logout users' },
  { key: 'users.delete', module: 'users', page: 'all_users', action: 'delete', description: 'Soft-delete and restore user accounts' },
  { key: 'users.export', module: 'users', page: 'export_import', action: 'read', description: 'Export user datasets to CSV' },
  { key: 'users.import', module: 'users', page: 'export_import', action: 'write', description: 'Import user records in bulk' },

  // Roles & Permissions
  { key: 'roles.read', module: 'roles', page: 'roles_matrix', action: 'read', description: 'View roles, permission groups, and permission audits' },
  { key: 'roles.manage', module: 'roles', page: 'roles_matrix', action: 'manage', description: 'Create custom roles, edit permission matrices, and assign roles' },

  // Content Management
  { key: 'content.read', module: 'content', page: 'all_content', action: 'read', description: 'View content items, categories, tags, and version history' },
  { key: 'content.write', module: 'content', page: 'all_content', action: 'write', description: 'Create and edit content drafts and categories' },
  { key: 'content.publish', module: 'content', page: 'content_approval', action: 'manage', description: 'Approve, publish, schedule, and bulk publish content' },
  { key: 'content.delete', module: 'content', page: 'trash', action: 'delete', description: 'Move content to trash or permanently delete' },

  // Notifications
  { key: 'notifications.read', module: 'notifications', page: 'all_notifications', action: 'read', description: 'View notifications, delivery history, and templates' },
  { key: 'notifications.send', module: 'notifications', page: 'compose', action: 'write', description: 'Send notifications and manage templates' },

  // Financial Management
  { key: 'finance.read', module: 'finance', page: 'transactions', action: 'read', description: 'View transactions, payouts, and revenue reports' },
  { key: 'finance.manage', module: 'finance', page: 'refunds', action: 'manage', description: 'Record transactions, process refunds, and flag fraud' },

  // Advertisement Management
  { key: 'ads.read', module: 'ads', page: 'ad_configs', action: 'read', description: 'View ad networks, placements, and error logs' },
  { key: 'ads.manage', module: 'ads', page: 'ad_configs', action: 'manage', description: 'Configure ad units, frequency caps, and visibility rules' },

  // Application Management
  { key: 'app.read', module: 'app', page: 'app_config', action: 'read', description: 'View app version, releases, and feature flags' },
  { key: 'app.manage', module: 'app', page: 'app_config', action: 'manage', description: 'Manage releases, force updates, maintenance mode, and flags' },

  // Support & Communication
  { key: 'support.read', module: 'support', page: 'tickets', action: 'read', description: 'View support tickets and user conversations' },
  { key: 'support.write', module: 'support', page: 'tickets', action: 'write', description: 'Reply to tickets, add internal notes, and update status' },
  { key: 'support.manage', module: 'support', page: 'tickets', action: 'manage', description: 'Assign tickets, manage categories and response templates' },

  // Security Center
  { key: 'security.read', module: 'security', page: 'security_dashboard', action: 'read', description: 'View login attempts, active sessions, and security events' },
  { key: 'security.manage', module: 'security', page: 'security_policies', action: 'manage', description: 'Enforce 2FA, IP policies, rate limits, and revoke sessions' },

  // System Management
  { key: 'system.read', module: 'system', page: 'system_health', action: 'read', description: 'Monitor OS, API, DB health, logs, and background jobs' },
  { key: 'system.manage', module: 'system', page: 'maintenance', action: 'manage', description: 'Run jobs, clear caches, and trigger maintenance tools' },

  // GitHub & Developer Center
  { key: 'github.read', module: 'github', page: 'repo_overview', action: 'read', description: 'View GitHub repository commits, branches, workflows, and PRs' },
  { key: 'github.manage', module: 'github', page: 'repo_connection', action: 'manage', description: 'Configure connected GitHub repository and release metadata' },

  // Database Management (Restricted)
  { key: 'database.read', module: 'database', page: 'db_overview', action: 'read', description: 'Inspect SQLite D1 schema metadata and backup history' },
  { key: 'database.inspect', module: 'database', page: 'records', action: 'manage', description: 'Browse table records, create/verify backups, and export' },
  { key: 'database.restore', module: 'database', page: 'backups', action: 'manage', description: 'Restore backups and import full database snapshots' },

  // Multi-App & SDK Management
  { key: 'apps.read', module: 'apps', page: 'apps_directory', action: 'read', description: 'View connected apps, end-users, health, and error telemetry' },
  { key: 'apps.manage', module: 'apps', page: 'apps_connect', action: 'manage', description: 'Connect, configure, disconnect, and manage apps and end-users' },
  { key: 'apps.keys', module: 'apps', page: 'apps_api_keys', action: 'manage', description: 'Generate, rotate, and revoke per-app SDK API keys' },
  { key: 'webhooks.manage', module: 'apps', page: 'apps_webhooks', action: 'manage', description: 'Create, test, and manage outbound HMAC-signed webhooks' },

  // File & Media Management
  { key: 'files.read', module: 'files', page: 'file_explorer', action: 'read', description: 'Browse files, metadata, and storage usage' },
  { key: 'files.write', module: 'files', page: 'upload_manager', action: 'write', description: 'Upload files and update permissions' },
  { key: 'files.delete', module: 'files', page: 'file_explorer', action: 'delete', description: 'Safely delete unused or archived files' },

  // Settings & Audit
  { key: 'settings.read', module: 'settings', page: 'general', action: 'read', description: 'View system and integration settings' },
  { key: 'settings.manage', module: 'settings', page: 'general', action: 'manage', description: 'Modify platform, security, backup, and privacy settings' },
  { key: 'audit.read', module: 'audit', page: 'audit_logs', action: 'read', description: 'View immutable audit logs, API logs, and export history' },

  // AI Operations Assistant
  { key: 'ai.analyze', module: 'ai', page: 'security_dashboard', action: 'manage', description: 'Run Gemini high-thinking operational and security analysis' },
];

const ALL_KEYS = SYSTEM_PERMISSIONS.map((p) => p.key);

export const SYSTEM_ROLES: RoleDefinition[] = [
  {
    slug: 'super_admin',
    name: 'Super Admin',
    description: 'Unrestricted enterprise governance including database inspection, restore, multi-app SDK keys, RBAC, and security policies.',
    hierarchyLevel: 100,
    isSystem: true,
    permissions: ALL_KEYS,
  },
  {
    slug: 'admin',
    name: 'Admin',
    description: 'Full operational administration across connected apps, users, content, finance, support, and monitoring; restricted from raw database dumps and restores.',
    hierarchyLevel: 80,
    isSystem: true,
    permissions: ALL_KEYS.filter((k) => k !== 'database.inspect' && k !== 'database.restore'),
  },
  {
    slug: 'manager',
    name: 'Manager',
    description: 'Operational oversight for connected apps, content publishing, notifications, analytics, support escalation, and team workflows.',
    hierarchyLevel: 60,
    isSystem: true,
    permissions: [
      'dashboard.read',
      'dashboard.customize',
      'analytics.read',
      'apps.read',
      'users.read',
      'users.write',
      'users.export',
      'roles.read',
      'content.read',
      'content.write',
      'content.publish',
      'notifications.read',
      'notifications.send',
      'finance.read',
      'ads.read',
      'app.read',
      'support.read',
      'support.write',
      'support.manage',
      'files.read',
      'files.write',
      'settings.read',
      'audit.read',
      'github.read',
    ],
  },
  {
    slug: 'moderator',
    name: 'Moderator',
    description: 'Content moderation, user suspension review, and community safety enforcement.',
    hierarchyLevel: 40,
    isSystem: true,
    permissions: [
      'dashboard.read',
      'users.read',
      'users.suspend',
      'content.read',
      'content.write',
      'content.publish',
      'notifications.read',
      'support.read',
      'support.write',
      'files.read',
      'audit.read',
    ],
  },
  {
    slug: 'support_agent',
    name: 'Support Agent',
    description: 'Customer support ticket handling, user diagnostics, and account verification.',
    hierarchyLevel: 20,
    isSystem: true,
    permissions: [
      'dashboard.read',
      'users.read',
      'notifications.read',
      'support.read',
      'support.write',
      'content.read',
      'files.read',
    ],
  },
];

export interface PermissionOverride {
  key: string;
  granted: boolean;
}

export function resolveEffectivePermissions(
  rolePermissions: string[],
  overrides: PermissionOverride[] = [],
  roleSlug?: string
): Set<string> {
  if (roleSlug === 'super_admin') {
    const full = new Set(ALL_KEYS);
    for (const ov of overrides) {
      if (!ov.granted) full.delete(ov.key);
    }
    return full;
  }

  const effective = new Set(rolePermissions);
  for (const ov of overrides) {
    if (ov.granted) {
      effective.add(ov.key);
    } else {
      effective.delete(ov.key);
    }
  }
  return effective;
}

export function hasPermission(effective: Set<string>, required: string | string[]): boolean {
  if (Array.isArray(required)) {
    return required.some((perm) => effective.has(perm));
  }
  return effective.has(required);
}

export function canManageRole(actorHierarchy: number, targetHierarchy: number, actorIsSuperAdmin: boolean): boolean {
  if (actorIsSuperAdmin) return true;
  return actorHierarchy > targetHierarchy;
}
