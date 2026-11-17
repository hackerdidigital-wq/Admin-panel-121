import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Database, Download, ShieldCheck, Trash2, Upload } from 'lucide-react';
import { apiRequest, downloadWithAuth } from '../lib/api';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAuth } from '../contexts/AuthContext';

export const DatabaseManagementPage: React.FC<{ subview: string }> = () => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [tables, setTables] = useState<
    Array<{ table_name: string; estimated_rows: number; total_size_bytes?: number }>
  >([]);
  const [backups, setBackups] = useState<
    Array<{
      id: number;
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

  const loadDb = useCallback(async () => {
    const res = await apiRequest<{ tables: typeof tables; backups: typeof backups }>('/database/overview');
    setTables(res.tables);
    setBackups(res.backups);
  }, []);

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
        { method: 'POST' }
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
    const res = await apiRequest<{ valid: boolean }>(`/database/backups/${id}/verify`, {
      method: 'POST',
    });
    pushToast({
      type: res.valid ? 'success' : 'error',
      title: res.valid ? 'Backup SHA-256 checksum verified' : 'Backup integrity mismatch',
    });
    await loadDb();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">Database & Backup Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Cloudflare D1 SQLite table statistics, restricted Super Admin record browser, and SHA-256 verified backups.
          </p>
        </div>
        {hasPerm('database.inspect') && (
          <button
            type="button"
            disabled={creatingBackup}
            onClick={() => void createBackup()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white disabled:opacity-50"
          >
            <Database className="h-3.5 w-3.5" />
            {creatingBackup ? 'Backing up...' : 'Create Verified Backup'}
          </button>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-12">
        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-5 dark:border-slate-800 dark:bg-slate-900">
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

        <section className="rounded-xl border border-slate-200 bg-white p-5 lg:col-span-7 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-display text-sm font-semibold mb-3">Verified Backup History</h2>
          {backups.length === 0 ? (
            <p className="py-6 text-center text-xs text-slate-500">
              No backups created yet. Only Super Admins can generate and verify database snapshots.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {backups.map((b) => (
                <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-mono font-medium">{b.filename}</p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {b.rowCount} rows · {(b.sizeBytes / 1024).toFixed(1)} KB · SHA256:{' '}
                      {b.checksumSha256.slice(0, 12)}...
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      {b.status}
                    </span>
                    {hasPerm('database.inspect') && (
                      <>
                        <button
                          type="button"
                          onClick={() => void verifyBackup(b.id)}
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                        >
                          <ShieldCheck className="inline h-3.5 w-3.5 mr-1" />
                          Verify
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            void downloadWithAuth(`/database/backups/${b.id}/download`, b.filename)
                          }
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                        >
                          <Download className="inline h-3.5 w-3.5" />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {hasPerm('database.inspect') && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <h2 className="font-display text-sm font-semibold">Restricted Record Inspector (Super Admin Only)</h2>
            <div className="flex items-center gap-2">
              <select
                value={selectedTable}
                onChange={(e) => void inspectTable(e.target.value)}
                className="h-8 rounded border border-slate-200 px-2 text-xs font-mono dark:border-slate-700 dark:bg-slate-950"
              >
                {(tables.length > 0
                  ? tables.map((t) => t.table_name)
                  : [
                      'users',
                      'roles',
                      'content_items',
                      'support_tickets',
                      'transactions',
                      'feature_flags',
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
    </div>
  );
};

export const FilesManagementPage: React.FC<{ subview: string }> = ({ subview }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const [files, setFiles] = useState<
    Array<{
      id: number;
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

  const loadFiles = useCallback(async () => {
    const qs = new URLSearchParams();
    if (subview === 'files-images') qs.set('category', 'image');
    if (subview === 'files-documents') qs.set('category', 'document');
    if (subview === 'files-unused') qs.set('unused', 'true');
    const res = await apiRequest<{ data: typeof files; totalBytes: number }>(`/files?${qs.toString()}`);
    setFiles(res.data);
    setTotalBytes(res.totalBytes);
  }, [subview]);

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
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold">File & Media Management</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Total Storage Used: {(totalBytes / 1024).toFixed(1)} KB across {files.length} verified asset(s).
          </p>
        </div>
        {hasPerm('files.write') && (
          <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700">
            <Upload className="h-3.5 w-3.5" />
            <span>Upload File (Max 750 KB)</span>
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
                  {f.mimeType} · {(f.sizeBytes / 1024).toFixed(1)} KB · SHA256:{' '}
                  {f.checksumSha256.slice(0, 12)}...
                </p>
              </div>
              <div className="flex items-center gap-2">
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

      <ConfirmDialog
        open={deleteTargetId !== null}
        title="Safely Delete File"
        description="Remove this stored asset payload from Cloudflare D1 and mark its metadata record deleted?"
        destructive
        onConfirm={async () => {
          if (deleteTargetId !== null) {
            await apiRequest(`/files/${deleteTargetId}`, { method: 'DELETE' });
            pushToast({ type: 'success', title: 'File deleted' });
            setDeleteTargetId(null);
            await loadFiles();
          }
        }}
        onCancel={() => setDeleteTargetId(null)}
      />
    </div>
  );
};
