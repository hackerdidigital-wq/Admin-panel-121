import React, { useState } from 'react';
import { Check, Copy, FileJson, Plus, Terminal, X } from 'lucide-react';
import { useToast } from '../common/Toast';
import type { ConnectedAppRecord } from '../../contexts/AppScopeContext';
import { apiRequest } from '../../lib/api';
import {
  parseQuickConnectJson,
  sanitizeConnectionConfig,
  type QuickConnectAppCandidate,
} from '../../lib/packageSync';

interface QuickConnectApiResponse {
  sourceFormat: 'connection_json' | 'google_services_json';
  connectedCount: number;
  connected: Array<{
    app: ConnectedAppRecord;
    initialApiKey: string | null;
  }>;
  conflicts: Array<{ package_name: string; error: string }>;
}

interface ConnectAppModalProps {
  open: boolean;
  onClose: () => void;
  onConnected: (app: ConnectedAppRecord) => Promise<void> | void;
  onOpenWorkspace: (appId: number) => void;
}

const SAMPLE_CONNECTION_JSON = JSON.stringify(
  {
    app_name: 'Sample Android App',
    package_name: 'com.company.myapp',
    version_name: '1.0.0',
    version_code: 1,
    connection_config: {
      firebase_project_id: 'my-firebase-project',
      firebase_app_id: '1:123456789012:android:abc123def456',
      auth_mode: 'firebase',
      require_sdk_key: false,
    },
  },
  null,
  2
);

export const ConnectAppModal: React.FC<ConnectAppModalProps> = ({
  open,
  onClose,
  onConnected,
  onOpenWorkspace,
}) => {
  const { pushToast } = useToast();
  const [mode, setMode] = useState<'form' | 'json'>('form');
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Standard form state
  const [appName, setAppName] = useState('');
  const [packageName, setPackageName] = useState('');
  const [platform, setPlatform] = useState('android');
  const [versionName, setVersionName] = useState('1.0.0');
  const [versionCode, setVersionCode] = useState('1');
  const [connectionConfigText, setConnectionConfigText] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  // Quick JSON Connect state
  const [quickJsonText, setQuickJsonText] = useState('');
  const [quickParsed, setQuickParsed] = useState<{
    sourceFormat: 'connection_json' | 'google_services_json';
    apps: QuickConnectAppCandidate[];
  } | null>(null);
  const [quickParseError, setQuickParseError] = useState<string | null>(null);

  // Result state after successful connection
  const [resultList, setResultList] = useState<
    Array<{ app: ConnectedAppRecord; apiKey: string | null }>
  >([]);
  const [resultConflicts, setResultConflicts] = useState<
    Array<{ package_name: string; error: string }>
  >([]);

  if (!open) return null;

  const copyText = async (id: string, value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(id);
      pushToast({ type: 'success', title: `Copied ${label}` });
      setTimeout(() => setCopiedId((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      pushToast({ type: 'error', title: 'Clipboard permission denied' });
    }
  };

  const resetAll = () => {
    setAppName('');
    setPackageName('');
    setPlatform('android');
    setVersionName('1.0.0');
    setVersionCode('1');
    setConnectionConfigText('');
    setFormError(null);
    setQuickJsonText('');
    setQuickParsed(null);
    setQuickParseError(null);
    setResultList([]);
    setResultConflicts([]);
  };

  const handleClose = () => {
    resetAll();
    onClose();
  };

  const handleQuickJsonChange = (raw: string) => {
    setQuickJsonText(raw);
    if (!raw.trim()) {
      setQuickParsed(null);
      setQuickParseError(null);
      return;
    }
    const parsed = parseQuickConnectJson(raw);
    if (parsed.error || !parsed.apps || !parsed.sourceFormat) {
      setQuickParsed(null);
      setQuickParseError(parsed.error || 'Could not parse JSON.');
    } else {
      setQuickParsed({ sourceFormat: parsed.sourceFormat, apps: parsed.apps });
      setQuickParseError(null);
    }
  };

  const handleStandardSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    const trimmedName = appName.trim();
    const trimmedPkg = packageName.trim();
    if (!trimmedName) {
      setFormError('App Name is required.');
      return;
    }
    if (platform === 'android' && !trimmedPkg) {
      setFormError('Package Name (e.g. com.company.myapp) is required for Android apps.');
      return;
    }

    const connCheck = sanitizeConnectionConfig(connectionConfigText);
    if (connCheck.error) {
      setFormError(connCheck.error);
      return;
    }

    const parsedCode = Math.max(1, Math.floor(Number(versionCode) || 1));
    setSubmitting(true);
    try {
      const res = await apiRequest<{
        app: ConnectedAppRecord;
        initialApiKey: string | null;
      }>('/apps', {
        method: 'POST',
        body: JSON.stringify({
          app_name: trimmedName,
          package_name: trimmedPkg.includes('://') ? undefined : trimmedPkg,
          packageOrDomain: trimmedPkg,
          platform,
          version_name: versionName.trim() || '1.0.0',
          version_code: parsedCode,
          connection_config: connCheck.value,
          createInitialKey: true,
        }),
      });
      setResultList([{ app: res.app, apiKey: res.initialApiKey }]);
      setResultConflicts([]);
      pushToast({
        type: 'success',
        title: `Registered ${res.app.name}`,
        description: res.app.packageName || res.app.appUid,
      });
      await onConnected(res.app);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register application.';
      setFormError(message);
      pushToast({ type: 'error', title: 'Registration failed', description: message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickJsonSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickParsed || quickParsed.apps.length === 0) {
      setQuickParseError('Paste valid Connection JSON or google-services.json first.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiRequest<QuickConnectApiResponse>('/apps/quick-connect', {
        method: 'POST',
        body: JSON.stringify({ json: quickJsonText }),
      });
      setResultList(res.connected.map((c) => ({ app: c.app, apiKey: c.initialApiKey })));
      setResultConflicts(res.conflicts || []);
      if (res.connected.length > 0) {
        pushToast({
          type: 'success',
          title: `Connected ${res.connected.length} app${res.connected.length > 1 ? 's' : ''}`,
          description: res.connected.map((c) => c.app.packageName || c.app.name).join(', '),
        });
        await onConnected(res.connected[0].app);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Quick JSON connect failed.';
      setQuickParseError(message);
      pushToast({ type: 'error', title: 'Quick JSON connect failed', description: message });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Connect or Register Application"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 overflow-y-auto"
    >
      <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 shadow-xl dark:border-slate-800 dark:bg-slate-900 my-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
              Connect / Register Application
            </h2>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Register any Android app, game, website, or API service cleanly by unique{' '}
              <code className="font-mono">package_name</code> with isolated backend controls.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close Connect App Modal"
            className="rounded-lg border border-slate-200 p-1.5 text-slate-500 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {resultList.length > 0 ? (
          <div className="mt-5 space-y-4 text-xs">
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3.5 dark:border-emerald-900 dark:bg-emerald-950/30">
              <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                Provisioned {resultList.length} isolated application
                {resultList.length > 1 ? 's' : ''}. Save any generated API key now (only SHA-256 hash is stored).
              </p>
            </div>

            {resultConflicts.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
                {resultConflicts.map((c) => (
                  <p key={c.package_name} className="font-mono text-[11px]">
                    Skipped {c.package_name}: {c.error}
                  </p>
                ))}
              </div>
            )}

            <div className="max-h-72 space-y-3 overflow-y-auto">
              {resultList.map(({ app, apiKey }) => (
                <div
                  key={app.id}
                  className="space-y-2 rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-950"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                        {app.name}
                      </p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {app.packageName || app.packageOrDomain} · v{app.currentVersion} (code{' '}
                        {app.versionCode ?? 1})
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const targetId = app.id;
                        handleClose();
                        onOpenWorkspace(targetId);
                      }}
                      className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 font-medium text-white hover:bg-slate-800 dark:bg-blue-600"
                    >
                      <Terminal className="h-3.5 w-3.5" />
                      Open App Console
                    </button>
                  </div>
                  <div className="grid min-w-0 gap-2 sm:grid-cols-2">
                    <div className="flex min-w-0 items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px]">UID: {app.appUid}</span>
                      <button
                        type="button"
                        aria-label={`Copy App UID for ${app.name}`}
                        onClick={() => void copyText(`uid-${app.id}`, app.appUid, 'App UID')}
                        className="shrink-0 text-blue-600 hover:underline"
                      >
                        {copiedId === `uid-${app.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    </div>
                    {apiKey && (
                      <div className="flex min-w-0 items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 dark:border-slate-800 dark:bg-slate-900">
                        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">Key: {apiKey}</span>
                        <button
                          type="button"
                          aria-label={`Copy API Key for ${app.name}`}
                          onClick={() => void copyText(`key-${app.id}`, apiKey, 'API Key')}
                          className="shrink-0 text-blue-600 hover:underline"
                        >
                          {copiedId === `key-${app.id}` ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={resetAll}
                className="h-9 rounded-lg border border-slate-200 px-3.5 font-medium hover:bg-slate-50 dark:border-slate-700"
              >
                Connect Another App
              </button>
              <button
                type="button"
                onClick={handleClose}
                className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-4">
            {/* Mode Switcher */}
            <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs dark:bg-slate-950">
              <button
                type="button"
                onClick={() => setMode('form')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${
                  mode === 'form'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <Plus className="h-3.5 w-3.5" />
                Standard Form
              </button>
              <button
                type="button"
                onClick={() => setMode('json')}
                className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-medium ${
                  mode === 'json'
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                <FileJson className="h-3.5 w-3.5" />
                Quick JSON Connect
              </button>
            </div>

            {mode === 'form' ? (
              <form onSubmit={handleStandardSubmit} className="space-y-3 text-xs">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <label htmlFor="modal-app-name" className="block font-medium">
                      App Name (app_name) *
                    </label>
                    <input
                      id="modal-app-name"
                      required
                      value={appName}
                      onChange={(e) => setAppName(e.target.value)}
                      placeholder="e.g. My Android App"
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="modal-package-name" className="block font-medium">
                      Package Name (package_name) *
                    </label>
                    <input
                      id="modal-package-name"
                      required={platform === 'android'}
                      value={packageName}
                      onChange={(e) => setPackageName(e.target.value)}
                      placeholder="com.company.myapp"
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <label htmlFor="modal-platform" className="block font-medium">
                      Platform
                    </label>
                    <select
                      id="modal-platform"
                      value={platform}
                      onChange={(e) => setPlatform(e.target.value)}
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                    >
                      <option value="android">Android</option>
                      <option value="unity">Unity Game</option>
                      <option value="game">Multiplayer Game</option>
                      <option value="website">Website</option>
                      <option value="ios">iOS App</option>
                      <option value="api">REST API</option>
                    </select>
                  </div>
                  <div>
                    <label htmlFor="modal-version-name" className="block font-medium">
                      Version Name (version_name)
                    </label>
                    <input
                      id="modal-version-name"
                      value={versionName}
                      onChange={(e) => setVersionName(e.target.value)}
                      placeholder="1.0.0"
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                  <div>
                    <label htmlFor="modal-version-code" className="block font-medium">
                      Version Code (version_code)
                    </label>
                    <input
                      id="modal-version-code"
                      type="number"
                      min={1}
                      value={versionCode}
                      onChange={(e) => setVersionCode(e.target.value)}
                      placeholder="1"
                      className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label htmlFor="modal-conn-config" className="block font-medium">
                      Connection Config JSON (optional identity/auth/sync fields only)
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setConnectionConfigText(
                          JSON.stringify(
                            {
                              firebase_project_id: 'my-firebase-project',
                              firebase_app_id: '1:123456789012:android:abc123def456',
                              auth_mode: 'firebase',
                              require_sdk_key: false,
                            },
                            null,
                            2
                          )
                        )
                      }
                      className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                    >
                      Insert Connection Config Example
                    </button>
                  </div>
                  <textarea
                    id="modal-conn-config"
                    rows={4}
                    value={connectionConfigText}
                    onChange={(e) => setConnectionConfigText(e.target.value)}
                    placeholder='{"firebase_project_id":"my-firebase-project","firebase_app_id":"1:123456789012:android:abc123def456","require_sdk_key":false,"auth_mode":"package_name"}'
                    className="mt-1 w-full rounded-lg border border-slate-200 p-2.5 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-950"
                  />
                  <p className="mt-1 text-[11px] text-slate-500">
                    Allowed focused fields: <code className="font-mono">firebase_project_id</code>,{' '}
                    <code className="font-mono">firebase_app_id</code>,{' '}
                    <code className="font-mono">firebase_project_number</code>,{' '}
                    <code className="font-mono">firebase_storage_bucket</code>,{' '}
                    <code className="font-mono">auth_mode</code>,{' '}
                    <code className="font-mono">sync_mode</code>,{' '}
                    <code className="font-mono">require_sdk_key</code>. Unrelated keys and secrets are omitted.
                  </p>
                </div>

                {formError && <p className="text-red-600 dark:text-red-400">{formError}</p>}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="h-9 rounded-lg border border-slate-200 px-3.5 dark:border-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {submitting ? 'Connecting...' : 'Connect & Provision App'}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleQuickJsonSubmit} className="space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="modal-quick-json" className="font-medium">
                    Paste Connection JSON or Android <code className="font-mono">google-services.json</code>
                  </label>
                  <button
                    type="button"
                    onClick={() => handleQuickJsonChange(SAMPLE_CONNECTION_JSON)}
                    className="text-[11px] font-medium text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Insert Connection JSON Template
                  </button>
                </div>
                <textarea
                  id="modal-quick-json"
                  rows={7}
                  value={quickJsonText}
                  onChange={(e) => handleQuickJsonChange(e.target.value)}
                  placeholder='{"app_name":"My App","package_name":"com.company.myapp","version_name":"1.0.0","version_code":1,"connection_config":{"firebase_project_id":"my-firebase-project","firebase_app_id":"1:123456789012:android:abc123def456"}}'
                  className="w-full rounded-lg border border-slate-200 p-2.5 font-mono text-[11px] dark:border-slate-700 dark:bg-slate-950"
                />

                {quickParseError && (
                  <p className="text-red-600 dark:text-red-400">{quickParseError}</p>
                )}

                {quickParsed && (
                  <div className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950">
                    <p className="font-medium text-slate-800 dark:text-slate-200">
                      Ready to connect {quickParsed.apps.length} app
                      {quickParsed.apps.length > 1 ? 's' : ''} ({quickParsed.sourceFormat}):
                    </p>
                    {quickParsed.apps.map((candidate) => (
                      <div
                        key={candidate.package_name}
                        className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 font-mono text-[11px] dark:border-slate-800 dark:bg-slate-900"
                      >
                        <span className="font-semibold text-slate-900 dark:text-slate-100">
                          {candidate.app_name} · {candidate.package_name}
                        </span>
                        <span className="text-slate-500">
                          v{candidate.version_name} (code {candidate.version_code})
                          {candidate.connection_config.firebase_project_id
                            ? ` · fb:${candidate.connection_config.firebase_project_id}`
                            : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="h-9 rounded-lg border border-slate-200 px-3.5 dark:border-slate-700"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={submitting || !quickParsed}
                    className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {submitting ? 'Connecting...' : 'Quick Connect App(s)'}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
