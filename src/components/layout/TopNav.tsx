import React, { useEffect, useState } from 'react';
import {
  Bell,
  ChevronRight,
  LogOut,
  Menu,
  Moon,
  Search,
  Settings,
  Shield,
  Sun,
  User as UserIcon,
} from 'lucide-react';
import { resolveBreadcrumb } from '../../config/navigation';
import { useAuth } from '../../contexts/AuthContext';
import { useRealtime } from '../../contexts/RealtimeContext';
import { apiRequest } from '../../lib/api';

interface TopNavProps {
  activeView: string;
  onOpenMobileMenu: () => void;
  onOpenSearch: () => void;
  onNavigate: (viewId: string) => void;
}

interface NotificationRow {
  id: number;
  title: string;
  message: string;
  status: string;
  createdAt: string;
}

export const TopNav: React.FC<TopNavProps> = ({
  activeView,
  onOpenMobileMenu,
  onOpenSearch,
  onNavigate,
}) => {
  const { adminUser, theme, toggleTheme, logout, hasPerm } = useAuth();
  const { connected, activeConnections } = useRealtime();
  const [notifOpen, setNotifOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);

  const crumb = resolveBreadcrumb(activeView);

  useEffect(() => {
    if (!notifOpen || !hasPerm('notifications.read')) return;
    void apiRequest<{ data: NotificationRow[] }>('/notifications')
      .then((res) => setNotifications(res.data.slice(0, 6)))
      .catch(() => {});
  }, [notifOpen, hasPerm]);

  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 lg:px-6 dark:border-slate-800 dark:bg-slate-950 no-print">
      {/* Left: Mobile drawer trigger + Breadcrumbs */}
      <div className="flex min-w-0 items-center gap-3">
        <button
          type="button"
          onClick={onOpenMobileMenu}
          aria-label="Open navigation menu"
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 lg:hidden dark:border-slate-800 dark:text-slate-300"
        >
          <Menu className="h-4 w-4" />
        </button>

        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="hidden text-slate-500 sm:inline dark:text-slate-400">
            {crumb.moduleLabel}
          </span>
          <ChevronRight className="hidden h-3.5 w-3.5 text-slate-400 sm:inline" />
          <span className="truncate font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            {crumb.pageLabel}
          </span>
        </nav>
      </div>

      {/* Right: Search, Realtime SSE state, Notification Center, Theme, Profile */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onOpenSearch}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-xs text-slate-500 hover:border-slate-300 hover:bg-white dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400 dark:hover:border-slate-700"
        >
          <Search className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Search workspace...</span>
          <kbd className="hidden rounded border border-slate-200 bg-white px-1.5 py-0.5 font-mono text-[10px] text-slate-500 md:inline dark:border-slate-700 dark:bg-slate-800">
            Ctrl+K
          </kbd>
        </button>

        <span
          title={connected ? `Live activity polling connected (${activeConnections} active sessions)` : 'Live activity polling reconnecting'}
          className="hidden items-center gap-1.5 px-2 text-xs text-slate-500 xl:inline-flex dark:text-slate-400"
        >
          <span
            className={`h-2 w-2 rounded-full ${
              connected ? 'bg-emerald-500' : 'bg-amber-500'
            }`}
          />
          <span>{connected ? 'Live Sync' : 'Connecting'}</span>
        </span>

        {hasPerm('notifications.read') && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setNotifOpen((v) => !v);
                setProfileOpen(false);
              }}
              aria-label="Open notifications center"
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
            >
              <Bell className="h-4 w-4" />
            </button>

            {notifOpen && (
              <div className="absolute right-0 top-11 z-40 w-80 rounded-xl border border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
                <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
                  <span className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                    Notifications
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setNotifOpen(false);
                      onNavigate('notifications-all');
                    }}
                    className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    View all
                  </button>
                </div>
                <div className="max-h-72 divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                  {notifications.length === 0 ? (
                    <div className="px-4 py-6 text-center text-xs text-slate-500">
                      No recorded notifications yet.
                    </div>
                  ) : (
                    notifications.map((n) => (
                      <div key={n.id} className="px-4 py-2.5">
                        <p className="text-xs font-medium text-slate-900 dark:text-slate-100">
                          {n.title}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500 dark:text-slate-400">
                          {n.message}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-900"
        >
          {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        {/* User Profile Menu */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setProfileOpen((v) => !v);
              setNotifOpen(false);
            }}
            aria-label="Open administrator profile menu"
            className="flex h-9 items-center gap-2 rounded-lg border border-slate-200 px-2.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-200 dark:hover:bg-slate-900"
          >
            <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-[11px] font-semibold text-white">
              {(adminUser?.displayName || adminUser?.email || 'A').slice(0, 1).toUpperCase()}
            </div>
            <span className="hidden max-w-[120px] truncate md:inline">
              {adminUser?.displayName || adminUser?.email}
            </span>
          </button>

          {profileOpen && (
            <div className="absolute right-0 top-11 z-40 w-64 rounded-xl border border-slate-200 bg-white p-2 shadow-xl dark:border-slate-800 dark:bg-slate-900">
              <div className="border-b border-slate-100 px-2.5 py-2 dark:border-slate-800">
                <p className="truncate text-xs font-semibold text-slate-900 dark:text-slate-100">
                  {adminUser?.displayName}
                </p>
                <p className="truncate text-[11px] text-slate-500 dark:text-slate-400">
                  {adminUser?.email} · {adminUser?.roleName}
                </p>
              </div>
              <div className="mt-1 space-y-0.5">
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    onNavigate('settings-profile');
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <UserIcon className="h-3.5 w-3.5" />
                  Profile Settings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    onNavigate('security-2fa');
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Shield className="h-3.5 w-3.5" />
                  Two-Factor Auth ({adminUser?.twoFactorEnabled ? 'On' : 'Off'})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    onNavigate('settings-general');
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Settings className="h-3.5 w-3.5" />
                  Workspace Settings
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setProfileOpen(false);
                    void logout();
                  }}
                  className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  Sign Out
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
