import { ensureD1SchemaReady } from './bootstrap.ts';
import { SYSTEM_PERMISSIONS, SYSTEM_ROLES } from '../lib/rbac.ts';
import type { D1Database, D1PreparedStatement } from '../worker/types.ts';

const seededDbs = new WeakSet<object>();
const inflightSeeds = new WeakMap<object, Promise<void>>();

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

function buildDefaultSettings(defaultGithubRepo = ''): Array<{
  key: string;
  category: string;
  value: unknown;
  description: string;
}> {
  return [
    {
      key: 'general.siteName',
      category: 'general',
      value: 'Aegis Enterprise Console',
      description: 'Organization workspace display name',
    },
    {
      key: 'general.supportEmail',
      category: 'general',
      value: 'ops@example.com',
      description: 'Primary operations contact address',
    },
    {
      key: 'app.version',
      category: 'app',
      value: '1.0.0',
      description: 'Current production client version',
    },
    {
      key: 'app.minSupportedVersion',
      category: 'app',
      value: '1.0.0',
      description: 'Minimum supported application version',
    },
    {
      key: 'app.forceUpdate',
      category: 'app',
      value: false,
      description: 'Require clients below minimum version to update',
    },
    {
      key: 'app.maintenanceMode',
      category: 'maintenance',
      value: false,
      description: 'Put public application endpoints in maintenance mode',
    },
    {
      key: 'app.maintenanceMessage',
      category: 'maintenance',
      value: 'Scheduled system maintenance is in progress.',
      description: 'Message displayed during maintenance windows',
    },
    {
      key: 'app.availabilityRegions',
      category: 'app',
      value: ['global-edge', 'cloudflare-workers-d1'],
      description: 'Supported deployment regions',
    },
    {
      key: 'app.homepageBanner',
      category: 'app',
      value: { enabled: false, headline: '', ctaLabel: '', ctaHref: '' },
      description: 'Application homepage announcement configuration',
    },
    {
      key: 'security.passwordPolicy',
      category: 'security',
      value: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireNumber: true,
        requireSymbol: true,
        maxAgeDays: 90,
      },
      description: 'Enterprise password complexity policy',
    },
    {
      key: 'security.ipAllowlist',
      category: 'security',
      value: [],
      description: 'Optional CIDR/IP allowlist for admin access (empty allows all)',
    },
    {
      key: 'security.rateLimitPerMinute',
      category: 'security',
      value: 180,
      description: 'API requests allowed per minute per client IP',
    },
    {
      key: 'security.sessionTimeoutMinutes',
      category: 'security',
      value: 480,
      description: 'Idle session expiration timeout in minutes',
    },
    {
      key: 'security.require2faForAdmins',
      category: 'security',
      value: false,
      description: 'Require enrolled TOTP 2FA for administrative actions',
    },
    {
      key: 'privacy.geoTrackingConsent',
      category: 'privacy',
      value: false,
      description: 'Enable geographic analytics only when user consent is active',
    },
    {
      key: 'retention.auditLogDays',
      category: 'retention',
      value: 365,
      description: 'Minimum retention window for immutable audit logs',
    },
    {
      key: 'retention.apiLogDays',
      category: 'retention',
      value: 30,
      description: 'Retention window in days for HTTP telemetry logs',
    },
    {
      key: 'backup.autoSchedule',
      category: 'backup',
      value: 'manual',
      description: 'Backup cadence (manual | daily | weekly)',
    },
    {
      key: 'notifications.emailProvider',
      category: 'notifications',
      value: { configured: false, provider: 'none' },
      description: 'External email provider configuration status',
    },
    {
      key: 'notifications.pushProvider',
      category: 'notifications',
      value: { configured: false, provider: 'none' },
      description: 'External push notification provider configuration status',
    },
    {
      key: 'github.repository',
      category: 'integrations',
      value: defaultGithubRepo,
      description: 'Connected GitHub repository (owner/repo)',
    },
    {
      key: 'appearance.defaultTheme',
      category: 'appearance',
      value: 'light',
      description: 'Default workspace color mode (light | dark)',
    },
    {
      key: 'localization.defaultTimezone',
      category: 'general',
      value: 'UTC',
      description: 'Default workspace timezone',
    },
    {
      key: 'localization.dateFormat',
      category: 'general',
      value: 'YYYY-MM-DD HH:mm',
      description: 'Default date and time format',
    },
  ];
}

async function runStructuralSeed(d1: D1Database, defaultGithubRepo = ''): Promise<void> {
  await ensureD1SchemaReady(d1);

  const defaultSettings = buildDefaultSettings(defaultGithubRepo);

  // Fast-path check in 1 single query (prevents redundant batch writes on warm/recreated wrappers)
  const fastCheck = await d1
    .prepare(
      `SELECT
        (SELECT count(*) FROM permissions) AS perms_count,
        (SELECT count(*) FROM roles) AS roles_count,
        (SELECT count(*) FROM system_settings) AS settings_count,
        (SELECT count(*) FROM categories) AS categories_count,
        (SELECT count(*) FROM notification_templates) AS notif_tpl_count,
        (SELECT count(*) FROM support_templates) AS support_tpl_count,
        (SELECT count(*) FROM users WHERE is_admin = 1 AND role_id IS NULL) AS unassigned_admins_count`
    )
    .first<{
      perms_count: number;
      roles_count: number;
      settings_count: number;
      categories_count: number;
      notif_tpl_count: number;
      support_tpl_count: number;
      unassigned_admins_count: number;
    }>();

  if (
    fastCheck &&
    Number(fastCheck.perms_count) >= SYSTEM_PERMISSIONS.length &&
    Number(fastCheck.roles_count) >= SYSTEM_ROLES.length &&
    Number(fastCheck.settings_count) >= defaultSettings.length &&
    Number(fastCheck.categories_count) >= 3 &&
    Number(fastCheck.notif_tpl_count) >= 2 &&
    Number(fastCheck.support_tpl_count) >= 1 &&
    Number(fastCheck.unassigned_admins_count) === 0
  ) {
    return;
  }

  const nowMs = Date.now();
  const existingRoleRows = await d1.prepare('SELECT id, slug FROM roles').all<{ id: number; slug: string }>();
  const preExistingRoleSlugs = new Set(existingRoleRows.results.map((r) => r.slug));

  const batchOne: D1PreparedStatement[] = [];

  // 1. Ensure system permissions exist
  const permStmt = d1.prepare(
    `INSERT INTO permissions (key, module, page, action, description)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       module = excluded.module,
       page = excluded.page,
       action = excluded.action,
       description = excluded.description`
  );
  for (const perm of SYSTEM_PERMISSIONS) {
    batchOne.push(permStmt.bind(perm.key, perm.module, perm.page, perm.action, perm.description));
  }

  // 2. Ensure system roles exist
  const roleStmt = d1.prepare(
    `INSERT OR IGNORE INTO roles (slug, name, description, hierarchy_level, is_system, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const roleDef of SYSTEM_ROLES) {
    batchOne.push(
      roleStmt.bind(
        roleDef.slug,
        roleDef.name,
        roleDef.description,
        roleDef.hierarchyLevel,
        roleDef.isSystem ? 1 : 0,
        nowMs,
        nowMs
      )
    );
  }

  // 3. Default structural system settings (non-secret configuration; zero fake users)
  const settingStmt = d1.prepare(
    `INSERT OR IGNORE INTO system_settings (key, category, value, is_secret, description, updated_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  );
  for (const s of defaultSettings) {
    batchOne.push(settingStmt.bind(s.key, s.category, JSON.stringify(s.value), s.description, nowMs));
  }

  // 4. Default structural categories & templates
  const defaultCategories = [
    { slug: 'announcements', name: 'Announcements', description: 'Platform updates and operational notices' },
    { slug: 'documentation', name: 'Documentation', description: 'Guides, runbooks, and release notes' },
    { slug: 'security-advisories', name: 'Security Advisories', description: 'Security bulletins and policy updates' },
  ];
  const catStmt = d1.prepare(
    `INSERT OR IGNORE INTO categories (slug, name, description, created_at) VALUES (?, ?, ?, ?)`
  );
  for (const cat of defaultCategories) {
    batchOne.push(catStmt.bind(cat.slug, cat.name, cat.description, nowMs));
  }

  const defaultNotifTemplates = [
    {
      key: 'account-status-change',
      name: 'Account Status Notice',
      channel: 'in_app',
      subject: 'Account Status Updated',
      body: 'Your account status has been updated to {{status}}.',
      variables: ['status'],
    },
    {
      key: 'security-alert',
      name: 'Security Advisory',
      channel: 'in_app',
      subject: 'Security Alert',
      body: 'A security event was recorded on your account: {{event}}.',
      variables: ['event'],
    },
  ];
  const notifStmt = d1.prepare(
    `INSERT OR IGNORE INTO notification_templates (key, name, channel, subject, body, variables, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  for (const tpl of defaultNotifTemplates) {
    batchOne.push(
      notifStmt.bind(
        tpl.key,
        tpl.name,
        tpl.channel,
        tpl.subject,
        tpl.body,
        JSON.stringify(tpl.variables),
        nowMs
      )
    );
  }

  if (Number(fastCheck?.support_tpl_count ?? 0) === 0) {
    const supportStmt = d1.prepare(
      `INSERT INTO support_templates (title, category, body, created_at) VALUES (?, ?, ?, ?)`
    );
    batchOne.push(
      supportStmt.bind(
        'Initial Acknowledgment',
        'general',
        'Thank you for contacting Operations Support. We have received your request and are reviewing the details.',
        nowMs
      ),
      supportStmt.bind(
        'Resolution Confirmation',
        'general',
        'The requested change has been applied and verified. Please let us know if you need any further assistance.',
        nowMs
      )
    );
  }

  await runStatementBatches(d1, batchOne, 40);

  // Resolve permission & role IDs in a single batch read
  const [permReadRes, roleReadRes] = await d1.batch<{ id: number; key?: string; slug?: string }>([
    d1.prepare('SELECT id, key FROM permissions'),
    d1.prepare('SELECT id, slug FROM roles'),
  ]);

  const permIdByKey = new Map<string, number>();
  for (const row of permReadRes.results) {
    if (row.key) permIdByKey.set(row.key, row.id);
  }
  const roleIdBySlug = new Map<string, number>();
  for (const row of roleReadRes.results) {
    if (row.slug) roleIdBySlug.set(row.slug, row.id);
  }

  // Link role permissions via batch for newly created roles & super_admin
  const batchTwo: D1PreparedStatement[] = [];
  const rpStmt = d1.prepare(
    `INSERT OR IGNORE INTO role_permissions (role_id, permission_id, created_at) VALUES (?, ?, ?)`
  );
  for (const roleDef of SYSTEM_ROLES) {
    const roleId = roleIdBySlug.get(roleDef.slug);
    if (!roleId) continue;
    const isNewRole = !preExistingRoleSlugs.has(roleDef.slug);
    if (!isNewRole && roleDef.slug !== 'super_admin') continue;

    for (const permKey of roleDef.permissions) {
      const permId = permIdByKey.get(permKey);
      if (permId) {
        batchTwo.push(rpStmt.bind(roleId, permId, nowMs));
      }
    }
  }

  // Ensure any migrated/unassigned admin users receive the super_admin role
  const superAdminId = roleIdBySlug.get('super_admin');
  if (superAdminId) {
    batchTwo.push(
      d1.prepare('UPDATE users SET role_id = ? WHERE is_admin = 1 AND role_id IS NULL').bind(superAdminId)
    );
  }

  await runStatementBatches(d1, batchTwo, 40);
}

export async function ensureSystemSeeded(
  d1: D1Database,
  defaultGithubRepo = ''
): Promise<void> {
  if (seededDbs.has(d1)) return;
  let pending = inflightSeeds.get(d1);
  if (!pending) {
    pending = runStructuralSeed(d1, defaultGithubRepo)
      .then(() => {
        seededDbs.add(d1);
      })
      .catch((err) => {
        inflightSeeds.delete(d1);
        console.error('Failed to seed structural system defaults:', err);
        throw err;
      });
    inflightSeeds.set(d1, pending);
  }
  return pending;
}
