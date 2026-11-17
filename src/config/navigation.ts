import type { LucideIcon } from 'lucide-react';
import {
  Activity,
  AppWindow,
  BarChart3,
  Bell,
  Database,
  FileText,
  FolderOpen,
  GitBranch,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Megaphone,
  ScrollText,
  Server,
  Settings,
  Shield,
  Users,
  Wallet,
} from 'lucide-react';

export interface SubMenuItem {
  id: string;
  label: string;
  permission?: string | string[];
}

export interface SidebarModule {
  id: string;
  code: string;
  label: string;
  icon: LucideIcon;
  permission?: string | string[];
  submenus: SubMenuItem[];
}

export const SIDEBAR_MODULES: SidebarModule[] = [
  {
    id: 'overview',
    code: 'A',
    label: 'Overview',
    icon: LayoutDashboard,
    permission: 'dashboard.read',
    submenus: [
      { id: 'overview-dashboard', label: 'Dashboard', permission: 'dashboard.read' },
      { id: 'analytics-overview', label: 'Analytics', permission: 'analytics.read' },
      { id: 'analytics-reports', label: 'Reports', permission: 'analytics.read' },
      { id: 'overview-activity', label: 'Activity Overview', permission: 'dashboard.read' },
    ],
  },
  {
    id: 'users',
    code: 'B',
    label: 'User Management',
    icon: Users,
    permission: 'users.read',
    submenus: [
      { id: 'users-all', label: 'All Users', permission: 'users.read' },
      { id: 'users-active', label: 'Active Users', permission: 'users.read' },
      { id: 'users-new', label: 'New Users', permission: 'users.read' },
      { id: 'users-online', label: 'Online Users', permission: 'users.read' },
      { id: 'users-inactive', label: 'Inactive Users', permission: 'users.read' },
      { id: 'users-suspended', label: 'Suspended Users', permission: 'users.read' },
      { id: 'users-banned', label: 'Banned Users', permission: 'users.read' },
      { id: 'users-deleted', label: 'Deleted Users', permission: 'users.read' },
      { id: 'users-verification', label: 'User Verification', permission: 'users.write' },
      { id: 'users-export-import', label: 'Export & Import', permission: ['users.export', 'users.import'] },
    ],
  },
  {
    id: 'roles',
    code: 'C',
    label: 'Roles & Permissions',
    icon: KeyRound,
    permission: 'roles.read',
    submenus: [
      { id: 'roles-system', label: 'System Roles', permission: 'roles.read' },
      { id: 'roles-custom', label: 'Custom Roles', permission: 'roles.read' },
      { id: 'roles-matrix', label: 'Permission Matrix', permission: 'roles.read' },
      { id: 'roles-audit', label: 'Permission Audit', permission: 'audit.read' },
    ],
  },
  {
    id: 'content',
    code: 'D',
    label: 'Content Management',
    icon: FileText,
    permission: 'content.read',
    submenus: [
      { id: 'content-all', label: 'All Content', permission: 'content.read' },
      { id: 'content-create', label: 'Create Content', permission: 'content.write' },
      { id: 'content-drafts', label: 'Drafts', permission: 'content.read' },
      { id: 'content-approval', label: 'Content Approval', permission: 'content.publish' },
      { id: 'content-published', label: 'Published Content', permission: 'content.read' },
      { id: 'content-scheduled', label: 'Scheduled Content', permission: 'content.read' },
      { id: 'content-archived', label: 'Archived Content', permission: 'content.read' },
      { id: 'content-categories', label: 'Categories & Tags', permission: 'content.read' },
      { id: 'content-trash', label: 'Trash', permission: 'content.read' },
    ],
  },
  {
    id: 'notifications',
    code: 'E',
    label: 'Notifications Center',
    icon: Bell,
    permission: 'notifications.read',
    submenus: [
      { id: 'notifications-all', label: 'All Notifications', permission: 'notifications.read' },
      { id: 'notifications-compose', label: 'Send Notification', permission: 'notifications.send' },
      { id: 'notifications-in-app', label: 'In-App Channel', permission: 'notifications.read' },
      { id: 'notifications-email', label: 'Email Channel', permission: 'notifications.read' },
      { id: 'notifications-push', label: 'Push Channel', permission: 'notifications.read' },
      { id: 'notifications-templates', label: 'Templates', permission: 'notifications.read' },
      { id: 'notifications-scheduled', label: 'Scheduled', permission: 'notifications.read' },
      { id: 'notifications-failed', label: 'Failed Deliveries', permission: 'notifications.read' },
      { id: 'notifications-settings', label: 'Delivery Settings', permission: 'settings.read' },
    ],
  },
  {
    id: 'finance',
    code: 'F',
    label: 'Financial Management',
    icon: Wallet,
    permission: 'finance.read',
    submenus: [
      { id: 'finance-transactions', label: 'Transactions', permission: 'finance.read' },
      { id: 'finance-refunds', label: 'Refund Management', permission: 'finance.read' },
      { id: 'finance-failed', label: 'Failed Payments', permission: 'finance.read' },
      { id: 'finance-payouts', label: 'Payout Records', permission: 'finance.read' },
      { id: 'finance-fraud', label: 'Fraud Alerts', permission: 'finance.read' },
      { id: 'finance-analytics', label: 'Revenue Analytics', permission: 'finance.read' },
    ],
  },
  {
    id: 'ads',
    code: 'G',
    label: 'Advertisement Mgmt',
    icon: Megaphone,
    permission: 'ads.read',
    submenus: [
      { id: 'ads-networks', label: 'Ad Networks & Config', permission: 'ads.read' },
      { id: 'ads-placements', label: 'Placements & Formats', permission: 'ads.read' },
      { id: 'ads-performance', label: 'Performance & Logs', permission: 'ads.read' },
    ],
  },
  {
    id: 'app',
    code: 'H',
    label: 'Application Mgmt',
    icon: AppWindow,
    permission: 'app.read',
    submenus: [
      { id: 'app-general', label: 'App Info & Versions', permission: 'app.read' },
      { id: 'app-flags', label: 'Feature Flags', permission: 'app.read' },
      { id: 'app-maintenance', label: 'Maintenance & Updates', permission: 'app.read' },
      { id: 'app-releases', label: 'Release Changelog', permission: 'app.read' },
    ],
  },
  {
    id: 'support',
    code: 'I',
    label: 'Support & Comms',
    icon: LifeBuoy,
    permission: 'support.read',
    submenus: [
      { id: 'support-tickets', label: 'All Tickets', permission: 'support.read' },
      { id: 'support-open', label: 'Open Tickets', permission: 'support.read' },
      { id: 'support-pending', label: 'Pending Tickets', permission: 'support.read' },
      { id: 'support-resolved', label: 'Resolved Tickets', permission: 'support.read' },
      { id: 'support-templates', label: 'Response Templates', permission: 'support.read' },
      { id: 'support-analytics', label: 'Support Analytics', permission: 'support.read' },
    ],
  },
  {
    id: 'analytics',
    code: 'J',
    label: 'Analytics & Reports',
    icon: BarChart3,
    permission: 'analytics.read',
    submenus: [
      { id: 'analytics-users', label: 'User & Growth', permission: 'analytics.read' },
      { id: 'analytics-revenue', label: 'Revenue & Content', permission: 'analytics.read' },
      { id: 'analytics-devices', label: 'Devices & Geo', permission: 'analytics.read' },
      { id: 'analytics-export', label: 'Custom Reports', permission: 'analytics.read' },
    ],
  },
  {
    id: 'security',
    code: 'K',
    label: 'Security Center',
    icon: Shield,
    permission: 'security.read',
    submenus: [
      { id: 'security-dashboard', label: 'Security Dashboard', permission: 'security.read' },
      { id: 'security-sessions', label: 'Active Sessions', permission: 'security.read' },
      { id: 'security-2fa', label: 'Two-Factor Auth', permission: 'dashboard.read' },
      { id: 'security-policies', label: 'Policies & IP Rules', permission: 'security.read' },
      { id: 'security-events', label: 'Security Events & AI', permission: 'security.read' },
    ],
  },
  {
    id: 'system',
    code: 'L',
    label: 'System Management',
    icon: Server,
    permission: 'system.read',
    submenus: [
      { id: 'system-health', label: 'System & API Health', permission: 'system.read' },
      { id: 'system-logs', label: 'Application & Error Logs', permission: 'system.read' },
      { id: 'system-jobs', label: 'Background Jobs', permission: 'system.read' },
      { id: 'system-maintenance', label: 'Maintenance Tools', permission: 'system.read' },
    ],
  },
  {
    id: 'github',
    code: 'M',
    label: 'GitHub & Dev Center',
    icon: GitBranch,
    permission: 'github.read',
    submenus: [
      { id: 'github-overview', label: 'Repository Overview', permission: 'github.read' },
      { id: 'github-branches', label: 'Branches & Commits', permission: 'github.read' },
      { id: 'github-workflows', label: 'Actions & Workflows', permission: 'github.read' },
      { id: 'github-releases', label: 'Releases & Rollback', permission: 'github.read' },
      { id: 'github-docs', label: 'Repo Docs & Limits', permission: 'github.read' },
    ],
  },
  {
    id: 'database',
    code: 'N',
    label: 'Database Mgmt',
    icon: Database,
    permission: 'database.read',
    submenus: [
      { id: 'database-overview', label: 'Database Overview', permission: 'database.read' },
      { id: 'database-records', label: 'Record Inspector', permission: 'database.inspect' },
      { id: 'database-backups', label: 'Backup & Verification', permission: 'database.read' },
      { id: 'database-retention', label: 'Retention & Migrations', permission: 'database.read' },
    ],
  },
  {
    id: 'files',
    code: 'O',
    label: 'File & Media Mgmt',
    icon: FolderOpen,
    permission: 'files.read',
    submenus: [
      { id: 'files-explorer', label: 'File Explorer', permission: 'files.read' },
      { id: 'files-images', label: 'Image Manager', permission: 'files.read' },
      { id: 'files-documents', label: 'Document Manager', permission: 'files.read' },
      { id: 'files-unused', label: 'Unused File Audit', permission: 'files.read' },
    ],
  },
  {
    id: 'settings',
    code: 'P',
    label: 'Settings',
    icon: Settings,
    permission: 'settings.read',
    submenus: [
      { id: 'settings-general', label: 'General Settings', permission: 'settings.read' },
      { id: 'settings-profile', label: 'Profile Settings' },
      { id: 'settings-appearance', label: 'Appearance & Theme' },
      { id: 'settings-localization', label: 'Language & Timezone' },
      { id: 'settings-notifications', label: 'Notification Prefs', permission: 'settings.read' },
      { id: 'settings-security', label: 'Security Preferences', permission: 'settings.read' },
      { id: 'settings-integrations', label: 'API & Integrations', permission: 'settings.read' },
      { id: 'settings-backup', label: 'Backup & Retention', permission: 'settings.read' },
      { id: 'settings-privacy', label: 'Privacy & Maintenance', permission: 'settings.read' },
    ],
  },
  {
    id: 'audit',
    code: 'Q',
    label: 'Audit & Activity Logs',
    icon: ScrollText,
    permission: 'audit.read',
    submenus: [
      { id: 'audit-admin', label: 'Admin Activity', permission: 'audit.read' },
      { id: 'audit-auth', label: 'Login History', permission: 'audit.read' },
      { id: 'audit-security', label: 'Security & Permissions', permission: 'audit.read' },
      { id: 'audit-api', label: 'API Requests', permission: 'audit.read' },
      { id: 'audit-exports', label: 'Export History', permission: 'audit.read' },
    ],
  },
];

export function resolveBreadcrumb(viewId: string): { moduleLabel: string; pageLabel: string } {
  if (viewId.startsWith('user-detail:')) {
    return { moduleLabel: 'User Management', pageLabel: `User Profile #${viewId.split(':')[1]}` };
  }
  for (const mod of SIDEBAR_MODULES) {
    const sub = mod.submenus.find((s) => s.id === viewId);
    if (sub) {
      return { moduleLabel: mod.label, pageLabel: sub.label };
    }
  }
  return { moduleLabel: 'Overview', pageLabel: 'Dashboard' };
}

export const MODULE_ICON_BY_KEY: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  users: Users,
  roles: KeyRound,
  content: FileText,
  notifications: Bell,
  finance: Wallet,
  ads: Megaphone,
  app: AppWindow,
  support: LifeBuoy,
  analytics: BarChart3,
  security: Shield,
  system: Server,
  github: GitBranch,
  database: Database,
  files: FolderOpen,
  settings: Settings,
  audit: Activity,
};
