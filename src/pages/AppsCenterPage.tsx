import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Check,
  Copy,
  Download,
  Edit3,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  RotateCw,
  ShieldAlert,
  Trash2,
  UserPlus,
  Webhook,
  Zap,
} from 'lucide-react';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAppScope, type ConnectedAppRecord } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest, downloadWithAuth } from '../lib/api';

interface OverviewResponse {
  summary: {
    totalApps: number;
    connectedApps: number;
    maintenanceApps: number;
    disconnectedApps: number;
    totalEndUsers: number;
    activeEndUsers: number;
    bannedEndUsers: number;
    totalRevenueCents: number;
    totalAdRevenueCents: number;
    errors24h: number;
  };
  apps: Array<
    ConnectedAppRecord & {
      stats: {
        totalUsers: number;
        activeUsers: number;
        bannedUsers: number;
        revenueCents: number;
        adRevenueCents: number;
        openTickets: number;
        activeKeysCount: number;
        errors24h: number;
      };
    }
  >;
}

interface AppApiKeyRow {
  id: number;
  appId: number;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isActive: boolean;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

interface AppEndUserRow {
  id: number;
  appId: number;
  appName: string;
  appUid: string;
  platform: string;
  externalUserId: string;
  email: string;
  displayName: string;
  status: string;
  appVersion: string;
  deviceModel: string;
  osVersion: string;
  country: string;
  ipAddress: string;
  totalSessions: number;
  lastActiveAt: string;
  createdAt: string;
}

interface WebhookRow {
  id: number;
  appId: number | null;
  appName: string | null;
  name: string;
  targetUrl: string;
  events: string[];
  isActive: boolean;
  lastStatusCode: number | null;
  lastTriggeredAt: string | null;
  createdAt: string;
}

interface WebhookDeliveryRow {
  id: number;
  eventType: string;
  statusCode: number;
  durationMs: number;
  success: boolean;
  errorMessage: string;
  responseBody: string;
  createdAt: string;
}

interface ErrorMonitorResponse {
  sdkErrors: Array<{
    id: number;
    appId: number;
    appName: string;
    eventType: string;
    eventName: string;
    severity: string;
    latencyMs: number;
    payload: unknown;
    createdAt: string;
  }>;
  httpErrors: Array<{
    id: number;
    appId: number | null;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    errorMessage: string;
    createdAt: string;
  }>;
  apps: Array<{
    id: number;
    name: string;
    appUid: string;
    platform: string;
    status: string;
    healthStatus: string;
    lastHeartbeatAt: string | null;
    lastLatencyMs: number;
    errorCount24h: number;
  }>;
}

interface TeamPermissionsResponse {
  users: Array<{
    id: number;
    email: string;
    displayName: string;
    status: string;
    roleName: string | null;
    roleSlug: string | null;
  }>;
  apps: Array<{ id: number; name: string; appUid: string; platform: string }>;
  grants: Array<{
    id: number;
    userId: number;
    appId: number;
    roleScope: string;
    permissions: string[];
    updatedAt: string;
  }>;
}

const KEY_SCOPE_OPTIONS = ['config:read', 'users:write', 'events:write', 'commerce:write'] as const;
const WEBHOOK_EVENT_OPTIONS = [
  'app_user.created',
  'app_user.banned',
  'app_user.status_changed',
  'app.error',
  'app.status_changed',
  'transaction.recorded',
  'notification.sent',
  '*',
] as const;

export const AppsCenterPage: React.FC<{
  subview: string;
  onNavigate: (viewId: string) => void;
}> = ({ subview, onNavigate }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { apps, selectedAppId, setSelectedAppId, refreshApps } = useAppScope();

  const [copiedId, setCopiedId] = useState<string | null>(null);
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

  // ---- Directory State ----
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [dirLoading, setDirLoading] = useState(true);
  const [dirSearch, setDirSearch] = useState('');
  const [dirPlatform, setDirPlatform] = useState('all');
  const [editingApp, setEditingApp] = useState<ConnectedAppRecord | null>(null);
  const [deleteAppTarget, setDeleteAppTarget] = useState<ConnectedAppRecord | null>(null);

  const loadOverview = useCallback(async () => {
    setDirLoading(true);
    try {
      const res = await apiRequest<OverviewResponse>('/apps/overview');
      setOverview(res);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load connected apps',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setDirLoading(false);
    }
  }, [pushToast]);

  // ---- Connect App & SDK State ----
  const [newName, setNewName] = useState('');
  const [newPlatform, setNewPlatform] = useState('android');
  const [newPkg, setNewPkg] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newVersion, setNewVersion] = useState('1.0.0');
  const [newMinVersion, setNewMinVersion] = useState('1.0.0');
  const [newAdmobId, setNewAdmobId] = useState('');
  const [newKeyName, setNewKeyName] = useState('Primary Production Key');
  const [newScopes, setNewScopes] = useState<string[]>([...KEY_SCOPE_OPTIONS]);
  const [creatingApp, setCreatingApp] = useState(false);
  const [createdCredentials, setCreatedCredentials] = useState<{
    app: ConnectedAppRecord;
    apiKey: string | null;
  } | null>(null);
  const [sdkTestKey, setSdkTestKey] = useState('');
  const [sdkTestAppUid, setSdkTestAppUid] = useState('');
  const [sdkTestOutput, setSdkTestOutput] = useState<string | null>(null);
  const [sdkTesting, setSdkTesting] = useState(false);

  // ---- App Users State ----
  const [endUsers, setEndUsers] = useState<AppEndUserRow[]>([]);
  const [endUsersTotal, setEndUsersTotal] = useState(0);
  const [endUsersLoading, setEndUsersLoading] = useState(false);
  const [endUserSearch, setEndUserSearch] = useState('');
  const [endUserStatus, setEndUserStatus] = useState('all');
  const [showAddEndUser, setShowAddEndUser] = useState(false);
  const [euAppId, setEuAppId] = useState<string>('');
  const [euExternalId, setEuExternalId] = useState('');
  const [euEmail, setEuEmail] = useState('');
  const [euName, setEuName] = useState('');
  const [euDevice, setEuDevice] = useState('');
  const [euCountry, setEuCountry] = useState('');
  const [deleteEndUserTarget, setDeleteEndUserTarget] = useState<AppEndUserRow | null>(null);
  const [activityModal, setActivityModal] = useState<{
    user: AppEndUserRow;
    events: Array<{ id: number; eventType: string; eventName: string; severity: string; createdAt: string }>;
  } | null>(null);

  // ---- API Keys State ----
  const [keysTargetAppId, setKeysTargetAppId] = useState<string>('');
  const [keysList, setKeysList] = useState<AppApiKeyRow[]>([]);
  const [keyNameInput, setKeyNameInput] = useState('');
  const [keyScopesInput, setKeyScopesInput] = useState<string[]>([...KEY_SCOPE_OPTIONS]);
  const [keyExpiryDays, setKeyExpiryDays] = useState('');
  const [revealedKeyOnce, setRevealedKeyOnce] = useState<string | null>(null);
  const [revokeKeyTarget, setRevokeKeyTarget] = useState<AppApiKeyRow | null>(null);

  // ---- Webhooks State ----
  const [webhooksList, setWebhooksList] = useState<WebhookRow[]>([]);
  const [whName, setWhName] = useState('');
  const [whUrl, setWhUrl] = useState('');
  const [whAppId, setWhAppId] = useState<string>('all');
  const [whEvents, setWhEvents] = useState<string[]>(['app_user.created', 'app.error', 'transaction.recorded']);
  const [revealedWebhookSecret, setRevealedWebhookSecret] = useState<string | null>(null);
  const [deliveriesModal, setDeliveriesModal] = useState<{
    hookName: string;
    items: WebhookDeliveryRow[];
  } | null>(null);
  const [deleteWebhookTarget, setDeleteWebhookTarget] = useState<WebhookRow | null>(null);

  // ---- Health & Errors State ----
  const [errorMonitor, setErrorMonitor] = useState<ErrorMonitorResponse | null>(null);

  // ---- App Permissions State ----
  const [teamMatrix, setTeamMatrix] = useState<TeamPermissionsResponse | null>(null);
  const [permUserId, setPermUserId] = useState<string>('');
  const [permAppId, setPermAppId] = useState<string>('');
  const [permRoleScope, setPermRoleScope] = useState('admin');
  const [permKeys, setPermKeys] = useState<string[]>(['apps.read', 'apps.manage', 'users.read', 'notifications.send']);

  const loadEndUsers = useCallback(async () => {
    setEndUsersLoading(true);
    try {
      const qs = new URLSearchParams({
        status: endUserStatus,
        search: endUserSearch,
      });
      if (selectedAppId !== 'all') qs.set('appId', String(selectedAppId));
      const res = await apiRequest<{ data: AppEndUserRow[]; total: number }>(`/app-users?${qs.toString()}`);
      setEndUsers(res.data);
      setEndUsersTotal(res.total);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load app end-users',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setEndUsersLoading(false);
    }
  }, [selectedAppId, endUserStatus, endUserSearch, pushToast]);

  const effectiveKeysAppId =
    keysTargetAppId || (selectedAppId !== 'all' ? String(selectedAppId) : apps[0] ? String(apps[0].id) : '');

  const loadKeys = useCallback(async () => {
    if (!effectiveKeysAppId) {
      setKeysList([]);
      return;
    }
    try {
      const res = await apiRequest<{ data: AppApiKeyRow[] }>(`/apps/${effectiveKeysAppId}/keys`);
      setKeysList(res.data);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load API keys',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [effectiveKeysAppId, pushToast]);

  const loadWebhooks = useCallback(async () => {
    try {
      const qs = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';
      const res = await apiRequest<{ data: WebhookRow[] }>(`/webhooks${qs}`);
      setWebhooksList(res.data);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load webhooks',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [selectedAppId, pushToast]);

  const loadHealth = useCallback(async () => {
    try {
      const qs = selectedAppId !== 'all' ? `?appId=${selectedAppId}` : '';
      const res = await apiRequest<ErrorMonitorResponse>(`/errors${qs}`);
      setErrorMonitor(res);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load health monitor',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [selectedAppId, pushToast]);

  const loadTeamPermissions = useCallback(async () => {
    try {
      const res = await apiRequest<TeamPermissionsResponse>('/team/app-permissions');
      setTeamMatrix(res);
      if (res.users.length > 0 && !permUserId) setPermUserId(String(res.users[0].id));
      if (res.apps.length > 0 && !permAppId) {
        setPermAppId(selectedAppId !== 'all' ? String(selectedAppId) : String(res.apps[0].id));
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to load team app permissions',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  }, [permUserId, permAppId, selectedAppId, pushToast]);

  useEffect(() => {
    if (subview === 'apps-directory') void loadOverview();
    if (subview === 'apps-users') void loadEndUsers();
    if (subview === 'apps-api-keys') void loadKeys();
    if (subview === 'apps-webhooks') void loadWebhooks();
    if (subview === 'apps-health') void loadHealth();
    if (subview === 'apps-permissions') void loadTeamPermissions();
  }, [subview, loadOverview, loadEndUsers, loadKeys, loadWebhooks, loadHealth, loadTeamPermissions]);

  useEffect(() => {
    if (apps.length > 0 && !euAppId) {
      setEuAppId(selectedAppId !== 'all' ? String(selectedAppId) : String(apps[0].id));
    }
  }, [apps, euAppId, selectedAppId]);

  const apiBaseOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://your-console.workers.dev';

  const runLiveSdkTest = async (uidArg?: string, keyArg?: string) => {
    const uid = (uidArg ?? sdkTestAppUid).trim();
    const apiKey = (keyArg ?? sdkTestKey).trim();
    if (!uid || !apiKey) {
      pushToast({ type: 'error', title: 'App UID and API Key are required to test the SDK endpoint' });
      return;
    }
    setSdkTesting(true);
    setSdkTestOutput(null);
    try {
      const res = await fetch('/api/v1/sdk/config', {
        method: 'GET',
        headers: {
          'X-App-Id': uid,
          'X-API-Key': apiKey,
        },
      });
      const text = await res.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // leave plain text
      }
      setSdkTestOutput(`HTTP ${res.status}\n${formatted}`);
      pushToast({
        type: res.ok ? 'success' : 'error',
        title: res.ok ? 'Live SDK connection verified (200 OK)' : `SDK returned HTTP ${res.status}`,
      });
    } catch (err) {
      setSdkTestOutput(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSdkTesting(false);
    }
  };

  // ---------------- SUBVIEW: APPS CONNECT & SDK ----------------
  if (subview === 'apps-connect') {
    const handleConnectApp = async (e: React.FormEvent) => {
      e.preventDefault();
      setCreatingApp(true);
      try {
        const res = await apiRequest<{
          app: ConnectedAppRecord;
          initialApiKey: string | null;
        }>('/apps', {
          method: 'POST',
          body: JSON.stringify({
            name: newName,
            platform: newPlatform,
            packageOrDomain: newPkg,
            description: newDesc,
            currentVersion: newVersion,
            minSupportedVersion: newMinVersion,
            admobAppId: newAdmobId,
            initialKeyName: newKeyName,
            scopes: newScopes,
            createInitialKey: true,
          }),
        });
        setCreatedCredentials({ app: res.app, apiKey: res.initialApiKey });
        setSdkTestAppUid(res.app.appUid);
        if (res.initialApiKey) setSdkTestKey(res.initialApiKey);
        setSdkTestOutput(null);
        setNewName('');
        setNewPkg('');
        setNewDesc('');
        setNewAdmobId('');
        pushToast({ type: 'success', title: `Connected "${res.app.name}"` });
        await refreshApps();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Failed to connect app',
          description: err instanceof Error ? err.message : undefined,
        });
      } finally {
        setCreatingApp(false);
      }
    };

    const activeUidForSnippets = sdkTestAppUid || createdCredentials?.app.appUid || apps[0]?.appUid || 'app_your_uid';
    const activeKeyForSnippets = sdkTestKey || createdCredentials?.apiKey || 'aegis_live_YOUR_API_KEY';

    const curlSnippet = `curl -s "${apiBaseOrigin}/api/v1/sdk/config" \\
  -H "X-App-Id: ${activeUidForSnippets}" \\
  -H "X-API-Key: ${activeKeyForSnippets}"`;

    const webSnippet = `const res = await fetch("${apiBaseOrigin}/api/v1/sdk/config", {
  headers: {
    "X-App-Id": "${activeUidForSnippets}",
    "X-API-Key": "${activeKeyForSnippets}"
  }
});
const config = await res.json();
// Sync end-user & block banned accounts (returns HTTP 403 if banned):
await fetch("${apiBaseOrigin}/api/v1/sdk/users/sync", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-App-Id": "${activeUidForSnippets}",
    "X-API-Key": "${activeKeyForSnippets}"
  },
  body: JSON.stringify({ externalUserId: "usr_123", email: "player@example.com", appVersion: "1.0.0" })
});`;

    const kotlinSnippet = `val client = OkHttpClient()
val req = Request.Builder()
  .url("${apiBaseOrigin}/api/v1/sdk/config")
  .addHeader("X-App-Id", "${activeUidForSnippets}")
  .addHeader("X-API-Key", "${activeKeyForSnippets}")
  .build()
client.newCall(req).execute().use { resp ->
  if (resp.isSuccessful) { /* Apply maintenance, forceUpdate, featureFlags, ads */ }
}`;

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
              Connect New App & SDK Integration
            </h1>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
              Register unlimited Android apps, games, websites, iOS apps, or API services and obtain isolated App UID & Bearer credentials.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNavigate('apps-directory')}
            className="h-9 rounded-lg border border-slate-200 bg-white px-3.5 text-xs font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
          >
            Back to Connected Apps
          </button>
        </div>

        {createdCredentials && (
          <section className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-5 dark:border-emerald-800 dark:bg-emerald-950/30">
            <h2 className="font-display text-sm font-semibold text-emerald-900 dark:text-emerald-200">
              Credentials Issued for {createdCredentials.app.name}
            </h2>
            <p className="mt-1 text-xs text-emerald-800 dark:text-emerald-300">
              Copy the plaintext API key now — Aegis stores only its SHA-256 hash and will not show this secret again.
            </p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 text-xs">
              <div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-slate-900">
                <p className="text-slate-500">App UID (X-App-Id)</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <code className="font-mono font-semibold text-slate-900 dark:text-slate-100">
                    {createdCredentials.app.appUid}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyText('new-uid', createdCredentials.app.appUid, 'App UID')}
                    className="inline-flex items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700"
                  >
                    {copiedId === 'new-uid' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                    Copy
                  </button>
                </div>
              </div>
              {createdCredentials.apiKey && (
                <div className="rounded-lg border border-emerald-200 bg-white p-3 dark:border-emerald-900 dark:bg-slate-900">
                  <p className="text-slate-500">API Key (X-API-Key / Bearer)</p>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <code className="truncate font-mono font-semibold text-slate-900 dark:text-slate-100">
                      {createdCredentials.apiKey}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText('new-key', createdCredentials.apiKey!, 'API Key')}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-slate-200 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700"
                    >
                      {copiedId === 'new-key' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-12">
          <form
            onSubmit={handleConnectApp}
            className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-sm font-semibold">Register Application</h2>
            <div className="grid gap-3 sm:grid-cols-2 text-xs">
              <div>
                <label htmlFor="connect-app-name" className="block font-medium">
                  App Name *
                </label>
                <input
                  id="connect-app-name"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="e.g. Atlas Runner Android"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="connect-app-platform" className="block font-medium">
                  Platform *
                </label>
                <select
                  id="connect-app-platform"
                  value={newPlatform}
                  onChange={(e) => setNewPlatform(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="android">Android App</option>
                  <option value="game">Mobile / Web Game</option>
                  <option value="website">Website / Web App</option>
                  <option value="ios">iOS App</option>
                  <option value="api">Backend / API Service</option>
                </select>
              </div>
              <div>
                <label htmlFor="connect-app-pkg" className="block font-medium">
                  Package Name or Domain
                </label>
                <input
                  id="connect-app-pkg"
                  value={newPkg}
                  onChange={(e) => setNewPkg(e.target.value)}
                  placeholder="com.studio.atlas or app.example.com"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="connect-app-admob" className="block font-medium">
                  AdMob App ID (optional)
                </label>
                <input
                  id="connect-app-admob"
                  value={newAdmobId}
                  onChange={(e) => setNewAdmobId(e.target.value)}
                  placeholder="ca-app-pub-xxxxxxxxxxxxxxxx~yyyyyyyyyy"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="connect-app-ver" className="block font-medium">
                  Current Version
                </label>
                <input
                  id="connect-app-ver"
                  value={newVersion}
                  onChange={(e) => setNewVersion(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="connect-app-minver" className="block font-medium">
                  Min Supported Version
                </label>
                <input
                  id="connect-app-minver"
                  value={newMinVersion}
                  onChange={(e) => setNewMinVersion(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono text-xs dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div className="text-xs">
              <label htmlFor="connect-app-desc" className="block font-medium">
                Description
              </label>
              <input
                id="connect-app-desc"
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                placeholder="Production Android client connected to Aegis telemetry & remote config"
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div className="text-xs">
              <label htmlFor="connect-key-name" className="block font-medium">
                Initial API Key Name & Scopes
              </label>
              <input
                id="connect-key-name"
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
              />
              <div className="mt-2 flex flex-wrap gap-3">
                {KEY_SCOPE_OPTIONS.map((scope) => (
                  <label key={scope} className="inline-flex items-center gap-1.5 font-mono">
                    <input
                      type="checkbox"
                      checked={newScopes.includes(scope)}
                      onChange={() =>
                        setNewScopes((prev) =>
                          prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]
                        )
                      }
                    />
                    <span>{scope}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={creatingApp}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              {creatingApp ? 'Connecting App...' : 'Connect App & Issue API Key'}
            </button>
          </form>

          {/* Live SDK Verifier & Snippets */}
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold">Live SDK Endpoint Verifier & Snippets</h2>
            <div className="grid gap-2 sm:grid-cols-2 text-xs">
              <div>
                <label htmlFor="sdk-test-uid" className="block font-medium">
                  X-App-Id
                </label>
                <input
                  id="sdk-test-uid"
                  value={sdkTestAppUid}
                  onChange={(e) => setSdkTestAppUid(e.target.value)}
                  placeholder="app_..."
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label htmlFor="sdk-test-key" className="block font-medium">
                  X-API-Key
                </label>
                <input
                  id="sdk-test-key"
                  value={sdkTestKey}
                  onChange={(e) => setSdkTestKey(e.target.value)}
                  placeholder="aegis_live_..."
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={sdkTesting}
              onClick={() => void runLiveSdkTest()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-4 text-xs font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900"
            >
              <Zap className="h-3.5 w-3.5" />
              {sdkTesting ? 'Testing GET /api/v1/sdk/config...' : 'Test SDK Connection'}
            </button>

            {sdkTestOutput && (
              <pre className="max-h-44 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] dark:border-slate-800 dark:bg-slate-950">
                {sdkTestOutput}
              </pre>
            )}

            <div className="space-y-3 text-xs">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-slate-700 dark:text-slate-300">Website / JS Fetch SDK</span>
                  <button
                    type="button"
                    onClick={() => void copyText('snip-web', webSnippet, 'Web SDK snippet')}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Copy
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] dark:bg-slate-950">
                  {webSnippet}
                </pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-slate-700 dark:text-slate-300">Android (Kotlin / OkHttp)</span>
                  <button
                    type="button"
                    onClick={() => void copyText('snip-kt', kotlinSnippet, 'Kotlin snippet')}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Copy
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] dark:bg-slate-950">
                  {kotlinSnippet}
                </pre>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="font-medium text-slate-700 dark:text-slate-300">cURL Verification</span>
                  <button
                    type="button"
                    onClick={() => void copyText('snip-curl', curlSnippet, 'cURL command')}
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Copy
                  </button>
                </div>
                <pre className="overflow-x-auto rounded-lg bg-slate-50 p-2.5 font-mono text-[11px] dark:bg-slate-950">
                  {curlSnippet}
                </pre>
              </div>
            </div>
          </section>
        </div>
      </div>
    );
  }

  // ---------------- SUBVIEW: APP END-USERS ----------------
  if (subview === 'apps-users') {
    const handleAddEndUser = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!euAppId) {
        pushToast({ type: 'error', title: 'Select a target app first' });
        return;
      }
      try {
        await apiRequest(`/apps/${euAppId}/users`, {
          method: 'POST',
          body: JSON.stringify({
            externalUserId: euExternalId || undefined,
            email: euEmail,
            displayName: euName,
            deviceModel: euDevice,
            country: euCountry,
          }),
        });
        setShowAddEndUser(false);
        setEuExternalId('');
        setEuEmail('');
        setEuName('');
        pushToast({ type: 'success', title: 'App end-user synced' });
        await loadEndUsers();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Failed to add end-user',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    const updateEndUserStatus = async (u: AppEndUserRow, status: string) => {
      try {
        await apiRequest(`/app-users/${u.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ status }),
        });
        pushToast({ type: 'success', title: `${u.displayName || u.externalUserId} marked ${status}` });
        await loadEndUsers();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Failed to update status',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    const openActivity = async (u: AppEndUserRow) => {
      try {
        const res = await apiRequest<{
          data: Array<{ id: number; eventType: string; eventName: string; severity: string; createdAt: string }>;
        }>(`/app-users/${u.id}/activity`);
        setActivityModal({ user: u, events: res.data });
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Could not load activity',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    return (
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold">App End-Users ({endUsersTotal})</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Manage players, mobile users, and web customers per application. Banned users are blocked by <code className="font-mono">/api/v1/sdk/users/sync</code> (HTTP 403).
            </p>
          </div>
          {hasPerm('apps.manage') && (
            <button
              type="button"
              onClick={() => setShowAddEndUser(true)}
              disabled={apps.length === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <UserPlus className="h-4 w-4" />
              Add App End-User
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            value={endUserSearch}
            onChange={(e) => setEndUserSearch(e.target.value)}
            placeholder="Search external ID, email, or name..."
            aria-label="Search app end-users"
            className="h-9 min-w-[220px] flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
          />
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
            {(['all', 'active', 'banned', 'suspended'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setEndUserStatus(st)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize ${
                  endUserStatus === st
                    ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {st}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                <th className="px-4 py-3 font-medium">End-User</th>
                <th className="px-4 py-3 font-medium">App Scope</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Version / Device</th>
                <th className="px-4 py-3 text-right font-medium">Sessions</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {endUsersLoading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-500">
                    Loading end-users...
                  </td>
                </tr>
              ) : endUsers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-500">
                    No end-users recorded for this scope yet. Register users via SDK or add one manually.
                  </td>
                </tr>
              ) : (
                endUsers.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {u.displayName || u.externalUserId}
                      </p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {u.externalUserId} {u.email ? `· ${u.email}` : ''}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span>{u.appName}</span>
                      <span className="text-slate-400"> · {u.platform}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`font-medium capitalize ${
                          u.status === 'active'
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : u.status === 'banned'
                              ? 'text-red-600 dark:text-red-400'
                              : 'text-amber-700 dark:text-amber-400'
                        }`}
                      >
                        {u.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                      {u.appVersion || '-'} · {u.deviceModel || u.country || 'Unknown'}
                    </td>
                    <td className="px-4 py-3 text-right font-mono tabular-nums">{u.totalSessions}</td>
                    <td className="px-4 py-3 text-right">
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void openActivity(u)}
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                        >
                          Activity
                        </button>
                        {hasPerm('apps.manage') && (
                          <>
                            {u.status === 'banned' ? (
                              <button
                                type="button"
                                onClick={() => void updateEndUserStatus(u, 'active')}
                                className="rounded border border-emerald-300 px-2 py-1 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400"
                              >
                                Unban
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => void updateEndUserStatus(u, 'banned')}
                                className="rounded border border-red-200 px-2 py-1 text-red-600 dark:border-red-900"
                              >
                                Ban
                              </button>
                            )}
                            <button
                              type="button"
                              aria-label={`Delete ${u.externalUserId}`}
                              onClick={() => setDeleteEndUserTarget(u)}
                              className="rounded border border-slate-200 p-1 text-slate-500 hover:text-red-600 dark:border-slate-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {showAddEndUser && (
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <form
              onSubmit={handleAddEndUser}
              className="w-full max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-xs dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-display text-base font-semibold">Add App End-User</h2>
              <div>
                <label className="block font-medium">Target Application *</label>
                <select
                  required
                  value={euAppId}
                  onChange={(e) => setEuAppId(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm dark:border-slate-700 dark:bg-slate-950"
                >
                  {apps.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.platform})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium">External User ID (auto-generated if blank)</label>
                <input
                  value={euExternalId}
                  onChange={(e) => setEuExternalId(e.target.value)}
                  placeholder="player_9012"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium">Display Name</label>
                  <input
                    value={euName}
                    onChange={(e) => setEuName(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium">Email</label>
                  <input
                    type="email"
                    value={euEmail}
                    onChange={(e) => setEuEmail(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium">Device Model</label>
                  <input
                    value={euDevice}
                    onChange={(e) => setEuDevice(e.target.value)}
                    placeholder="Pixel 9 / Chrome"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium">Country</label>
                  <input
                    value={euCountry}
                    onChange={(e) => setEuCountry(e.target.value)}
                    placeholder="IN / US"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setShowAddEndUser(false)} className="rounded-lg border border-slate-200 px-3 py-1.5">
                  Cancel
                </button>
                <button type="submit" className="rounded-lg bg-blue-600 px-3.5 py-1.5 font-medium text-white">
                  Save End-User
                </button>
              </div>
            </form>
          </div>
        )}

        {activityModal && (
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-base font-semibold">
                Activity: {activityModal.user.displayName || activityModal.user.externalUserId}
              </h2>
              <ul className="mt-4 max-h-64 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
                {activityModal.events.length === 0 ? (
                  <li className="py-6 text-center text-slate-500">No SDK events recorded for this user yet.</li>
                ) : (
                  activityModal.events.map((ev) => (
                    <li key={ev.id} className="flex items-center justify-between py-2">
                      <div>
                        <span className="font-mono font-medium">{ev.eventName}</span>
                        <span className="text-slate-500"> · {ev.eventType} · {ev.severity}</span>
                      </div>
                      <span className="font-mono text-slate-400">{new Date(ev.createdAt).toLocaleString()}</span>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={() => setActivityModal(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={Boolean(deleteEndUserTarget)}
          title="Remove App End-User"
          description={`Permanently delete ${deleteEndUserTarget?.externalUserId} from this app?`}
          destructive
          onConfirm={async () => {
            if (!deleteEndUserTarget) return;
            await apiRequest(`/app-users/${deleteEndUserTarget.id}`, { method: 'DELETE' });
            pushToast({ type: 'success', title: 'App end-user removed' });
            setDeleteEndUserTarget(null);
            await loadEndUsers();
          }}
          onCancel={() => setDeleteEndUserTarget(null)}
        />
      </div>
    );
  }

  // ---------------- SUBVIEW: API KEYS & SCOPES ----------------
  if (subview === 'apps-api-keys') {
    const createKey = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!effectiveKeysAppId) return;
      try {
        const res = await apiRequest<{ apiKey: string }>(`/apps/${effectiveKeysAppId}/keys`, {
          method: 'POST',
          body: JSON.stringify({
            name: keyNameInput || undefined,
            scopes: keyScopesInput,
            expiresInDays: keyExpiryDays ? Number(keyExpiryDays) : undefined,
          }),
        });
        setRevealedKeyOnce(res.apiKey);
        setKeyNameInput('');
        setKeyExpiryDays('');
        pushToast({ type: 'success', title: 'Scoped API key generated' });
        await loadKeys();
        await refreshApps();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Key creation failed',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    const rotateKey = async (keyRow: AppApiKeyRow) => {
      try {
        const res = await apiRequest<{ apiKey: string }>(`/apps/${keyRow.appId}/keys/${keyRow.id}/rotate`, {
          method: 'POST',
        });
        setRevealedKeyOnce(res.apiKey);
        pushToast({ type: 'success', title: `Rotated ${keyRow.name}` });
        await loadKeys();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Key rotation failed',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold">App API Keys & Scopes</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              Issue SHA-256 hashed API keys with strict scope isolation per connected app.
            </p>
          </div>
          <select
            aria-label="Select app for API keys"
            value={effectiveKeysAppId}
            onChange={(e) => setKeysTargetAppId(e.target.value)}
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
          >
            {apps.length === 0 ? (
              <option value="">No apps connected</option>
            ) : (
              apps.map((a) => (
                <option key={a.id} value={String(a.id)}>
                  {a.name} ({a.appUid})
                </option>
              ))
            )}
          </select>
        </div>

        {revealedKeyOnce && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-4 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
            <p className="font-semibold text-emerald-900 dark:text-emerald-200">
              One-Time Plaintext API Key (copy now):
            </p>
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-white p-2.5 dark:border-emerald-900 dark:bg-slate-900">
              <code className="truncate font-mono font-semibold">{revealedKeyOnce}</code>
              <button
                type="button"
                onClick={() => void copyText('once-key', revealedKeyOnce, 'API Key')}
                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 dark:border-slate-700"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
          </div>
        )}

        {hasPerm('apps.keys') && effectiveKeysAppId && (
          <form
            onSubmit={createKey}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-sm font-semibold">Generate New Key</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                value={keyNameInput}
                onChange={(e) => setKeyNameInput(e.target.value)}
                placeholder="Key label (e.g. Android Prod v2)"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
              <input
                type="number"
                min={1}
                max={3650}
                value={keyExpiryDays}
                onChange={(e) => setKeyExpiryDays(e.target.value)}
                placeholder="Expires in days (optional)"
                className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
              <button type="submit" className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 font-medium text-white">
                <KeyRound className="h-3.5 w-3.5" />
                Create Scoped Key
              </button>
            </div>
            <div className="flex flex-wrap gap-3">
              {KEY_SCOPE_OPTIONS.map((sc) => (
                <label key={sc} className="inline-flex items-center gap-1.5 font-mono">
                  <input
                    type="checkbox"
                    checked={keyScopesInput.includes(sc)}
                    onChange={() =>
                      setKeyScopesInput((prev) =>
                        prev.includes(sc) ? prev.filter((x) => x !== sc) : [...prev, sc]
                      )
                    }
                  />
                  <span>{sc}</span>
                </label>
              ))}
            </div>
          </form>
        )}

        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {keysList.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              {effectiveKeysAppId ? 'No API keys issued for this app yet.' : 'Connect an app first to manage API keys.'}
            </p>
          ) : (
            keysList.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                <div>
                  <p className="font-semibold text-slate-900 dark:text-slate-100">
                    {k.name} · <code className="font-mono text-slate-600 dark:text-slate-300">{k.keyPrefix}...</code>
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {k.isActive ? 'Active' : 'Revoked'} · Scopes: {(k.scopes || []).join(', ')} · Last used:{' '}
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'Never'}
                  </p>
                </div>
                {hasPerm('apps.keys') && k.isActive && (
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void rotateKey(k)}
                      className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-700"
                    >
                      <RotateCw className="h-3 w-3" />
                      Rotate
                    </button>
                    <button
                      type="button"
                      onClick={() => setRevokeKeyTarget(k)}
                      className="rounded border border-red-200 px-2.5 py-1 text-red-600 dark:border-red-900"
                    >
                      Revoke
                    </button>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <ConfirmDialog
          open={Boolean(revokeKeyTarget)}
          title="Revoke API Key"
          description={`Immediately revoke "${revokeKeyTarget?.name}" (${revokeKeyTarget?.keyPrefix}...)? Connected clients using it will receive 401.`}
          destructive
          onConfirm={async () => {
            if (!revokeKeyTarget) return;
            await apiRequest(`/apps/${revokeKeyTarget.appId}/keys/${revokeKeyTarget.id}`, { method: 'DELETE' });
            pushToast({ type: 'warning', title: 'API key revoked' });
            setRevokeKeyTarget(null);
            await loadKeys();
            await refreshApps();
          }}
          onCancel={() => setRevokeKeyTarget(null)}
        />
      </div>
    );
  }

  // ---------------- SUBVIEW: WEBHOOKS ----------------
  if (subview === 'apps-webhooks') {
    const createWebhook = async (e: React.FormEvent) => {
      e.preventDefault();
      try {
        const res = await apiRequest<{ signingSecret: string }>('/webhooks', {
          method: 'POST',
          body: JSON.stringify({
            name: whName,
            targetUrl: whUrl,
            appId: whAppId === 'all' ? null : Number(whAppId),
            events: whEvents,
          }),
        });
        setRevealedWebhookSecret(res.signingSecret);
        setWhName('');
        setWhUrl('');
        pushToast({ type: 'success', title: 'Outbound webhook registered' });
        await loadWebhooks();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Failed to create webhook',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    const testWebhook = async (hook: WebhookRow) => {
      try {
        const res = await apiRequest<{
          delivery: { success: boolean; statusCode: number; durationMs: number; errorMessage: string };
        }>(`/webhooks/${hook.id}/test`, { method: 'POST' });
        pushToast({
          type: res.delivery.success ? 'success' : 'warning',
          title: res.delivery.success
            ? `Webhook test succeeded (HTTP ${res.delivery.statusCode} in ${res.delivery.durationMs}ms)`
            : `Webhook delivery returned ${res.delivery.errorMessage || `HTTP ${res.delivery.statusCode}`}`,
        });
        await loadWebhooks();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Webhook test failed',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    const openDeliveries = async (hook: WebhookRow) => {
      const res = await apiRequest<{ data: WebhookDeliveryRow[] }>(`/webhooks/${hook.id}/deliveries`);
      setDeliveriesModal({ hookName: hook.name, items: res.data });
    };

    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-xl font-semibold">Outbound Webhooks</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Real-time HMAC-SHA256 signed event notifications (<code className="font-mono">X-Aegis-Signature</code>) delivered to your app servers.
          </p>
        </div>

        {revealedWebhookSecret && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50/70 p-4 text-xs dark:border-emerald-800 dark:bg-emerald-950/30">
            <p className="font-semibold text-emerald-900 dark:text-emerald-200">
              Webhook HMAC Signing Secret (copy now):
            </p>
            <div className="mt-2 flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-white p-2.5 dark:border-emerald-900 dark:bg-slate-900">
              <code className="font-mono font-semibold">{revealedWebhookSecret}</code>
              <button
                type="button"
                onClick={() => void copyText('wh-sec', revealedWebhookSecret, 'Signing secret')}
                className="inline-flex items-center gap-1 rounded border border-slate-200 px-2.5 py-1 dark:border-slate-700"
              >
                <Copy className="h-3 w-3" />
                Copy
              </button>
            </div>
          </div>
        )}

        {hasPerm('webhooks.manage') && (
          <form
            onSubmit={createWebhook}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-sm font-semibold">Register Webhook Endpoint</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <input
                required
                value={whName}
                onChange={(e) => setWhName(e.target.value)}
                placeholder="Endpoint label"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
              <input
                required
                type="url"
                value={whUrl}
                onChange={(e) => setWhUrl(e.target.value)}
                placeholder="https://api.example.com/aegis-webhook"
                className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
              <select
                value={whAppId}
                onChange={(e) => setWhAppId(e.target.value)}
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="all">All Connected Apps (Global)</option>
                {apps.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-wrap gap-3">
              {WEBHOOK_EVENT_OPTIONS.map((ev) => (
                <label key={ev} className="inline-flex items-center gap-1.5 font-mono">
                  <input
                    type="checkbox"
                    checked={whEvents.includes(ev)}
                    onChange={() =>
                      setWhEvents((prev) =>
                        prev.includes(ev) ? prev.filter((x) => x !== ev) : [...prev, ev]
                      )
                    }
                  />
                  <span>{ev}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 font-medium text-white">
              <Webhook className="h-3.5 w-3.5" />
              Save Webhook
            </button>
          </form>
        )}

        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {webhooksList.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">No webhooks configured yet.</p>
          ) : (
            webhooksList.map((hook) => (
              <div key={hook.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                <div>
                  <p className="font-semibold text-slate-900 dark:text-slate-100">
                    {hook.name} · <span className="font-normal text-slate-500">{hook.appName || 'Global'}</span>
                  </p>
                  <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                    {hook.targetUrl} · Events: {(hook.events || []).join(', ')} · Last HTTP:{' '}
                    {hook.lastStatusCode ?? 'None'}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void testWebhook(hook)}
                    className="rounded border border-slate-200 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-700"
                  >
                    Test Ping
                  </button>
                  <button
                    type="button"
                    onClick={() => void openDeliveries(hook)}
                    className="rounded border border-slate-200 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-700"
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void apiRequest(`/webhooks/${hook.id}`, {
                        method: 'PATCH',
                        body: JSON.stringify({ isActive: !hook.isActive }),
                      }).then(() => loadWebhooks())
                    }
                    className="rounded border border-slate-200 px-2.5 py-1 dark:border-slate-700"
                  >
                    {hook.isActive ? 'Pause' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete webhook ${hook.name}`}
                    onClick={() => setDeleteWebhookTarget(hook)}
                    className="rounded border border-red-200 p-1.5 text-red-600 dark:border-red-900"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        {deliveriesModal && (
          <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
            <div className="w-full max-w-2xl rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-base font-semibold">Delivery Logs: {deliveriesModal.hookName}</h2>
              <div className="mt-4 max-h-72 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
                {deliveriesModal.items.length === 0 ? (
                  <p className="py-6 text-center text-slate-500">No deliveries attempted yet.</p>
                ) : (
                  deliveriesModal.items.map((d) => (
                    <div key={d.id} className="py-2.5 font-mono">
                      <div className="flex justify-between">
                        <span>
                          {d.eventType} · HTTP {d.statusCode} ({d.durationMs}ms)
                        </span>
                        <span className={d.success ? 'text-emerald-600' : 'text-red-600'}>
                          {d.success ? 'Delivered' : d.errorMessage || 'Failed'}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
              <div className="mt-4 flex justify-end">
                <button type="button" onClick={() => setDeliveriesModal(null)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs">
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        <ConfirmDialog
          open={Boolean(deleteWebhookTarget)}
          title="Delete Webhook"
          description={`Remove webhook "${deleteWebhookTarget?.name}" and its delivery history?`}
          destructive
          onConfirm={async () => {
            if (!deleteWebhookTarget) return;
            await apiRequest(`/webhooks/${deleteWebhookTarget.id}`, { method: 'DELETE' });
            pushToast({ type: 'success', title: 'Webhook removed' });
            setDeleteWebhookTarget(null);
            await loadWebhooks();
          }}
          onCancel={() => setDeleteWebhookTarget(null)}
        />
      </div>
    );
  }

  // ---------------- SUBVIEW: HEALTH & ERROR MONITOR ----------------
  if (subview === 'apps-health') {
    return (
      <div className="space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold">App Health & Error Monitoring</h1>
            <p className="mt-0.5 text-xs text-slate-500">
              SDK heartbeats, latency telemetry, client crashes, and HTTP 4xx/5xx error stream across connected apps.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadHealth()}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-xs font-medium dark:border-slate-700 dark:bg-slate-900"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(errorMonitor?.apps || []).map((a) => (
            <div key={a.id} className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <span className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">{a.name}</span>
                <span
                  className={`font-medium capitalize ${
                    a.healthStatus === 'healthy'
                      ? 'text-emerald-600'
                      : a.healthStatus === 'degraded'
                        ? 'text-amber-600'
                        : 'text-red-600'
                  }`}
                >
                  {a.healthStatus}
                </span>
              </div>
              <p className="mt-1 font-mono text-[11px] text-slate-500">
                {a.platform} · {a.status} · Latency {a.lastLatencyMs}ms · 24h Errors: {a.errorCount24h}
              </p>
              <p className="mt-1 font-mono text-[11px] text-slate-400">
                Heartbeat: {a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).toLocaleString() : 'Awaiting SDK ping'}
              </p>
            </div>
          ))}
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold mb-3">SDK Error & Warning Events</h2>
            <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
              {(errorMonitor?.sdkErrors || []).length === 0 ? (
                <p className="py-6 text-center text-slate-500">No SDK error events recorded.</p>
              ) : (
                errorMonitor!.sdkErrors.map((ev) => (
                  <div key={ev.id} className="py-2.5">
                    <div className="flex justify-between">
                      <span className="font-mono font-semibold text-red-600 dark:text-red-400">
                        [{ev.severity}] {ev.eventName}
                      </span>
                      <span className="font-mono text-slate-400">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-slate-500">{ev.appName} · {ev.eventType} · {ev.latencyMs}ms</p>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold mb-3">API HTTP 4xx / 5xx Failures</h2>
            <div className="max-h-80 divide-y divide-slate-100 overflow-y-auto text-xs dark:divide-slate-800">
              {(errorMonitor?.httpErrors || []).length === 0 ? (
                <p className="py-6 text-center text-slate-500">No API errors recorded.</p>
              ) : (
                errorMonitor!.httpErrors.map((err) => (
                  <div key={err.id} className="py-2.5 font-mono">
                    <div className="flex justify-between">
                      <span className="text-red-600 dark:text-red-400">
                        {err.statusCode} {err.method} {err.path}
                      </span>
                      <span className="text-slate-400">{err.durationMs}ms</span>
                    </div>
                    {err.errorMessage && <p className="mt-0.5 text-slate-500">{err.errorMessage}</p>}
                  </div>
                ))
              )}
            </div>
          </section>
        </div>
      </div>
    );
  }

  // ---------------- SUBVIEW: APP TEAM PERMISSIONS ----------------
  if (subview === 'apps-permissions') {
    const PERM_OPTIONS = [
      'apps.read',
      'apps.manage',
      'apps.keys',
      'users.read',
      'users.write',
      'ads.manage',
      'notifications.send',
      'finance.read',
    ];

    const saveAppGrant = async (e: React.FormEvent) => {
      e.preventDefault();
      if (!permUserId || !permAppId) return;
      try {
        await apiRequest(`/apps/${permAppId}/permissions`, {
          method: 'PUT',
          body: JSON.stringify({
            userId: Number(permUserId),
            roleScope: permRoleScope,
            permissions: permKeys,
          }),
        });
        pushToast({ type: 'success', title: 'App team permission saved' });
        await loadTeamPermissions();
      } catch (err) {
        pushToast({
          type: 'error',
          title: 'Could not save permission',
          description: err instanceof Error ? err.message : undefined,
        });
      }
    };

    return (
      <div className="space-y-6">
        <div>
          <h1 className="font-display text-xl font-semibold">App-Wise Admin Team Permissions</h1>
          <p className="mt-0.5 text-xs text-slate-500">
            Assign scoped ownership and access rights for team administrators across individual connected apps.
          </p>
        </div>

        {teamMatrix && teamMatrix.apps.length > 0 && (
          <form
            onSubmit={saveAppGrant}
            className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-sm font-semibold">Grant / Update Team App Access</h2>
            <div className="grid gap-3 sm:grid-cols-3">
              <select
                value={permUserId}
                onChange={(e) => setPermUserId(e.target.value)}
                aria-label="Select administrator user"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              >
                {teamMatrix.users.map((u) => (
                  <option key={u.id} value={String(u.id)}>
                    {u.displayName || u.email} ({u.roleName || u.roleSlug})
                  </option>
                ))}
              </select>
              <select
                value={permAppId}
                onChange={(e) => setPermAppId(e.target.value)}
                aria-label="Select connected app"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              >
                {teamMatrix.apps.map((a) => (
                  <option key={a.id} value={String(a.id)}>
                    {a.name} ({a.platform})
                  </option>
                ))}
              </select>
              <select
                value={permRoleScope}
                onChange={(e) => setPermRoleScope(e.target.value)}
                aria-label="Select app role scope"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              >
                <option value="owner">App Owner</option>
                <option value="admin">App Admin</option>
                <option value="editor">App Editor</option>
                <option value="viewer">App Viewer</option>
              </select>
            </div>
            <div className="flex flex-wrap gap-3">
              {PERM_OPTIONS.map((p) => (
                <label key={p} className="inline-flex items-center gap-1.5 font-mono">
                  <input
                    type="checkbox"
                    checked={permKeys.includes(p)}
                    onChange={() =>
                      setPermKeys((prev) =>
                        prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
                      )
                    }
                  />
                  <span>{p}</span>
                </label>
              ))}
            </div>
            <button type="submit" className="h-9 rounded-lg bg-blue-600 px-4 font-medium text-white">
              Save App Permission Grant
            </button>
          </form>
        )}

        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {!teamMatrix || teamMatrix.grants.length === 0 ? (
            <p className="p-8 text-center text-xs text-slate-500">
              No per-app permission overrides assigned yet.
            </p>
          ) : (
            teamMatrix.grants.map((g) => {
              const u = teamMatrix.users.find((x) => x.id === g.userId);
              const a = teamMatrix.apps.find((x) => x.id === g.appId);
              return (
                <div key={g.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-xs">
                  <div>
                    <p className="font-semibold text-slate-900 dark:text-slate-100">
                      {u?.displayName || u?.email || `User #${g.userId}`} → {a?.name || `App #${g.appId}`} ({g.roleScope})
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                      Permissions: {(g.permissions || []).join(', ')}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      await apiRequest(`/apps/${g.appId}/permissions/${g.userId}`, { method: 'DELETE' });
                      pushToast({ type: 'success', title: 'App grant revoked' });
                      await loadTeamPermissions();
                    }}
                    className="rounded border border-red-200 px-2.5 py-1 text-red-600 dark:border-red-900"
                  >
                    Revoke
                  </button>
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  // ---------------- DEFAULT SUBVIEW: CONNECTED APPS DIRECTORY ----------------
  const filteredApps = (overview?.apps || []).filter((a) => {
    if (dirPlatform !== 'all' && a.platform !== dirPlatform) return false;
    if (dirSearch.trim()) {
      const q = dirSearch.trim().toLowerCase();
      return (
        a.name.toLowerCase().includes(q) ||
        a.appUid.toLowerCase().includes(q) ||
        (a.packageOrDomain || '').toLowerCase().includes(q)
      );
    }
    return true;
  });

  const handleSaveEditApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingApp) return;
    try {
      await apiRequest(`/apps/${editingApp.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editingApp.name,
          platform: editingApp.platform,
          packageOrDomain: editingApp.packageOrDomain,
          status: editingApp.status,
          currentVersion: editingApp.currentVersion,
          minSupportedVersion: editingApp.minSupportedVersion,
          forceUpdate: editingApp.forceUpdate,
          admobAppId: editingApp.admobAppId,
          adsEnabled: editingApp.adsEnabled,
          maintenanceMessage: editingApp.maintenanceMessage,
        }),
      });
      pushToast({ type: 'success', title: `Updated ${editingApp.name}` });
      setEditingApp(null);
      await loadOverview();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold text-slate-900 dark:text-slate-100">
            Multi-App Management Platform
          </h1>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
            Connect, monitor, isolate, and control unlimited Android apps, games, websites, and services from one unified console.
          </p>
        </div>
        {hasPerm('apps.manage') && (
          <button
            type="button"
            onClick={() => onNavigate('apps-connect')}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Connect New App
          </button>
        )}
      </div>

      {/* Combined Portfolio Summary */}
      {overview && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Connected Apps</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {overview.summary.connectedApps} / {overview.summary.totalApps}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {overview.summary.maintenanceApps} maintenance · {overview.summary.disconnectedApps} offline
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Combined App End-Users</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              {overview.summary.totalEndUsers.toLocaleString()}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              {overview.summary.activeEndUsers} active · {overview.summary.bannedEndUsers} banned
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">Total Revenue (Apps + AdMob)</p>
            <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
              ${((overview.summary.totalRevenueCents + overview.summary.totalAdRevenueCents) / 100).toFixed(2)}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">
              SDK ${(overview.summary.totalRevenueCents / 100).toFixed(2)} · Ads ${(overview.summary.totalAdRevenueCents / 100).toFixed(2)}
            </p>
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
            <p className="text-xs text-slate-500">SDK Errors (24h)</p>
            <p className="mt-1 flex items-center gap-1.5 font-display text-2xl font-semibold tabular-nums">
              <ShieldAlert className={`h-5 w-5 ${overview.summary.errors24h > 0 ? 'text-red-600' : 'text-emerald-600'}`} />
              {overview.summary.errors24h}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-500">Isolated per-app error tracking</p>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={dirSearch}
          onChange={(e) => setDirSearch(e.target.value)}
          placeholder="Search app name, App UID, package, or domain..."
          aria-label="Search connected apps"
          className="h-9 min-w-[220px] flex-1 rounded-lg border border-slate-200 bg-white px-3 text-xs dark:border-slate-700 dark:bg-slate-900"
        />
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-900">
          {(['all', 'android', 'game', 'website', 'ios', 'api'] as const).map((plat) => (
            <button
              key={plat}
              type="button"
              onClick={() => setDirPlatform(plat)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize ${
                dirPlatform === plat
                  ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                  : 'text-slate-600 dark:text-slate-400'
              }`}
            >
              {plat}
            </button>
          ))}
        </div>
      </div>

      {/* Connected Apps List */}
      {dirLoading && !overview ? (
        <div className="h-40 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
      ) : filteredApps.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center dark:border-slate-800 dark:bg-slate-900">
          <Activity className="mx-auto h-7 w-7 text-slate-400" />
          <p className="mt-3 font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
            No Connected Applications Yet
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Connect your first Android app, game, or website to manage isolated users, feature flags, AdMob units, and SDK keys.
          </p>
          {hasPerm('apps.manage') && (
            <button
              type="button"
              onClick={() => onNavigate('apps-connect')}
              className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-xs font-medium text-white"
            >
              <Plus className="h-4 w-4" />
              Connect First App
            </button>
          )}
        </div>
      ) : (
        <div className="divide-y divide-slate-200 rounded-xl border border-slate-200 bg-white dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
          {filteredApps.map((app) => {
            const isScoped = selectedAppId === app.id;
            return (
              <div key={app.id} className="flex flex-wrap items-center justify-between gap-4 p-4 text-xs">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                      {app.name}
                    </span>
                    <span className="text-slate-500 capitalize">
                      {app.platform} · v{app.currentVersion} · {app.status}
                    </span>
                    {isScoped && (
                      <span className="font-medium text-blue-600 dark:text-blue-400">
                        · Active Scope
                      </span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-slate-500">
                    {app.appUid} {app.packageOrDomain ? `· ${app.packageOrDomain}` : ''} ·{' '}
                    {app.stats.totalUsers} users ({app.stats.bannedUsers} banned) · {app.stats.activeKeysCount} active keys ·{' '}
                    Ads ${(app.stats.adRevenueCents / 100).toFixed(2)} · {app.stats.errors24h} errors
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAppId(isScoped ? 'all' : app.id);
                      pushToast({
                        type: 'info',
                        title: isScoped ? 'Switched workspace to All Apps' : `Workspace scoped to ${app.name}`,
                      });
                    }}
                    className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 font-medium ${
                      isScoped
                        ? 'border-blue-600 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-950/40 dark:text-blue-300'
                        : 'border-slate-200 hover:bg-slate-50 dark:border-slate-700'
                    }`}
                  >
                    <Layers className="h-3.5 w-3.5" />
                    {isScoped ? 'Clear Scope' : 'Scope App'}
                  </button>

                  {hasPerm('apps.manage') && (
                    <>
                      <button
                        type="button"
                        onClick={async () => {
                          const nextStatus = app.status === 'connected' ? 'disconnected' : 'connected';
                          await apiRequest(`/apps/${app.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ status: nextStatus }),
                          });
                          pushToast({ type: 'success', title: `${app.name} is now ${nextStatus}` });
                          await loadOverview();
                          await refreshApps();
                        }}
                        className="rounded-lg border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50 dark:border-slate-700"
                      >
                        {app.status === 'connected' ? 'Disconnect' : 'Connect'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingApp(app)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50 dark:border-slate-700"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                        Edit
                      </button>
                    </>
                  )}

                  <button
                    type="button"
                    onClick={() =>
                      void downloadWithAuth(`/apps/${app.id}/export?format=json`, `${app.slug}-export.json`)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50 dark:border-slate-700"
                  >
                    <Download className="h-3.5 w-3.5" />
                    JSON
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadWithAuth(`/apps/${app.id}/export?format=csv`, `${app.slug}-users.csv`)
                    }
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 hover:bg-slate-50 dark:border-slate-700"
                  >
                    CSV
                  </button>

                  {hasPerm('apps.manage') && (
                    <button
                      type="button"
                      aria-label={`Delete ${app.name}`}
                      onClick={() => setDeleteAppTarget(app)}
                      className="rounded-lg border border-red-200 p-1.5 text-red-600 hover:bg-red-50 dark:border-red-900"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Edit App Modal */}
      {editingApp && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <form
            onSubmit={handleSaveEditApp}
            className="w-full max-w-lg space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <h2 className="font-display text-base font-semibold">Edit App: {editingApp.name}</h2>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium">Name</label>
                <input
                  required
                  value={editingApp.name}
                  onChange={(e) => setEditingApp({ ...editingApp, name: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Connection Status</label>
                <select
                  value={editingApp.status}
                  onChange={(e) => setEditingApp({ ...editingApp, status: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                >
                  <option value="connected">Connected</option>
                  <option value="maintenance">Maintenance Mode</option>
                  <option value="disconnected">Disconnected</option>
                </select>
              </div>
              <div>
                <label className="block font-medium">Current Version</label>
                <input
                  value={editingApp.currentVersion}
                  onChange={(e) => setEditingApp({ ...editingApp, currentVersion: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div>
                <label className="block font-medium">Min Supported Version</label>
                <input
                  value={editingApp.minSupportedVersion}
                  onChange={(e) => setEditingApp({ ...editingApp, minSupportedVersion: e.target.value })}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium">Package / Domain</label>
              <input
                value={editingApp.packageOrDomain}
                onChange={(e) => setEditingApp({ ...editingApp, packageOrDomain: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium">AdMob App ID</label>
              <input
                value={editingApp.admobAppId}
                onChange={(e) => setEditingApp({ ...editingApp, admobAppId: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div>
              <label className="block font-medium">Maintenance Message</label>
              <input
                value={editingApp.maintenanceMessage}
                onChange={(e) => setEditingApp({ ...editingApp, maintenanceMessage: e.target.value })}
                className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
            </div>
            <div className="flex flex-wrap gap-4 pt-1">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editingApp.forceUpdate}
                  onChange={(e) => setEditingApp({ ...editingApp, forceUpdate: e.target.checked })}
                />
                <span>Force Minimum Version Update</span>
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={editingApp.adsEnabled}
                  onChange={(e) => setEditingApp({ ...editingApp, adsEnabled: e.target.checked })}
                />
                <span>Enable Ads SDK</span>
              </label>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setEditingApp(null)} className="rounded-lg border border-slate-200 px-3 py-1.5">
                Cancel
              </button>
              <button type="submit" className="rounded-lg bg-blue-600 px-4 py-1.5 font-medium text-white">
                Save Changes
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteAppTarget)}
        title="Delete Connected App"
        description={`Remove "${deleteAppTarget?.name}" (${deleteAppTarget?.appUid}) and revoke its API keys & end-users? Financial & audit logs remain safely preserved.`}
        destructive
        onConfirm={async () => {
          if (!deleteAppTarget) return;
          await apiRequest(`/apps/${deleteAppTarget.id}`, { method: 'DELETE' });
          pushToast({ type: 'success', title: `Deleted ${deleteAppTarget.name}` });
          if (selectedAppId === deleteAppTarget.id) setSelectedAppId('all');
          setDeleteAppTarget(null);
          await loadOverview();
          await refreshApps();
        }}
        onCancel={() => setDeleteAppTarget(null)}
      />
    </div>
  );
};
