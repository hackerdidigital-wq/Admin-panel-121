import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Database, Download, Eye, RotateCcw, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAppScope } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';

export const DatabaseManagementPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { appQueryParam, selectedApp } = useAppScope();
  const { pushToast } = useToast();
  const [tables, setTables] = useState<
    Array<{ table_name: string; estimated_rows: number; total_size_bytes?: number }>
  >([]);
  const [backups, setBackups] = useState<
    Array<{
      id: number;
      appId?: number | null;
      filename: string;
      status: string;
      sizeBytes: number;
      checksumSha256: string;
      rowCount: number;
      createdAt: string;
    }>
  >([]);
  const [selectedTable, setSelectedTable] = useState('users');
  const [inspectedRows, setInspectedRows] = useState<Record<string, unknown>[]>([]);
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);

  const loadDb = useCallback(async () => {
    try {
      const qs = appQueryParam ? `?appId=${encodeURIComponent(appQueryParam)}` : '';
      const res = await apiRequest<{ tables: typeof tables; backups: typeof backups }>(
        `/database/overview${qs}`
      );
      setTables(res.tables);
      setBackups(res.backups);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Database overview failed to load',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [appQueryParam, pushToast]);

  useEffect(() => {
    void loadDb();
  }, [loadDb]);

  const inspectTable = async (tableName: string) => {
    setSelectedTable(tableName);
    try {
      const res = await apiRequest<{ rows: Record<string, unknown>[] }>(
        `/database/records/${tableName}`
      );
      setInspectedRows(res.rows);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Inspection restricted',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const createBackup = async () => {
    setCreatingBackup(true);
    try {
      const res = await apiRequest<{ backup: { filename: string; rowCount: number } }>(
        '/database/backups',
        {
          method: 'POST',
          body: JSON.stringify({ appId: selectedApp ? selectedApp.id : null }),
        }
      );
      pushToast({
        type: 'success',
        title: 'Backup created and SHA-256 verified',
        description: `${res.backup.filename} (${res.backup.rowCount} rows)`,
      });
      await loadDb();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Backup failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setCreatingBackup(false);
    }
  };

  const verifyBackup = async (id: number) => {
    try {
      const res = await apiRequest<{ valid: boolean }>(`/database/backups/${id}/verify`, {
        method: 'POST',
      });
      pushToast({
        type: res.valid ? 'success' : 'error',
        title: res.valid ? 'Backup SHA-256 checksum verified' : 'Backup integrity mismatch',
      });
      await loadDb();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Backup verification failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const restoreBackup = async (id: number) => {
    setRestoring(true);
    try {
      const res = await apiRequest<{ restoredRows: number; restoredTables: string[] }>(
        `/database/backups/${id}/restore`,
        {
          method: 'POST',
          body: JSON.stringify({ mode: 'replace' }),
        }
      );
      pushToast({
        type: 'success',
        title: 'Snapshot restored cleanly',
        description: `Restored ${res.restoredRows} row(s) across ${res.restoredTables.length} table(s).`,
      });
      setRestoreTargetId(null);
      await loadDb();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Backup restore failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRestoring(false);
    }
  };

  const handleJsonSnapshotRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const snapshotData = JSON.parse(text) as Record<string, unknown>;
      const res = await apiRequest<{ restoredRows: number; restoredTables: string[] }>(
        '/database/restore',
        {
          method: 'POST',
          body: JSON.stringify({
            mode: 'merge',
            appId: selectedApp ? selectedApp.id : null,
            snapshotData,
          }),
        }
      );
      pushToast({
        type: 'success',
        title: 'JSON snapshot imported cleanly',
        description: `Merged ${res.restoredRows} row(s) into Cloudflare D1.`,
      });
      await loadDb();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Snapshot import failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      e.target.value = '';
    }
  };

  const showTables = subview === 'database-overview' || subview === 'database-tables' || subview === 'database-status';
  const showBackups = subview === 'database-overview' || subview === 'database-backups' || subview === 'database-retention';
  const showInspector = subview === 'database-overview' || subview === 'database-records';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">Database & Backup Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selectedApp
              ? `Cloudflare D1 SQLite (${tables.length} tables) · Backup scope: ${selectedApp.name}`
              : `Cloudflare D1 SQLite (${tables.length} tables), Super Admin record inspector, and SHA-256 verified backup & restore.`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {hasPerm('database.restore') && (
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
              <Upload className="h-3.5 w-3.5" />
              <span>Restore from JSON</span>
              <input
                type="file"
                accept="application/json,.json"
                onChange={handleJsonSnapshotRestore}
                className="hidden"
              />
            </label>
          )}
          {hasPerm('database.inspect') && (
            <button
              type="button"
              disabled={creatingBackup}
              onClick={() => void createBackup()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Database className="h-3.5 w-3.5" />
              {creatingBackup
                ? 'Backing up...'
                : selectedApp
                  ? `Backup ${selectedApp.name}`
                  : 'Create Full Backup'}
            </button>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        {showTables && (
          <section className={`rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 ${showBackups ? 'lg:col-span-5' : 'lg:col-span-12'}`}>
            <h2 className="font-display text-sm font-semibold mb-3">Cloudflare D1 Tables ({tables.length})</h2>
            <div className="max-h-96 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
              {tables.map((t) => (
                <div key={t.table_name} className="flex items-center justify-between py-2">
                  <span className="font-mono font-medium">{t.table_name}</span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {t.estimated_rows} rows
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {showBackups && (
          <section className={`rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900 ${showTables ? 'lg:col-span-7' : 'lg:col-span-12'}`}>
            <h2 className="font-display text-sm font-semibold mb-3">Verified Backup & Restore History</h2>
            {backups.length === 0 ? (
              <p className="py-6 text-center text-xs text-slate-500">
                No backups created yet for this scope. Super Admins can generate, verify, download, and restore snapshots.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
                {backups.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                    <div>
                      <p className="font-mono font-medium">{b.filename}</p>
                      <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {b.rowCount} rows · {(b.sizeBytes / 1024).toFixed(1)} KB · SHA256:{' '}
                        {b.checksumSha256.slice(0, 12)}...
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5" />
                        {b.status}
                      </span>
                      {hasPerm('database.inspect') && (
                        <>
                          <button
                            type="button"
                            onClick={() => void verifyBackup(b.id)}
                            className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                          >
                            <ShieldCheck className="inline h-3.5 w-3.5 mr-1" />
                            Verify
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              void downloadWithAuth(`/database/backups/${b.id}/download`, b.filename)
                            }
                            aria-label={`Download ${b.filename}`}
                            className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                          >
                            <Download className="inline h-3.5 w-3.5" />
                          </button>
                        </>
                      )}
                      {hasPerm('database.restore') && (
                        <button
                          type="button"
                          onClick={() => setRestoreTargetId(b.id)}
                          className="inline-flex items-center gap-1 rounded border border-amber-300 bg-amber-50 px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
                        >
                          <RotateCcw className="h-3 w-3" />
                          Restore
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>

      {showInspector && hasPerm('database.inspect') && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="font-display text-sm font-semibold">Restricted Record Inspector (Super Admin Only)</h2>
            <div className="flex items-center gap-2">
              <select
                value={selectedTable}
                onChange={(e) => void inspectTable(e.target.value)}
                aria-label="Select D1 table"
                className="h-8 rounded border border-slate-200 px-2 text-xs font-mono dark:border-slate-700 dark:bg-slate-950"
              >
                {(tables.length > 0
                  ? tables.map((t) => t.table_name)
                  : [
                      'users',
                      'connected_apps',
                      'app_users',
                      'app_api_keys',
                      'webhooks',
                      'system_settings',
                      'audit_logs',
                    ]
                ).map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void inspectTable(selectedTable)}
                className="h-8 rounded bg-slate-900 px-3 text-xs font-medium text-white dark:bg-slate-100 dark:text-slate-900"
              >
                Query Rows
              </button>
            </div>
          </div>
          {inspectedRows.length === 0 ? (
            <p className="text-xs text-slate-500">Click "Query Rows" to inspect live table records.</p>
          ) : (
            <pre className="max-h-72 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] dark:bg-slate-950">
              {JSON.stringify(inspectedRows.slice(0, 20), null, 2)}
            </pre>
          )}
        </section>
      )}

      <ConfirmDialog
        open={restoreTargetId !== null}
        title="Restore Verified Database Snapshot"
        description={
          restoring
            ? 'Restoring snapshot into Cloudflare D1...'
            : 'Restore this verified snapshot into Cloudflare D1? Your administrator password hashes and audit history remain intact while operational records are reverted to the snapshot state.'
        }
        destructive
        onConfirm={() => {
          if (restoreTargetId !== null && !restoring) {
            void restoreBackup(restoreTargetId);
          }
        }}
        onCancel={() => {
          if (!restoring) setRestoreTargetId(null);
        }}
      />
    </div>
  );
};

export const FilesManagementPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { selectedApp, appQueryParam } = useAppScope();
  const { pushToast } = useToast();
  const [files, setFiles] = useState<
    Array<{
      id: number;
      appId?: number | null;
      storageNamespace?: string;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      category: string;
      checksumSha256: string;
      usageCount: number;
      createdAt: string;
    }>
  >([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [previewItem, setPreviewItem] = useState<{ name: string; url: string } | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const qs = new URLSearchParams();
      if (subview === 'files-images') qs.set('category', 'image');
      if (subview === 'files-documents') qs.set('category', 'document');
      if (subview === 'files-unused') qs.set('unused', 'true');
      if (appQueryParam) qs.set('appId', appQueryParam);
      const res = await apiRequest<{ data: typeof files; totalBytes: number }>(`/files?${qs.toString()}`);
      setFiles(res.data);
      setTotalBytes(res.totalBytes);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load files',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [subview, appQueryParam, pushToast]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        await apiRequest('/files/upload', {
          method: 'POST',
          body: JSON.stringify({
            appId: selectedApp ? selectedApp.id : null,
            filename: file.name,
            mimeType: file.type || 'application/octet-stream',
            base64Data: reader.result,
          }),
        });
        pushToast({ type: 'success', title: `Uploaded ${file.name}` });
        await loadFiles();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Upload failed',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  const openImagePreview = async (id: number, name: string) => {
    try {
      const res = await fetch(`/api/files/${id}/download`, { credentials: 'include' });
      if (!res.ok) throw new Error('Unable to load image preview');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      setPreviewItem((prev) => {
        if (prev?.url) URL.revokeObjectURL(prev.url);
        return { name, url };
      });
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Preview failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">File & Media Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            {selectedApp ? `Namespace: ${selectedApp.backendNamespace || selectedApp.slug} · ` : 'Global + All Apps · '}
            Total Storage Used: {(totalBytes / 1024).toFixed(1)} KB across {files.length} verified asset(s).
          </p>
        </div>
        {hasPerm('files.write') && (
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700">
            <Upload className="h-3.5 w-3.5" />
            <span>{selectedApp ? `Upload to ${selectedApp.name}` : 'Upload File (Max 750 KB)'}</span>
            <input type="file" onChange={handleFileUpload} className="hidden" />
          </label>
        )}
      </div>

      <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
        {files.length === 0 ? (
          <p className="p-8 text-center text-xs text-slate-500">No uploaded files match this view.</p>
        ) : (
          files.map((f) => (
            <div key={f.id} className="flex items-center justify-between gap-4 p-4 text-xs">
              <div>
                <p className="font-medium text-slate-900 dark:text-slate-100">{f.originalName}</p>
                <p className="font-mono text-[11px] text-slate-500">
                  {f.storageNamespace || 'global'} · {f.mimeType} · {(f.sizeBytes / 1024).toFixed(1)} KB · SHA256:{' '}
                  {f.checksumSha256.slice(0, 12)}...
                </p>
              </div>
              <div className="flex items-center gap-2">
                {f.mimeType.startsWith('image/') && (
                  <button
                    type="button"
                    onClick={() => void openImagePreview(f.id, f.originalName)}
                    aria-label={`Preview ${f.originalName}`}
                    className="rounded border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    <Eye className="h-3.5 w-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void downloadWithAuth(`/files/${f.id}/download`, f.originalName)}
                  aria-label={`Download ${f.originalName}`}
                  className="rounded border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                {hasPerm('files.delete') && (
                  <button
                    type="button"
                    onClick={() => setDeleteTargetId(f.id)}
                    aria-label={`Delete ${f.originalName}`}
                    className="rounded border border-red-200 p-1.5 text-red-600 hover:bg-red-50 dark:border-red-900"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {previewItem && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
        >
          <div className="max-w-xl rounded-xl border border-slate-200 bg-white p-5 shadow-xl dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold">{previewItem.name}</h2>
            <img
              src={previewItem.url}
              alt={previewItem.name}
              className="mt-3 max-h-[60vh] rounded-lg border border-slate-200 object-contain dark:border-slate-800"
            />
            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => {
                  URL.revokeObjectURL(previewItem.url);
                  setPreviewItem(null);
                }}
                className="rounded-lg border border-slate-200 px-4 py-1.5 text-xs font-medium dark:border-slate-700"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTargetId !== null}
        title="Safely Delete File"
        description="Remove this stored asset payload from Cloudflare D1 and mark its metadata record deleted?"
        destructive
        onConfirm={async () => {
          if (deleteTargetId !== null) {
            try {
              await apiRequest(`/files/${deleteTargetId}`, { method: 'DELETE' });
              pushToast({ type: 'success', title: 'File deleted' });
              setDeleteTargetId(null);
              await loadFiles();
            } catch (err) {
              pushToast({
                type: 'error',
                title: 'Delete failed',
                description: err instanceof Error ? err.message : undefined,
              });
            }
          }
        }}
        onCancel={() => setDeleteTargetId(null)}
      />
    </div>
  );
};
