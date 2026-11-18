import React, { useCallback, useEffect, useState } from 'react';
import { Plus, RotateCcw, Send, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

interface FeatureFlag {
  id: number;
  appId: number | null;
  key: string;
  name: string;
  description: string;
  isEnabled: boolean;
  rolloutPercentage: number;
}

interface AppRelease {
  id: number;
  appId: number | null;
  version: string;
  minSupportedVersion: string;
  forceUpdate: boolean;
  platform: string;
  releaseNotes: string;
  status: string;
  createdAt: string;
}

export const AppManagementPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { selectedAppId, selectedApp, refreshApps } = useAppScope();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [loading, setLoading] = useState(true);

  // Flag form
  const [flagKey, setFlagKey] = useState('');
  const [flagName, setFlagName] = useState('');
  const [flagRollout, setFlagRollout] = useState('100');
  // Release form
  const [relVersion, setRelVersion] = useState('1.1.0');
  const [relMin, setRelMin] = useState('1.0.0');
  const [relPlatform, setRelPlatform] = useState('android');
  const [relNotes, setRelNotes] = useState('');
  const [forceUpdate, setForceUpdate] = useState(false);

  const loadApp = useCallback(async () => {
    setLoading(true);
    try {
      const qs = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';
      const res = await apiRequest<{
        flags: FeatureFlag[];
        releases: AppRelease[];
        settings: Array<{ key: string; value: unknown }>;
      }>(`/app/overview${qs}`);
      setFlags(res.flags);
      setReleases(res.releases);
      if (selectedApp) {
        setMaintenanceMode(selectedApp.status === 'maintenance');
      } else {
        const maint = res.settings.find((s) => s.key === 'app.maintenanceMode');
        setMaintenanceMode(Boolean(maint?.value));
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load app configuration',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [selectedAppId, selectedApp, pushToast]);

  useEffect(() => {
    void loadApp();
  }, [loadApp]);

  const toggleMaintenance = async () => {
    const next = !maintenanceMode;
    try {
      if (selectedApp) {
        await apiRequest(`/apps/${selectedApp.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: next ? 'maintenance' : 'connected' }),
        });
        await refreshApps();
      } else {
        await apiRequest('/settings/app.maintenanceMode', {
          method: 'PUT',
          body: JSON.stringify({ value: next, category: 'maintenance' }),
        });
      }
      setMaintenanceMode(next);
      pushToast({
        type: next ? 'warning' : 'success',
        title: `${selectedApp ? selectedApp.name : 'Global'} maintenance mode ${next ? 'enabled' : 'disabled'}`,
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Maintenance update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const createFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/app/flags', {
        method: 'POST',
        body: JSON.stringify({
          key: flagKey,
          name: flagName,
          isEnabled: true,
          rolloutPercentage: Math.min(100, Math.max(0, Number(flagRollout) || 100)),
          appId: selectedAppId !== 'all' ? selectedAppId : null,
        }),
      });
      setFlagKey('');
      setFlagName('');
      pushToast({ type: 'success', title: 'Feature flag created' });
      await loadApp();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not create flag',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const publishRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/app/releases', {
        method: 'POST',
        body: JSON.stringify({
          version: relVersion,
          minSupportedVersion: relMin,
          platform: selectedApp?.platform || relPlatform,
          releaseNotes: relNotes,
          forceUpdate,
          appId: selectedAppId !== 'all' ? selectedAppId : null,
        }),
      });
      setRelNotes('');
      pushToast({ type: 'success', title: `Release ${relVersion} published` });
      await loadApp();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to publish release',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const showFlagsSection = subview === 'app-general' || subview === 'app-flags';
  const showReleasesSection =
    subview === 'app-general' || subview === 'app-maintenance' || subview === 'app-releases';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">
            Application Management {selectedApp ? `· ${selectedApp.name}` : '· Global'}
          </h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Control release versions, force updates, maintenance windows, and dynamic feature flags per app or globally.
          </p>
        </div>
        {hasPerm('app.manage') && (
          <button
            type="button"
            onClick={() => void toggleMaintenance()}
            className={`h-9 rounded-lg px-4 text-xs font-medium ${
              maintenanceMode
                ? 'bg-amber-600 text-white'
                : 'border border-slate-200 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
            }`}
          >
            {selectedApp ? `${selectedApp.name} Maintenance` : 'Global Maintenance'}: {maintenanceMode ? 'ON' : 'OFF'}
          </button>
        )}
      </div>

      {loading && flags.length === 0 && releases.length === 0 ? (
        <div className="h-36 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
      ) : (
        <div className={`grid gap-6 ${showFlagsSection && showReleasesSection ? 'lg:grid-cols-2' : ''}`}>
          {showFlagsSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold">Feature Flags</h2>
              {hasPerm('app.manage') && (
                <form onSubmit={createFlag} className="mt-3 flex flex-wrap gap-2">
                  <input
                    required
                    value={flagKey}
                    onChange={(e) => setFlagKey(e.target.value)}
                    placeholder="flag_key"
                    className="h-9 w-32 rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <input
                    required
                    value={flagName}
                    onChange={(e) => setFlagName(e.target.value)}
                    placeholder="Display name"
                    className="h-9 min-w-[140px] flex-1 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={flagRollout}
                    onChange={(e) => setFlagRollout(e.target.value)}
                    aria-label="Rollout percentage"
                    className="h-9 w-20 rounded-lg border border-slate-200 px-2 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button type="submit" className="h-9 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
                    Add Flag
                  </button>
                </form>
              )}
              <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
                {flags.length === 0 ? (
                  <p className="py-6 text-center text-xs text-slate-500">No feature flags created yet.</p>
                ) : (
                  flags.map((f) => (
                    <div key={f.id} className="flex items-center justify-between gap-2 py-2.5 text-xs">
                      <div>
                        <p className="font-medium">{f.name}</p>
                        <p className="font-mono text-slate-500">
                          {f.key} · {f.rolloutPercentage}% rollout · {f.appId ? `App #${f.appId}` : 'Global'}
                        </p>
                      </div>
                      {hasPerm('app.manage') && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={async () => {
                              try {
                                await apiRequest(`/app/flags/${f.id}`, {
                                  method: 'PATCH',
                                  body: JSON.stringify({ isEnabled: !f.isEnabled }),
                                });
                                await loadApp();
                              } catch (err) {
                                pushToast({
                                  type: 'error',
                                  title: 'Toggle failed',
                                  description: err instanceof Error ? err.message : undefined,
                                });
                              }
                            }}
                            className={`rounded px-2.5 py-1 font-medium ${
                              f.isEnabled
                                ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300'
                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                            }`}
                          >
                            {f.isEnabled ? 'Enabled' : 'Disabled'}
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete flag ${f.key}`}
                            onClick={async () => {
                              try {
                                await apiRequest(`/app/flags/${f.id}`, { method: 'DELETE' });
                                pushToast({ type: 'success', title: `Deleted flag ${f.key}` });
                                await loadApp();
                              } catch (err) {
                                pushToast({
                                  type: 'error',
                                  title: 'Delete failed',
                                  description: err instanceof Error ? err.message : undefined,
                                });
                              }
                            }}
                            className="rounded border border-red-200 p-1 text-red-600 dark:border-red-900"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {showReleasesSection && (
            <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold">Release & Version Control</h2>
              {hasPerm('app.manage') && (
                <form onSubmit={publishRelease} className="mt-3 space-y-2.5 text-xs">
                  <div className="grid grid-cols-3 gap-2">
                    <input
                      required
                      value={relVersion}
                      onChange={(e) => setRelVersion(e.target.value)}
                      placeholder="Version (1.2.0)"
                      className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <input
                      required
                      value={relMin}
                      onChange={(e) => setRelMin(e.target.value)}
                      placeholder="Min supported"
                      className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                    <select
                      value={selectedApp?.platform || relPlatform}
                      disabled={Boolean(selectedApp)}
                      onChange={(e) => setRelPlatform(e.target.value)}
                      aria-label="Target platform"
                      className="h-9 rounded-lg border border-slate-200 px-2 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="android">Android</option>
                      <option value="game">Game</option>
                      <option value="website">Website</option>
                      <option value="ios">iOS</option>
                    </select>
                  </div>
                  <input
                    value={relNotes}
                    onChange={(e) => setRelNotes(e.target.value)}
                    placeholder="Release changelog notes..."
                    className="h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <div className="flex items-center justify-between">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={forceUpdate}
                        onChange={(e) => setForceUpdate(e.target.checked)}
                      />
                      <span>Enforce minimum version update</span>
                    </label>
                    <button type="submit" className="h-9 rounded-lg bg-blue-600 px-3.5 font-medium text-white">
                      Publish Release
                    </button>
                  </div>
                </form>
              )}
              <ul className="mt-4 divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {releases.length === 0 ? (
                  <li className="py-6 text-center text-slate-500">No releases published yet.</li>
                ) : (
                  releases.map((r) => (
                    <li key={r.id} className="flex items-center justify-between gap-2 py-2.5">
                      <div>
                        <p className="font-mono font-semibold">
                          v{r.version} (min v{r.minSupportedVersion}) · {r.platform} · {r.status}
                          {r.forceUpdate ? ' · Force Update' : ''}
                        </p>
                        <p className="text-slate-500">{r.releaseNotes || 'No release notes'}</p>
                      </div>
                      {hasPerm('app.manage') && (
                        <button
                          type="button"
                          onClick={async () => {
                            const nextStatus = r.status === 'active' ? 'rolled_back' : 'active';
                            await apiRequest(`/app/releases/${r.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ status: nextStatus }),
                            });
                            pushToast({ type: 'info', title: `Release v${r.version} marked ${nextStatus}` });
                            await loadApp();
                          }}
                          className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                        >
                          <RotateCcw className="h-3 w-3" />
                          {r.status === 'active' ? 'Rollback' : 'Activate'}
                        </button>
                      )}
                    </li>
                  ))
                )}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
};

interface TicketRow {
  id: number;
  appId: number | null;
  ticketNumber: string;
  userEmail: string | null;
  category: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  createdAt: string;
}

export const SupportPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { selectedAppId } = useAppScope();
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [templates, setTemplates] = useState<Array<{ id: number; title: string; body: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeTicket, setActiveTicket] = useState<TicketRow | null>(null);
  const [messages, setMessages] = useState<
    Array<{ id: number; body: string; isInternalNote: boolean; senderEmail: string | null; createdAt: string }>
  >([]);
  const [replyBody, setReplyBody] = useState('');
  const [isInternal, setIsInternal] = useState(false);

  const [showNew, setShowNew] = useState(false);
  const [newSubject, setNewSubject] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newPriority, setNewPriority] = useState('medium');

  const statusFilter =
    subview === 'support-open'
      ? 'open'
      : subview === 'support-pending'
        ? 'pending'
        : subview === 'support-resolved'
          ? 'resolved'
          : 'all';

  const loadTickets = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ status: statusFilter, search });
      if (selectedAppId !== 'all') qs.set('appId', String(selectedAppId));
      const res = await apiRequest<{ data: TicketRow[]; templates: typeof templates }>(
        `/support/tickets?${qs.toString()}`
      );
      setTickets(res.data);
      setTemplates(res.templates);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load tickets',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search, selectedAppId, pushToast]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const openTicket = async (t: TicketRow) => {
    try {
      setActiveTicket(t);
      const res = await apiRequest<{ messages: typeof messages }>(`/support/tickets/${t.id}/messages`);
      setMessages(res.messages);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not open ticket thread',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTicket || !replyBody.trim()) return;
    try {
      await apiRequest(`/support/tickets/${activeTicket.id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody, isInternalNote: isInternal }),
      });
      setReplyBody('');
      await openTicket(activeTicket);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to send reply',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const createTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/support/tickets', {
        method: 'POST',
        body: JSON.stringify({
          subject: newSubject,
          description: newDesc,
          priority: newPriority,
          appId: selectedAppId !== 'all' ? selectedAppId : null,
        }),
      });
      setShowNew(false);
      setNewSubject('');
      setNewDesc('');
      pushToast({ type: 'success', title: 'Support ticket created' });
      await loadTickets();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not create ticket',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (subview === 'support-analytics') {
    const openCount = tickets.filter((t) => t.status === 'open').length;
    const pendingCount = tickets.filter((t) => t.status === 'pending').length;
    const resolvedCount = tickets.filter((t) => t.status === 'resolved' || t.status === 'closed').length;
    const urgentCount = tickets.filter((t) => t.priority === 'urgent' || t.priority === 'high').length;

    return (
      <div className="space-y-5">
        <h1 className="font-display text-xl font-semibold">Support SLA & Analytics</h1>
        <div className="grid gap-4 sm:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Total Tickets</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{tickets.length}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Open / Pending</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {openCount} / {pendingCount}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Resolved & Closed</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">{resolvedCount}</p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">High / Urgent Queue</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-amber-600">{urgentCount}</p>
          </div>
        </div>
      </div>
    );
  }

  if (subview === 'support-templates') {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-xl font-semibold">Support Response Templates</h1>
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {templates.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">No response templates configured.</p>
          ) : (
            templates.map((t) => (
              <div key={t.id} className="p-4 text-xs">
                <p className="font-semibold">{t.title}</p>
                <p className="mt-1 text-slate-500">{t.body}</p>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  const columns: TableColumn<TicketRow>[] = [
    { key: 'ticketNumber', label: 'Ticket', render: (r) => <span className="font-mono text-xs">{r.ticketNumber}</span> },
    { key: 'subject', label: 'Subject' },
    { key: 'priority', label: 'Priority', render: (r) => <span className="capitalize">{r.priority}</span> },
    { key: 'status', label: 'Status', render: (r) => <span className="capitalize">{r.status}</span> },
    {
      key: 'createdAt',
      label: 'Created',
      align: 'right',
      render: (r) => <span className="font-mono text-xs text-slate-500">{new Date(r.createdAt).toLocaleDateString()}</span>,
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold">Support & Communication</h1>
        {hasPerm('support.write') && (
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white"
          >
            <Plus className="h-4 w-4" />
            New Ticket
          </button>
        )}
      </div>

      <DataTable<TicketRow>
        tableId="support-tickets"
        columns={columns}
        rows={tickets}
        search={search}
        onSearchChange={setSearch}
        loading={loading}
        onRowClick={(r) => void openTicket(r)}
      />

      {activeTicket && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
              <div>
                <h2 className="font-display text-base font-semibold">
                  {activeTicket.ticketNumber} · {activeTicket.subject}
                </h2>
                <p className="mt-1 text-xs text-slate-500">{activeTicket.description}</p>
              </div>
              <div className="flex items-center gap-2">
                <select
                  aria-label="Ticket priority"
                  value={activeTicket.priority}
                  onChange={(e) => {
                    const pr = e.target.value;
                    void apiRequest(`/support/tickets/${activeTicket.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ priority: pr }),
                    }).then(() => {
                      setActiveTicket({ ...activeTicket, priority: pr });
                      void loadTickets();
                    });
                  }}
                  className="h-8 rounded border border-slate-200 px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <select
                  aria-label="Ticket status"
                  value={activeTicket.status}
                  onChange={(e) => {
                    const st = e.target.value;
                    void apiRequest(`/support/tickets/${activeTicket.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status: st }),
                    }).then(() => {
                      setActiveTicket({ ...activeTicket, status: st });
                      void loadTickets();
                    });
                  }}
                  className="h-8 rounded border border-slate-200 px-2 text-xs dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="open">Open</option>
                  <option value="pending">Pending</option>
                  <option value="resolved">Resolved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>
            </div>

            <div className="my-4 max-h-60 space-y-2 overflow-y-auto text-xs">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className={`rounded-lg border p-3 ${
                    m.isInternalNote
                      ? 'border-amber-200 bg-amber-50/70 dark:border-amber-900/50 dark:bg-amber-950/30'
                      : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-950'
                  }`}
                >
                  <p className="font-medium">
                    {m.senderEmail || 'Agent'} {m.isInternalNote ? '(Internal Note)' : ''}
                  </p>
                  <p className="mt-1">{m.body}</p>
                </div>
              ))}
            </div>

            <form onSubmit={sendReply} className="space-y-2">
              <textarea
                rows={3}
                value={replyBody}
                onChange={(e) => setReplyBody(e.target.value)}
                placeholder="Write a reply or internal note..."
                className="w-full rounded-lg border border-slate-200 p-2.5 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={isInternal}
                    onChange={(e) => setIsInternal(e.target.checked)}
                  />
                  <span>Internal note only</span>
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setActiveTicket(null)}
                    className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs dark:border-slate-700"
                  >
                    Close
                  </button>
                  <button type="submit" className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white">
                    <Send className="h-3.5 w-3.5" />
                    Send
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {showNew && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form onSubmit={createTicket} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-base font-semibold">Open Support Ticket</h2>
            <div className="mt-4 space-y-3 text-xs">
              <input
                required
                value={newSubject}
                onChange={(e) => setNewSubject(e.target.value)}
                placeholder="Subject"
                className="h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
              <select
                value={newPriority}
                onChange={(e) => setNewPriority(e.target.value)}
                className="h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="low">Low Priority</option>
                <option value="medium">Medium Priority</option>
                <option value="high">High Priority</option>
                <option value="urgent">Urgent Priority</option>
              </select>
              <textarea
                required
                rows={4}
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Issue description..."
                className="w-full rounded-lg border border-slate-200 p-3 dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setShowNew(false)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white">
                Create Ticket
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
