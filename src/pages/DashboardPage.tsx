import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Database,
  Eye,
  EyeOff,
  Plus,
  RefreshCw,
  Save,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  UserCheck,
  UserPlus,
  Users,
  Wallet,
  Wifi,
  XCircle,
} from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useAppScope } from '../contexts/AppScopeContext';
import { useRealtime } from '../contexts/RealtimeContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/common/Toast';
import { SimpleBarChart } from '../components/common/Charts';

interface OverviewResponse {
  kpis: {
    totalUsers: number;
    activeUsers: number;
    newUsersToday: number;
    onlineUsers: number;
    onlinePresenceSupported: boolean;
    suspendedUsers: number;
    totalTransactions: number;
    revenueCents: number;
    successfulOperations: number;
    failedOperations: number;
    openTickets: number;
  };
  health: {
    system: { status: string; memoryUsedPct: number; uptimeSeconds: number; loadAvg1m: number };
    api: { status: string; avgLatencyMs: number; activeSseConnections: number };
    database: { status: string; latencyMs: number; engine: string };
    jobs: { failedJobs: number; runningJobs: number };
  };
  recentActivities: Array<{
    id: number;
    actorEmail: string;
    action: string;
    module: string;
    targetType: string;
    targetId: string;
    status: string;
    createdAt: string;
  }>;
  criticalAlerts: Array<{
    id: number;
    actorEmail: string;
    action: string;
    module: string;
    status: string;
    createdAt: string;
  }>;
  charts: {
    operationsByDay: Array<{ day: string; success_count: number; error_count: number }>;
    signupsByDay: Array<{ day: string; signups: number }>;
  };
  multiApp?: {
    totalApps: number;
    connectedApps: number;
    maintenanceApps: number;
    totalAppUsers: number;
    activeAppUsers: number;
    bannedAppUsers: number;
    appErrors24h: number;
    adRevenueCents?: number;
  };
  layout: { order?: string[]; hidden?: string[] } | null;
}

const DEFAULT_WIDGET_ORDER = ['kpis', 'health', 'charts', 'feeds', 'realtime'];

export const DashboardPage: React.FC<{
  mode?: 'dashboard' | 'activity';
  onNavigate: (viewId: string) => void;
}> = ({ mode = 'dashboard', onNavigate }) => {
  const { hasPerm } = useAuth();
  const { selectedAppId, selectedApp, setSelectedAppId } = useAppScope();
  const { connected, onlineUserIds, recentEvents } = useRealtime();
  const { pushToast } = useToast();
  const [data, setData] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [customizing, setCustomizing] = useState(false);
  const [widgetOrder, setWidgetOrder] = useState<string[]>(DEFAULT_WIDGET_ORDER);
  const [hiddenWidgets, setHiddenWidgets] = useState<string[]>([]);
  const [savingLayout, setSavingLayout] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';
      const res = await apiRequest<OverviewResponse>(`/dashboard/overview${qs}`);
      setData(res);
      if (res.layout?.order?.length) setWidgetOrder(res.layout.order);
      if (res.layout?.hidden) setHiddenWidgets(res.layout.hidden);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  }, [selectedAppId]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const moveWidget = (id: string, dir: -1 | 1) => {
    const idx = widgetOrder.indexOf(id);
    if (idx === -1) return;
    const nextIdx = idx + dir;
    if (nextIdx < 0 || nextIdx >= widgetOrder.length) return;
    const next = [...widgetOrder];
    const [removed] = next.splice(idx, 1);
    next.splice(nextIdx, 0, removed);
    setWidgetOrder(next);
  };

  const toggleHideWidget = (id: string) => {
    setHiddenWidgets((prev) =>
      prev.includes(id) ? prev.filter((w) => w !== id) : [...prev, id]
    );
  };

  const saveLayout = async () => {
    setSavingLayout(true);
    try {
      await apiRequest('/dashboard/layout', {
        method: 'PUT',
        body: JSON.stringify({ config: { order: widgetOrder, hidden: hiddenWidgets } }),
      });
      pushToast({ type: 'success', title: 'Dashboard layout saved' });
      setCustomizing(false);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not save layout',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingLayout(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900"
            />
          ))}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-300">
        <p className="font-medium">{error}</p>
        <button
          type="button"
          onClick={() => void loadData()}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-slate-900"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  if (mode === 'activity') {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
              Real-Time Activity Overview
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Live operational events combined with recent Cloudflare D1 SQLite audit records.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Live Activity Feed ({connected ? 'Synced' : 'Connecting'})
            </h2>
            {recentEvents.length === 0 ? (
              <p className="mt-4 text-xs text-slate-500 dark:text-slate-400">
                Listening for live audit, ticket, notification, and job events on this session.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
                {recentEvents.map((ev, i) => (
                  <li key={i} className="py-2.5 text-xs">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono font-medium text-blue-600 dark:text-blue-400">
                        {ev.type}
                      </span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {new Date(ev.receivedAt).toLocaleTimeString()}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Recent Database Audit Activity
            </h2>
            <ul className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
              {data.recentActivities.map((act) => (
                <li key={act.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                      {act.action}
                    </p>
                    <p className="truncate text-slate-500 dark:text-slate-400">
                      {act.actorEmail} · {act.module}
                    </p>
                  </div>
                  <span className="shrink-0 font-mono tabular-nums text-slate-400">
                    {new Date(act.createdAt).toLocaleString()}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </div>
    );
  }

  const kpiCards = [
    {
      label: 'Total Users',
      value: data.kpis.totalUsers,
      icon: Users,
      target: 'users-all',
    },
    {
      label: 'Active Users',
      value: data.kpis.activeUsers,
      icon: UserCheck,
      target: 'users-active',
    },
    {
      label: 'New Users Today',
      value: data.kpis.newUsersToday,
      icon: UserPlus,
      target: 'users-new',
    },
    {
      label: 'Online Users',
      value: onlineUserIds.length || data.kpis.onlineUsers,
      icon: Wifi,
      target: 'users-online',
    },
    {
      label: 'Suspended Users',
      value: data.kpis.suspendedUsers,
      icon: ShieldAlert,
      target: 'users-suspended',
    },
    {
      label: 'Total Transactions',
      value: data.kpis.totalTransactions,
      icon: Wallet,
      target: 'finance-transactions',
    },
    {
      label: 'Successful Operations',
      value: data.kpis.successfulOperations,
      icon: CheckCircle2,
      target: 'system-logs',
    },
    {
      label: 'Failed Operations',
      value: data.kpis.failedOperations,
      icon: XCircle,
      target: 'system-logs',
    },
  ];

  const widgetLabels: Record<string, string> = {
    kpis: 'Operational KPIs',
    health: 'Infrastructure Health & Quick Actions',
    charts: 'Database Activity Charts',
    feeds: 'Recent Activities & Critical Alerts',
    realtime: 'Real-Time Stream Overview',
  };

  const renderWidget = (id: string) => {
    const isHidden = hiddenWidgets.includes(id);
    if (isHidden && !customizing) return null;

    const wrapperHeader = customizing ? (
      <div className="mb-2 flex items-center justify-between rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-1.5 text-xs dark:border-blue-900 dark:bg-blue-950/40">
        <span className="font-medium text-blue-900 dark:text-blue-200">
          {widgetLabels[id]} {isHidden ? '(Hidden)' : ''}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => moveWidget(id, -1)}
            aria-label={`Move ${widgetLabels[id]} up`}
            className="rounded p-1 hover:bg-white dark:hover:bg-slate-800"
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => moveWidget(id, 1)}
            aria-label={`Move ${widgetLabels[id]} down`}
            className="rounded p-1 hover:bg-white dark:hover:bg-slate-800"
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => toggleHideWidget(id)}
            aria-label={isHidden ? `Show ${widgetLabels[id]}` : `Hide ${widgetLabels[id]}`}
            className="rounded p-1 hover:bg-white dark:hover:bg-slate-800"
          >
            {isHidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>
    ) : null;

    if (id === 'kpis') {
      return (
        <section key={id} className={isHidden ? 'opacity-45' : ''}>
          {wrapperHeader}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {kpiCards.map((card) => {
              const Icon = card.icon;
              return (
                <button
                  key={card.label}
                  type="button"
                  onClick={() => onNavigate(card.target)}
                  className="flex items-start justify-between rounded-xl border border-slate-200 bg-white p-4 text-left transition-colors hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
                >
                  <div>
                    <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                      {card.label}
                    </p>
                    <p className="mt-1.5 font-display text-2xl font-semibold tabular-nums text-slate-900 dark:text-slate-100">
                      {card.value.toLocaleString()}
                    </p>
                  </div>
                  <div className="rounded-lg border border-slate-100 bg-slate-50 p-2 text-slate-600 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-400">
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      );
    }

    if (id === 'health') {
      return (
        <section key={id} className={isHidden ? 'opacity-45' : ''}>
          {wrapperHeader}
          <div className="grid gap-4 lg:grid-cols-12">
            <div className="grid gap-4 sm:grid-cols-3 lg:col-span-8">
              <button
                type="button"
                onClick={() => onNavigate('system-health')}
                className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    System Health
                  </span>
                  <Server className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="mt-2 text-sm font-semibold capitalize text-slate-900 dark:text-slate-100">
                  {data.health.system.status}
                </p>
                <p className="mt-1 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  Mem {data.health.system.memoryUsedPct}% · Load {data.health.system.loadAvg1m}
                </p>
              </button>

              <button
                type="button"
                onClick={() => onNavigate('system-health')}
                className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    API Health
                  </span>
                  <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="mt-2 text-sm font-semibold capitalize text-slate-900 dark:text-slate-100">
                  {data.health.api.status}
                </p>
                <p className="mt-1 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  Avg {data.health.api.avgLatencyMs}ms · {data.health.api.activeSseConnections} Active Sessions
                </p>
              </button>

              <button
                type="button"
                onClick={() => onNavigate('database-overview')}
                className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                    Database Health
                  </span>
                  <Database className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <p className="mt-2 text-sm font-semibold capitalize text-slate-900 dark:text-slate-100">
                  {data.health.database.status}
                </p>
                <p className="mt-1 font-mono text-xs tabular-nums text-slate-500 dark:text-slate-400">
                  Ping {data.health.database.latencyMs}ms · {data.health.database.engine || 'Cloudflare D1'}
                </p>
              </button>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 lg:col-span-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">
                Quick Actions
              </p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                {hasPerm('users.write') && (
                  <button
                    type="button"
                    onClick={() => onNavigate('users-all')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Manage Users
                  </button>
                )}
                {hasPerm('database.inspect') && (
                  <button
                    type="button"
                    onClick={() => onNavigate('database-backups')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Database className="h-3.5 w-3.5" />
                    Verify Backup
                  </button>
                )}
                {hasPerm('security.read') && (
                  <button
                    type="button"
                    onClick={() => onNavigate('security-dashboard')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <ShieldAlert className="h-3.5 w-3.5" />
                    Security Audit
                  </button>
                )}
                {hasPerm('support.read') && (
                  <button
                    type="button"
                    onClick={() => onNavigate('support-tickets')}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800"
                  >
                    <Activity className="h-3.5 w-3.5" />
                    Tickets ({data.kpis.openTickets})
                  </button>
                )}
              </div>
            </div>
          </div>
        </section>
      );
    }

    if (id === 'charts') {
      return (
        <section key={id} className={isHidden ? 'opacity-45' : ''}>
          {wrapperHeader}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  API Operations (7 Days)
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('analytics-overview')}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Details
                </button>
              </div>
              <SimpleBarChart
                data={data.charts.operationsByDay.map((d) => ({
                  label: d.day,
                  value: Number(d.success_count),
                  secondaryValue: Number(d.error_count),
                }))}
                primaryLabel="Success"
                secondaryLabel="Errors"
                emptyMessage="No API requests logged yet in the last 7 days."
              />
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  User Registrations (7 Days)
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('analytics-users')}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Details
                </button>
              </div>
              <SimpleBarChart
                data={data.charts.signupsByDay.map((d) => ({
                  label: d.day,
                  value: Number(d.signups),
                }))}
                primaryLabel="New Users"
                emptyMessage="No new user records created in the last 7 days."
              />
            </div>
          </div>
        </section>
      );
    }

    if (id === 'feeds') {
      return (
        <section key={id} className={isHidden ? 'opacity-45' : ''}>
          {wrapperHeader}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Recent Admin Activities & Events
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('audit-admin')}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Full Log
                </button>
              </div>
              {data.recentActivities.length === 0 ? (
                <p className="py-6 text-center text-xs text-slate-500">
                  No administrative events recorded yet.
                </p>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.recentActivities.slice(0, 6).map((act) => (
                    <li key={act.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                          {act.action}
                        </p>
                        <p className="truncate text-slate-500 dark:text-slate-400">
                          {act.actorEmail} · {act.module}
                        </p>
                      </div>
                      <span className="shrink-0 font-mono tabular-nums text-slate-400">
                        {new Date(act.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Critical Alerts & Denied Access
                </h2>
                <button
                  type="button"
                  onClick={() => onNavigate('security-events')}
                  className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
                >
                  Security Center
                </button>
              </div>
              {data.criticalAlerts.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-8 text-center">
                  <CheckCircle2 className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />
                  <p className="mt-2 text-xs font-medium text-slate-900 dark:text-slate-100">
                    No critical failures or denied operations recorded
                  </p>
                </div>
              ) : (
                <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                  {data.criticalAlerts.map((alert) => (
                    <li key={alert.id} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                        <div className="min-w-0">
                          <p className="truncate font-medium text-slate-900 dark:text-slate-100">
                            {alert.action} ({alert.status})
                          </p>
                          <p className="truncate text-slate-500 dark:text-slate-400">
                            {alert.actorEmail} · {alert.module}
                          </p>
                        </div>
                      </div>
                      <span className="shrink-0 font-mono tabular-nums text-slate-400">
                        {new Date(alert.createdAt).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </section>
      );
    }

    if (id === 'realtime') {
      return (
        <section key={id} className={isHidden ? 'opacity-45' : ''}>
          {wrapperHeader}
          <div className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Real-Time Activity Overview
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('overview-activity')}
                className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
              >
                Live Stream View
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Live Sync: {connected ? 'Connected' : 'Reconnecting'} · Online Admins:{' '}
              {onlineUserIds.length} · Events Received This Session: {recentEvents.length}
            </p>
          </div>
        </section>
      );
    }

    return null;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Operational Dashboard {selectedApp ? `· ${selectedApp.name}` : ''}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            {selectedApp
              ? `Scoped to ${selectedApp.name} (${selectedApp.platform} · v${selectedApp.currentVersion}).`
              : 'Combined telemetry computed from Cloudflare D1 SQLite across all connected apps and admins.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {selectedApp && (
            <button
              type="button"
              onClick={() => setSelectedAppId('all')}
              className="inline-flex h-9 items-center rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
            >
              Show All Apps
            </button>
          )}
          <button
            type="button"
            onClick={() => void loadData()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
          {hasPerm('dashboard.customize') &&
            (customizing ? (
              <button
                type="button"
                disabled={savingLayout}
                onClick={() => void saveLayout()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Save className="h-3.5 w-3.5" />
                {savingLayout ? 'Saving...' : 'Save Layout'}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setCustomizing(true)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                Customize Widgets
              </button>
            ))}
        </div>
      </div>

      {data.multiApp && (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <button
            type="button"
            onClick={() => onNavigate('apps-directory')}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
          >
            <p className="text-xs text-slate-500">Connected Apps</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {data.multiApp.connectedApps} / {data.multiApp.totalApps}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {data.multiApp.maintenanceApps} in maintenance
            </p>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('apps-users')}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
          >
            <p className="text-xs text-slate-500">App End-Users</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {(data.multiApp.totalAppUsers ?? 0).toLocaleString()}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {data.multiApp.bannedAppUsers ?? 0} banned
            </p>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('apps-health')}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
          >
            <p className="text-xs text-slate-500">SDK Errors (24h)</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {data.multiApp.appErrors24h ?? 0}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">View app error monitor</p>
          </button>
          <button
            type="button"
            onClick={() => onNavigate('apps-connect')}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900 dark:hover:border-slate-700"
          >
            <p className="text-xs text-slate-500">Revenue Volume</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              ${(data.kpis.revenueCents / 100).toFixed(2)}
            </p>
            <p className="mt-0.5 text-[11px] text-blue-600 dark:text-blue-400">
              Connect new app & SDK
            </p>
          </button>
        </section>
      )}

      {widgetOrder.map((widgetId) => renderWidget(widgetId))}
    </div>
  );
};
