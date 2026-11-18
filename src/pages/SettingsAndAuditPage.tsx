import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Download, Save, ShieldCheck } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

export const SettingsPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { adminUser, theme, setThemeMode, hasPerm, refreshSession } = useAuth();
  const { pushToast } = useToast();
  const [settings, setSettings] = useState<Array<{ key: string; category: string; value: unknown; description: string }>>([]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>({});
  const [timezone, setTimezone] = useState(adminUser?.preferences?.timezone || 'UTC');
  const [dateFormat, setDateFormat] = useState(adminUser?.preferences?.dateFormat || 'YYYY-MM-DD HH:mm');
  const [language, setLanguage] = useState(adminUser?.preferences?.language || 'en');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);

  const category =
    subview === 'settings-general'
      ? 'general'
      : subview === 'settings-notifications'
        ? 'notifications'
        : subview === 'settings-security'
          ? 'security'
          : subview === 'settings-integrations'
            ? 'integrations'
            : subview === 'settings-backup'
              ? 'backup'
              : subview === 'settings-privacy'
                ? 'privacy'
                : 'all';

  const loadSettings = useCallback(async () => {
    if (!hasPerm('settings.read')) return;
    try {
      const res = await apiRequest<{ settings: typeof settings }>(`/settings?category=${category}`);
      setSettings(res.settings);
      const map: Record<string, string> = {};
      for (const s of res.settings) {
        map[s.key] = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
      }
      setDraftValues(map);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load settings',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [category, hasPerm, pushToast]);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const saveSetting = async (key: string, cat: string, overrideValue?: unknown) => {
    try {
      let parsed: unknown;
      if (overrideValue !== undefined) {
        parsed = overrideValue;
      } else {
        const raw = draftValues[key] ?? '';
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
      }
      await apiRequest(`/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        body: JSON.stringify({ value: parsed, category: cat }),
      });
      pushToast({ type: 'success', title: `Updated ${key}` });
      await loadSettings();
    } catch (err) {
      pushToast({
        type: 'error',
        title: `Failed to update ${key}`,
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (subview === 'settings-profile') {
    const handleChangePassword = async (e: React.FormEvent) => {
      e.preventDefault();
      setChangingPassword(true);
      try {
        await apiRequest('/auth/change-password', {
          method: 'POST',
          body: JSON.stringify({ currentPassword, newPassword }),
        });
        setCurrentPassword('');
        setNewPassword('');
        pushToast({ type: 'success', title: 'Administrator password updated' });
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Password update failed',
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setChangingPassword(false);
      }
    };

    return (
      <div className="max-w-xl space-y-6">
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
          <h1 className="font-display text-xl font-semibold">Profile & Account Settings</h1>
          <div className="space-y-2 text-xs">
            <p><span className="text-slate-500">Email:</span> {adminUser?.email}</p>
            <p><span className="text-slate-500">Display Name:</span> {adminUser?.displayName}</p>
            <p><span className="text-slate-500">Role:</span> {adminUser?.roleName} ({adminUser?.roleSlug})</p>
            <p><span className="text-slate-500">Two-Factor Auth:</span> {adminUser?.twoFactorEnabled ? 'Enabled' : 'Disabled'}</p>
          </div>
        </section>

        <form
          onSubmit={handleChangePassword}
          className="space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-xs dark:border-slate-800 dark:bg-slate-900"
        >
          <h2 className="font-display text-sm font-semibold">Change Administrator Password</h2>
          <p className="text-slate-500">
            Requires at least 12 characters including uppercase, lowercase, number, and symbol.
          </p>
          <div>
            <label className="block font-medium">Current Password</label>
            <input
              type="password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <div>
            <label className="block font-medium">New Password</label>
            <input
              type="password"
              required
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <button
            type="submit"
            disabled={changingPassword}
            className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {changingPassword ? 'Updating...' : 'Update Password'}
          </button>
        </form>
      </div>
    );
  }

  if (subview === 'settings-appearance') {
    return (
      <div className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="font-display text-xl font-semibold">Appearance & Theme Settings</h1>
        <p className="text-xs text-slate-500">Choose your preferred enterprise workspace contrast mode.</p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setThemeMode('light')}
            className={`rounded-lg border px-4 py-2 text-xs font-medium ${
              theme === 'light' ? 'border-blue-600 bg-blue-50 text-blue-700' : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            Light Mode (Default)
          </button>
          <button
            type="button"
            onClick={() => setThemeMode('dark')}
            className={`rounded-lg border px-4 py-2 text-xs font-medium ${
              theme === 'dark' ? 'border-blue-600 bg-blue-950 text-blue-300' : 'border-slate-200 dark:border-slate-700'
            }`}
          >
            Dark Mode
          </button>
        </div>
      </div>
    );
  }

  if (subview === 'settings-localization') {
    return (
      <div className="max-w-xl space-y-4 rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h1 className="font-display text-xl font-semibold">Language, Timezone & Date Format</h1>
        <div className="space-y-3 text-xs">
          <div>
            <label className="block font-medium">Language</label>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="en">English (US)</option>
              <option value="en-GB">English (UK)</option>
            </select>
          </div>
          <div>
            <label className="block font-medium">Timezone</label>
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="UTC">UTC</option>
              <option value="America/Los_Angeles">America/Los_Angeles</option>
              <option value="America/New_York">America/New_York</option>
              <option value="Asia/Singapore">Asia/Singapore</option>
              <option value="Europe/London">Europe/London</option>
            </select>
          </div>
          <div>
            <label className="block font-medium">Date & Time Format</label>
            <input
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
            />
          </div>
          <button
            type="button"
            onClick={async () => {
              try {
                await apiRequest('/auth/preferences', {
                  method: 'PATCH',
                  body: JSON.stringify({ language, timezone, dateFormat }),
                });
                pushToast({ type: 'success', title: 'Localization preferences saved' });
                await refreshSession();
              } catch (err) {
                pushToast({
                  type: 'error',
                  title: 'Save preferences failed',
                  description: err instanceof Error ? err.message : undefined,
                });
              }
            }}
            className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white"
          >
            Save Preferences
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-xl font-semibold capitalize">
          {subview.replace('settings-', '')} Settings
        </h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Persisted in Cloudflare D1 <code className="font-mono">system_settings</code> with full audit logging.
        </p>
      </div>

      {subview === 'settings-integrations' && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            Multi-App API Keys & Outbound Webhooks
          </p>
          <p className="mt-1 text-slate-500">
            Per-app <code className="font-mono">X-API-Key</code> tokens and HMAC-SHA256 outbound webhooks are managed directly inside{' '}
            <strong className="text-slate-800 dark:text-slate-200">Multi-App Center → API Keys & Credentials</strong> and{' '}
            <strong className="text-slate-800 dark:text-slate-200">Multi-App Center → Outbound Webhooks</strong>.
          </p>
        </div>
      )}

      <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {settings.map((s) => {
          const isBool =
            typeof s.value === 'boolean' ||
            draftValues[s.key] === 'true' ||
            draftValues[s.key] === 'false';
          const boolChecked = draftValues[s.key] === 'true' || s.value === true;

          return (
            <div key={s.key} className="flex flex-wrap items-center justify-between gap-4 p-4 text-xs">
              <div className="min-w-0 flex-1">
                <p className="font-mono font-semibold text-slate-900 dark:text-slate-100">{s.key}</p>
                <p className="text-slate-500">{s.description}</p>
              </div>
              <div className="flex items-center gap-2">
                {isBool ? (
                  <label className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-slate-700">
                    <input
                      type="checkbox"
                      disabled={!hasPerm('settings.manage')}
                      checked={boolChecked}
                      onChange={(e) => {
                        const nextVal = e.target.checked;
                        setDraftValues((prev) => ({ ...prev, [s.key]: String(nextVal) }));
                        void saveSetting(s.key, s.category, nextVal);
                      }}
                    />
                    <span className="font-medium">{boolChecked ? 'Enabled' : 'Disabled'}</span>
                  </label>
                ) : (
                  <>
                    <input
                      value={draftValues[s.key] ?? ''}
                      disabled={!hasPerm('settings.manage')}
                      onChange={(e) => setDraftValues((prev) => ({ ...prev, [s.key]: e.target.value }))}
                      className="h-9 w-64 rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                    />
                    {hasPerm('settings.manage') && (
                      <button
                        type="button"
                        onClick={() => void saveSetting(s.key, s.category)}
                        className="inline-flex h-9 items-center gap-1 rounded-lg bg-blue-600 px-3 font-medium text-white hover:bg-blue-700"
                      >
                        <Save className="h-3.5 w-3.5" />
                        Save
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface AuditRow {
  id: number;
  actorEmail: string;
  action: string;
  module: string;
  targetType: string;
  targetId: string;
  status: string;
  ipAddress: string;
  entryHash: string;
  createdAt: string;
}

interface ApiLogRow {
  id: number;
  appId: number | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ipAddress: string;
  errorMessage: string;
  createdAt: string;
}

export const AuditLogsPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { appQueryParam } = useAppScope();
  const { pushToast } = useToast();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [apiRows, setApiRows] = useState<ApiLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [chainState, setChainState] = useState<{ checked: number; valid: boolean } | null>(null);

  const isApiLogsView = subview === 'audit-api';

  const moduleFilter =
    subview === 'audit-auth'
      ? 'auth'
      : subview === 'audit-security'
        ? 'security'
        : subview === 'audit-exports'
          ? 'exports'
          : 'all';

  const loadAudit = useCallback(async () => {
    setLoading(true);
    try {
      if (isApiLogsView) {
        const qs = new URLSearchParams();
        if (appQueryParam) qs.set('appId', appQueryParam);
        const res = await apiRequest<{ data: ApiLogRow[] }>(`/audit/api-logs?${qs.toString()}`);
        setApiRows(res.data || []);
        setTotal((res.data || []).length);
      } else {
        const qs = new URLSearchParams({
          page: String(page),
          pageSize: '20',
          search,
          module: moduleFilter,
        });
        const res = await apiRequest<{ data: AuditRow[]; total: number }>(`/audit/logs?${qs.toString()}`);
        setRows(res.data);
        setTotal(res.total);
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Audit logs failed to load',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [page, search, moduleFilter, isApiLogsView, appQueryParam, pushToast]);

  useEffect(() => {
    void loadAudit();
  }, [loadAudit]);

  const verifyChain = async () => {
    try {
      const res = await apiRequest<{ checked: number; valid: boolean; brokenAtId: number | null }>('/audit/verify');
      setChainState(res);
      pushToast({
        type: res.valid ? 'success' : 'error',
        title: res.valid
          ? `Audit hash chain verified (${res.checked} records)`
          : `Chain mismatch at record #${res.brokenAtId}`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Audit verification failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const columns: TableColumn<AuditRow>[] = [
    { key: 'action', label: 'Action', render: (r) => <span className="font-mono text-xs">{r.action}</span> },
    { key: 'actorEmail', label: 'Actor' },
    { key: 'module', label: 'Module' },
    { key: 'status', label: 'Outcome', render: (r) => <span className="capitalize">{r.status}</span> },
    { key: 'entryHash', label: 'SHA-256 Hash', render: (r) => <span className="font-mono text-[11px] text-slate-500">{r.entryHash.slice(0, 14)}...</span> },
    {
      key: 'createdAt',
      label: 'Timestamp',
      align: 'right',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-slate-500">
          {new Date(r.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];

  const apiColumns: TableColumn<ApiLogRow>[] = [
    { key: 'method', label: 'Method', render: (r) => <span className="font-mono font-semibold">{r.method}</span> },
    { key: 'path', label: 'Endpoint', render: (r) => <span className="font-mono text-xs">{r.path}</span> },
    {
      key: 'statusCode',
      label: 'Status',
      render: (r) => (
        <span className={`font-mono font-semibold tabular-nums ${r.statusCode >= 400 ? 'text-red-600' : 'text-emerald-600'}`}>
          {r.statusCode}
        </span>
      ),
    },
    {
      key: 'durationMs',
      label: 'Duration',
      render: (r) => <span className="font-mono text-xs tabular-nums">{r.durationMs} ms</span>,
    },
    { key: 'ipAddress', label: 'IP', render: (r) => <span className="font-mono text-xs">{r.ipAddress || 'N/A'}</span> },
    {
      key: 'createdAt',
      label: 'Timestamp',
      align: 'right',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-slate-500">
          {new Date(r.createdAt).toLocaleString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">
            {isApiLogsView
              ? 'API Request Telemetry Logs'
              : subview === 'audit-exports'
                ? 'Data Export Audit Trail'
                : 'Immutable Audit & Activity Logs'}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {isApiLogsView
              ? 'Recorded HTTP & App SDK requests scoped by TopNav app selection.'
              : 'Append-only SHA-256 hash-chained records. Modification and deletion are prohibited server-side.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              void downloadWithAuth('/audit/export.csv', 'aegis-audit-logs.csv').catch((err) =>
                pushToast({
                  type: 'error',
                  title: 'Audit CSV export failed',
                  description: err instanceof Error ? err.message : undefined,
                })
              )
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => void verifyChain()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            {chainState?.valid ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <ShieldCheck className="h-4 w-4 text-blue-600" />
            )}
            Verify Hash Chain
          </button>
        </div>
      </div>

      {isApiLogsView ? (
        <DataTable<ApiLogRow>
          tableId="api-telemetry-logs"
          columns={apiColumns}
          rows={apiRows}
          total={total}
          page={1}
          onPageChange={() => {}}
          search=""
          onSearchChange={() => {}}
          loading={loading}
        />
      ) : (
        <DataTable<AuditRow>
          tableId="audit-logs"
          columns={columns}
          rows={rows}
          total={total}
          page={page}
          onPageChange={setPage}
          search={search}
          onSearchChange={setSearch}
          loading={loading}
        />
      )}
    </div>
  );
};
