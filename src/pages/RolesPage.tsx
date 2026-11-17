import React, { useCallback, useEffect, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { apiRequest } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/common/Toast';

interface RoleRecord {
  id: number;
  slug: string;
  name: string;
  description: string;
  hierarchyLevel: number;
  isSystem: boolean;
  permissionIds: number[];
}

interface PermissionRecord {
  id: number;
  key: string;
  module: string;
  page: string;
  action: string;
  description: string;
}

export const RolesPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [permissions, setPermissions] = useState<PermissionRecord[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<number | null>(null);
  const [draftPermIds, setDraftPermIds] = useState<number[]>([]);
  const [showNewRole, setShowNewRole] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newLevel, setNewLevel] = useState(35);

  const loadRoles = useCallback(async () => {
    try {
      const res = await apiRequest<{ roles: RoleRecord[]; permissions: PermissionRecord[] }>('/roles');
      setRoles(res.roles);
      setPermissions(res.permissions);
      if (res.roles.length > 0 && !selectedRoleId) {
        setSelectedRoleId(res.roles[0].id);
        setDraftPermIds(res.roles[0].permissionIds);
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load RBAC matrix',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [selectedRoleId, pushToast]);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const activeRole = roles.find((r) => r.id === selectedRoleId) || null;

  const selectRole = (r: RoleRecord) => {
    setSelectedRoleId(r.id);
    setDraftPermIds(r.permissionIds);
  };

  const togglePerm = (permId: number) => {
    if (!activeRole || activeRole.slug === 'super_admin' || !hasPerm('roles.manage')) return;
    setDraftPermIds((prev) =>
      prev.includes(permId) ? prev.filter((id) => id !== permId) : [...prev, permId]
    );
  };

  const saveMatrix = async () => {
    if (!activeRole) return;
    try {
      await apiRequest(`/roles/${activeRole.id}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissionIds: draftPermIds }),
      });
      pushToast({ type: 'success', title: `Updated permissions for ${activeRole.name}` });
      await loadRoles();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Save failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const createRole = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await apiRequest('/roles', {
        method: 'POST',
        body: JSON.stringify({
          name: newName,
          description: newDesc,
          hierarchyLevel: newLevel,
          permissionIds: [],
        }),
      });
      pushToast({ type: 'success', title: 'Custom role created' });
      setShowNewRole(false);
      setNewName('');
      setNewDesc('');
      await loadRoles();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Create role failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const filteredRoles =
    subview === 'roles-system'
      ? roles.filter((r) => r.isSystem)
      : subview === 'roles-custom'
        ? roles.filter((r) => !r.isSystem)
        : roles;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Roles & Granular RBAC Permissions
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Server-enforced Role-Based Access Control across modules, pages, and actions.
          </p>
        </div>
        {hasPerm('roles.manage') && (
          <button
            type="button"
            onClick={() => setShowNewRole(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New Custom Role
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <div className="space-y-2 lg:col-span-4">
          {filteredRoles.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => selectRole(r)}
              className={`w-full rounded-xl border p-4 text-left transition-colors ${
                selectedRoleId === r.id
                  ? 'border-blue-600 bg-blue-50/60 dark:border-blue-500 dark:bg-blue-950/30'
                  : 'border-slate-200 bg-white hover:border-slate-300 dark:border-slate-800 dark:bg-slate-900'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {r.name}
                </span>
                <span className="font-mono text-xs text-slate-500">
                  Lvl {r.hierarchyLevel} · {r.isSystem ? 'System' : 'Custom'}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{r.description}</p>
            </button>
          ))}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-8 dark:border-slate-800 dark:bg-slate-900">
          {activeRole ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4 dark:border-slate-800">
                <div>
                  <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                    Permission Matrix: {activeRole.name}
                  </h2>
                  <p className="text-xs text-slate-500">
                    {activeRole.slug === 'super_admin'
                      ? 'Super Admin retains all system permissions.'
                      : `${draftPermIds.length} of ${permissions.length} permissions enabled`}
                  </p>
                </div>
                {hasPerm('roles.manage') && activeRole.slug !== 'super_admin' && (
                  <button
                    type="button"
                    onClick={() => void saveMatrix()}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
                  >
                    <Save className="h-3.5 w-3.5" />
                    Save Matrix
                  </button>
                )}
              </div>

              <div className="mt-4 max-h-[540px] divide-y divide-slate-100 overflow-y-auto dark:divide-slate-800">
                {permissions.map((perm) => {
                  const checked = draftPermIds.includes(perm.id);
                  return (
                    <label
                      key={perm.id}
                      className="flex cursor-pointer items-center justify-between gap-4 py-2.5 text-xs"
                    >
                      <div>
                        <p className="font-mono font-medium text-slate-900 dark:text-slate-100">
                          {perm.key}
                        </p>
                        <p className="text-slate-500 dark:text-slate-400">
                          {perm.module} / {perm.page} ({perm.action}) · {perm.description}
                        </p>
                      </div>
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={activeRole.slug === 'super_admin' || !hasPerm('roles.manage')}
                        onChange={() => togglePerm(perm.id)}
                      />
                    </label>
                  );
                })}
              </div>
            </>
          ) : (
            <p className="py-12 text-center text-xs text-slate-500">Select a role to inspect permissions.</p>
          )}
        </div>
      </div>

      {showNewRole && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4"
        >
          <form
            onSubmit={createRole}
            className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-base font-semibold">Create Custom Role</h2>
            <div className="mt-4 space-y-3 text-xs">
              <div>
                <label className="block font-medium">Role Name *</label>
                <input
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Description</label>
                <input
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Hierarchy Level (1–90)</label>
                <input
                  type="number"
                  min={1}
                  max={90}
                  value={newLevel}
                  onChange={(e) => setNewLevel(Number(e.target.value))}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowNewRole(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium dark:border-slate-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white"
              >
                Create Role
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
