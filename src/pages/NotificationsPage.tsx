import React, { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../contexts/AuthContext';

interface NotifRow {
  id: number;
  title: string;
  message: string;
  channel: string;
  targetType: string;
  targetUserEmail: string | null;
  status: string;
  deliveryProviderStatus: string;
  createdAt: string;
}

interface TemplateRow {
  id: number;
  key: string;
  name: string;
  channel: string;
  subject: string;
  body: string;
}

export const NotificationsPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [rows, setRows] = useState<NotifRow[]>([]);
  const [templates, setTemplates] = useState<TemplateRow[]>([]);
  const [providers, setProviders] = useState<{
    in_app: { configured: boolean; provider: string };
    email: { configured: boolean; provider: string };
    push: { configured: boolean; provider: string };
  } | null>(null);
  const [loading, setLoading] = useState(true);

  // Composer
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [channel, setChannel] = useState('in_app');
  const [targetType, setTargetType] = useState('all');
  const [sending, setSending] = useState(false);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (subview === 'notifications-in-app') qs.set('channel', 'in_app');
      if (subview === 'notifications-email') qs.set('channel', 'email');
      if (subview === 'notifications-push') qs.set('channel', 'push');
      if (subview === 'notifications-scheduled') qs.set('status', 'scheduled');
      if (subview === 'notifications-failed') qs.set('status', 'failed');

      const res = await apiRequest<{
        data: NotifRow[];
        templates: TemplateRow[];
        providers?: typeof providers;
      }>(`/notifications?${qs.toString()}`);
      setRows(res.data);
      setTemplates(res.templates);
      if (res.providers) setProviders(res.providers);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load notifications',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [subview, pushToast]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const sendNotification = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    try {
      const res = await apiRequest<{ notification: NotifRow }>('/notifications', {
        method: 'POST',
        body: JSON.stringify({ title, message, channel, targetType }),
      });
      if (res.notification.status === 'failed') {
        pushToast({
          type: 'warning',
          title: 'External provider not configured',
          description: `Recorded as failed (${res.notification.deliveryProviderStatus}). Only In-App delivery is natively active without SMTP/FCM keys.`,
        });
      } else {
        pushToast({ type: 'success', title: 'Notification delivered via In-App D1 persistence' });
      }
      setTitle('');
      setMessage('');
      await loadNotifications();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Send failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSending(false);
    }
  };

  if (subview === 'notifications-templates') {
    return (
      <div className="space-y-5">
        <h1 className="font-display text-xl font-semibold">Notification Templates</h1>
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {templates.map((t) => (
            <div key={t.id} className="p-4 text-xs">
              <p className="font-semibold text-slate-900 dark:text-slate-100">
                {t.name} · <span className="font-mono">{t.key}</span>
              </p>
              <p className="mt-1 text-slate-600 dark:text-slate-400">{t.subject}: {t.body}</p>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const columns: TableColumn<NotifRow>[] = [
    {
      key: 'title',
      label: 'Notification',
      render: (r) => (
        <div>
          <p className="font-medium text-slate-900 dark:text-slate-100">{r.title}</p>
          <p className="text-xs text-slate-500">{r.message}</p>
        </div>
      ),
    },
    { key: 'channel', label: 'Channel' },
    {
      key: 'status',
      label: 'Delivery Status',
      render: (r) => (
        <span className={r.status === 'failed' ? 'text-red-600 dark:text-red-400' : ''}>
          {r.status} · {r.deliveryProviderStatus}
        </span>
      ),
    },
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
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
          Notifications Center
        </h1>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          In-app notifications are persisted in Cloudflare D1 SQLite. Email/Push channels report actual provider status rather than simulated delivery.
        </p>
      </div>

      {providers && (
        <div className="grid gap-3 sm:grid-cols-3 text-xs">
          <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-slate-500">In-App Delivery</p>
            <p className="mt-1 font-medium text-emerald-700 dark:text-emerald-400">
              Active ({providers.in_app.provider})
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-slate-500">Email Channel</p>
            <p className={`mt-1 font-medium ${providers.email.configured ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {providers.email.configured ? `Configured (${providers.email.provider})` : 'Not Configured (EMAIL_PROVIDER_URL unset)'}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-slate-500">Push Channel</p>
            <p className={`mt-1 font-medium ${providers.push.configured ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}>
              {providers.push.configured ? `Configured (${providers.push.provider})` : 'Not Configured (PUSH_PROVIDER_URL unset)'}
            </p>
          </div>
        </div>
      )}

      {hasPerm('notifications.send') && (
        <form
          onSubmit={sendNotification}
          className="rounded-xl border border-slate-200 bg-white p-5 space-y-3 dark:border-slate-800 dark:bg-slate-900"
        >
          <h2 className="font-display text-sm font-semibold">Dispatch Notification</h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Notification title"
              className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <select
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="in_app">In-App (Cloudflare D1 SQLite)</option>
              <option value="email">Email (Requires SMTP/Webhook Provider)</option>
              <option value="push">Push (Requires FCM/Webhook Provider)</option>
            </select>
            <select
              value={targetType}
              onChange={(e) => setTargetType(e.target.value)}
              className="h-9 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
            >
              <option value="all">Broadcast to All Admins</option>
              <option value="user">Current Admin Session</option>
            </select>
          </div>
          <div className="flex gap-2">
            <input
              required
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Notification message body..."
              className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
            />
            <button
              type="submit"
              disabled={sending}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              {sending ? 'Sending...' : 'Send'}
            </button>
          </div>
        </form>
      )}

      <DataTable<NotifRow>
        tableId="notifications-log"
        columns={columns}
        rows={rows}
        loading={loading}
      />
    </div>
  );
};
