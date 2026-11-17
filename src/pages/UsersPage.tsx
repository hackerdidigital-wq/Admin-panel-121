import React, { useCallback, useEffect, useState } from 'react';
import { Download, Plus, Upload, UserCheck, Users } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { DataTable, type TableColumn } from '../components/common/DataTable';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../contexts/AuthContext';

interface UserRow {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  department: string;
  jobTitle: string;
  roleId: number | null;
  roleName: string | null;
  status: string;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  lastSeenAt: string | null;
  createdAt: string;
}

interface RoleOption {
  id: number;
  name: string;
  slug: string;
}

export const UsersPage: React.FC<{
  subview: string;
  onOpenUser: (userId: number) => void;
}> = ({ subview, onOpenUser }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();

  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [onlineIds, setOnlineIds] = useState<number[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Array<string | number>>([]);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [rolesList, setRolesList] = useState<RoleOption[]>([]);
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDept, setNewDept] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newRoleId, setNewRoleId] = useState<string>('');
  const [creating, setCreating] = useState(false);

  // Import CSV panel
  const [importCsvText, setImportCsvText] = useState('');
  const [importing, setImporting] = useState(false);

  // Bulk confirm
  const [bulkConfirm, setBulkConfirm] = useState<{ action: string; label: string } | null>(null);

  const segmentQuery =
    subview === 'users-active'
      ? 'active'
      : subview === 'users-inactive'
        ? 'inactive'
        : subview === 'users-suspended'
          ? 'suspended'
          : subview === 'users-banned'
            ? 'banned'
            : subview === 'users-deleted'
              ? 'deleted'
              : subview === 'users-online'
                ? 'online'
                : subview === 'users-new'
                  ? 'new'
                  : 'all';

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        search,
        sortBy,
        sortDir,
        segment: segmentQuery,
      });
      const res = await apiRequest<{
        data: UserRow[];
        total: number;
        onlineUserIds?: number[];
        onlineIds?: number[];
      }>(`/users?${qs.toString()}`);
      setRows(res.data);
      setTotal(res.total);
      setOnlineIds(res.onlineUserIds ?? res.onlineIds ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, sortBy, sortDir, segmentQuery]);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  useEffect(() => {
    if (!hasPerm('roles.read')) return;
    void apiRequest<{ roles: RoleOption[] }>('/roles')
      .then((res) => setRolesList(res.roles))
      .catch(() => {});
  }, [hasPerm]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    try {
      await apiRequest('/users', {
        method: 'POST',
        body: JSON.stringify({
          email: newEmail,
          displayName: newName,
          ...(newPassword ? { password: newPassword } : {}),
          department: newDept,
          jobTitle: newTitle,
          roleId: newRoleId ? Number(newRoleId) : null,
        }),
      });
      pushToast({ type: 'success', title: 'User record created' });
      setShowCreate(false);
      setNewEmail('');
      setNewName('');
      setNewPassword('');
      setNewDept('');
      setNewTitle('');
      await loadUsers();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Create user failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCreating(false);
    }
  };

  const handleBulkAction = async () => {
    if (!bulkConfirm) return;
    try {
      const res = await apiRequest<{ updatedCount: number }>('/users/bulk', {
        method: 'POST',
        body: JSON.stringify({ userIds: selectedIds, action: bulkConfirm.action }),
      });
      pushToast({
        type: 'success',
        title: `Updated ${res.updatedCount} user(s)`,
      });
      setSelectedIds([]);
      setBulkConfirm(null);
      await loadUsers();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Bulk action failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleImportCsv = async (e: React.FormEvent) => {
    e.preventDefault();
    setImporting(true);
    try {
      const res = await apiRequest<{ imported: number; errors: string[] }>('/users/import', {
        method: 'POST',
        body: JSON.stringify({ csvText: importCsvText }),
      });
      pushToast({
        type: res.errors.length > 0 ? 'warning' : 'success',
        title: `Imported ${res.imported} user(s)`,
        description: res.errors.length > 0 ? `${res.errors.length} row(s) skipped` : undefined,
      });
      setImportCsvText('');
      await loadUsers();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'CSV import failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setImporting(false);
    }
  };

  const verifyUser = async (userId: number, verified: boolean) => {
    try {
      await apiRequest(`/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ emailVerified: verified }),
      });
      pushToast({ type: 'success', title: verified ? 'User marked verified' : 'Verification removed' });
      await loadUsers();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  if (subview === 'users-export-import') {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Export & Import Users
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            RFC 4180 CSV export with formula-injection protection and validated bulk user import.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Export User Directory
            </h2>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Download all non-sensitive user account fields as CSV. Audited in Cloudflare D1 SQLite.
            </p>
            <button
              type="button"
              onClick={() => void downloadWithAuth('/users/export.csv', 'users-export.csv')}
              className="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700"
            >
              <Download className="h-4 w-4" />
              Download Users CSV
            </button>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
              Import Users via CSV
            </h2>
            <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
              Required column: <code className="font-mono">email</code>. Optional:{' '}
              <code className="font-mono">displayName,department,jobTitle</code>.
            </p>
            <form onSubmit={handleImportCsv} className="mt-4 space-y-3">
              <textarea
                rows={5}
                value={importCsvText}
                onChange={(e) => setImportCsvText(e.target.value)}
                placeholder="email,displayName,department,jobTitle"
                className="w-full rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-900 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-100"
              />
              <button
                type="submit"
                disabled={importing || !importCsvText.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Upload className="h-4 w-4" />
                {importing ? 'Importing...' : 'Run Bulk Import'}
              </button>
            </form>
          </section>
        </div>
      </div>
    );
  }

  const columns: TableColumn<UserRow>[] = [
    {
      key: 'displayName',
      label: 'User',
      sortable: true,
      render: (r) => (
        <div>
          <p className="font-medium text-slate-900 dark:text-slate-100">
            {r.displayName || r.email}
            {onlineIds.includes(r.id) ? ' · Online' : ''}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">{r.email}</p>
        </div>
      ),
    },
    {
      key: 'roleName',
      label: 'Role',
      render: (r) => <span>{r.roleName || 'Unassigned'}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      render: (r) => (
        <span
          className={`text-xs font-medium capitalize ${
            r.status === 'active'
              ? 'text-emerald-700 dark:text-emerald-400'
              : r.status === 'suspended'
                ? 'text-amber-700 dark:text-amber-400'
                : 'text-red-700 dark:text-red-400'
          }`}
        >
          {r.status}
        </span>
      ),
    },
    {
      key: 'emailVerified',
      label: 'Verification',
      render: (r) =>
        subview === 'users-verification' && hasPerm('users.write') ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void verifyUser(r.id, !r.emailVerified);
            }}
            className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <UserCheck className="h-3.5 w-3.5" />
            {r.emailVerified ? 'Verified (Revoke)' : 'Approve Verify'}
          </button>
        ) : (
          <span className="text-xs text-slate-600 dark:text-slate-400">
            {r.emailVerified ? 'Verified' : 'Unverified'} · 2FA {r.twoFactorEnabled ? 'On' : 'Off'}
          </span>
        ),
    },
    {
      key: 'createdAt',
      label: 'Created',
      sortable: true,
      align: 'right',
      render: (r) => (
        <span className="font-mono text-xs tabular-nums text-slate-500">
          {new Date(r.createdAt).toLocaleDateString()}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            User Management
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Click any user row to open the 14-tab Individual User Control console.
          </p>
        </div>
        {hasPerm('users.write') && (
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Provision User
          </button>
        )}
      </div>

      <DataTable<UserRow>
        tableId="users-directory"
        columns={columns}
        rows={rows}
        total={total}
        page={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => {
          setPageSize(s);
          setPage(1);
        }}
        search={search}
        onSearchChange={(val) => {
          setSearch(val);
          setPage(1);
        }}
        searchPlaceholder="Search name, email, department..."
        sortBy={sortBy}
        sortDir={sortDir}
        onSortChange={(key) => {
          if (sortBy === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
          else {
            setSortBy(key);
            setSortDir('asc');
          }
        }}
        loading={loading}
        error={error}
        onRetry={() => void loadUsers()}
        selectable={hasPerm('users.suspend')}
        selectedIds={selectedIds}
        onSelectionChange={setSelectedIds}
        onRowClick={(row) => onOpenUser(row.id)}
        emptyTitle="No users in this view"
        emptyDescription="Provision a user account above to grant access to the workspace."
        emptyAction={
          hasPerm('users.write') ? (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-medium text-white"
            >
              <Users className="h-3.5 w-3.5" />
              Provision First User
            </button>
          ) : undefined
        }
        bulkActions={
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium text-slate-600 dark:text-slate-300">
              {selectedIds.length} selected:
            </span>
            <button
              type="button"
              onClick={() => setBulkConfirm({ action: 'activate', label: 'Activate Selected' })}
              className="rounded border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            >
              Activate
            </button>
            <button
              type="button"
              onClick={() => setBulkConfirm({ action: 'suspend', label: 'Suspend Selected' })}
              className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-300"
            >
              Suspend
            </button>
            <button
              type="button"
              onClick={() => setBulkConfirm({ action: 'delete', label: 'Delete Selected' })}
              className="rounded border border-red-300 bg-red-50 px-2 py-1 text-xs font-medium text-red-700 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300"
            >
              Delete
            </button>
          </div>
        }
      />

      {/* Provision User Modal */}
      {showCreate && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <form
            onSubmit={handleCreateUser}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Provision Enterprise User
            </h2>
            <div className="mt-4 space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Email Address *
                </label>
                <input
                  required
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Full Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                  Initial Password (optional, 12+ chars w/ upper, lower, digit, symbol)
                </label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="Leave blank if non-login directory record"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Department
                  </label>
                  <input
                    type="text"
                    value={newDept}
                    onChange={(e) => setNewDept(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Job Title
                  </label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              {rolesList.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    Assigned Role
                  </label>
                  <select
                    value={newRoleId}
                    onChange={(e) => setNewRoleId(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="">Default (Support Agent)</option>
                    {rolesList.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-700 dark:border-slate-700 dark:text-slate-200"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={creating}
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {creating ? 'Provisioning...' : 'Create User'}
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(bulkConfirm)}
        title={bulkConfirm?.label || 'Bulk Action'}
        description={`Apply "${bulkConfirm?.action}" to ${selectedIds.length} selected user account(s)? This operation is logged to the immutable audit trail.`}
        confirmLabel={bulkConfirm?.label || 'Confirm'}
        destructive={bulkConfirm?.action === 'delete' || bulkConfirm?.action === 'suspend'}
        onConfirm={() => void handleBulkAction()}
        onCancel={() => setBulkConfirm(null)}
      />
    </div>
  );
};
