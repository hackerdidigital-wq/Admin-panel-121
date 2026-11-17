import { eq } from 'drizzle-orm';
import type { AegisDatabase } from './index.ts';
import {
  categories,
  notificationTemplates,
  permissions,
  rolePermissions,
  roles,
  supportTemplates,
  systemSettings,
} from './schema.ts';
import { SYSTEM_PERMISSIONS, SYSTEM_ROLES } from '../lib/rbac.ts';

const seededDbs = new WeakSet<object>();
const inflightSeeds = new WeakMap<object, Promise<void>>();

async function runStructuralSeed(db: AegisDatabase, defaultGithubRepo = ''): Promise<void> {
  // 1. Ensure system permissions exist
  for (const perm of SYSTEM_PERMISSIONS) {
    await db
      .insert(permissions)
      .values({
        key: perm.key,
        module: perm.module,
        page: perm.page,
        action: perm.action,
        description: perm.description,
      })
      .onConflictDoUpdate({
        target: permissions.key,
        set: {
          module: perm.module,
          page: perm.page,
          action: perm.action,
          description: perm.description,
        },
      });
  }

  const allPermRows = await db.select().from(permissions);
  const permIdByKey = new Map(allPermRows.map((p) => [p.key, p.id]));

  // 2. Ensure system roles exist and link default permissions
  for (const roleDef of SYSTEM_ROLES) {
    const existing = await db.select().from(roles).where(eq(roles.slug, roleDef.slug)).limit(1);
    let roleId: number;

    if (existing.length === 0) {
      const inserted = await db
        .insert(roles)
        .values({
          slug: roleDef.slug,
          name: roleDef.name,
          description: roleDef.description,
          hierarchyLevel: roleDef.hierarchyLevel,
          isSystem: roleDef.isSystem,
        })
        .returning();
      roleId = inserted[0].id;

      for (const permKey of roleDef.permissions) {
        const permId = permIdByKey.get(permKey);
        if (permId) {
          await db
            .insert(rolePermissions)
            .values({ roleId, permissionId: permId })
            .onConflictDoNothing();
        }
      }
    } else {
      roleId = existing[0].id;
      if (roleDef.slug === 'super_admin') {
        for (const permKey of roleDef.permissions) {
          const permId = permIdByKey.get(permKey);
          if (permId) {
            await db
              .insert(rolePermissions)
              .values({ roleId, permissionId: permId })
              .onConflictDoNothing();
          }
        }
      }
    }
  }

  // 3. Default structural system settings (non-secret configuration; zero fake users)
  const defaultSettings: Array<{
    key: string;
    category: string;
    value: unknown;
    description: string;
  }> = [
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

  for (const s of defaultSettings) {
    await db
      .insert(systemSettings)
      .values({
        key: s.key,
        category: s.category,
        value: s.value,
        isSecret: false,
        description: s.description,
      })
      .onConflictDoNothing();
  }

  // 4. Default structural categories & templates
  const defaultCategories = [
    { slug: 'announcements', name: 'Announcements', description: 'Platform updates and operational notices' },
    { slug: 'documentation', name: 'Documentation', description: 'Guides, runbooks, and release notes' },
    { slug: 'security-advisories', name: 'Security Advisories', description: 'Security bulletins and policy updates' },
  ];
  for (const cat of defaultCategories) {
    await db.insert(categories).values(cat).onConflictDoNothing();
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
  for (const tpl of defaultNotifTemplates) {
    await db.insert(notificationTemplates).values(tpl).onConflictDoNothing();
  }

  const existingSupportTpls = await db.select().from(supportTemplates).limit(1);
  if (existingSupportTpls.length === 0) {
    await db.insert(supportTemplates).values([
      {
        title: 'Initial Acknowledgment',
        category: 'general',
        body: 'Thank you for contacting Operations Support. We have received your request and are reviewing the details.',
      },
      {
        title: 'Resolution Confirmation',
        category: 'general',
        body: 'The requested change has been applied and verified. Please let us know if you need any further assistance.',
      },
    ]);
  }
}

export async function ensureSystemSeeded(
  db: AegisDatabase,
  defaultGithubRepo = ''
): Promise<void> {
  if (seededDbs.has(db)) return;
  let pending = inflightSeeds.get(db);
  if (!pending) {
    pending = runStructuralSeed(db, defaultGithubRepo)
      .then(() => {
        seededDbs.add(db);
      })
      .catch((err) => {
        inflightSeeds.delete(db);
        console.error('Failed to seed structural system defaults:', err);
        throw err;
      });
    inflightSeeds.set(db, pending);
  }
  return pending;
}
