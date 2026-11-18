import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, GitBranch, Play, RefreshCw, Save } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

export const SystemManagementPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { appQueryParam, selectedApp } = useAppScope();
  const { pushToast } = useToast();
  const [data, setData] = useState<{
    host: {
      platform: string;
      arch: string;
      nodeVersion: string;
      cpus: number;
      totalMemMb: number;
      freeMemMb: number;
      uptimeSeconds: number;
      loadAvg: number[];
    };
    database: { status: string; latencyMs: number };
    api: {
      activeConnections?: number;
      activeSseConnections?: number;
      recentLogs: Array<{ id: number; method: string; path: string; statusCode: number; durationMs: number; createdAt: string }>;
      errorLogs: Array<{ id: number; method: string; path: string; statusCode: number; errorMessage: string; createdAt: string }>;
    };
    sdkErrors?: Array<{ id: number; appId: number; eventType: string; eventName: string; severity: string; createdAt: string }>;
    jobs: Array<{ id: number; jobType: string; status: string; result: unknown; createdAt: string }>;
  } | null>(null);

  const loadSystem = useCallback(async () => {
    try {
      const qs = appQueryParam ? `?appId=${encodeURIComponent(appQueryParam)}` : '';
      const res = await apiRequest<NonNullable<typeof data>>(`/system/overview${qs}`);
      setData(res);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'System telemetry load failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [appQueryParam, pushToast]);

  useEffect(() => {
    void loadSystem();
  }, [loadSystem]);

  const runJob = async (jobType: string) => {
    try {
      await apiRequest('/system/jobs', {
        method: 'POST',
        body: JSON.stringify({ jobType, appId: selectedApp ? selectedApp.id : null }),
      });
      pushToast({ type: 'success', title: `Background job completed: ${jobType}` });
      await loadSystem();
    } catch (err) {
      pushToast({
        type: 'error',
        title: `Background job failed: ${jobType}`,
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (!data) {
    return <div className="h-40 animate-pulse rounded-xl bg-white dark:bg-slate-900" />;
  }

  const activeConnections = data.api.activeConnections ?? data.api.activeSseConnections ?? 0;
  const showJobs = subview === 'system-health' || subview === 'system-jobs' || subview === 'system-maintenance';
  const showErrors = subview === 'system-health' || subview === 'system-logs';
  const showLogs = subview === 'system-health' || subview === 'system-logs' || subview === 'system-api';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">System Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selectedApp
              ? `Cloudflare Workers & D1 telemetry filtered for ${selectedApp.name}.`
              : 'Live Cloudflare Workers runtime, D1 SQLite latency, HTTP/SDK error telemetry, and maintenance job execution.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadSystem()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh
        </button>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Worker Runtime</p>
          <p className="mt-1 font-mono text-sm font-semibold">
            {data.host.platform} ({data.host.arch})
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Isolate Memory Budget</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
            {data.host.freeMemMb} / {data.host.totalMemMb} MB
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Cloudflare D1 Ping</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
            {data.database.status} ({data.database.latencyMs} ms)
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p className="text-xs text-slate-500">Active Sessions & Uptime</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums">
            {activeConnections} active · {data.host.uptimeSeconds}s
          </p>
        </div>
      </div>

      {showJobs && hasPerm('system.manage') && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold">Maintenance & Automated Backup Jobs</h2>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { id: 'auto_backup', label: 'Run Scheduled Auto-Backup' },
              { id: 'audit_verify', label: 'Verify Audit Hash Chain' },
              { id: 'session_cleanup', label: 'Prune Expired Sessions' },
              { id: 'log_prune', label: 'Enforce 30-Day API Log Retention' },
            ].map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => void runJob(job.id)}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
              >
                <Play className="h-3.5 w-3.5 text-blue-600" />
                {job.label}
              </button>
            ))}
          </div>
          <ul className="mt-4 divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.jobs.slice(0, 8).map((j) => (
              <li key={j.id} className="flex flex-wrap justify-between gap-2 py-2 font-mono">
                <span>
                  #{j.id} {j.jobType} · {j.status}
                </span>
                <span className="truncate max-w-md text-slate-400">{JSON.stringify(j.result)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {showErrors && (data.api.errorLogs.length > 0 || (data.sdkErrors && data.sdkErrors.length > 0)) && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-center gap-2 mb-3">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <h2 className="font-display text-sm font-semibold">
              Recorded HTTP 4xx/5xx & SDK Error Events ({data.api.errorLogs.length + (data.sdkErrors?.length ?? 0)})
            </h2>
          </div>
          <div className="divide-y divide-slate-100 font-mono text-xs dark:divide-slate-800">
            {data.api.errorLogs.slice(0, 10).map((err) => (
              <div key={`http-${err.id}`} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  {err.method} {err.path}
                </span>
                <span className="text-red-600">
                  HTTP {err.statusCode} {err.errorMessage ? `· ${err.errorMessage}` : ''}
                </span>
              </div>
            ))}
            {(data.sdkErrors || []).slice(0, 10).map((sdkErr) => (
              <div key={`sdk-${sdkErr.id}`} className="flex flex-wrap justify-between gap-2 py-2">
                <span>
                  App #{sdkErr.appId} · {sdkErr.eventName}
                </span>
                <span className="text-amber-600 uppercase">{sdkErr.severity}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {showLogs && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold mb-3">Recent API Telemetry Logs</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2">Method</th>
                  <th className="py-2">Path</th>
                  <th className="py-2">Status</th>
                  <th className="py-2 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.api.recentLogs.slice(0, 20).map((l) => (
                  <tr key={l.id}>
                    <td className="py-1.5">{l.method}</td>
                    <td className="py-1.5">{l.path}</td>
                    <td className={`py-1.5 ${l.statusCode >= 400 ? 'text-red-600' : 'text-emerald-600'}`}>
                      {l.statusCode}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{l.durationMs} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
};

export const GithubCenterPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [repoInput, setRepoInput] = useState('');
  const [ghData, setGhData] = useState<{
    configured: boolean;
    repository: string;
    hasServerToken: boolean;
    error?: string;
    repo?: { full_name: string; default_branch: string; stargazers_count: number; open_issues_count: number };
    branches?: Array<{ name: string }>;
    commits?: Array<{ sha: string; commit: { message: string; author: { name: string; date: string } } }>;
    pulls?: Array<{ id: number; number: number; title: string; state: string }>;
    workflows?: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url: string }>;
    releases?: Array<{ id: number; tag_name: string; name: string; published_at: string }>;
    deployments?: Array<{ id: number; environment: string; ref: string; created_at: string }>;
  } | null>(null);

  const loadGithub = useCallback(async () => {
    try {
      const res = await apiRequest<NonNullable<typeof ghData>>('/github/overview');
      setGhData(res);
      if (res.repository) setRepoInput(res.repository);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'GitHub lookup error',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [pushToast]);

  useEffect(() => {
    void loadGithub();
  }, [loadGithub]);

  const saveRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/github/repository', {
        method: 'PUT',
        body: JSON.stringify({ repository: repoInput }),
      });
      pushToast({ type: 'success', title: 'GitHub repository updated' });
      await loadGithub();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to update GitHub repository',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const showRepoCol = subview !== 'github-actions' && subview !== 'github-releases';
  const showActionsCol = subview === 'github-repo' || subview === 'github-actions' || subview === 'github-releases';

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold">GitHub & Developer Center</h1>
        <p className="mt-0.5 text-xs text-slate-500">
          Server-proxied GitHub REST API integration inside Cloudflare Workers (tokens stay strictly server-side).
        </p>
      </div>

      {hasPerm('github.manage') && (
        <form
          onSubmit={saveRepo}
          className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
        >
          <GitBranch className="h-4 w-4 text-slate-500" />
          <input
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            placeholder="owner/repository (e.g. octocat/Hello-World)"
            className="h-9 flex-1 min-w-[220px] rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
          />
          <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white">
            <Save className="h-3.5 w-3.5" />
            Connect Repo
          </button>
        </form>
      )}

      {ghData && !ghData.configured && (
        <div className="rounded-xl border border-slate-200 bg-white p-6 text-xs dark:border-slate-800 dark:bg-slate-900">
          <p className="font-semibold text-slate-900 dark:text-slate-100">
            GitHub integration not configured
          </p>
          <p className="mt-1 text-slate-500">
            Enter an <code className="font-mono">owner/repo</code> slug above to inspect live branches, commits, pull requests, workflow runs, releases, and deployments. For private repositories, configure <code className="font-mono">GITHUB_TOKEN</code> in Worker secrets.
          </p>
        </div>
      )}

      {ghData?.error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {ghData.error}
        </div>
      )}

      {ghData?.repo && (
        <div className="grid gap-6 lg:grid-cols-2">
          {showRepoCol && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold">
                {ghData.repo.full_name} · Default branch: {ghData.repo.default_branch}
              </h2>
              <p className="mt-1 text-xs text-slate-500">
                Branches ({ghData.branches?.length ?? 0}): {(ghData.branches || []).map((b) => b.name).join(', ')}
              </p>
              <h3 className="mt-4 text-xs font-semibold">Recent Commits</h3>
              <ul className="mt-2 divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {(ghData.commits || []).slice(0, 6).map((c) => (
                  <li key={c.sha} className="py-2">
                    <p className="truncate font-medium">{c.commit.message}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {c.sha.slice(0, 7)} · {c.commit.author.name}
                    </p>
                  </li>
                ))}
              </ul>
              <h3 className="mt-4 text-xs font-semibold">Pull Requests</h3>
              <ul className="mt-2 divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {(ghData.pulls || []).slice(0, 5).map((pr) => (
                  <li key={pr.id} className="flex justify-between py-2">
                    <span className="truncate">#{pr.number} {pr.title}</span>
                    <span className="font-mono capitalize text-slate-500">{pr.state}</span>
                  </li>
                ))}
                {(ghData.pulls || []).length === 0 && (
                  <li className="py-2 text-slate-500">No pull requests returned.</li>
                )}
              </ul>
            </section>
          )}

          {showActionsCol && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold">GitHub Actions, Releases & Deployments</h2>
              <ul className="mt-3 divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {(ghData.workflows || []).slice(0, 6).map((w) => (
                  <li key={w.id} className="flex justify-between py-2">
                    <span>{w.name}</span>
                    <span className="font-mono">{w.conclusion || w.status}</span>
                  </li>
                ))}
                {(ghData.workflows || []).length === 0 && (
                  <li className="py-3 text-slate-500">No workflow runs returned.</li>
                )}
              </ul>
              <h3 className="mt-4 text-xs font-semibold">Releases & Deployments</h3>
              <ul className="mt-2 divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {(ghData.releases || []).slice(0, 4).map((rel) => (
                  <li key={rel.id} className="flex justify-between py-2">
                    <span className="font-mono">{rel.tag_name}</span>
                    <span className="text-slate-500">{rel.name || 'Release'}</span>
                  </li>
                ))}
                {(ghData.deployments || []).slice(0, 4).map((dep) => (
                  <li key={dep.id} className="flex justify-between py-2">
                    <span>Env: {dep.environment}</span>
                    <span className="font-mono text-slate-500">{dep.ref}</span>
                  </li>
                ))}
                {(ghData.releases || []).length === 0 && (ghData.deployments || []).length === 0 && (
                  <li className="py-2 text-slate-500">No releases or deployments recorded.</li>
                )}
              </ul>
            </section>
          )}
        </div>
      )}

      <section className="rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-display text-sm font-semibold">
          Zero-Cost Edge Architecture (Cloudflare Workers + D1 SQLite)
        </h2>
        <p className="mt-2 leading-relaxed text-slate-600 dark:text-slate-400">
          The full-stack Aegis Enterprise Console runs on Cloudflare Workers free tier (
          <code className="font-mono">workers.dev</code>) with Workers Static Assets for the React
          SPA and Cloudflare D1 SQLite for relational persistence across all 36 tables — zero paid
          cloud databases or Node servers required. <code className="font-mono">.github/workflows/ci.yml</code> and{' '}
          <code className="font-mono">deploy-cloudflare.yml</code> automate D1 migration validation,
          typechecking, unit/API tests, builds, and tag/SHA rollback deployments.
        </p>
      </section>
    </div>
  );
};
