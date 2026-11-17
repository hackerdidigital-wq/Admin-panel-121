/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import React, { Component, useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { RealtimeProvider } from './contexts/RealtimeContext';
import { ToastProvider } from './components/common/Toast';
import { Sidebar } from './components/layout/Sidebar';
import { TopNav } from './components/layout/TopNav';
import { CommandSearch } from './components/common/CommandSearch';
import { SIDEBAR_MODULES } from './config/navigation';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { UsersPage } from './pages/UsersPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { RolesPage } from './pages/RolesPage';
import { ContentPage } from './pages/ContentPage';
import { NotificationsPage } from './pages/NotificationsPage';
import { AdsPage, FinancePage } from './pages/FinanceAndAdsPage';
import { AppManagementPage, SupportPage } from './pages/AppAndSupportPage';
import { AnalyticsPage, SecurityCenterPage } from './pages/AnalyticsAndSecurityPage';
import { GithubCenterPage, SystemManagementPage } from './pages/SystemAndGithubPage';
import { DatabaseManagementPage, FilesManagementPage } from './pages/DatabaseAndFilesPage';
import { AuditLogsPage, SettingsPage } from './pages/SettingsAndAuditPage';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class WorkspaceErrorBoundary extends Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message || 'Unexpected workspace rendering error.' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center p-6 text-center">
          <div className="max-w-md rounded-xl border border-red-200 bg-white p-6 shadow-xs dark:border-red-900/60 dark:bg-slate-900">
            <AlertTriangle className="mx-auto h-8 w-8 text-red-600 dark:text-red-400" />
            <h2 className="mt-3 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Module Render Error
            </h2>
            <p className="mt-1.5 text-xs text-slate-600 dark:text-slate-400">
              {this.state.message}
            </p>
            <button
              type="button"
              onClick={() => this.setState({ hasError: false, message: '' })}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-blue-700"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Reload View
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function getInitialView(): string {
  if (typeof window !== 'undefined') {
    const hash = window.location.hash.replace(/^#\/?/, '').trim();
    if (hash) return hash;
  }
  return 'overview-dashboard';
}

function findRequiredPermission(viewId: string): string | string[] | undefined {
  if (viewId.startsWith('user-detail:')) {
    return 'users.read';
  }
  for (const mod of SIDEBAR_MODULES) {
    const sub = mod.submenus.find((s) => s.id === viewId);
    if (sub) {
      return sub.permission ?? mod.permission;
    }
  }
  return undefined;
}

const AdminWorkspace: React.FC = () => {
  const { adminUser, loading, hasPerm } = useAuth();
  const [activeView, setActiveView] = useState<string>(getInitialView);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('aegis-sidebar-collapsed') === 'true';
    }
    return false;
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const navigate = useCallback((viewId: string) => {
    setActiveView(viewId);
    if (typeof window !== 'undefined') {
      window.location.hash = viewId;
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = window.location.hash.replace(/^#\/?/, '').trim();
      if (next) setActiveView(next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      window.localStorage.setItem('aegis-sidebar-collapsed', String(next));
      return next;
    });
  };

  if (loading && !adminUser) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-blue-600 border-t-transparent" />
          <p className="text-xs font-medium text-slate-600 dark:text-slate-400">
            Verifying administrator session...
          </p>
        </div>
      </div>
    );
  }

  if (!adminUser) {
    return <LoginPage />;
  }

  const renderView = () => {
    const reqPerm = findRequiredPermission(activeView);
    if (reqPerm && !hasPerm(reqPerm)) {
      return (
        <div className="flex min-h-[55vh] items-center justify-center p-6">
          <div className="max-w-md rounded-xl border border-slate-200 bg-white p-6 text-center dark:border-slate-800 dark:bg-slate-900">
            <Lock className="mx-auto h-8 w-8 text-slate-400" />
            <h2 className="mt-3 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Insufficient Permissions
            </h2>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Your assigned role ({adminUser.roleName}) does not grant access to this module.
            </p>
            <button
              type="button"
              onClick={() => navigate('settings-profile')}
              className="mt-4 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              Open Profile Settings
            </button>
          </div>
        </div>
      );
    }

    if (activeView === 'overview-dashboard') {
      return <DashboardPage mode="dashboard" onNavigate={navigate} />;
    }
    if (activeView === 'overview-activity') {
      return <DashboardPage mode="activity" onNavigate={navigate} />;
    }
    if (activeView.startsWith('user-detail:')) {
      const userId = Number(activeView.split(':')[1]);
      return <UserDetailPage userId={userId} onBack={() => navigate('users-all')} />;
    }
    if (activeView.startsWith('users-')) {
      return (
        <UsersPage
          subview={activeView}
          onOpenUser={(id) => navigate(`user-detail:${id}`)}
        />
      );
    }
    if (activeView.startsWith('roles-')) {
      return <RolesPage subview={activeView} />;
    }
    if (activeView.startsWith('content-')) {
      return <ContentPage subview={activeView} />;
    }
    if (activeView.startsWith('notifications-')) {
      return <NotificationsPage subview={activeView} />;
    }
    if (activeView.startsWith('finance-')) {
      return <FinancePage subview={activeView} />;
    }
    if (activeView.startsWith('ads-')) {
      return <AdsPage />;
    }
    if (activeView.startsWith('app-')) {
      return <AppManagementPage subview={activeView} />;
    }
    if (activeView.startsWith('support-')) {
      return <SupportPage subview={activeView} />;
    }
    if (activeView.startsWith('analytics-')) {
      return <AnalyticsPage subview={activeView} />;
    }
    if (activeView.startsWith('security-')) {
      return <SecurityCenterPage subview={activeView} />;
    }
    if (activeView.startsWith('system-')) {
      return <SystemManagementPage subview={activeView} />;
    }
    if (activeView.startsWith('github-')) {
      return <GithubCenterPage subview={activeView} />;
    }
    if (activeView.startsWith('database-')) {
      return <DatabaseManagementPage subview={activeView} />;
    }
    if (activeView.startsWith('files-')) {
      return <FilesManagementPage subview={activeView} />;
    }
    if (activeView.startsWith('settings-')) {
      return <SettingsPage subview={activeView} />;
    }
    if (activeView.startsWith('audit-')) {
      return <AuditLogsPage subview={activeView} />;
    }

    return <DashboardPage mode="dashboard" onNavigate={navigate} />;
  };

  return (
    <div className="flex min-h-screen bg-slate-50 text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Sidebar
        activeView={activeView}
        collapsed={sidebarCollapsed}
        mobileOpen={mobileMenuOpen}
        onToggleCollapse={toggleSidebarCollapse}
        onCloseMobile={() => setMobileMenuOpen(false)}
        onSelectView={navigate}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopNav
          activeView={activeView}
          onOpenMobileMenu={() => setMobileMenuOpen(true)}
          onOpenSearch={() => setSearchOpen(true)}
          onNavigate={navigate}
        />

        <main className="mx-auto w-full max-w-[1600px] flex-1 p-4 lg:p-6">
          <WorkspaceErrorBoundary key={activeView}>{renderView()}</WorkspaceErrorBoundary>
        </main>
      </div>

      <CommandSearch
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onNavigate={navigate}
      />
    </div>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <RealtimeProvider>
        <ToastProvider>
          <AdminWorkspace />
        </ToastProvider>
      </RealtimeProvider>
    </AuthProvider>
  );
}
