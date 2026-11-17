import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Send } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../contexts/AuthContext';

interface FeatureFlag {
  id: number;
  key: string;
  name: string;
  description: string;
  isEnabled: boolean;
  rolloutPercentage: number;
}

interface AppRelease {
  id: number;
  version: string;
  minSupportedVersion: string;
  forceUpdate: boolean;
  platform: string;
  releaseNotes: string;
  status: string;
  createdAt: string;
}

export const AppManagementPage: React.FC<{ subview: string }> = () => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [releases, setReleases] = useState<AppRelease[]>([]);
  const [maintenanceMode, setMaintenanceMode] = useState(false);

  // Flag form
  const [flagKey, setFlagKey] = useState('');
  const [flagName, setFlagName] = useState('');
  // Release form
  const [relVersion, setRelVersion] = useState('1.1.0');
  const [relMin, setRelMin] = useState('1.0.0');
  const [relNotes, setRelNotes] = useState('');
  const [forceUpdate, setForceUpdate] = useState(false);

  const loadApp = useCallback(async () => {
    const res = await apiRequest<{
      flags: FeatureFlag[];
      releases: AppRelease[];
      settings: Array<{ key: string; value: unknown }>;
    }>('/app/overview');
    setFlags(res.flags);
    setReleases(res.releases);
    const maint = res.settings.find((s) => s.key === 'app.maintenanceMode');
    setMaintenanceMode(Boolean(maint?.value));
  }, []);

  useEffect(() => {
    void loadApp();
  }, [loadApp]);

  const toggleMaintenance = async () => {
    const next = !maintenanceMode;
    await apiRequest('/settings/app.maintenanceMode', {
      method: 'PUT',
      body: JSON.stringify({ value: next, category: 'maintenance' }),
    });
    setMaintenanceMode(next);
    pushToast({ type: next ? 'warning' : 'success', title: `Maintenance mode ${next ? 'enabled' : 'disabled'}` });
  };

  const createFlag = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiRequest('/app/flags', {
      method: 'POST',
      body: JSON.stringify({ key: flagKey, name: flagName, isEnabled: true }),
    });
    setFlagKey('');
    setFlagName('');
    pushToast({ type: 'success', title: 'Feature flag created' });
    await loadApp();
  };

  const publishRelease = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiRequest('/app/releases', {
      method: 'POST',
      body: JSON.stringify({
        version: relVersion,
        minSupportedVersion: relMin,
        releaseNotes: relNotes,
        forceUpdate,
      }),
    });
    setRelNotes('');
    pushToast({ type: 'success', title: `Release ${relVersion} published` });
    await loadApp();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">Application Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Control release versions, force updates, maintenance windows, and dynamic feature flags.
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
            Maintenance Mode: {maintenanceMode ? 'ON' : 'OFF'}
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold">Feature Flags</h2>
          {hasPerm('app.manage') && (
            <form onSubmit={createFlag} className="mt-3 flex gap-2">
              <input
                required
                value={flagKey}
                onChange={(e) => setFlagKey(e.target.value)}
                placeholder="flag_key"
                className="h-9 w-36 rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <input
                required
                value={flagName}
                onChange={(e) => setFlagName(e.target.value)}
                placeholder="Display name"
                className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
              />
              <button type="submit" className="h-9 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white">
                Add
              </button>
            </form>
          )}
          <div className="mt-4 divide-y divide-slate-100 dark:divide-slate-800">
            {flags.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">No feature flags created yet.</p>
            ) : (
              flags.map((f) => (
                <div key={f.id} className="flex items-center justify-between py-2.5 text-xs">
                  <div>
                    <p className="font-medium">{f.name}</p>
                    <p className="font-mono text-slate-500">{f.key} · {f.rolloutPercentage}% rollout</p>
                  </div>
                  {hasPerm('app.manage') && (
                    <button
                      type="button"
                      onClick={() =>
                        void apiRequest(`/app/flags/${f.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isEnabled: !f.isEnabled }),
                        }).then(() => loadApp())
                      }
                      className={`rounded px-2.5 py-1 font-medium ${
                        f.isEnabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
                      }`}
                    >
                      {f.isEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </section>

        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold">Release & Version Control</h2>
          {hasPerm('app.manage') && (
            <form onSubmit={publishRelease} className="mt-3 space-y-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <input
                  required
                  value={relVersion}
                  onChange={(e) => setRelVersion(e.target.value)}
                  placeholder="Version (e.g. 1.2.0)"
                  className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
                <input
                  required
                  value={relMin}
                  onChange={(e) => setRelMin(e.target.value)}
                  placeholder="Min supported"
                  className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
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
            {releases.map((r) => (
              <li key={r.id} className="py-2.5">
                <p className="font-mono font-semibold">
                  v{r.version} (min v{r.minSupportedVersion}) {r.forceUpdate ? '· Force Update' : ''}
                </p>
                <p className="text-slate-500">{r.releaseNotes || 'No release notes'}</p>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
};

interface TicketRow {
  id: number;
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
      const res = await apiRequest<{ data: TicketRow[]; templates: typeof templates }>(
        `/support/tickets?${qs.toString()}`
      );
      setTickets(res.data);
      setTemplates(res.templates);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, search]);

  useEffect(() => {
    void loadTickets();
  }, [loadTickets]);

  const openTicket = async (t: TicketRow) => {
    setActiveTicket(t);
    const res = await apiRequest<{ messages: typeof messages }>(`/support/tickets/${t.id}/messages`);
    setMessages(res.messages);
  };

  const sendReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTicket || !replyBody.trim()) return;
    await apiRequest(`/support/tickets/${activeTicket.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: replyBody, isInternalNote: isInternal }),
    });
    setReplyBody('');
    await openTicket(activeTicket);
  };

  const createTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    await apiRequest('/support/tickets', {
      method: 'POST',
      body: JSON.stringify({ subject: newSubject, description: newDesc, priority: newPriority }),
    });
    setShowNew(false);
    setNewSubject('');
    setNewDesc('');
    pushToast({ type: 'success', title: 'Support ticket created' });
    await loadTickets();
  };

  if (subview === 'support-templates') {
    return (
      <div className="space-y-4">
        <h1 className="font-display text-xl font-semibold">Support Response Templates</h1>
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {templates.map((t) => (
            <div key={t.id} className="p-4 text-xs">
              <p className="font-semibold">{t.title}</p>
              <p className="mt-1 text-slate-500">{t.body}</p>
            </div>
          ))}
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
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 pb-3 dark:border-slate-800">
              <div>
                <h2 className="font-display text-base font-semibold">
                  {activeTicket.ticketNumber} · {activeTicket.subject}
                </h2>
                <p className="mt-1 text-xs text-slate-500">{activeTicket.description}</p>
              </div>
              <select
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
