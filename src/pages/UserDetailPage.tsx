import React, { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, LogOut, Save, ShieldAlert, Trash2 } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../contexts/AuthContext';

interface UserDetailAggregate {
  user: {
    id: number;
    uid: string;
    email: string;
    displayName: string;
    phone: string;
    department: string;
    jobTitle: string;
    roleId: number | null;
    roleName: string | null;
    roleSlug: string | null;
    status: string;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    lastSeenAt: string | null;
    lastLoginAt: string | null;
    lastIp: string;
    country: string;
    tags: string[];
    restrictions: {
      apiDisabled?: boolean;
      readOnly?: boolean;
      ipAllowlist?: string[];
      reason?: string;
    };
    createdAt: string;
  };
  isOnline: boolean;
  sessions: Array<{
    id: number;
    deviceName: string;
    browser: string;
    os: string;
    ipAddress: string;
    isActive: boolean;
    lastActivityAt: string;
    expiresAt: string;
  }>;
  notes: Array<{ id: number; note: string; authorEmail: string | null; createdAt: string }>;
  overrides: Array<{ id: number; permissionId: number; permissionKey: string; granted: boolean; reason: string }>;
  notifications: Array<{ id: number; title: string; channel: string; status: string; createdAt: string }>;
  transactions: Array<{ id: number; reference: string; amountCents: number; currency: string; status: string; createdAt: string }>;
  tickets: Array<{ id: number; ticketNumber: string; subject: string; status: string; priority: string; createdAt: string }>;
  activityHistory: Array<{ id: number; action: string; module: string; status: string; createdAt: string }>;
  auditHistory: Array<{ id: number; actorEmail: string; action: string; status: string; createdAt: string }>;
}

const TABS = [
  'Overview',
  'Personal Information',
  'Account Settings',
  'Activity',
  'Login History',
  'Devices',
  'Sessions',
  'Notifications',
  'Permissions',
  'Restrictions',
  'Transactions',
  'Support History',
  'Internal Notes',
  'Audit History',
] as const;

export const UserDetailPage: React.FC<{ userId: number; onBack: () => void }> = ({
  userId,
  onBack,
}) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [activeTab, setActiveTab] = useState<(typeof TABS)[number]>('Overview');
  const [data, setData] = useState<UserDetailAggregate | null>(null);
  const [rolesList, setRolesList] = useState<Array<{ id: number; name: string }>>([]);
  const [allPerms, setAllPerms] = useState<Array<{ id: number; key: string; module: string }>>([]);
  const [loading, setLoading] = useState(true);

  // Form states
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [department, setDepartment] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [country, setCountry] = useState('');
  const [roleId, setRoleId] = useState<string>('');
  const [adminResetPassword, setAdminResetPassword] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [apiDisabled, setApiDisabled] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [ipAllowText, setIpAllowText] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [overridePermId, setOverridePermId] = useState('');
  const [overrideGranted, setOverrideGranted] = useState('true');
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    desc: string;
    action: () => Promise<void>;
    destructive?: boolean;
  } | null>(null);

  const loadDetail = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiRequest<UserDetailAggregate>(`/users/${userId}`);
      setData(res);
      setDisplayName(res.user.displayName);
      setPhone(res.user.phone);
      setDepartment(res.user.department);
      setJobTitle(res.user.jobTitle);
      setCountry(res.user.country);
      setRoleId(res.user.roleId ? String(res.user.roleId) : '');
      setTagsText((res.user.tags || []).join(', '));
      setApiDisabled(Boolean(res.user.restrictions?.apiDisabled));
      setReadOnly(Boolean(res.user.restrictions?.readOnly));
      setIpAllowText((res.user.restrictions?.ipAllowlist || []).join(', '));
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load user profile',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  }, [userId, pushToast]);

  useEffect(() => {
    void loadDetail();
    if (hasPerm('roles.read')) {
      void apiRequest<{
        roles: Array<{ id: number; name: string }>;
        permissions: Array<{ id: number; key: string; module: string }>;
      }>('/roles')
        .then((res) => {
          setRolesList(res.roles);
          setAllPerms(res.permissions);
        })
        .catch(() => {});
    }
  }, [loadDetail, hasPerm]);

  const saveProfile = async (payload: Record<string, unknown>) => {
    try {
      await apiRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      pushToast({ type: 'success', title: 'User record updated' });
      await loadDetail();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const changeStatus = async (status: string) => {
    await apiRequest(`/users/${userId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
    pushToast({ type: 'success', title: `Account marked ${status}` });
    await loadDetail();
  };

  const forceLogout = async () => {
    await apiRequest(`/users/${userId}/force-logout`, { method: 'POST' });
    pushToast({ type: 'success', title: 'All active sessions revoked' });
    await loadDetail();
  };

  const addNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!noteInput.trim()) return;
    await apiRequest(`/users/${userId}/notes`, {
      method: 'POST',
      body: JSON.stringify({ note: noteInput }),
    });
    setNoteInput('');
    pushToast({ type: 'success', title: 'Internal note added' });
    await loadDetail();
  };

  const applyPermissionOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!overridePermId) return;
    await apiRequest(`/users/${userId}/permissions`, {
      method: 'POST',
      body: JSON.stringify({
        permissionId: Number(overridePermId),
        granted: overrideGranted === 'null' ? null : overrideGranted === 'true',
      }),
    });
    pushToast({ type: 'success', title: 'User permission override updated' });
    await loadDetail();
  };

  if (loading || !data) {
    return (
      <div className="space-y-4">
        <div className="h-10 w-48 animate-pulse rounded-lg bg-slate-200 dark:bg-slate-800" />
        <div className="h-64 animate-pulse rounded-xl bg-white dark:bg-slate-900" />
      </div>
    );
  }

  const u = data.user;

  return (
    <div className="space-y-6">
      {/* Header + Critical Account Controls */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to users list"
            className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
              {u.displayName || u.email}
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              {u.email} · {u.roleName || 'Unassigned'} · Status: {u.status} ·{' '}
              {data.isOnline ? 'Online now' : 'Offline'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {hasPerm('users.suspend') && (
            <>
              <button
                type="button"
                onClick={() =>
                  setConfirmAction({
                    title: 'Force Logout User',
                    desc: `Revoke all active sessions for ${u.email}?`,
                    action: forceLogout,
                  })
                }
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                <LogOut className="h-3.5 w-3.5" />
                Force Logout
              </button>

              {u.status !== 'active' ? (
                <button
                  type="button"
                  onClick={() => void changeStatus('active')}
                  className="h-9 rounded-lg bg-emerald-600 px-3 text-xs font-medium text-white hover:bg-emerald-700"
                >
                  Activate / Restore
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setConfirmAction({
                      title: 'Suspend Account',
                      desc: `Suspend ${u.email} and terminate active sessions?`,
                      destructive: true,
                      action: () => changeStatus('suspended'),
                    })
                  }
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-3 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
                >
                  <ShieldAlert className="h-3.5 w-3.5" />
                  Suspend
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  setConfirmAction({
                    title: 'Ban Account',
                    desc: `Permanently ban ${u.email} from accessing the platform?`,
                    destructive: true,
                    action: () => changeStatus('banned'),
                  })
                }
                className="h-9 rounded-lg border border-red-300 bg-red-50 px-3 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
              >
                Ban
              </button>
            </>
          )}

          {hasPerm('users.delete') && u.status !== 'deleted' && (
            <button
              type="button"
              onClick={() =>
                setConfirmAction({
                  title: 'Delete User Account',
                  desc: `Soft-delete ${u.email}? You can restore the account from Deleted Users later.`,
                  destructive: true,
                  action: () => changeStatus('deleted'),
                })
              }
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </button>
          )}
        </div>
      </div>

      {/* 14-Tab Navigation */}
      <div
        role="tablist"
        aria-label="User detail sections"
        className="flex items-center gap-1 overflow-x-auto border-b border-slate-200 pb-1 dark:border-slate-800"
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            onClick={() => setActiveTab(tab)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              activeTab === tab
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        {activeTab === 'Overview' && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div>
              <p className="text-slate-500">Account ID / UID</p>
              <p className="mt-1 font-mono text-slate-900 dark:text-slate-100">
                #{u.id} · {u.uid.slice(0, 14)}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Role & Verification</p>
              <p className="mt-1 text-slate-900 dark:text-slate-100">
                {u.roleName || 'Unassigned'} · {u.emailVerified ? 'Verified' : 'Unverified'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Last Login & IP</p>
              <p className="mt-1 font-mono tabular-nums text-slate-900 dark:text-slate-100">
                {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'} · {u.lastIp || 'N/A'}
              </p>
            </div>
            <div>
              <p className="text-slate-500">Two-Factor Auth</p>
              <p className="mt-1 text-slate-900 dark:text-slate-100">
                {u.twoFactorEnabled ? 'Enabled (TOTP)' : 'Not Enrolled'}
              </p>
            </div>
          </div>
        )}

        {activeTab === 'Personal Information' && (
          <div className="max-w-xl space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Display Name
                </label>
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Phone
                </label>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Department
                </label>
                <input
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Job Title
                </label>
                <input
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Country
                </label>
                <input
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  User Tags (comma-separated)
                </label>
                <input
                  value={tagsText}
                  onChange={(e) => setTagsText(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            {hasPerm('users.write') && (
              <button
                type="button"
                onClick={() =>
                  void saveProfile({
                    displayName,
                    phone,
                    department,
                    jobTitle,
                    country,
                    tags: tagsText
                      .split(',')
                      .map((t) => t.trim())
                      .filter(Boolean),
                  })
                }
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
              >
                <Save className="h-3.5 w-3.5" />
                Save Personal Info
              </button>
            )}
          </div>
        )}

        {activeTab === 'Account Settings' && (
          <div className="max-w-md space-y-6">
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                  Assigned RBAC Role
                </label>
                <select
                  value={roleId}
                  onChange={(e) => setRoleId(e.target.value)}
                  disabled={!hasPerm('roles.manage')}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="">Unassigned</option>
                  {rolesList.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </div>
              {hasPerm('roles.manage') && (
                <button
                  type="button"
                  onClick={() => void saveProfile({ roleId: roleId ? Number(roleId) : null })}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white"
                >
                  <Save className="h-3.5 w-3.5" />
                  Update Role
                </button>
              )}
            </div>

            {hasPerm('users.write') && (
              <div className="space-y-3 border-t border-slate-200 pt-5 dark:border-slate-800">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
                    Set Temporary / Replacement Password
                  </label>
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Used when automated email delivery is unconfigured. Requires 12+ characters with mixed case, number, and symbol.
                  </p>
                  <input
                    type="password"
                    value={adminResetPassword}
                    onChange={(e) => setAdminResetPassword(e.target.value)}
                    placeholder="Enter new strong password..."
                    className="mt-2 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <button
                  type="button"
                  disabled={!adminResetPassword}
                  onClick={async () => {
                    await saveProfile({ newPassword: adminResetPassword });
                    setAdminResetPassword('');
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-900 px-4 py-2 text-xs font-medium text-white disabled:opacity-50 dark:border-slate-700 dark:bg-slate-100 dark:text-slate-900"
                >
                  <Save className="h-3.5 w-3.5" />
                  Set Password
                </button>
              </div>
            )}
          </div>
        )}

        {activeTab === 'Activity' && (
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.activityHistory.length === 0 ? (
              <li className="py-6 text-center text-slate-500">No recorded user actions yet.</li>
            ) : (
              data.activityHistory.map((a) => (
                <li key={a.id} className="flex justify-between py-2.5">
                  <span>
                    {a.action} · {a.module} ({a.status})
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}

        {(activeTab === 'Login History' || activeTab === 'Devices' || activeTab === 'Sessions') && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2">Device</th>
                  <th className="py-2">Browser / OS</th>
                  <th className="py-2">IP Address</th>
                  <th className="py-2">State</th>
                  <th className="py-2 text-right">Last Activity</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.sessions.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-6 text-center text-slate-500">
                      No recorded sessions or devices.
                    </td>
                  </tr>
                ) : (
                  data.sessions.map((s) => (
                    <tr key={s.id}>
                      <td className="py-2.5 font-medium">{s.deviceName}</td>
                      <td className="py-2.5">
                        {s.browser} · {s.os}
                      </td>
                      <td className="py-2.5 font-mono">{s.ipAddress || 'Unknown'}</td>
                      <td className="py-2.5">{s.isActive ? 'Active' : 'Revoked'}</td>
                      <td className="py-2.5 text-right font-mono tabular-nums text-slate-400">
                        {new Date(s.lastActivityAt).toLocaleString()}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {activeTab === 'Notifications' && (
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.notifications.length === 0 ? (
              <li className="py-6 text-center text-slate-500">No user-specific notifications.</li>
            ) : (
              data.notifications.map((n) => (
                <li key={n.id} className="flex justify-between py-2.5">
                  <span>
                    {n.title} · {n.channel} ({n.status})
                  </span>
                  <span className="font-mono tabular-nums text-slate-400">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}

        {activeTab === 'Permissions' && (
          <div className="space-y-4">
            {hasPerm('roles.manage') && (
              <form onSubmit={applyPermissionOverride} className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="block text-xs text-slate-500">Permission</label>
                  <select
                    value={overridePermId}
                    onChange={(e) => setOverridePermId(e.target.value)}
                    className="mt-1 h-9 rounded-lg border border-slate-200 px-2.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">Select permission...</option>
                    {allPerms.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.key}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-500">Override</label>
                  <select
                    value={overrideGranted}
                    onChange={(e) => setOverrideGranted(e.target.value)}
                    className="mt-1 h-9 rounded-lg border border-slate-200 px-2.5 text-xs dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="true">Explicit Grant</option>
                    <option value="false">Explicit Deny</option>
                    <option value="null">Remove Override</option>
                  </select>
                </div>
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-blue-600 px-3 text-xs font-medium text-white"
                >
                  Apply Override
                </button>
              </form>
            )}
            <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.overrides.length === 0 ? (
                <li className="py-4 text-slate-500">No user-specific permission overrides; inherits role permissions.</li>
              ) : (
                data.overrides.map((o) => (
                  <li key={o.id} className="flex justify-between py-2">
                    <span className="font-mono">{o.permissionKey}</span>
                    <span>{o.granted ? 'Granted' : 'Denied'}</span>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {activeTab === 'Restrictions' && (
          <div className="max-w-md space-y-4 text-xs">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={apiDisabled}
                onChange={(e) => setApiDisabled(e.target.checked)}
              />
              <span>Disable API Access</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={readOnly}
                onChange={(e) => setReadOnly(e.target.checked)}
              />
              <span>Enforce Read-Only Mode</span>
            </label>
            <div>
              <label className="block text-slate-500">User-Specific IP Allowlist (comma-separated)</label>
              <input
                value={ipAllowText}
                onChange={(e) => setIpAllowText(e.target.value)}
                placeholder="10.0.0.1, 192.168.1.*"
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            {hasPerm('users.write') && (
              <button
                type="button"
                onClick={() =>
                  void saveProfile({
                    restrictions: {
                      apiDisabled,
                      readOnly,
                      ipAllowlist: ipAllowText
                        .split(',')
                        .map((x) => x.trim())
                        .filter(Boolean),
                    },
                  })
                }
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white"
              >
                Save Restrictions
              </button>
            )}
          </div>
        )}

        {activeTab === 'Transactions' && (
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.transactions.length === 0 ? (
              <li className="py-6 text-center text-slate-500">No financial transactions for this user.</li>
            ) : (
              data.transactions.map((t) => (
                <li key={t.id} className="flex justify-between py-2.5 font-mono">
                  <span>
                    {t.reference} · {(t.amountCents / 100).toFixed(2)} {t.currency} ({t.status})
                  </span>
                  <span className="text-slate-400">{new Date(t.createdAt).toLocaleDateString()}</span>
                </li>
              ))
            )}
          </ul>
        )}

        {activeTab === 'Support History' && (
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.tickets.length === 0 ? (
              <li className="py-6 text-center text-slate-500">No support tickets opened by this user.</li>
            ) : (
              data.tickets.map((t) => (
                <li key={t.id} className="flex justify-between py-2.5">
                  <span>
                    {t.ticketNumber} · {t.subject} ({t.status})
                  </span>
                  <span className="font-mono text-slate-400">
                    {new Date(t.createdAt).toLocaleDateString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}

        {activeTab === 'Internal Notes' && (
          <div className="space-y-4">
            {hasPerm('users.write') && (
              <form onSubmit={addNote} className="flex gap-2">
                <input
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  placeholder="Add an internal compliance or support note..."
                  className="h-9 flex-1 rounded-lg border border-slate-200 px-3 text-xs dark:border-slate-700 dark:bg-slate-950"
                />
                <button
                  type="submit"
                  className="h-9 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white"
                >
                  Add Note
                </button>
              </form>
            )}
            <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {data.notes.length === 0 ? (
                <li className="py-4 text-slate-500">No internal notes recorded.</li>
              ) : (
                data.notes.map((n) => (
                  <li key={n.id} className="py-2.5">
                    <p className="text-slate-900 dark:text-slate-100">{n.note}</p>
                    <p className="mt-1 text-[11px] text-slate-400">
                      By {n.authorEmail || 'Admin'} · {new Date(n.createdAt).toLocaleString()}
                    </p>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {activeTab === 'Audit History' && (
          <ul className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
            {data.auditHistory.length === 0 ? (
              <li className="py-6 text-center text-slate-500">No audit records targeting this user.</li>
            ) : (
              data.auditHistory.map((a) => (
                <li key={a.id} className="flex justify-between py-2.5">
                  <span>
                    {a.action} by {a.actorEmail} ({a.status})
                  </span>
                  <span className="font-mono text-slate-400">
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={confirmAction?.title || ''}
        description={confirmAction?.desc || ''}
        destructive={confirmAction?.destructive}
        onConfirm={() => {
          const fn = confirmAction?.action;
          setConfirmAction(null);
          if (fn) void fn();
        }}
        onCancel={() => setConfirmAction(null)}
      />
    </div>
  );
};
