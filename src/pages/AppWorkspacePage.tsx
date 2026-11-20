import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Check,
  Copy,
  Database,
  Download,
  Edit3,
  FileUp,
  Flag,
  KeyRound,
  Megaphone,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sliders,
  Terminal,
  Trash2,
  Users,
  Zap,
} from 'lucide-react';
import { ConfirmDialog } from '../components/common/ConfirmDialog';
import { useToast } from '../components/common/Toast';
import { useAppScope, type ConnectedAppRecord } from '../contexts/AppScopeContext';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest, downloadWithAuth } from '../lib/api';

interface CollectionFieldSpec {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'json';
  required: boolean;
}

interface WorkspaceCollection {
  id: number;
  appId: number;
  slug: string;
  name: string;
  description: string;
  fieldsJson: CollectionFieldSpec[];
  migrationSql: string;
  recordCount: number;
}

interface WorkspaceModule {
  id: number;
  appId: number;
  moduleKey: string;
  name: string;
  category: string;
  status: string;
  migrationSql: string;
  generatedCode: string;
  apiEndpoints: Array<{ method: string; path: string; scope?: string }>;
}

interface WorkspaceRecordRow {
  id: number;
  appId: number;
  collectionId: number;
  recordUid: string;
  dataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceResponse {
  app: ConnectedAppRecord & {
    backendNamespace: string;
    integrationMode: string;
    backendBaseUrl: string;
    manifestUrl: string;
    syncStatus: string;
    discoveredCapabilities?: {
      fullControlAvailable?: boolean;
      controlLevel?: string;
      honestySummary?: string;
      verifiedCapabilities?: string[];
      missingCapabilities?: string[];
      discoveredEndpoints?: Array<{ method: string; path: string; summary: string; verified: boolean }>;
    };
    enabledModules?: string[];
  };
  stats: {
    endUsersCount: number;
    activeUsersCount: number;
    bannedUsersCount: number;
    collectionsCount: number;
    modulesCount: number;
    filesCount: number;
    activeKeysCount: number;
    announcementsCount?: number;
    heartbeatsCount?: number;
    revenueCents: number;
    txCount: number;
    adRevenueCents: number;
  };
  modules: WorkspaceModule[];
  collections: WorkspaceCollection[];
  keys: Array<{
    id: number;
    name: string;
    keyPrefix: string;
    scopes: string[];
    isActive: boolean;
    lastUsedAt: string | null;
    expiresAt: string | null;
    createdAt: string;
  }>;
  endUsers: Array<{
    id: number;
    externalUserId: string;
    email: string;
    displayName: string;
    status: string;
    appVersion: string;
    deviceModel: string;
    totalSessions: number;
    lastActiveAt: string;
  }>;
  flags: Array<{
    id: number;
    key: string;
    name: string;
    description: string;
    isEnabled: boolean;
    rolloutPercentage: number;
  }>;
  releases: Array<{
    id: number;
    version: string;
    minSupportedVersion: string;
    forceUpdate: boolean;
    platform: string;
    releaseNotes: string;
    status: string;
    createdAt: string;
  }>;
  ads: Array<{
    id: number;
    name: string;
    network: string;
    adFormat: string;
    placement: string;
    admobUnitId: string;
    isEnabled: boolean;
    impressions: number;
    revenueCents: number;
  }>;
  files: Array<{
    id: number;
    originalName: string;
    mimeType: string;
    sizeBytes: number;
    category: string;
    storageNamespace: string;
    checksumSha256: string;
    createdAt: string;
  }>;
  webhooks: Array<{
    id: number;
    name: string;
    targetUrl: string;
    events: string[];
    isActive: boolean;
    lastStatusCode: number | null;
  }>;
  backups: Array<{
    id: number;
    filename: string;
    status: string;
    sizeBytes: number;
    rowCount: number;
    checksumSha256: string;
    createdAt: string;
  }>;
  recentEvents: Array<{
    id: number;
    eventType: string;
    eventName: string;
    severity: string;
    createdAt: string;
  }>;
  announcements?: Array<{
    id: number;
    appId: number;
    package_name: string;
    title: string;
    body: string;
    active: 0 | 1;
    priority: number;
    action_url: string;
    expires_at: string | null;
    created_at: string;
    updated_at: string;
  }>;
  remoteConfig?: {
    appId: number;
    package_name: string;
    app_uid: string;
    app_name: string;
    platform: string;
    status: string;
    maintenance: boolean;
    kill_switch: boolean;
    maintenance_message: string;
    require_sdk_key: boolean;
    version_gate: {
      current_version: string;
      min_supported_version: string;
      force_update: boolean;
    };
    banner: {
      enabled: boolean;
      title: string;
      message: string;
      cta_label: string;
      cta_url: string;
      image_url: string;
    };
    ads: {
      enabled: boolean;
      admob_app_id: string;
    };
    flags: Record<string, string | number | boolean>;
    updated_at: string;
  };
  heartbeats?: Array<{
    id: number;
    appId: number;
    package_name: string;
    version_name: string;
    version_code: number;
    platform: string;
    status: string;
    event: string;
    payload: Record<string, unknown>;
    ip_address: string;
    last_seen_at: string;
  }>;
  integrationSnippets: {
    curl: string;
    website: string;
    android: string;
    unity: string;
    ios: string;
  };
}

type WorkspaceTab =
  | 'overview'
  | 'announcements'
  | 'collections'
  | 'users'
  | 'config'
  | 'storage'
  | 'sdk'
  | 'backups';

const SCOPE_OPTIONS = [
  'config:read',
  'users:write',
  'events:write',
  'commerce:write',
  'data:read',
  'data:write',
  'storage:write',
  'admin:sync',
] as const;

export const AppWorkspacePage: React.FC<{
  appId: number;
  onBack: () => void;
  onNavigate: (viewId: string) => void;
}> = ({ appId, onBack, onNavigate }) => {
  const { hasPerm } = useAuth();
  const { pushToast } = useToast();
  const { refreshApps, setSelectedAppId } = useAppScope();

  const [tab, setTab] = useState<WorkspaceTab>('overview');
  const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Sync & quick controls
  const [syncingControls, setSyncingControls] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
  const [editPackageName, setEditPackageName] = useState('');
  const [editVersion, setEditVersion] = useState('');
  const [editMinVersion, setEditMinVersion] = useState('');
  const [editForceUpdate, setEditForceUpdate] = useState(false);
  const [editAdsEnabled, setEditAdsEnabled] = useState(true);
  const [editBackendUrl, setEditBackendUrl] = useState('');
  const [editMaintenanceMsg, setEditMaintenanceMsg] = useState('');
  const [savingControls, setSavingControls] = useState(false);

  // Two-way Announcements, Remote Config Flags & Heartbeats
  const [annTitle, setAnnTitle] = useState('');
  const [annBody, setAnnBody] = useState('');
  const [annPriority, setAnnPriority] = useState('10');
  const [annActionUrl, setAnnActionUrl] = useState('');
  const [annActive, setAnnActive] = useState(true);
  const [editingAnnId, setEditingAnnId] = useState<number | null>(null);
  const [savingAnn, setSavingAnn] = useState(false);

  const [rcMaintenance, setRcMaintenance] = useState(false);
  const [rcKillSwitch, setRcKillSwitch] = useState(false);
  const [rcRequireKey, setRcRequireKey] = useState(false);
  const [rcMaintenanceMsg, setRcMaintenanceMsg] = useState('');
  const [rcBannerEnabled, setRcBannerEnabled] = useState(false);
  const [rcBannerTitle, setRcBannerTitle] = useState('');
  const [rcBannerMessage, setRcBannerMessage] = useState('');
  const [rcBannerCtaLabel, setRcBannerCtaLabel] = useState('');
  const [rcBannerCtaUrl, setRcBannerCtaUrl] = useState('');
  const [rcFlagRows, setRcFlagRows] = useState<Array<{ key: string; value: string }>>([]);
  const [newRcFlagKey, setNewRcFlagKey] = useState('');
  const [newRcFlagVal, setNewRcFlagVal] = useState('true');
  const [savingRemoteConfig, setSavingRemoteConfig] = useState(false);
  const [sendingTestHeartbeat, setSendingTestHeartbeat] = useState(false);

  // Collections & Module Generator
  const [activeCollectionSlug, setActiveCollectionSlug] = useState<string>('');
  const [collectionRecords, setCollectionRecords] = useState<WorkspaceRecordRow[]>([]);
  const [recordsLoading, setRecordsLoading] = useState(false);
  const [showDdl, setShowDdl] = useState(false);
  const [recordForm, setRecordForm] = useState<Record<string, string>>({});
  const [editingRecordId, setEditingRecordId] = useState<number | null>(null);
  const [recordSearch, setRecordSearch] = useState('');
  const [recordCategoryFilter, setRecordCategoryFilter] = useState('all');
  const [recordPublishFilter, setRecordPublishFilter] = useState<'all' | 'published' | 'draft'>('all');
  const [addingRecord, setAddingRecord] = useState(false);

  const [modName, setModName] = useState('');
  const [modCategory, setModCategory] = useState('custom');
  const [modFieldsText, setModFieldsText] = useState('title:text, score:number, active:boolean');
  const [generatingMod, setGeneratingMod] = useState(false);

  // End-Users
  const [newUserExtId, setNewUserExtId] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserName, setNewUserName] = useState('');
  const [addingEndUser, setAddingEndUser] = useState(false);

  // Flags & Releases
  const [flagKey, setFlagKey] = useState('');
  const [flagName, setFlagName] = useState('');
  const [relVersion, setRelVersion] = useState('');
  const [relMinVersion, setRelMinVersion] = useState('');
  const [relForce, setRelForce] = useState(false);
  const [relNotes, setRelNotes] = useState('');

  // Storage
  const [uploadingFile, setUploadingFile] = useState(false);

  // SDK Keys & Live Verifier
  const [newKeyLabel, setNewKeyLabel] = useState('Client Runtime Key');
  const [newKeyScopes, setNewKeyScopes] = useState<string[]>([...SCOPE_OPTIONS]);
  const [issuedKeyOnce, setIssuedKeyOnce] = useState<string | null>(null);
  const [testSdkKey, setTestSdkKey] = useState('');
  const [sdkResult, setSdkResult] = useState<string | null>(null);
  const [sdkRunning, setSdkRunning] = useState(false);
  const [snippetLang, setSnippetLang] = useState<'website' | 'android' | 'unity' | 'ios' | 'curl'>('website');

  // Backups & Confirmations
  const [creatingBackup, setCreatingBackup] = useState(false);
  const [restoreTargetId, setRestoreTargetId] = useState<number | null>(null);
  const [confirmDeleteApp, setConfirmDeleteApp] = useState(false);

  const copyText = async (id: string, value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(id);
      pushToast({ type: 'success', title: `Copied ${label}` });
      setTimeout(() => setCopiedKey((prev) => (prev === id ? null : prev)), 1800);
    } catch {
      pushToast({ type: 'error', title: 'Clipboard permission denied' });
    }
  };

  const loadWorkspace = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await apiRequest<WorkspaceResponse>(`/apps/${appId}/workspace`);
      setWorkspace(data);
      setEditPackageName(data.app.packageName || data.app.packageOrDomain || '');
      setEditVersion(data.app.currentVersion);
      setEditMinVersion(data.app.minSupportedVersion);
      setEditForceUpdate(Boolean(data.app.forceUpdate));
      setEditAdsEnabled(Boolean(data.app.adsEnabled));
      setEditBackendUrl(data.app.backendBaseUrl || '');
      setEditMaintenanceMsg(data.app.maintenanceMessage || '');
      if (data.remoteConfig) {
        setRcMaintenance(Boolean(data.remoteConfig.maintenance));
        setRcKillSwitch(Boolean(data.remoteConfig.kill_switch));
        setRcRequireKey(Boolean(data.remoteConfig.require_sdk_key));
        setRcMaintenanceMsg(data.remoteConfig.maintenance_message || '');
        setRcBannerEnabled(Boolean(data.remoteConfig.banner?.enabled));
        setRcBannerTitle(data.remoteConfig.banner?.title || '');
        setRcBannerMessage(data.remoteConfig.banner?.message || '');
        setRcBannerCtaLabel(data.remoteConfig.banner?.cta_label || '');
        setRcBannerCtaUrl(data.remoteConfig.banner?.cta_url || '');
        setRcFlagRows(
          Object.entries(data.remoteConfig.flags || {}).map(([key, val]) => ({
            key,
            value: String(val),
          }))
        );
      }
      if (data.app.platform === 'unity' || data.app.platform === 'game') setSnippetLang('unity');
      else if (data.app.platform === 'android') setSnippetLang('android');
      else if (data.app.platform === 'ios') setSnippetLang('ios');
      else if (data.app.platform === 'api') setSnippetLang('curl');
      else setSnippetLang('website');
      if (data.collections.length > 0) {
        setActiveCollectionSlug((prev) =>
          prev && data.collections.some((c) => c.slug === prev) ? prev : data.collections[0].slug
        );
      } else {
        setActiveCollectionSlug('');
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load app workspace');
    } finally {
      setLoading(false);
    }
  }, [appId]);

  const loadCollectionRecords = useCallback(async () => {
    if (!activeCollectionSlug) {
      setCollectionRecords([]);
      return;
    }
    setRecordsLoading(true);
    try {
      const res = await apiRequest<{ data: WorkspaceRecordRow[] }>(
        `/apps/${appId}/collections/${activeCollectionSlug}/records`
      );
      setCollectionRecords(res.data);
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not load collection records',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setRecordsLoading(false);
    }
  }, [appId, activeCollectionSlug, pushToast]);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  useEffect(() => {
    setEditingRecordId(null);
    setRecordForm({});
    setRecordSearch('');
    setRecordCategoryFilter('all');
    setRecordPublishFilter('all');
    if (activeCollectionSlug) {
      void loadCollectionRecords();
    }
  }, [activeCollectionSlug, loadCollectionRecords]);

  if (loading && !workspace) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
        <div className="h-72 animate-pulse rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" />
      </div>
    );
  }

  if (loadError || !workspace) {
    return (
      <div className="rounded-xl border border-red-200 bg-white p-8 text-center dark:border-red-900 dark:bg-slate-900">
        <ShieldAlert className="mx-auto h-7 w-7 text-red-600" />
        <h2 className="mt-3 font-display text-base font-semibold text-slate-900 dark:text-slate-100">
          Could not open application control workspace
        </h2>
        <p className="mt-1 text-xs text-slate-500">{loadError || 'Application not found.'}</p>
        <button
          type="button"
          onClick={onBack}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 py-2 text-xs font-medium dark:border-slate-700"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Back to Apps Directory
        </button>
      </div>
    );
  }

  const { app, stats, modules, collections, keys, endUsers, flags, releases, ads, files, backups, recentEvents } =
    workspace;
  const announcements = workspace.announcements || [];
  const heartbeats = workspace.heartbeats || [];
  const canonicalPackageName = app.packageName || app.packageOrDomain || app.appUid;
  const cap = app.discoveredCapabilities;
  const activeCollection = collections.find((c) => c.slug === activeCollectionSlug) || null;
  const isMaintenance = app.status === 'maintenance';
  const isGamePlatform = app.platform === 'unity' || app.platform === 'game';
  const canManageAppScoped = hasPerm('app.manage') || hasPerm('apps.manage');

  const handleToggleMaintenance = async () => {
    const nextStatus = isMaintenance ? 'connected' : 'maintenance';
    try {
      await apiRequest(`/apps/${app.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      pushToast({
        type: 'success',
        title: `${app.name} is now ${nextStatus === 'maintenance' ? 'in Maintenance Mode' : 'Connected'}`,
      });
      await loadWorkspace();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Status update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleControlSync = async () => {
    setSyncingControls(true);
    setSyncFeedback(null);
    try {
      const res = await apiRequest<{
        syncStatus: string;
        externalSyncResult: { ok: boolean; statusCode: number | null; message: string };
      }>(`/apps/${app.id}/control-sync`, { method: 'POST', body: JSON.stringify({}) });
      setSyncFeedback(res.externalSyncResult.message);
      pushToast({
        type: res.externalSyncResult.ok ? 'success' : 'info',
        title: `Sync ${res.syncStatus}`,
        description: res.externalSyncResult.message,
      });
      await loadWorkspace();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Control sync failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSyncingControls(false);
    }
  };

  const handleSaveRuntimeControls = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingControls(true);
    try {
      await apiRequest(`/apps/${app.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          packageName: editPackageName.trim(),
          currentVersion: editVersion,
          minSupportedVersion: editMinVersion,
          forceUpdate: editForceUpdate,
          adsEnabled: editAdsEnabled,
          backendBaseUrl: editBackendUrl,
          maintenanceMessage: editMaintenanceMsg,
        }),
      });
      pushToast({ type: 'success', title: 'Application runtime controls saved' });
      await loadWorkspace();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not save controls',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingControls(false);
    }
  };

  const handleSaveAnnouncement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!annTitle.trim() || !annBody.trim()) return;
    setSavingAnn(true);
    try {
      const payload = {
        title: annTitle.trim(),
        body: annBody.trim(),
        priority: Number(annPriority) || 0,
        action_url: annActionUrl.trim(),
        active: annActive ? 1 : 0,
      };
      if (editingAnnId !== null) {
        await apiRequest(`/apps/${app.id}/announcements/${editingAnnId}`, {
          method: 'PATCH',
          body: JSON.stringify(payload),
        });
        pushToast({ type: 'success', title: 'Announcement updated' });
      } else {
        await apiRequest(`/apps/${app.id}/announcements`, {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        pushToast({ type: 'success', title: 'Announcement published' });
      }
      setAnnTitle('');
      setAnnBody('');
      setAnnPriority('10');
      setAnnActionUrl('');
      setAnnActive(true);
      setEditingAnnId(null);
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not save announcement',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingAnn(false);
    }
  };

  const handleToggleAnnouncementActive = async (annId: number, currentActive: 0 | 1) => {
    const nextActive = currentActive === 1 ? 0 : 1;
    try {
      await apiRequest(`/apps/${app.id}/announcements/${annId}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: nextActive }),
      });
      pushToast({
        type: 'success',
        title: nextActive === 1 ? 'Announcement activated (active=1)' : 'Announcement paused (active=0)',
      });
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to toggle announcement',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleDeleteAnnouncement = async (annId: number) => {
    try {
      await apiRequest(`/apps/${app.id}/announcements/${annId}`, { method: 'DELETE' });
      if (editingAnnId === annId) {
        setEditingAnnId(null);
        setAnnTitle('');
        setAnnBody('');
      }
      pushToast({ type: 'success', title: 'Announcement deleted' });
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to delete announcement',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleSaveRemoteConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRemoteConfig(true);
    try {
      const parsedFlags: Record<string, string | number | boolean> = {};
      for (const row of rcFlagRows) {
        const cleanKey = row.key.trim();
        if (!cleanKey) continue;
        const raw = row.value.trim();
        if (raw === 'true') parsedFlags[cleanKey] = true;
        else if (raw === 'false') parsedFlags[cleanKey] = false;
        else if (raw !== '' && !Number.isNaN(Number(raw))) parsedFlags[cleanKey] = Number(raw);
        else parsedFlags[cleanKey] = raw;
      }

      await apiRequest(`/apps/${app.id}/remote-config`, {
        method: 'PUT',
        body: JSON.stringify({
          maintenance: rcMaintenance,
          kill_switch: rcKillSwitch,
          require_sdk_key: rcRequireKey,
          maintenance_message: rcMaintenanceMsg.trim(),
          banner: {
            enabled: rcBannerEnabled,
            title: rcBannerTitle.trim(),
            message: rcBannerMessage.trim(),
            cta_label: rcBannerCtaLabel.trim(),
            cta_url: rcBannerCtaUrl.trim(),
          },
          flags: parsedFlags,
        }),
      });
      pushToast({
        type: 'success',
        title: `Remote config synced for ${canonicalPackageName}`,
      });
      await loadWorkspace();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Remote config update failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSavingRemoteConfig(false);
    }
  };

  const handleSendTestHeartbeat = async () => {
    setSendingTestHeartbeat(true);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'X-Package-Name': canonicalPackageName,
      };
      if (testSdkKey.trim()) {
        headers['X-API-Key'] = testSdkKey.trim();
        headers['X-App-Id'] = app.appUid;
      }
      const res = await fetch('/api/v1/sdk/heartbeat', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          package_name: canonicalPackageName,
          version_name: app.currentVersion || '1.0.0',
          version_code: 1,
          platform: app.platform || 'android',
          last_seen_at: Date.now(),
          status: 'online',
          event: 'admin_probe',
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        throw new Error(json.error || `HTTP ${res.status}`);
      }
      pushToast({
        type: 'success',
        title: `Heartbeat recorded for ${canonicalPackageName}`,
      });
      await loadWorkspace();
      await refreshApps();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Test heartbeat failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSendingTestHeartbeat(false);
    }
  };

  const handleGenerateModule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modName.trim()) return;
    setGeneratingMod(true);
    try {
      const parsedFields: CollectionFieldSpec[] = modFieldsText
        .split(',')
        .map((chunk) => chunk.trim())
        .filter(Boolean)
        .map((chunk) => {
          const [rawName, rawType] = chunk.split(':').map((s) => s.trim());
          const cleanName = rawName.toLowerCase().replace(/[^a-z0-9_]+/g, '_') || 'field';
          const lowerType = (rawType || 'text').toLowerCase();
          const type: CollectionFieldSpec['type'] =
            lowerType === 'number' || lowerType === 'int'
              ? 'number'
              : lowerType === 'boolean' || lowerType === 'bool'
                ? 'boolean'
                : lowerType === 'json'
                  ? 'json'
                  : 'text';
          return {
            name: cleanName,
            label: cleanName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
            type,
            required: cleanName === 'title' || cleanName === 'name' || cleanName === 'player_name',
          };
        });

      const res = await apiRequest<{ collection?: { slug: string } }>(`/apps/${app.id}/modules/generate`, {
        method: 'POST',
        body: JSON.stringify({
          name: modName.trim(),
          category: modCategory,
          createCollection: true,
          fields: parsedFields,
        }),
      });
      setModName('');
      pushToast({ type: 'success', title: `Provisioned isolated module & D1 schema` });
      await loadWorkspace();
      if (res.collection?.slug) {
        setActiveCollectionSlug(res.collection.slug);
      }
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Module generation failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setGeneratingMod(false);
    }
  };

  const startEditCollectionRecord = (rec: WorkspaceRecordRow) => {
    if (!activeCollection) return;
    const nextForm: Record<string, string> = {};
    for (const f of activeCollection.fieldsJson) {
      const val = rec.dataJson?.[f.name];
      if (f.type === 'json') {
        nextForm[f.name] = typeof val === 'object' && val !== null ? JSON.stringify(val) : String(val ?? '');
      } else if (f.type === 'boolean') {
        nextForm[f.name] = val === true || val === 'true' || val === 1 ? 'true' : 'false';
      } else {
        nextForm[f.name] = val !== undefined && val !== null ? String(val) : '';
      }
    }
    setRecordForm(nextForm);
    setEditingRecordId(rec.id);
  };

  const handleSaveCollectionRecord = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeCollection) return;
    setAddingRecord(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const f of activeCollection.fieldsJson) {
        const rawVal = recordForm[f.name] ?? '';
        if (f.type === 'number') {
          payload[f.name] = rawVal === '' ? 0 : Number(rawVal);
        } else if (f.type === 'boolean') {
          payload[f.name] = rawVal === 'true' || rawVal === '1' || rawVal === 'yes';
        } else if (f.type === 'json') {
          try {
            payload[f.name] = rawVal.trim() ? JSON.parse(rawVal) : {};
          } catch {
            payload[f.name] = rawVal;
          }
        } else {
          payload[f.name] = rawVal;
        }
      }

      if (editingRecordId !== null) {
        await apiRequest(`/apps/${app.id}/collections/${activeCollection.slug}/records/${editingRecordId}`, {
          method: 'PATCH',
          body: JSON.stringify({ data: payload }),
        });
        pushToast({ type: 'success', title: `Updated record in ${activeCollection.name}` });
      } else {
        await apiRequest(`/apps/${app.id}/collections/${activeCollection.slug}/records`, {
          method: 'POST',
          body: JSON.stringify({ data: payload }),
        });
        pushToast({ type: 'success', title: `Saved record to ${activeCollection.name}` });
      }
      setRecordForm({});
      setEditingRecordId(null);
      await loadCollectionRecords();
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to save record',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAddingRecord(false);
    }
  };

  const handleToggleRecordPublished = async (rec: WorkspaceRecordRow) => {
    if (!activeCollection) return;
    const currentPub = rec.dataJson?.published === true || rec.dataJson?.published === 'true';
    try {
      await apiRequest(`/apps/${app.id}/collections/${activeCollection.slug}/records/${rec.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            ...(rec.dataJson || {}),
            published: !currentPub,
          },
        }),
      });
      pushToast({
        type: 'success',
        title: !currentPub ? 'Record published to SDK' : 'Record moved to draft',
      });
      await loadCollectionRecords();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Failed to update publish status',
        description: err instanceof Error ? err.message : undefined,
      });
    }
  };

  const handleAddEndUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddingEndUser(true);
    try {
      await apiRequest(`/apps/${app.id}/users`, {
        method: 'POST',
        body: JSON.stringify({
          externalUserId: newUserExtId.trim() || undefined,
          email: newUserEmail.trim(),
          displayName: newUserName.trim(),
        }),
      });
      setNewUserExtId('');
      setNewUserEmail('');
      setNewUserName('');
      pushToast({ type: 'success', title: 'End-user registered in app namespace' });
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Could not register end-user',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setAddingEndUser(false);
    }
  };

  const handleUploadFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 750 * 1024) {
      pushToast({ type: 'error', title: 'File exceeds 750 KB D1 inline limit' });
      e.target.value = '';
      return;
    }
    setUploadingFile(true);
    try {
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('File read error'));
        reader.readAsDataURL(file);
      });
      await apiRequest('/files/upload', {
        method: 'POST',
        body: JSON.stringify({
          appId: app.id,
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          base64Data,
        }),
      });
      pushToast({ type: 'success', title: `Uploaded ${file.name} to ${app.backendNamespace}` });
      await loadWorkspace();
    } catch (err) {
      pushToast({
        type: 'error',
        title: 'Upload failed',
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setUploadingFile(false);
      e.target.value = '';
    }
  };

  const handleRunSdkVerifier = async (
    endpoint: 'config' | 'data' | 'announcements' | 'remote-config'
  ) => {
    const keyToUse = testSdkKey.trim();
    if ((endpoint === 'config' || endpoint === 'data') && !keyToUse) {
      pushToast({ type: 'error', title: 'Paste an active plaintext API key to run this SDK check' });
      return;
    }
    setSdkRunning(true);
    setSdkResult(null);
    const encodedPkg = encodeURIComponent(canonicalPackageName);
    const targetUrl =
      endpoint === 'config'
        ? `/api/v1/sdk/config?package_name=${encodedPkg}`
        : endpoint === 'announcements'
          ? `/api/v1/sdk/announcements?package_name=${encodedPkg}&active=1`
          : endpoint === 'remote-config'
            ? `/api/v1/sdk/remote-config?package_name=${encodedPkg}`
            : `/api/v1/sdk/data/${activeCollectionSlug || collections[0]?.slug || 'leaderboard'}`;
    try {
      const reqHeaders: Record<string, string> = {
        'X-Package-Name': canonicalPackageName,
      };
      if (keyToUse) {
        reqHeaders['X-App-Id'] = app.appUid;
        reqHeaders['X-API-Key'] = keyToUse;
      }
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: reqHeaders,
      });
      const text = await res.text();
      let formatted = text;
      try {
        formatted = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        // leave plain text
      }
      setSdkResult(`GET ${targetUrl} -> HTTP ${res.status}\n${formatted}`);
      pushToast({
        type: res.ok ? 'success' : 'error',
        title: res.ok ? `SDK verified (HTTP ${res.status})` : `SDK returned HTTP ${res.status}`,
      });
    } catch (err) {
      setSdkResult(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setSdkRunning(false);
    }
  };

  const tabItems: Array<{ id: WorkspaceTab; label: string }> = [
    { id: 'overview', label: 'Overview & Controls' },
    { id: 'announcements', label: `Announcements & Remote (${announcements.length})` },
    { id: 'collections', label: `Collections & Backend (${collections.length})` },
    { id: 'users', label: `${isGamePlatform ? 'Players' : 'End-Users'} (${stats.endUsersCount})` },
    { id: 'config', label: `Flags & Releases (${flags.length + releases.length})` },
    { id: 'storage', label: `Storage (${stats.filesCount})` },
    { id: 'sdk', label: `SDK & Keys (${stats.activeKeysCount})` },
    { id: 'backups', label: `Backups (${backups.length})` },
  ];

  return (
    <div className="space-y-6">
      {/* Workspace Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Apps Directory
          </button>
          <h1 className="font-display text-2xl font-semibold text-slate-900 dark:text-slate-100">
            {app.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs text-slate-500 dark:text-slate-400">
            <span className="capitalize">{app.platform}</span>
            <span aria-hidden="true">·</span>
            <span className="font-semibold text-slate-800 dark:text-slate-200">{canonicalPackageName}</span>
            <span aria-hidden="true">·</span>
            <span>{app.appUid}</span>
            <span aria-hidden="true">·</span>
            <span>{app.backendNamespace}</span>
            <span aria-hidden="true">·</span>
            <span className="capitalize">{app.integrationMode.replace('_', ' ')}</span>
            <span aria-hidden="true">·</span>
            <span
              className={
                app.syncStatus === 'verified'
                  ? 'font-medium text-emerald-700 dark:text-emerald-400'
                  : 'font-medium text-amber-700 dark:text-amber-400'
              }
            >
              Sync: {app.syncStatus}
            </span>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {hasPerm('apps.manage') && (
            <>
              <button
                type="button"
                onClick={() => void handleToggleMaintenance()}
                className={`inline-flex h-9 items-center gap-1.5 rounded-lg border px-3.5 text-xs font-medium whitespace-nowrap shrink-0 ${
                  isMaintenance
                    ? 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200'
                }`}
              >
                {isMaintenance ? 'Exit Maintenance' : 'Maintenance Mode'}
              </button>
              <button
                type="button"
                disabled={syncingControls}
                onClick={() => void handleControlSync()}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <RotateCw className={`h-3.5 w-3.5 ${syncingControls ? 'animate-spin' : ''}`} />
                {syncingControls ? 'Syncing...' : 'Sync Controls'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Honest Control Capability Notice */}
      {(cap?.honestySummary || syncFeedback) && (
        <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
          <div className="flex items-start gap-2.5">
            {cap?.fullControlAvailable !== false ? (
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <div className="space-y-1">
              <p className="font-medium text-slate-900 dark:text-slate-100">
                {syncFeedback || cap?.honestySummary}
              </p>
              {cap?.missingCapabilities && cap.missingCapabilities.length > 0 && (
                <p className="text-slate-600 dark:text-slate-400">
                  Unverified remote permissions: {cap.missingCapabilities.join(' · ')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Single-Row Workspace Tab Navigation */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-800 dark:bg-slate-900">
        {tabItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors ${
              tab === item.id
                ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                : 'text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {/* TAB 1: OVERVIEW & CONTROLS */}
      {tab === 'overview' && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">{isGamePlatform ? 'Registered Players' : 'End-Users'}</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
                {stats.endUsersCount}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                {stats.activeUsersCount} active · {stats.bannedUsersCount} banned
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">Isolated Collections & Modules</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
                {stats.collectionsCount} / {stats.modulesCount}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                Namespace {app.backendNamespace}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">App Revenue (SDK + Ads)</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums">
                ${((stats.revenueCents + stats.adRevenueCents) / 100).toFixed(2)}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                {stats.txCount} tx · Ads ${(stats.adRevenueCents / 100).toFixed(2)}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <p className="text-xs text-slate-500">SDK Version & Keys</p>
              <p className="mt-1 font-display text-2xl font-semibold font-mono tabular-nums">
                v{app.currentVersion}
              </p>
              <p className="mt-0.5 text-[11px] text-slate-500 tabular-nums">
                {stats.activeKeysCount} active keys · min v{app.minSupportedVersion}
              </p>
            </div>
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            <form
              onSubmit={handleSaveRuntimeControls}
              className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900"
            >
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                App Runtime Configuration & External Backend Hook
              </h2>
              <div className="text-xs">
                <label className="block font-medium">Package Name (package_name) or Domain</label>
                <input
                  value={editPackageName}
                  onChange={(e) => setEditPackageName(e.target.value)}
                  placeholder="com.cyberking.candymindmatch"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2 text-xs">
                <div>
                  <label className="block font-medium">Current Version</label>
                  <input
                    value={editVersion}
                    onChange={(e) => setEditVersion(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label className="block font-medium">Min Supported Version</label>
                  <input
                    value={editMinVersion}
                    onChange={(e) => setEditMinVersion(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
              </div>
              <div className="text-xs">
                <label className="block font-medium">External Backend Sync URL (optional HTTPS)</label>
                <input
                  value={editBackendUrl}
                  onChange={(e) => setEditBackendUrl(e.target.value)}
                  placeholder="https://api.yourapp.com"
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="text-xs">
                <label className="block font-medium">Maintenance Message</label>
                <input
                  value={editMaintenanceMsg}
                  onChange={(e) => setEditMaintenanceMsg(e.target.value)}
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="flex flex-wrap gap-4 text-xs">
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editForceUpdate}
                    onChange={(e) => setEditForceUpdate(e.target.checked)}
                  />
                  <span>Force Update below Min Version</span>
                </label>
                <label className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={editAdsEnabled}
                    onChange={(e) => setEditAdsEnabled(e.target.checked)}
                  />
                  <span>Enable Ads SDK</span>
                </label>
              </div>
              {hasPerm('apps.manage') && (
                <button
                  type="submit"
                  disabled={savingControls}
                  className="h-9 rounded-lg bg-blue-600 px-4 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingControls ? 'Saving...' : 'Save App Controls'}
                </button>
              )}
            </form>

            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900">
              <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                Discovered Capabilities & Active Endpoints
              </h2>
              <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800 max-h-64 overflow-y-auto">
                {(cap?.discoveredEndpoints || []).length === 0 ? (
                  <p className="py-4 text-slate-500">Standard Aegis isolated SDK endpoints are active.</p>
                ) : (
                  (cap?.discoveredEndpoints || []).map((ep, idx) => (
                    <div key={`${ep.method}-${ep.path}-${idx}`} className="flex items-center justify-between gap-2 py-2">
                      <div className="min-w-0">
                        <span className="font-mono font-semibold text-blue-600 dark:text-blue-400">
                          {ep.method}
                        </span>{' '}
                        <span className="font-mono text-slate-800 dark:text-slate-200">{ep.path}</span>
                        <p className="text-[11px] text-slate-500 truncate">{ep.summary}</p>
                      </div>
                      <span
                        className={`shrink-0 text-[11px] font-medium ${
                          ep.verified ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600'
                        }`}
                      >
                        {ep.verified ? 'Verified' : 'Unverified'}
                      </span>
                    </div>
                  ))
                )}
              </div>
              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-300">Recent App Telemetry</h3>
                {recentEvents.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">No SDK events ingested yet.</p>
                ) : (
                  <div className="mt-1 max-h-28 space-y-1 overflow-y-auto font-mono text-[11px] text-slate-500">
                    {recentEvents.slice(0, 6).map((ev) => (
                      <div key={ev.id} className="flex justify-between">
                        <span>
                          [{ev.severity}] {ev.eventName}
                        </span>
                        <span className="tabular-nums">{new Date(ev.createdAt).toLocaleTimeString()}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      )}

      {/* TAB 1B: PACKAGE-SCOPED ANNOUNCEMENTS, REMOTE CONFIG & HEARTBEATS */}
      {tab === 'announcements' && (
        <div className="space-y-6">
          {/* Package Sync Endpoints Bar */}
          <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <div>
                <h2 className="font-display text-sm font-semibold text-slate-900 dark:text-slate-100">
                  Two-Way Package Sync Endpoints ({canonicalPackageName})
                </h2>
                <p className="text-slate-500">
                  CORS-enabled endpoints keyed by <code className="font-mono">package_name</code> for instant Android &amp; multi-app control.
                </p>
              </div>
              <button
                type="button"
                disabled={sendingTestHeartbeat}
                onClick={() => void handleSendTestHeartbeat()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-slate-900 px-3 font-medium text-white hover:bg-slate-800 disabled:opacity-50 dark:bg-blue-600"
              >
                <Activity className="h-3.5 w-3.5" />
                {sendingTestHeartbeat ? 'Sending...' : 'Send Test Heartbeat'}
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                {
                  id: 'ep-hb',
                  label: 'POST Heartbeat (App → Admin)',
                  value: `${window.location.origin}/api/v1/sdk/heartbeat`,
                },
                {
                  id: 'ep-ann',
                  label: 'GET Announcements (active=1)',
                  value: `${window.location.origin}/api/v1/sdk/announcements?package_name=${encodeURIComponent(canonicalPackageName)}&active=1`,
                },
                {
                  id: 'ep-rc',
                  label: 'GET Remote Config & Flags',
                  value: `${window.location.origin}/api/v1/sdk/remote-config?package_name=${encodeURIComponent(canonicalPackageName)}`,
                },
              ].map((ep) => (
                <div
                  key={ep.id}
                  className="flex min-w-0 items-center justify-between gap-2 overflow-hidden rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-950"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-slate-500">{ep.label}</p>
                    <code className="block truncate font-mono text-[11px] text-slate-800 dark:text-slate-200">
                      {ep.value}
                    </code>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText(ep.id, ep.value, ep.label)}
                    className="shrink-0 rounded border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                    aria-label={`Copy ${ep.label}`}
                  >
                    {copiedKey === ep.id ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              ))}
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-12">
            {/* Announcements CRUD Column */}
            <section className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-xs lg:col-span-6 dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Megaphone className="h-4 w-4 text-blue-600" />
                  <h2 className="font-display text-sm font-semibold">
                    App Announcements ({announcements.length})
                  </h2>
                </div>
                <span className="font-mono text-[11px] text-slate-500">{canonicalPackageName}</span>
              </div>

              {hasPerm('apps.manage') && (
                <form
                  onSubmit={handleSaveAnnouncement}
                  className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3.5 dark:border-slate-800 dark:bg-slate-950/60"
                >
                  {editingAnnId !== null && (
                    <div className="flex items-center justify-between rounded border border-blue-200 bg-blue-50 px-2.5 py-1 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                      <span>Editing announcement #{editingAnnId}</span>
                      <button
                        type="button"
                        onClick={() => {
                          setEditingAnnId(null);
                          setAnnTitle('');
                          setAnnBody('');
                          setAnnPriority('10');
                          setAnnActionUrl('');
                          setAnnActive(true);
                        }}
                        className="underline"
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  <div className="grid gap-2.5 sm:grid-cols-3">
                    <div className="sm:col-span-2">
                      <label htmlFor="ann-title" className="block font-medium">
                        Announcement Title *
                      </label>
                      <input
                        id="ann-title"
                        required
                        value={annTitle}
                        onChange={(e) => setAnnTitle(e.target.value)}
                        placeholder="e.g. Weekend Mega Tournament Live!"
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>
                    <div>
                      <label htmlFor="ann-priority" className="block font-medium">
                        Priority
                      </label>
                      <input
                        id="ann-priority"
                        type="number"
                        value={annPriority}
                        onChange={(e) => setAnnPriority(e.target.value)}
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>
                  </div>
                  <div>
                    <label htmlFor="ann-body" className="block font-medium">
                      Message Body *
                    </label>
                    <textarea
                      id="ann-body"
                      required
                      rows={2}
                      value={annBody}
                      onChange={(e) => setAnnBody(e.target.value)}
                      placeholder="Update to v2.0 for double rewards and new levels."
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    />
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div>
                      <label htmlFor="ann-url" className="block font-medium">
                        Action URL (optional)
                      </label>
                      <input
                        id="ann-url"
                        value={annActionUrl}
                        onChange={(e) => setAnnActionUrl(e.target.value)}
                        placeholder="https://play.google.com/..."
                        className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 font-mono dark:border-slate-700 dark:bg-slate-900"
                      />
                    </div>
                    <div className="flex items-end pb-2">
                      <label className="inline-flex items-center gap-2 font-medium">
                        <input
                          type="checkbox"
                          checked={annActive}
                          onChange={(e) => setAnnActive(e.target.checked)}
                        />
                        <span>Active (active = 1)</span>
                      </label>
                    </div>
                  </div>
                  <button
                    type="submit"
                    disabled={savingAnn}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {savingAnn
                      ? 'Saving...'
                      : editingAnnId !== null
                        ? 'Save Announcement'
                        : 'Publish Announcement'}
                  </button>
                </form>
              )}

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {announcements.length === 0 ? (
                  <p className="py-6 text-center text-slate-500">
                    No announcements created for {canonicalPackageName} yet.
                  </p>
                ) : (
                  announcements.map((ann) => (
                    <div key={ann.id} className="space-y-1.5 py-3">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-semibold text-slate-900 dark:text-slate-100">{ann.title}</p>
                            <span
                              className={`font-mono text-[11px] font-medium ${
                                ann.active === 1
                                  ? 'text-emerald-700 dark:text-emerald-400'
                                  : 'text-slate-400'
                              }`}
                            >
                              active={ann.active} · P{ann.priority}
                            </span>
                          </div>
                          <p className="mt-0.5 text-slate-600 dark:text-slate-300">{ann.body}</p>
                          {ann.action_url && (
                            <p className="mt-0.5 truncate font-mono text-[11px] text-blue-600 dark:text-blue-400">
                              {ann.action_url}
                            </p>
                          )}
                        </div>
                        {hasPerm('apps.manage') && (
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => void handleToggleAnnouncementActive(ann.id, ann.active)}
                              className={`rounded border px-2 py-1 text-[11px] font-medium ${
                                ann.active === 1
                                  ? 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300'
                                  : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-300'
                              }`}
                            >
                              {ann.active === 1 ? 'Active (1)' : 'Paused (0)'}
                            </button>
                            <button
                              type="button"
                              aria-label={`Edit announcement ${ann.title}`}
                              onClick={() => {
                                setEditingAnnId(ann.id);
                                setAnnTitle(ann.title);
                                setAnnBody(ann.body);
                                setAnnPriority(String(ann.priority));
                                setAnnActionUrl(ann.action_url || '');
                                setAnnActive(ann.active === 1);
                              }}
                              className="rounded border border-slate-200 p-1 text-slate-500 hover:text-blue-600 dark:border-slate-700"
                            >
                              <Edit3 className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              aria-label={`Delete announcement ${ann.title}`}
                              onClick={() => void handleDeleteAnnouncement(ann.id)}
                              className="rounded border border-slate-200 p-1 text-slate-500 hover:text-red-600 dark:border-slate-700"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>

            {/* Remote Config & Kill-Switch Column */}
            <form
              onSubmit={handleSaveRemoteConfig}
              className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-xs lg:col-span-6 dark:border-slate-800 dark:bg-slate-900"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sliders className="h-4 w-4 text-blue-600" />
                  <h2 className="font-display text-sm font-semibold">
                    Remote Config, Kill-Switch &amp; Flags
                  </h2>
                </div>
                {rcKillSwitch && (
                  <span className="font-mono text-[11px] font-semibold text-red-600 dark:text-red-400">
                    KILL-SWITCH ACTIVE
                  </span>
                )}
              </div>

              <div className="grid gap-2.5 sm:grid-cols-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 dark:border-slate-800 dark:bg-slate-950/60">
                <label className="inline-flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={rcMaintenance}
                    onChange={(e) => setRcMaintenance(e.target.checked)}
                  />
                  <span>Maintenance Mode</span>
                </label>
                <label className="inline-flex items-center gap-2 font-medium text-red-700 dark:text-red-400">
                  <input
                    type="checkbox"
                    checked={rcKillSwitch}
                    onChange={(e) => setRcKillSwitch(e.target.checked)}
                  />
                  <span>Kill-Switch</span>
                </label>
                <label className="inline-flex items-center gap-2 font-medium">
                  <input
                    type="checkbox"
                    checked={rcRequireKey}
                    onChange={(e) => setRcRequireKey(e.target.checked)}
                  />
                  <span>Require API Key</span>
                </label>
              </div>

              <div>
                <label htmlFor="rc-maint-msg" className="block font-medium">
                  Maintenance / Kill-Switch Message
                </label>
                <input
                  id="rc-maint-msg"
                  value={rcMaintenanceMsg}
                  onChange={(e) => setRcMaintenanceMsg(e.target.value)}
                  placeholder="Scheduled maintenance is in progress."
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                />
              </div>

              <div className="space-y-2.5 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <label className="inline-flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
                  <input
                    type="checkbox"
                    checked={rcBannerEnabled}
                    onChange={(e) => setRcBannerEnabled(e.target.checked)}
                  />
                  <span>Enable In-App Remote Banner</span>
                </label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={rcBannerTitle}
                    onChange={(e) => setRcBannerTitle(e.target.value)}
                    placeholder="Banner title"
                    aria-label="Banner Title"
                    className="h-8 rounded-md border border-slate-200 px-2.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <input
                    value={rcBannerCtaLabel}
                    onChange={(e) => setRcBannerCtaLabel(e.target.value)}
                    placeholder="CTA Label (e.g. Play Now)"
                    aria-label="Banner CTA Label"
                    className="h-8 rounded-md border border-slate-200 px-2.5 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <input
                  value={rcBannerMessage}
                  onChange={(e) => setRcBannerMessage(e.target.value)}
                  placeholder="Banner body message"
                  aria-label="Banner Message"
                  className="h-8 w-full rounded-md border border-slate-200 px-2.5 dark:border-slate-700 dark:bg-slate-950"
                />
                <input
                  value={rcBannerCtaUrl}
                  onChange={(e) => setRcBannerCtaUrl(e.target.value)}
                  placeholder="Banner CTA URL (https://...)"
                  aria-label="Banner CTA URL"
                  className="h-8 w-full rounded-md border border-slate-200 px-2.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>

              <div className="space-y-2">
                <p className="font-semibold text-slate-900 dark:text-slate-100">
                  Structured Remote Flags (key / value)
                </p>
                {rcFlagRows.length > 0 && (
                  <div className="space-y-1.5">
                    {rcFlagRows.map((row, idx) => (
                      <div key={`${row.key}-${idx}`} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                        <input
                          value={row.key}
                          onChange={(e) =>
                            setRcFlagRows((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, key: e.target.value } : item))
                            )
                          }
                          aria-label={`Remote flag key ${idx}`}
                          className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                        />
                        <input
                          value={row.value}
                          onChange={(e) =>
                            setRcFlagRows((prev) =>
                              prev.map((item, i) => (i === idx ? { ...item, value: e.target.value } : item))
                            )
                          }
                          aria-label={`Remote flag value ${idx}`}
                          className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                        />
                        <button
                          type="button"
                          onClick={() => setRcFlagRows((prev) => prev.filter((_, i) => i !== idx))}
                          className="shrink-0 rounded border border-slate-200 p-1.5 text-slate-500 hover:text-red-600 dark:border-slate-700"
                          aria-label={`Remove flag ${row.key}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={newRcFlagKey}
                    onChange={(e) => setNewRcFlagKey(e.target.value)}
                    placeholder="flag_key (e.g. daily_bonus_enabled)"
                    aria-label="New remote flag key"
                    className="h-8 min-w-0 flex-1 rounded-md border border-slate-200 px-2.5 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <input
                    value={newRcFlagVal}
                    onChange={(e) => setNewRcFlagVal(e.target.value)}
                    placeholder="true / 500 / promo"
                    aria-label="New remote flag value"
                    className="h-8 min-w-0 w-24 rounded-md border border-slate-200 px-2.5 font-mono sm:w-32 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const k = newRcFlagKey.trim().replace(/[^a-zA-Z0-9_.-]+/g, '_');
                      if (!k) return;
                      setRcFlagRows((prev) => [
                        ...prev.filter((r) => r.key !== k),
                        { key: k, value: newRcFlagVal.trim() || 'true' },
                      ]);
                      setNewRcFlagKey('');
                    }}
                    className="h-8 rounded-md border border-slate-200 px-3 font-medium hover:bg-slate-50 dark:border-slate-700"
                  >
                    Add Flag
                  </button>
                </div>
              </div>

              {hasPerm('apps.manage') && (
                <button
                  type="submit"
                  disabled={savingRemoteConfig}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingRemoteConfig ? 'Saving Remote Config...' : 'Save Remote Config'}
                </button>
              )}
            </form>
          </div>

          {/* Live App Heartbeats Table */}
          <section className="rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-sm font-semibold">
                  Connected Client Heartbeats ({heartbeats.length})
                </h2>
                <p className="text-slate-500">
                  Last app heartbeat:{' '}
                  <span className="font-mono">
                    {app.lastHeartbeatAt ? new Date(app.lastHeartbeatAt).toLocaleString() : 'Never'}
                  </span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => void loadWorkspace()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-200 px-3 font-medium hover:bg-slate-50 dark:border-slate-700"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
              </button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                    <th className="py-2 pr-3 font-medium">Package Name</th>
                    <th className="py-2 pr-3 font-medium">Version</th>
                    <th className="py-2 pr-3 font-medium">Platform</th>
                    <th className="py-2 pr-3 font-medium">Status / Event</th>
                    <th className="py-2 pr-3 font-medium">Client IP</th>
                    <th className="py-2 text-right font-medium">Last Seen</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {heartbeats.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No heartbeats recorded yet for {canonicalPackageName}. Click &ldquo;Send Test Heartbeat&rdquo; or connect your app.
                      </td>
                    </tr>
                  ) : (
                    heartbeats.map((hb) => (
                      <tr key={hb.id}>
                        <td className="py-2.5 pr-3 font-mono font-medium text-slate-900 dark:text-slate-100">
                          {hb.package_name}
                        </td>
                        <td className="py-2.5 pr-3 font-mono tabular-nums">
                          v{hb.version_name || '-'} ({hb.version_code})
                        </td>
                        <td className="py-2.5 pr-3 capitalize">{hb.platform}</td>
                        <td className="py-2.5 pr-3 font-mono">
                          <span className="text-emerald-700 dark:text-emerald-400">{hb.status}</span> · {hb.event}
                        </td>
                        <td className="py-2.5 pr-3 font-mono text-slate-500">{hb.ip_address || '-'}</td>
                        <td className="py-2.5 text-right font-mono tabular-nums text-slate-500">
                          {new Date(hb.last_seen_at).toLocaleString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* TAB 2: COLLECTIONS & CUSTOM BACKEND GENERATOR */}
      {tab === 'collections' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-4">
            <section className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
              <div className="mb-3 flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold">Isolated Collections</h2>
                <span className="font-mono text-[11px] text-slate-500">{collections.length} schemas</span>
              </div>
              {collections.length === 0 ? (
                <p className="text-xs text-slate-500">No custom collections created yet. Generate one below.</p>
              ) : (
                <div className="space-y-1">
                  {collections.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setActiveCollectionSlug(c.slug)}
                      className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-xs transition-colors ${
                        activeCollectionSlug === c.slug
                          ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                          : 'text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="truncate">{c.name}</span>
                      <span className="font-mono text-[11px] tabular-nums">{c.recordCount}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            {hasPerm('apps.manage') && (
              <form
                onSubmit={handleGenerateModule}
                className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900"
              >
                <div className="flex items-center gap-1.5 font-display text-sm font-semibold">
                  <Database className="h-4 w-4 text-blue-600" />
                  <span>Generate Custom Backend Module</span>
                </div>
                <p className="text-slate-500">
                  Provisions an isolated collection schema, D1 DDL, REST SDK endpoints, and platform client code.
                </p>
                <div>
                  <label htmlFor="gen-mod-name" className="block font-medium">
                    Module / Feature Name *
                  </label>
                  <input
                    id="gen-mod-name"
                    required
                    value={modName}
                    onChange={(e) => setModName(e.target.value)}
                    placeholder="e.g. Tournaments or Guilds"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div>
                  <label htmlFor="gen-mod-cat" className="block font-medium">
                    Category
                  </label>
                  <select
                    id="gen-mod-cat"
                    value={modCategory}
                    onChange={(e) => setModCategory(e.target.value)}
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  >
                    <option value="custom">Custom Feature</option>
                    <option value="game_economy">Game Economy / Rankings</option>
                    <option value="cms">Website CMS / Catalog</option>
                    <option value="support">Workflow / Moderation</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="gen-mod-fields" className="block font-medium">
                    Schema Fields (name:type, comma separated)
                  </label>
                  <input
                    id="gen-mod-fields"
                    value={modFieldsText}
                    onChange={(e) => setModFieldsText(e.target.value)}
                    placeholder="title:text, prize_pool:number, live:boolean"
                    className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <button
                  type="submit"
                  disabled={generatingMod}
                  className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {generatingMod ? 'Provisioning Backend...' : 'Provision Backend Module'}
                </button>
              </form>
            )}

            {modules.length > 0 && (
              <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
                <h3 className="font-display text-sm font-semibold mb-2">Active Modules ({modules.length})</h3>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {modules.map((m) => (
                    <div key={m.id} className="flex items-center justify-between py-2">
                      <div>
                        <p className="font-medium text-slate-900 dark:text-slate-100">{m.name}</p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {m.moduleKey} · {m.category}
                        </p>
                      </div>
                      <span className="text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                        {m.status}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>

          <div className="space-y-4 lg:col-span-8">
            {activeCollection ? (
              <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <h2 className="font-display text-base font-semibold text-slate-900 dark:text-slate-100">
                      {activeCollection.name}
                    </h2>
                    <p className="font-mono text-[11px] text-slate-500">
                      REST Endpoint: /api/v1/sdk/data/{activeCollection.slug} · {activeCollection.description}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setShowDdl((v) => !v)}
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700"
                    >
                      {showDdl ? 'Hide SQL Schema' : 'View D1 SQL DDL'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void downloadWithAuth(
                          `/apps/${app.id}/collections/${activeCollection.slug}/records?format=csv`,
                          `${app.slug}-${activeCollection.slug}.csv`
                        )
                      }
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium hover:bg-slate-50 dark:border-slate-700"
                    >
                      <Download className="h-3.5 w-3.5" />
                      Export CSV
                    </button>
                  </div>
                </div>

                {showDdl && (
                  <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-800 dark:border-slate-800 dark:bg-slate-950 dark:text-slate-200">
                    {activeCollection.migrationSql}
                  </pre>
                )}

                {hasPerm('apps.manage') && (
                  <form
                    onSubmit={handleSaveCollectionRecord}
                    className="space-y-3 rounded-lg border border-slate-200 bg-slate-50/60 p-3.5 dark:border-slate-800 dark:bg-slate-950/60 text-xs"
                  >
                    {editingRecordId !== null && (
                      <div className="flex items-center justify-between rounded-md border border-blue-200 bg-blue-50/70 px-3 py-1.5 text-blue-800 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300">
                        <span className="font-medium">Editing existing record #{editingRecordId}</span>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRecordId(null);
                            setRecordForm({});
                          }}
                          className="font-medium underline"
                        >
                          Cancel Edit
                        </button>
                      </div>
                    )}
                    <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
                      {activeCollection.fieldsJson.map((f) => {
                        const isLongText =
                          f.type === 'text' &&
                          /text|body|content|description|poem|shayari|quote|notes|message|summary/i.test(f.name);
                        return (
                          <div key={f.name} className={isLongText ? 'sm:col-span-2 lg:col-span-4' : ''}>
                            <label className="block font-medium text-slate-700 dark:text-slate-300">
                              {f.label} ({f.type})
                            </label>
                            {f.type === 'boolean' ? (
                              <select
                                aria-label={f.label}
                                value={recordForm[f.name] ?? 'false'}
                                onChange={(e) => setRecordForm((p) => ({ ...p, [f.name]: e.target.value }))}
                                className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2 dark:border-slate-700 dark:bg-slate-900"
                              >
                                <option value="true">true</option>
                                <option value="false">false</option>
                              </select>
                            ) : isLongText ? (
                              <textarea
                                rows={3}
                                required={f.required}
                                aria-label={f.label}
                                value={recordForm[f.name] ?? ''}
                                onChange={(e) => setRecordForm((p) => ({ ...p, [f.name]: e.target.value }))}
                                placeholder={f.label}
                                className="mt-1 w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 dark:border-slate-700 dark:bg-slate-900"
                              />
                            ) : (
                              <input
                                type={f.type === 'number' ? 'number' : 'text'}
                                step={f.type === 'number' ? 'any' : undefined}
                                required={f.required}
                                aria-label={f.label}
                                value={recordForm[f.name] ?? ''}
                                onChange={(e) => setRecordForm((p) => ({ ...p, [f.name]: e.target.value }))}
                                placeholder={f.type === 'json' ? '{"key":"value"}' : f.label}
                                className="mt-1 h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 dark:border-slate-700 dark:bg-slate-900"
                              />
                            )}
                          </div>
                        );
                      })}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="submit"
                        disabled={addingRecord}
                        className="h-8 rounded-md bg-slate-900 px-4 font-medium text-white hover:bg-slate-800 dark:bg-blue-600"
                      >
                        {addingRecord
                          ? 'Saving...'
                          : editingRecordId !== null
                            ? 'Save Changes'
                            : 'Insert Record'}
                      </button>
                      {editingRecordId !== null && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRecordId(null);
                            setRecordForm({});
                          }}
                          className="h-8 rounded-md border border-slate-200 bg-white px-3 font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </form>
                )}

                {(() => {
                  const hasCategoryField = activeCollection.fieldsJson.some((f) => f.name === 'category');
                  const hasPublishedField = activeCollection.fieldsJson.some((f) => f.name === 'published');
                  const categories = Array.from(
                    new Set(
                      collectionRecords
                        .map((r) => String(r.dataJson?.category ?? '').trim())
                        .filter(Boolean)
                    )
                  ).sort();

                  const filteredRecords = collectionRecords.filter((rec) => {
                    if (hasCategoryField && recordCategoryFilter !== 'all') {
                      if (String(rec.dataJson?.category ?? '').trim() !== recordCategoryFilter) return false;
                    }
                    if (hasPublishedField && recordPublishFilter !== 'all') {
                      const pub = rec.dataJson?.published === true || rec.dataJson?.published === 'true';
                      if (recordPublishFilter === 'published' && !pub) return false;
                      if (recordPublishFilter === 'draft' && pub) return false;
                    }
                    if (recordSearch.trim()) {
                      const needle = recordSearch.trim().toLowerCase();
                      const hay = `${rec.recordUid} ${JSON.stringify(rec.dataJson ?? {})}`.toLowerCase();
                      if (!hay.includes(needle)) return false;
                    }
                    return true;
                  });

                  return (
                    <>
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <div className="relative flex-1 min-w-[180px]">
                          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-slate-400" />
                          <input
                            value={recordSearch}
                            onChange={(e) => setRecordSearch(e.target.value)}
                            placeholder={`Search ${activeCollection.name}...`}
                            aria-label="Filter collection records"
                            className="h-8 w-full rounded-md border border-slate-200 bg-white pl-8 pr-3 dark:border-slate-700 dark:bg-slate-950"
                          />
                        </div>
                        {hasCategoryField && (
                          <select
                            aria-label="Filter by category"
                            value={recordCategoryFilter}
                            onChange={(e) => setRecordCategoryFilter(e.target.value)}
                            className="h-8 rounded-md border border-slate-200 bg-white px-2.5 dark:border-slate-700 dark:bg-slate-950"
                          >
                            <option value="all">All Categories</option>
                            {categories.map((cat) => (
                              <option key={cat} value={cat}>
                                {cat}
                              </option>
                            ))}
                          </select>
                        )}
                        {hasPublishedField && (
                          <select
                            aria-label="Filter by publish status"
                            value={recordPublishFilter}
                            onChange={(e) =>
                              setRecordPublishFilter(e.target.value as 'all' | 'published' | 'draft')
                            }
                            className="h-8 rounded-md border border-slate-200 bg-white px-2.5 dark:border-slate-700 dark:bg-slate-950"
                          >
                            <option value="all">All Statuses</option>
                            <option value="published">Published Only</option>
                            <option value="draft">Drafts Only</option>
                          </select>
                        )}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs">
                          <thead>
                            <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                              <th className="py-2 pr-3 font-medium">Record UID</th>
                              {activeCollection.fieldsJson.map((f) => (
                                <th key={f.name} className="py-2 pr-3 font-medium">
                                  {f.label}
                                </th>
                              ))}
                              <th className="py-2 text-right font-medium">Actions</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                            {recordsLoading ? (
                              <tr>
                                <td colSpan={activeCollection.fieldsJson.length + 2} className="py-6 text-center text-slate-500">
                                  Loading isolated collection records...
                                </td>
                              </tr>
                            ) : filteredRecords.length === 0 ? (
                              <tr>
                                <td colSpan={activeCollection.fieldsJson.length + 2} className="py-8 text-center text-slate-500">
                                  {collectionRecords.length === 0
                                    ? `No records in "${activeCollection.name}" yet. Insert a record above or write from the client SDK.`
                                    : 'No matching records for the current filter.'}
                                </td>
                              </tr>
                            ) : (
                              filteredRecords.map((rec) => {
                                const isPublished =
                                  rec.dataJson?.published === true || rec.dataJson?.published === 'true';
                                return (
                                  <tr key={rec.id} className="hover:bg-slate-50/70 dark:hover:bg-slate-800/40">
                                    <td
                                      title={rec.recordUid}
                                      className="max-w-[92px] truncate py-2.5 pr-3 font-mono text-[11px] text-slate-500"
                                    >
                                      {rec.recordUid}
                                    </td>
                                    {activeCollection.fieldsJson.map((f) => {
                                      const val = rec.dataJson?.[f.name];
                                      if (f.name === 'published' && f.type === 'boolean') {
                                        return (
                                          <td key={f.name} className="py-2.5 pr-3 whitespace-nowrap">
                                            <span
                                              className={`font-medium ${
                                                isPublished
                                                  ? 'text-emerald-700 dark:text-emerald-400'
                                                  : 'text-amber-700 dark:text-amber-400'
                                              }`}
                                            >
                                              {isPublished ? 'Published' : 'Draft'}
                                            </span>
                                          </td>
                                        );
                                      }
                                      return (
                                        <td key={f.name} className="py-2.5 pr-3 tabular-nums max-w-[170px] truncate">
                                          {typeof val === 'object' && val !== null
                                            ? JSON.stringify(val)
                                            : String(val ?? '-')}
                                        </td>
                                      );
                                    })}
                                    <td className="py-2.5 text-right whitespace-nowrap">
                                      {hasPerm('apps.manage') && (
                                        <div className="inline-flex items-center gap-1">
                                          {hasPublishedField && (
                                            <button
                                              type="button"
                                              onClick={() => void handleToggleRecordPublished(rec)}
                                              className={`rounded border px-2 py-1 text-[11px] font-medium ${
                                                isPublished
                                                  ? 'border-amber-200 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-300'
                                                  : 'border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-300'
                                              }`}
                                            >
                                              {isPublished ? 'Unpublish' : 'Publish'}
                                            </button>
                                          )}
                                          <button
                                            type="button"
                                            aria-label={`Edit record ${rec.recordUid}`}
                                            onClick={() => startEditCollectionRecord(rec)}
                                            className="rounded border border-slate-200 p-1 text-slate-500 hover:text-blue-600 dark:border-slate-700"
                                          >
                                            <Edit3 className="h-3.5 w-3.5" />
                                          </button>
                                          <button
                                            type="button"
                                            aria-label={`Delete record ${rec.recordUid}`}
                                            onClick={async () => {
                                              await apiRequest(
                                                `/apps/${app.id}/collections/${activeCollection.slug}/records/${rec.id}`,
                                                { method: 'DELETE' }
                                              );
                                              if (editingRecordId === rec.id) {
                                                setEditingRecordId(null);
                                                setRecordForm({});
                                              }
                                              pushToast({ type: 'success', title: 'Record deleted' });
                                              await loadCollectionRecords();
                                              await loadWorkspace();
                                            }}
                                            className="rounded border border-slate-200 p-1 text-slate-500 hover:text-red-600 dark:border-slate-700"
                                          >
                                            <Trash2 className="h-3.5 w-3.5" />
                                          </button>
                                        </div>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })
                            )}
                          </tbody>
                        </table>
                      </div>
                    </>
                  );
                })()}
              </section>
            ) : (
              <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-xs text-slate-500 dark:border-slate-800 dark:bg-slate-900">
                Select or generate an isolated backend collection to inspect records and REST endpoints.
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: APP-SCOPED END-USERS */}
      {tab === 'users' && (
        <div className="space-y-4">
          {hasPerm('apps.manage') && (
            <form
              onSubmit={handleAddEndUser}
              className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 text-xs sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900"
            >
              <input
                value={newUserExtId}
                onChange={(e) => setNewUserExtId(e.target.value)}
                placeholder="External ID (optional)"
                aria-label="External User ID"
                className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
              />
              <input
                value={newUserName}
                onChange={(e) => setNewUserName(e.target.value)}
                placeholder="Display Name"
                aria-label="User Display Name"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
              <input
                type="email"
                value={newUserEmail}
                onChange={(e) => setNewUserEmail(e.target.value)}
                placeholder="user@example.com"
                aria-label="User Email"
                className="h-9 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
              />
              <button
                type="submit"
                disabled={addingEndUser}
                className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-blue-600 px-4 font-medium text-white hover:bg-blue-700"
              >
                <Users className="h-3.5 w-3.5" />
                {addingEndUser ? 'Registering...' : isGamePlatform ? 'Add Player' : 'Add End-User'}
              </button>
            </form>
          )}

          {isGamePlatform && (
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              {app.platform === 'unity'
                ? 'Unity C# Remote Config & Telemetry: Ban players here to immediately return 403 USER_BANNED on /api/v1/sdk/users/sync and update leaderboard or unity_remote_tuning collections.'
                : 'Battle Royale Match/Lobby & Anti-Cheat Controls: Banning a player blocks matchmaking sync (403), while br_matches & weapon_loot_balance in Collections control lobby limits and loot tuning.'}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="px-4 py-3 font-medium">User</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Version / Device</th>
                  <th className="px-4 py-3 text-right font-medium">Sessions</th>
                  <th className="px-4 py-3 text-right font-medium">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {endUsers.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                      No end-users synced for {app.name} yet.
                    </td>
                  </tr>
                ) : (
                  endUsers.map((u) => (
                    <tr key={u.id}>
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900 dark:text-slate-100">
                          {u.displayName || u.externalUserId}
                        </p>
                        <p className="font-mono text-[11px] text-slate-500">
                          {u.externalUserId} {u.email ? `· ${u.email}` : ''}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`font-medium capitalize ${
                            u.status === 'active'
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : 'text-red-600 dark:text-red-400'
                          }`}
                        >
                          {u.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                        {u.appVersion || '-'} · {u.deviceModel || 'Client'}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">{u.totalSessions}</td>
                      <td className="px-4 py-3 text-right">
                        {hasPerm('apps.manage') && (
                          <button
                            type="button"
                            onClick={async () => {
                              const nextStatus = u.status === 'banned' ? 'active' : 'banned';
                              await apiRequest(`/app-users/${u.id}`, {
                                method: 'PATCH',
                                body: JSON.stringify({ status: nextStatus }),
                              });
                              pushToast({ type: 'success', title: `User marked ${nextStatus}` });
                              await loadWorkspace();
                            }}
                            className={`rounded border px-2.5 py-1 text-xs ${
                              u.status === 'banned'
                                ? 'border-emerald-300 text-emerald-700 dark:border-emerald-800 dark:text-emerald-400'
                                : 'border-red-200 text-red-600 dark:border-red-900'
                            }`}
                          >
                            {u.status === 'banned' ? 'Unban' : 'Ban'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 4: FLAGS, RELEASES & ADMOB */}
      {tab === 'config' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900">
            <div className="flex items-center justify-between">
              <h2 className="font-display text-sm font-semibold">Feature Flags (Isolated to {app.name})</h2>
              <Flag className="h-4 w-4 text-slate-400" />
            </div>
            {canManageAppScoped && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await apiRequest('/app/flags', {
                    method: 'POST',
                    body: JSON.stringify({
                      appId: app.id,
                      key: flagKey.trim(),
                      name: flagName.trim() || flagKey.trim(),
                      isEnabled: true,
                      rolloutPercentage: 100,
                    }),
                  });
                  setFlagKey('');
                  setFlagName('');
                  pushToast({ type: 'success', title: 'Feature flag saved' });
                  await loadWorkspace();
                }}
                className="flex flex-wrap gap-2 text-xs"
              >
                <input
                  required
                  value={flagKey}
                  onChange={(e) => setFlagKey(e.target.value)}
                  placeholder="flag_key"
                  className="h-9 flex-1 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
                <input
                  value={flagName}
                  onChange={(e) => setFlagName(e.target.value)}
                  placeholder="Display label"
                  className="h-9 flex-1 rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                />
                <button type="submit" className="h-9 rounded-lg bg-blue-600 px-3.5 font-medium text-white">
                  Add Flag
                </button>
              </form>
            )}
            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {flags.length === 0 ? (
                <p className="py-4 text-slate-500">No app-specific feature flags configured.</p>
              ) : (
                flags.map((f) => (
                  <div key={f.id} className="flex items-center justify-between py-2.5">
                    <div>
                      <p className="font-medium text-slate-900 dark:text-slate-100">{f.name}</p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {f.key} · Rollout {f.rolloutPercentage}%
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await apiRequest(`/app/flags/${f.id}`, {
                          method: 'PATCH',
                          body: JSON.stringify({ isEnabled: !f.isEnabled }),
                        });
                        await loadWorkspace();
                      }}
                      className={`rounded-md border px-2.5 py-1 font-medium ${
                        f.isEnabled
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-400'
                          : 'border-slate-200 text-slate-600 dark:border-slate-700 dark:text-slate-400'
                      }`}
                    >
                      {f.isEnabled ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 lg:col-span-6 dark:border-slate-800 dark:bg-slate-900">
            <h2 className="font-display text-sm font-semibold">Releases & AdMob Monetization</h2>
            {canManageAppScoped && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  await apiRequest('/app/releases', {
                    method: 'POST',
                    body: JSON.stringify({
                      appId: app.id,
                      version: relVersion.trim(),
                      minSupportedVersion: relMinVersion.trim() || relVersion.trim(),
                      forceUpdate: relForce,
                      platform: app.platform,
                      releaseNotes: relNotes.trim(),
                    }),
                  });
                  setRelVersion('');
                  setRelMinVersion('');
                  setRelNotes('');
                  pushToast({ type: 'success', title: 'App release published' });
                  await loadWorkspace();
                  await refreshApps();
                }}
                className="space-y-2 text-xs"
              >
                <div className="grid grid-cols-2 gap-2">
                  <input
                    required
                    value={relVersion}
                    onChange={(e) => setRelVersion(e.target.value)}
                    placeholder="Release e.g. 2.4.0"
                    className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                  <input
                    value={relMinVersion}
                    onChange={(e) => setRelMinVersion(e.target.value)}
                    placeholder="Min supported e.g. 2.0.0"
                    className="h-9 rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={relForce}
                      onChange={(e) => setRelForce(e.target.checked)}
                    />
                    <span>Force update</span>
                  </label>
                  <button type="submit" className="h-8 rounded-lg bg-slate-900 px-3 font-medium text-white dark:bg-blue-600">
                    Publish Release
                  </button>
                </div>
              </form>
            )}

            <div className="divide-y divide-slate-100 text-xs dark:divide-slate-800">
              {releases.map((r) => (
                <div key={r.id} className="flex items-center justify-between py-2">
                  <div>
                    <span className="font-mono font-semibold">v{r.version}</span>{' '}
                    <span className="text-slate-500">· min v{r.minSupportedVersion}</span>
                    {r.forceUpdate && <span className="ml-1.5 text-amber-600">· Force Update</span>}
                  </div>
                  <span className="font-mono text-[11px] text-slate-400">
                    {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
              {ads.length > 0 && (
                <div className="pt-3">
                  <p className="font-semibold text-slate-700 dark:text-slate-300 mb-1">
                    AdMob Units ({ads.length})
                  </p>
                  {ads.map((ad) => (
                    <div key={ad.id} className="flex items-center justify-between py-1 font-mono text-[11px]">
                      <span>
                        {ad.name} ({ad.adFormat})
                      </span>
                      <span className="tabular-nums">
                        {ad.impressions} impr · ${(ad.revenueCents / 100).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* TAB 5: ISOLATED FILE STORAGE */}
      {tab === 'storage' && (
        <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold">
                Isolated App Storage ({app.backendNamespace})
              </h2>
              <p className="text-xs text-slate-500">
                Files uploaded here or via <code className="font-mono">POST /api/v1/sdk/storage/files</code> stay strictly scoped to {app.name} (max 750 KB per D1 asset).
              </p>
            </div>
            {hasPerm('files.write') && (
              <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 text-xs font-medium text-white hover:bg-blue-700">
                <FileUp className="h-3.5 w-3.5" />
                <span>{uploadingFile ? 'Uploading...' : 'Upload App Asset'}</span>
                <input
                  type="file"
                  className="hidden"
                  onChange={(e) => void handleUploadFile(e)}
                  disabled={uploadingFile}
                />
              </label>
            )}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500 dark:border-slate-800">
                  <th className="py-2.5 pr-3 font-medium">File Name</th>
                  <th className="py-2.5 pr-3 font-medium">MIME</th>
                  <th className="py-2.5 pr-3 font-medium text-right">Size</th>
                  <th className="py-2.5 pr-3 font-medium">SHA-256</th>
                  <th className="py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {files.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-8 text-center text-slate-500">
                      No assets stored in {app.backendNamespace}.
                    </td>
                  </tr>
                ) : (
                  files.map((f) => (
                    <tr key={f.id}>
                      <td className="py-2.5 pr-3 font-medium text-slate-900 dark:text-slate-100">
                        {f.originalName}
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-500">{f.mimeType}</td>
                      <td className="py-2.5 pr-3 text-right font-mono tabular-nums">
                        {(f.sizeBytes / 1024).toFixed(1)} KB
                      </td>
                      <td className="py-2.5 pr-3 font-mono text-[11px] text-slate-400">
                        {f.checksumSha256.slice(0, 12)}...
                      </td>
                      <td className="py-2.5 text-right">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => void downloadWithAuth(`/files/${f.id}/download`, f.originalName)}
                            className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                          >
                            Download
                          </button>
                          {hasPerm('files.write') && (
                            <button
                              type="button"
                              onClick={async () => {
                                await apiRequest(`/files/${f.id}`, { method: 'DELETE' });
                                pushToast({ type: 'success', title: 'File deleted' });
                                await loadWorkspace();
                              }}
                              className="rounded border border-red-200 px-2 py-1 text-red-600 dark:border-red-900"
                            >
                              Delete
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 6: SDK, KEYS & LIVE VERIFIER */}
      {tab === 'sdk' && (
        <div className="grid gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-6">
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold">App API Keys ({keys.length})</h2>
                <KeyRound className="h-4 w-4 text-slate-400" />
              </div>

              {issuedKeyOnce && (
                <div className="rounded-lg border border-emerald-300 bg-emerald-50/70 p-3 dark:border-emerald-800 dark:bg-emerald-950/30">
                  <p className="font-semibold text-emerald-900 dark:text-emerald-200">
                    New API Key Generated (copy once — SHA-256 hashed on server)
                  </p>
                  <div className="mt-1.5 flex items-center justify-between gap-2">
                    <code className="truncate font-mono text-[11px]">{issuedKeyOnce}</code>
                    <button
                      type="button"
                      onClick={() => void copyText('ws-key', issuedKeyOnce, 'API Key')}
                      className="inline-flex shrink-0 items-center gap-1 rounded border border-emerald-300 bg-white px-2 py-1 dark:bg-slate-900"
                    >
                      {copiedKey === 'ws-key' ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      Copy
                    </button>
                  </div>
                </div>
              )}

              {hasPerm('apps.keys') && (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const res = await apiRequest<{ apiKey: string }>(`/apps/${app.id}/keys`, {
                      method: 'POST',
                      body: JSON.stringify({ name: newKeyLabel.trim() || 'App Key', scopes: newKeyScopes }),
                    });
                    setIssuedKeyOnce(res.apiKey);
                    setTestSdkKey(res.apiKey);
                    pushToast({ type: 'success', title: 'Issued isolated API key' });
                    await loadWorkspace();
                  }}
                  className="space-y-2 border-b border-slate-100 pb-3 dark:border-slate-800"
                >
                  <input
                    value={newKeyLabel}
                    onChange={(e) => setNewKeyLabel(e.target.value)}
                    placeholder="Key Name"
                    className="h-9 w-full rounded-lg border border-slate-200 px-3 dark:border-slate-700 dark:bg-slate-950"
                  />
                  <div className="flex flex-wrap gap-2">
                    {SCOPE_OPTIONS.map((sc) => (
                      <label key={sc} className="inline-flex items-center gap-1 font-mono text-[11px]">
                        <input
                          type="checkbox"
                          checked={newKeyScopes.includes(sc)}
                          onChange={() =>
                            setNewKeyScopes((prev) =>
                              prev.includes(sc) ? prev.filter((x) => x !== sc) : [...prev, sc]
                            )
                          }
                        />
                        <span>{sc}</span>
                      </label>
                    ))}
                  </div>
                  <button type="submit" className="h-9 rounded-lg bg-blue-600 px-3.5 font-medium text-white">
                    Issue New API Key
                  </button>
                </form>
              )}

              <div className="divide-y divide-slate-100 dark:divide-slate-800">
                {keys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between gap-2 py-2.5">
                    <div>
                      <p className="font-medium text-slate-900 dark:text-slate-100">
                        {k.name} {!k.isActive && <span className="text-red-600">· Revoked</span>}
                      </p>
                      <p className="font-mono text-[11px] text-slate-500">
                        {k.keyPrefix}... · {(k.scopes || []).join(', ')}
                      </p>
                    </div>
                    {hasPerm('apps.keys') && k.isActive && (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={async () => {
                            const res = await apiRequest<{ apiKey: string }>(`/apps/${app.id}/keys/${k.id}/rotate`, {
                              method: 'POST',
                              body: JSON.stringify({}),
                            });
                            setIssuedKeyOnce(res.apiKey);
                            setTestSdkKey(res.apiKey);
                            pushToast({ type: 'success', title: 'API key rotated' });
                            await loadWorkspace();
                          }}
                          className="rounded border border-slate-200 px-2 py-1 hover:bg-slate-50 dark:border-slate-700"
                        >
                          Rotate
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await apiRequest(`/apps/${app.id}/keys/${k.id}`, { method: 'DELETE' });
                            pushToast({ type: 'success', title: 'Key revoked' });
                            await loadWorkspace();
                          }}
                          className="rounded border border-red-200 px-2 py-1 text-red-600 dark:border-red-900"
                        >
                          Revoke
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          </div>

          <div className="space-y-4 lg:col-span-6">
            <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-sm font-semibold">Live SDK Endpoint Verifier</h2>
                <Terminal className="h-4 w-4 text-slate-400" />
              </div>
              <div>
                <label className="block font-medium">Plaintext API Key (X-API-Key)</label>
                <input
                  value={testSdkKey}
                  onChange={(e) => setTestSdkKey(e.target.value)}
                  placeholder="Paste issued key aegis_live_..."
                  className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 font-mono dark:border-slate-700 dark:bg-slate-950"
                />
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={sdkRunning}
                  onClick={() => void handleRunSdkVerifier('announcements')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Test GET /sdk/announcements
                </button>
                <button
                  type="button"
                  disabled={sdkRunning}
                  onClick={() => void handleRunSdkVerifier('remote-config')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 font-medium hover:bg-slate-50 dark:border-slate-700"
                >
                  Test GET /sdk/remote-config
                </button>
                <button
                  type="button"
                  disabled={sdkRunning}
                  onClick={() => void handleRunSdkVerifier('config')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3.5 font-medium text-white hover:bg-slate-800 dark:bg-slate-800"
                >
                  <Zap className="h-3.5 w-3.5" />
                  Test GET /sdk/config
                </button>
                <button
                  type="button"
                  disabled={sdkRunning}
                  onClick={() => void handleRunSdkVerifier('data')}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-3.5 font-medium hover:bg-slate-50 dark:border-slate-700"
                >
                  Test GET /sdk/data/{activeCollectionSlug || collections[0]?.slug || 'leaderboard'}
                </button>
              </div>
              {sdkResult && (
                <pre className="max-h-52 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] dark:border-slate-800 dark:bg-slate-950">
                  {sdkResult}
                </pre>
              )}

              <div className="pt-2 border-t border-slate-100 dark:border-slate-800">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-950">
                    {(['website', 'android', 'unity', 'ios', 'curl'] as const).map((lang) => (
                      <button
                        key={lang}
                        type="button"
                        onClick={() => setSnippetLang(lang)}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-medium capitalize ${
                          snippetLang === lang
                            ? 'bg-white text-slate-900 shadow-xs dark:bg-slate-800 dark:text-slate-100'
                            : 'text-slate-600 dark:text-slate-400'
                        }`}
                      >
                        {lang}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      void copyText('ws-snip', workspace.integrationSnippets[snippetLang], `${snippetLang} SDK code`)
                    }
                    className="text-blue-600 hover:underline dark:text-blue-400"
                  >
                    Copy Code
                  </button>
                </div>
                <pre className="max-h-60 overflow-auto rounded-lg bg-slate-50 p-3 font-mono text-[11px] dark:bg-slate-950">
                  {workspace.integrationSnippets[snippetLang]}
                </pre>
              </div>
            </section>
          </div>
        </div>
      )}

      {/* TAB 7: PER-APP BACKUPS & LIFECYCLE */}
      {tab === 'backups' && (
        <div className="space-y-6">
          <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 text-xs dark:border-slate-800 dark:bg-slate-900">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-display text-sm font-semibold">
                  Isolated App Backups ({app.name})
                </h2>
                <p className="text-slate-500">
                  Create and restore SHA-256 verified JSON snapshots covering only this app&apos;s users, collections, records, flags, releases, and webhooks.
                </p>
              </div>
              {hasPerm('database.backup') && (
                <button
                  type="button"
                  disabled={creatingBackup}
                  onClick={async () => {
                    setCreatingBackup(true);
                    try {
                      await apiRequest('/database/backups', {
                        method: 'POST',
                        body: JSON.stringify({ appId: app.id }),
                      });
                      pushToast({ type: 'success', title: `Backup created for ${app.name}` });
                      await loadWorkspace();
                    } finally {
                      setCreatingBackup(false);
                    }
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-blue-600 px-3.5 font-medium text-white hover:bg-blue-700"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${creatingBackup ? 'animate-spin' : ''}`} />
                  {creatingBackup ? 'Snapshotting...' : 'Backup This App'}
                </button>
              )}
            </div>

            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {backups.length === 0 ? (
                <p className="py-6 text-center text-slate-500">No app-specific backups created yet.</p>
              ) : (
                backups.map((b) => (
                  <div key={b.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                    <div>
                      <p className="font-mono font-semibold text-slate-900 dark:text-slate-100">{b.filename}</p>
                      <p className="font-mono text-[11px] text-slate-500 tabular-nums">
                        {b.rowCount} rows · {(b.sizeBytes / 1024).toFixed(1)} KB · {b.status} ·{' '}
                        {b.checksumSha256.slice(0, 12)}...
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void downloadWithAuth(`/database/backups/${b.id}/download`, b.filename)}
                        className="rounded border border-slate-200 px-2.5 py-1 hover:bg-slate-50 dark:border-slate-700"
                      >
                        Download JSON
                      </button>
                      {hasPerm('database.restore') && (
                        <button
                          type="button"
                          onClick={() => setRestoreTargetId(b.id)}
                          className="rounded border border-amber-300 px-2.5 py-1 text-amber-700 hover:bg-amber-50 dark:border-amber-800 dark:text-amber-400"
                        >
                          Restore App State
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </section>

          {hasPerm('apps.manage') && (
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-red-200 bg-white p-5 text-xs dark:border-red-900/60 dark:bg-slate-900">
              <div>
                <h3 className="font-display text-sm font-semibold text-red-700 dark:text-red-400">
                  Disconnect or Remove Application
                </h3>
                <p className="mt-0.5 text-slate-500">
                  Disconnecting immediately blocks SDK requests for {app.appUid}. Deleting removes app credentials and app-scoped data while preserving immutable financial & audit logs.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const nextStatus = app.status === 'disconnected' ? 'connected' : 'disconnected';
                    await apiRequest(`/apps/${app.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify({ status: nextStatus }),
                    });
                    pushToast({ type: 'success', title: `${app.name} is now ${nextStatus}` });
                    await loadWorkspace();
                    await refreshApps();
                  }}
                  className="h-9 rounded-lg border border-slate-200 px-3.5 font-medium dark:border-slate-700"
                >
                  {app.status === 'disconnected' ? 'Reconnect App' : 'Disconnect App'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteApp(true)}
                  className="h-9 rounded-lg bg-red-600 px-3.5 font-medium text-white hover:bg-red-700"
                >
                  Delete Application
                </button>
              </div>
            </section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={restoreTargetId !== null}
        title="Restore Application Snapshot"
        description={`Replace isolated data for "${app.name}" (end-users, collections, records, flags, releases) with the verified backup snapshot? Other apps and admin accounts are untouched.`}
        confirmLabel="Restore Snapshot"
        destructive
        onConfirm={async () => {
          if (restoreTargetId === null) return;
          await apiRequest(`/database/backups/${restoreTargetId}/restore`, {
            method: 'POST',
            body: JSON.stringify({ mode: 'replace' }),
          });
          setRestoreTargetId(null);
          pushToast({ type: 'success', title: 'Application state restored cleanly' });
          await loadWorkspace();
          await refreshApps();
        }}
        onCancel={() => setRestoreTargetId(null)}
      />

      <ConfirmDialog
        open={confirmDeleteApp}
        title="Delete Connected Application"
        description={`Permanently delete "${app.name}" (${app.appUid}) along with its API keys, isolated collections, and end-users? Audit & transaction logs remain preserved.`}
        confirmLabel="Delete App"
        destructive
        onConfirm={async () => {
          await apiRequest(`/apps/${app.id}`, { method: 'DELETE' });
          setConfirmDeleteApp(false);
          setSelectedAppId('all');
          pushToast({ type: 'success', title: `Deleted ${app.name}` });
          await refreshApps();
          onNavigate('apps-directory');
        }}
        onCancel={() => setConfirmDeleteApp(false)}
      />
    </div>
  );
};
