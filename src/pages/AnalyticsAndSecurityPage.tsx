import React, { useCallback, useEffect, useState } from 'react';
import { Brain, CheckCircle2, Download, FileJson, Printer, Shield, ShieldAlert, Trash2 } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { SimpleBarChart } from '../components/common/Charts';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

export const AnalyticsPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { appQueryParam, selectedApp } = useAppScope();
  const { pushToast } = useToast();
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<{
    days: number;
    appId: number | null;
    sdkSummary?: {
      appUsersCount: number;
      activeAppUsersCount: number;
      bannedAppUsersCount: number;
      appEventsCount: number;
      errorEventsCount: number;
      adRevenueCents: number;
      adImpressions: number;
      adClicks: number;
    };
    userGrowth: Array<{ day: string; count: number }>;
    revenueSeries: Array<{ day: string; amount_cents: number }>;
    deviceBreakdown: Array<{ browser: string; os: string; count: number }>;
    contentSummary: Array<{ status: string; count: number }>;
    ticketSummary: Array<{ status: string; priority: string; count: number }>;
    geoConsentEnabled: boolean;
    geoBreakdown: Array<{ country: string; count: number }>;
  } | null>(null);

  const loadAnalytics = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const qs = new URLSearchParams({ days: String(days) });
      if (appQueryParam) qs.set('appId', appQueryParam);
      const res = await apiRequest<NonNullable<typeof data>>(`/analytics/overview?${qs.toString()}`);
      setData(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load analytics';
      setLoadError(msg);
      pushToast({ type: 'error', title: 'Analytics load failed', description: msg });
    } finally {
      setLoading(false);
    }
  }, [days, appQueryParam, pushToast]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const exportQuery = appQueryParam ? `?appId=${encodeURIComponent(appQueryParam)}` : '';

  const showUsersSection =
    subview === 'analytics-overview' || subview === 'analytics-users' || subview === 'analytics-reports';
  const showRevenueSection =
    subview === 'analytics-overview' || subview === 'analytics-revenue' || subview === 'analytics-reports';
  const showDevicesSection =
    subview === 'analytics-overview' || subview === 'analytics-devices' || subview === 'analytics-reports';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">
            {subview === 'analytics-users'
              ? 'User Growth Analytics'
              : subview === 'analytics-revenue'
                ? 'Revenue & AdMob Analytics'
                : subview === 'analytics-devices'
                  ? 'Devices, Browsers & Geo Analytics'
                  : subview === 'analytics-export'
                    ? 'Analytics Exports & Reports'
                    : 'Analytics & Reports'}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selectedApp
              ? `Scoped to ${selectedApp.name} (${selectedApp.appUid}) · Cloudflare D1 SQLite aggregations.`
              : 'Combined multi-app aggregations computed directly from Cloudflare D1 SQLite records.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 no-print">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label="Date range window"
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
          </select>
          <button
            type="button"
            onClick={() =>
              void downloadWithAuth(`/analytics/export.csv${exportQuery}`, 'aegis-analytics-report.csv').catch(
                (err) =>
                  pushToast({
                    type: 'error',
                    title: 'CSV export failed',
                    description: err instanceof Error ? err.message : undefined,
                  })
              )
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            <Download className="h-3.5 w-3.5" />
            CSV Export
          </button>
          <button
            type="button"
            onClick={() =>
              void downloadWithAuth(`/analytics/export.json${exportQuery}`, 'aegis-analytics-report.json').catch(
                (err) =>
                  pushToast({
                    type: 'error',
                    title: 'JSON export failed',
                    description: err instanceof Error ? err.message : undefined,
                  })
              )
            }
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
          >
            <FileJson className="h-3.5 w-3.5" />
            JSON Export
          </button>
          <button
            type="button"
            onClick={() => window.print()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Printer className="h-3.5 w-3.5" />
            Print / PDF
          </button>
        </div>
      </div>

      {loading && !data && (
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((idx) => (
            <div key={idx} className="h-24 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
          ))}
        </div>
      )}

      {loadError && !data && (
        <div className="flex items-center justify-between rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <span>{loadError}</span>
          <button
            type="button"
            onClick={() => void loadAnalytics()}
            className="rounded border border-red-300 px-3 py-1 font-medium hover:bg-red-100 dark:border-red-800"
          >
            Retry
          </button>
        </div>
      )}

      {data?.sdkSummary && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">App End-Users</p>
            <p className="mt-1 font-display text-xl font-semibold tabular-nums">
              {data.sdkSummary.appUsersCount}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
              {data.sdkSummary.activeAppUsersCount} active · {data.sdkSummary.bannedAppUsersCount} banned
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">SDK Events ({days}d)</p>
            <p className="mt-1 font-display text-xl font-semibold tabular-nums">
              {data.sdkSummary.appEventsCount}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
              {data.sdkSummary.errorEventsCount} error/critical events
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">AdMob Revenue</p>
            <p className="mt-1 font-display text-xl font-semibold tabular-nums">
              ${(data.sdkSummary.adRevenueCents / 100).toFixed(2)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
              {data.sdkSummary.adImpressions.toLocaleString()} impressions · {data.sdkSummary.adClicks.toLocaleString()} clicks
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Content & Support Queue</p>
            <p className="mt-1 font-display text-xl font-semibold tabular-nums">
              {data.contentSummary.reduce((a, b) => a + b.count, 0)} entries
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
              {data.ticketSummary.reduce((a, b) => a + b.count, 0)} support tickets
            </p>
          </div>
        </div>
      )}

      {data && subview === 'analytics-export' && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold">Download Structured Operational Reports</h2>
          <p className="text-xs text-slate-500">
            Export real-time D1 metrics, end-user counts, transactions, AdMob revenue, and recent SDK telemetry filtered by your selected TopNav app scope ({selectedApp ? selectedApp.name : 'All Apps'}).
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => void downloadWithAuth(`/analytics/export.csv${exportQuery}`, 'aegis-analytics-report.csv')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-4 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-950"
            >
              <Download className="h-3.5 w-3.5" />
              Download Summary CSV
            </button>
            <button
              type="button"
              onClick={() => void downloadWithAuth(`/analytics/export.json${exportQuery}`, 'aegis-analytics-report.json')}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700"
            >
              <FileJson className="h-3.5 w-3.5" />
              Download Full JSON Snapshot
            </button>
          </div>
        </section>
      )}

      {data && (
        <div className="grid gap-6 lg:grid-cols-2">
          {showUsersSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">User Growth ({days}d)</h2>
              <SimpleBarChart
                data={data.userGrowth.map((d) => ({ label: d.day, value: Number(d.count) }))}
                primaryLabel="New Users"
              />
            </section>
          )}

          {showRevenueSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">Revenue USD ({days}d)</h2>
              <SimpleBarChart
                data={data.revenueSeries.map((d) => ({
                  label: d.day,
                  value: Math.round(Number(d.amount_cents) / 100),
                }))}
                primaryLabel="USD"
              />
            </section>
          )}

          {showDevicesSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">Device & Browser Sessions</h2>
              {data.deviceBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500">No session telemetry recorded yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                  {data.deviceBreakdown.map((d, i) => (
                    <li key={i} className="flex justify-between py-2">
                      <span>
                        {d.browser} · {d.os}
                      </span>
                      <span className="font-mono tabular-nums">{d.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {showDevicesSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">Geographic Analytics</h2>
              {!data.geoConsentEnabled ? (
                <p className="text-xs text-slate-500">
                  Geographic analytics are disabled because user location consent (<code className="font-mono">privacy.geoTrackingConsent</code>) is off.
                </p>
              ) : data.geoBreakdown.length === 0 ? (
                <p className="text-xs text-slate-500">No country data recorded on user profiles yet.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                  {data.geoBreakdown.map((g) => (
                    <li key={g.country} className="flex justify-between py-2">
                      <span>{g.country}</span>
                      <span className="font-mono tabular-nums">{g.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </div>
  );
};

export const SecurityCenterPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { adminUser, hasPerm, refreshSession } = useAuth();
  const { pushToast } = useToast();

  const [secData, setSecData] = useState<{
    activeSessions: Array<{
      id: number;
      userEmail: string | null;
      deviceName: string;
      browser: string;
      os: string;
      ipAddress: string;
      lastActivityAt: string;
    }>;
    securityEvents: Array<{
      id: number;
      actorEmail: string;
      action: string;
      status: string;
      ipAddress: string;
      createdAt: string;
    }>;
    policies: Array<{ key: string; value: unknown; description: string }>;
    auditChainIntegrity: { checked: number; valid: boolean; brokenAtId: number | null };
  } | null>(null);

  const [totpSecret, setTotpSecret] = useState('');
  const [totpUri, setTotpUri] = useState('');
  const [totpCode, setTotpCode] = useState('');

  const [ipAllowlistText, setIpAllowlistText] = useState('');
  const [rateLimit, setRateLimit] = useState('180');
  const [revokeTargetId, setRevokeTargetId] = useState<number | null>(null);

  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const loadSecurity = useCallback(async () => {
    if (!hasPerm('security.read')) return;
    try {
      const res = await apiRequest<NonNullable<typeof secData>>('/security/overview');
      setSecData(res);
      const ipPol = res.policies.find((p) => p.key === 'security.ipAllowlist');
      if (Array.isArray(ipPol?.value)) setIpAllowlistText((ipPol.value as string[]).join(', '));
      const rlPol = res.policies.find((p) => p.key === 'security.rateLimitPerMinute');
      if (rlPol?.value) setRateLimit(String(rlPol.value));
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Security overview failed to load',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [hasPerm, pushToast]);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  const start2faSetup = async () => {
    try {
      const res = await apiRequest<{ secret: string; otpauthUri: string }>('/auth/2fa/setup', {
        method: 'POST',
      });
      setTotpSecret(res.secret);
      setTotpUri(res.otpauthUri);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to initialize 2FA setup',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const verify2fa = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/auth/2fa/verify', {
        method: 'POST',
        body: JSON.stringify({ code: totpCode }),
      });
      pushToast({ type: 'success', title: 'Two-factor authentication enabled' });
      setTotpSecret('');
      setTotpCode('');
      await refreshSession();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Verification failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const disable2fa = async () => {
    try {
      await apiRequest('/auth/2fa/disable', { method: 'POST' });
      pushToast({ type: 'warning', title: 'Two-factor authentication disabled' });
      await refreshSession();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to disable 2FA',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const savePolicies = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const allowlist = ipAllowlistText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await apiRequest('/settings/security.ipAllowlist', {
        method: 'PUT',
        body: JSON.stringify({ value: allowlist, category: 'security' }),
      });
      await apiRequest('/settings/security.rateLimitPerMinute', {
        method: 'PUT',
        body: JSON.stringify({ value: Math.max(20, Number(rateLimit) || 180), category: 'security' }),
      });
      pushToast({ type: 'success', title: 'Security policies updated' });
      await loadSecurity();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to update security policies',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const runAiAudit = async () => {
    setAiLoading(true);
    try {
      const res = await apiRequest<{ analysis: string; model: string; thinkingLevel: string }>(
        '/ai/analyze',
        {
          method: 'POST',
          body: JSON.stringify({ mode: 'security_audit', question: aiQuestion }),
        }
      );
      setAiAnalysis(res.analysis);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'AI Security Investigation failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAiLoading(false);
    }
  };

  const show2fa = subview === 'security-2fa' || subview === 'security-dashboard';
  const showPolicies =
    subview === 'security-dashboard' ||
    subview === 'security-ip' ||
    subview === 'security-rate' ||
    subview === 'security-policies';
  const showSessions = subview === 'security-dashboard' || subview === 'security-sessions';
  const showEvents =
    subview === 'security-dashboard' || subview === 'security-failed' || subview === 'security-events';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold">Security Center</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Active session governance, RFC 6238 TOTP two-factor auth, IP allowlisting, rate limits, and tamper-evident audit verification.
        </p>
      </div>

      {show2fa && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold">
                Two-Factor Authentication (TOTP RFC 6238)
              </h2>
              <p className="mt-0.5 text-xs text-slate-500">
                Status: {adminUser?.twoFactorEnabled ? 'Enrolled & Active' : 'Not Enrolled'}
              </p>
            </div>
            {adminUser?.twoFactorEnabled ? (
              <button
                type="button"
                onClick={() => void disable2fa()}
                className="rounded-lg border border-red-300 px-3 py-1.5 text-xs font-medium text-red-600"
              >
                Disable 2FA
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void start2faSetup()}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
              >
                Enroll Authenticator App
              </button>
            )}
          </div>

          {totpSecret && (
            <form onSubmit={verify2fa} className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-xs dark:border-slate-800">
              <p>
                Add this secret to Google Authenticator / 1Password:{' '}
                <code className="rounded bg-slate-100 px-2 py-0.5 font-mono dark:bg-slate-800">
                  {totpSecret}
                </code>
              </p>
              <p className="break-all font-mono text-[11px] text-slate-500">{totpUri}</p>
              <div className="flex gap-2">
                <input
                  required
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="Enter 6-digit code"
                  className="h-9 w-44 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
                <button type="submit" className="h-9 rounded-lg bg-emerald-600 px-4 font-medium text-white">
                  Verify & Activate
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      {secData && (
        <>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">Audit Chain Integrity</p>
              <p className="mt-1 flex items-center gap-1.5 font-display text-base font-semibold">
                {secData.auditChainIntegrity.valid ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    Verified ({secData.auditChainIntegrity.checked} entries)
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-4 w-4 text-red-600" />
                    Tamper Detected #{secData.auditChainIntegrity.brokenAtId}
                  </>
                )}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">Active Sessions</p>
              <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                {secData.activeSessions.length}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">Recorded Security Events</p>
              <p className="mt-1 font-display text-xl font-semibold tabular-nums">
                {secData.securityEvents.length}
              </p>
            </div>
          </div>

          {showPolicies && hasPerm('security.manage') && (
            <form
              onSubmit={savePolicies}
              className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 text-xs dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-display text-sm font-semibold">IP Restrictions & Rate Limiting</h2>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400">
                    Admin IP Allowlist (comma-separated, empty allows all)
                  </label>
                  <input
                    value={ipAllowlistText}
                    onChange={(e) => setIpAllowlistText(e.target.value)}
                    placeholder="e.g. 203.0.113.10, 10.0.0.*"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium text-slate-600 dark:text-slate-400">
                    API Rate Limit (requests / min / IP)
                  </label>
                  <input
                    type="number"
                    min={20}
                    value={rateLimit}
                    onChange={(e) => setRateLimit(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              <button type="submit" className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white">
                Save Security Policies
              </button>
            </form>
          )}

          {showSessions && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">Active Admin & User Sessions</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                      <th className="py-2">User</th>
                      <th className="py-2">Client</th>
                      <th className="py-2">IP</th>
                      <th className="py-2">Last Active</th>
                      <th className="py-2 text-right">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {secData.activeSessions.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2 font-medium">{s.userEmail || 'User'}</td>
                        <td className="py-2">{s.browser} · {s.os}</td>
                        <td className="py-2 font-mono">{s.ipAddress || 'N/A'}</td>
                        <td className="py-2 font-mono tabular-nums text-slate-400">
                          {new Date(s.lastActivityAt).toLocaleString()}
                        </td>
                        <td className="py-2 text-right">
                          {hasPerm('security.manage') && (
                            <button
                              type="button"
                              onClick={() => setRevokeTargetId(s.id)}
                              className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-red-600"
                            >
                              <Trash2 className="h-3 w-3" />
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {showEvents && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold mb-3">Security & Auth Alert Events</h2>
              {secData.securityEvents.length === 0 ? (
                <p className="text-xs text-slate-500">No anomalous security events logged yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                        <th className="py-2">Action</th>
                        <th className="py-2">Actor</th>
                        <th className="py-2">Status</th>
                        <th className="py-2">IP</th>
                        <th className="py-2 text-right">Time</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {secData.securityEvents.slice(0, 20).map((ev) => (
                        <tr key={ev.id}>
                          <td className="py-2 font-mono">{ev.action}</td>
                          <td className="py-2">{ev.actorEmail}</td>
                          <td className="py-2 capitalize">{ev.status}</td>
                          <td className="py-2 font-mono">{ev.ipAddress || 'N/A'}</td>
                          <td className="py-2 text-right font-mono tabular-nums text-slate-400">
                            {new Date(ev.createdAt).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}

          {hasPerm('ai.analyze') && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center gap-2">
                <Brain className="h-4 w-4 text-blue-600 dark:text-blue-400" />
                <h2 className="font-display text-sm font-semibold">
                  AI Security & Audit Investigation (High Thinking Mode)
                </h2>
              </div>
              <p className="text-xs text-slate-500">
                Optional server-side analysis of recent Cloudflare D1 audit events and failed API requests (requires GEMINI_API_KEY secret).
              </p>
              <div className="flex gap-2">
                <input
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  placeholder="Optional focus (e.g. 'Check for repeated permission denials or latency spikes')"
                  className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  type="button"
                  disabled={aiLoading}
                  onClick={() => void runAiAudit()}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white disabled:opacity-50"
                >
                  <Shield className="h-3.5 w-3.5" />
                  {aiLoading ? 'Analyzing...' : 'Run Security Analysis'}
                </button>
              </div>
              {aiAnalysis && (
                <pre className="whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                  {aiAnalysis}
                </pre>
              )}
            </section>
          )}
        </>
      )}

      <ConfirmDialog
        open={revokeTargetId !== null}
        title="Revoke Active Session"
        description="Terminate this session immediately? The user will need to re-authenticate."
        destructive
        onConfirm={async () => {
          if (revokeTargetId !== null) {
            try {
              await apiRequest(`/security/sessions/${revokeTargetId}/revoke`, { method: 'POST' });
              pushToast({ type: 'success', title: 'Session revoked' });
              setRevokeTargetId(null);
              await loadSecurity();
            } catch (err) {
              pushToast({
                type: 'error',
                title: 'Failed to revoke session',
                description: err instanceof Error ? err.message : undefined,
              });
            }
          }
        }}
        onCancel={() => setRevokeTargetId(null)}
      />
    </div>
  );
};
