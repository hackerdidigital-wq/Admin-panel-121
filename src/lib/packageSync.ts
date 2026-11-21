import { sanitizeText } from './security.ts';

const PACKAGE_NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_-]+)+$/;
const RESERVED_PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export interface RemoteBannerConfig {
  enabled: boolean;
  title: string;
  message: string;
  cta_label: string;
  cta_url: string;
  image_url: string;
}

export function normalizePackageName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return '';
  return trimmed.slice(0, 180);
}

export function isValidPackageNameFormat(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 180) return false;
  if (trimmed.includes('..')) return false;
  return PACKAGE_NAME_REGEX.test(trimmed);
}

export function derivePackageNameFromInput(
  packageNameRaw: unknown,
  packageOrDomainRaw: unknown
): {
  packageName: string;
  packageOrDomain: string;
  error?: string;
} {
  const pkgDomainClean = sanitizeText(packageOrDomainRaw, 200);

  if (packageNameRaw !== undefined) {
    const rawStr = typeof packageNameRaw === 'string' ? packageNameRaw.trim() : '';
    if (!rawStr) {
      return {
        packageName: '',
        packageOrDomain: pkgDomainClean,
      };
    }
    if (!isValidPackageNameFormat(rawStr)) {
      return {
        packageName: '',
        packageOrDomain: pkgDomainClean,
        error: 'Invalid package_name format. Expected reverse-DNS package like com.company.myapp.',
      };
    }
    const normalized = normalizePackageName(rawStr);
    return {
      packageName: normalized,
      packageOrDomain: pkgDomainClean || normalized,
    };
  }

  if (
    pkgDomainClean &&
    !pkgDomainClean.includes('://') &&
    isValidPackageNameFormat(pkgDomainClean)
  ) {
    const normalized = normalizePackageName(pkgDomainClean);
    return {
      packageName: normalized,
      packageOrDomain: pkgDomainClean,
    };
  }

  return {
    packageName: '',
    packageOrDomain: pkgDomainClean,
  };
}

export function deriveAppNameFromPackage(packageName: string): string {
  const normalized = normalizePackageName(packageName);
  if (!normalized) return 'Connected App';
  const lastSeg = normalized.split('.').filter(Boolean).pop() || normalized;
  const spaced = lastSeg
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
  return spaced || normalized;
}

export function parseFlexibleTimestampMs(raw: unknown, fallbackMs = Date.now()): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw < 1_000_000_000_000 ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string' && raw.trim()) {
    const num = Number(raw.trim());
    if (Number.isFinite(num) && num > 0) {
      return num < 1_000_000_000_000 ? Math.round(num * 1000) : Math.round(num);
    }
    const parsed = Date.parse(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return fallbackMs;
}

export function toActiveBinary(raw: unknown, defaultVal: 0 | 1 = 1): 0 | 1 {
  if (raw === 1 || raw === '1' || raw === true || raw === 'true') return 1;
  if (raw === 0 || raw === '0' || raw === false || raw === 'false') return 0;
  return defaultVal;
}

export function sanitizeBannerUrl(raw: unknown): string {
  const cleaned = sanitizeText(raw, 400);
  if (!cleaned) return '';
  try {
    const parsed = new URL(cleaned);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
  } catch {
    // Allow relative or deep link scheme only for non-javascript schemes? Restrict to http(s) or empty
  }
  return '';
}

export function sanitizeRemoteBanner(raw: unknown): RemoteBannerConfig {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    enabled: Boolean(r.enabled),
    title: sanitizeText(r.title, 120),
    message: sanitizeText(r.message, 500),
    cta_label: sanitizeText(r.cta_label ?? r.ctaLabel, 40),
    cta_url: sanitizeBannerUrl(r.cta_url ?? r.ctaUrl),
    image_url: sanitizeBannerUrl(r.image_url ?? r.imageUrl),
  };
}

export type RemoteFlagScalar = string | number | boolean;

export function sanitizeRemoteFlags(raw: unknown): Record<string, RemoteFlagScalar> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, RemoteFlagScalar> = {};
  const entries = Object.entries(raw as Record<string, unknown>).slice(0, 100);
  for (const [rawKey, val] of entries) {
    const key = rawKey.trim().replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 80);
    if (!key || RESERVED_PROTO_KEYS.has(key)) continue;
    if (typeof val === 'boolean') {
      out[key] = val;
    } else if (typeof val === 'number' && Number.isFinite(val)) {
      out[key] = val;
    } else if (typeof val === 'string') {
      out[key] = sanitizeText(val, 500);
    } else if (val !== null && val !== undefined) {
      out[key] = sanitizeText(JSON.stringify(val), 500);
    }
  }
  return out;
}

const FIREBASE_PROJECT_ID_REGEX = /^[a-z][a-z0-9-]{2,78}[a-z0-9]$/i;
const FIREBASE_APP_ID_REGEX = /^[0-9]+:[0-9]+:(android|ios|web):[a-zA-Z0-9._-]+$/;
const FIREBASE_PROJECT_NUMBER_REGEX = /^[0-9]{4,24}$/;
const FIREBASE_STORAGE_BUCKET_REGEX = /^[a-z0-9][a-z0-9._-]{2,140}$/i;

export interface AppFirebaseMetadata {
  firebase_project_id: string;
  firebase_app_id: string;
  firebase_project_number: string;
  firebase_storage_bucket: string;
}

export function validateFirebaseProjectId(raw: unknown): { value: string; error?: string } {
  if (raw === undefined || raw === null) return { value: '' };
  const cleaned = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!cleaned) return { value: '' };
  if (cleaned.length > 80 || !FIREBASE_PROJECT_ID_REGEX.test(cleaned)) {
    return {
      value: '',
      error: 'Invalid firebase_project_id format (expected lowercase letters, numbers, and hyphens, e.g. my-firebase-project).',
    };
  }
  return { value: cleaned };
}

export function validateFirebaseAppId(raw: unknown): { value: string; error?: string } {
  if (raw === undefined || raw === null) return { value: '' };
  const cleaned = typeof raw === 'string' ? raw.trim() : '';
  if (!cleaned) return { value: '' };
  if (cleaned.length > 120 || !FIREBASE_APP_ID_REGEX.test(cleaned)) {
    return {
      value: '',
      error:
        'Invalid firebase_app_id format (expected <project_number>:<client>:<platform>:<hash>, e.g. 1:123456789012:android:abc123def456).',
    };
  }
  return { value: cleaned };
}

export function validateFirebaseProjectNumber(raw: unknown): { value: string; error?: string } {
  if (raw === undefined || raw === null) return { value: '' };
  const cleaned =
    typeof raw === 'number' && Number.isFinite(raw)
      ? String(Math.floor(raw))
      : typeof raw === 'string'
        ? raw.trim()
        : '';
  if (!cleaned) return { value: '' };
  if (!FIREBASE_PROJECT_NUMBER_REGEX.test(cleaned)) {
    return {
      value: '',
      error: 'Invalid firebase_project_number format (expected numeric project number, e.g. 123456789012).',
    };
  }
  return { value: cleaned };
}

export function validateFirebaseStorageBucket(raw: unknown): { value: string; error?: string } {
  if (raw === undefined || raw === null) return { value: '' };
  const cleaned = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!cleaned) return { value: '' };
  if (!FIREBASE_STORAGE_BUCKET_REGEX.test(cleaned) || cleaned.includes('..')) {
    return {
      value: '',
      error: 'Invalid firebase_storage_bucket format (e.g. my-firebase-project.firebasestorage.app).',
    };
  }
  return { value: cleaned };
}

export function extractFirebaseMetadata(settingsJson: unknown): AppFirebaseMetadata {
  const rec =
    settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)
      ? (settingsJson as Record<string, unknown>)
      : {};
  const projectRaw = rec.firebaseProjectId ?? rec.firebase_project_id ?? '';
  const appIdRaw = rec.firebaseAppId ?? rec.firebase_app_id ?? '';
  const projectNumRaw = rec.firebaseProjectNumber ?? rec.firebase_project_number ?? '';
  const bucketRaw = rec.firebaseStorageBucket ?? rec.firebase_storage_bucket ?? '';
  return {
    firebase_project_id: sanitizeText(projectRaw, 80),
    firebase_app_id: sanitizeText(appIdRaw, 120),
    firebase_project_number: sanitizeText(projectNumRaw, 24),
    firebase_storage_bucket: sanitizeText(bucketRaw, 140),
  };
}

export function withFirebaseSettings(
  currentSettings: unknown,
  updates: {
    firebaseProjectId?: string;
    firebaseAppId?: string;
    firebaseProjectNumber?: string;
    firebaseStorageBucket?: string;
  }
): Record<string, unknown> {
  const base =
    currentSettings && typeof currentSettings === 'object' && !Array.isArray(currentSettings)
      ? { ...(currentSettings as Record<string, unknown>) }
      : {};
  if (updates.firebaseProjectId !== undefined) {
    if (updates.firebaseProjectId) {
      base.firebaseProjectId = updates.firebaseProjectId;
    } else {
      delete base.firebaseProjectId;
    }
    delete base.firebase_project_id;
  }
  if (updates.firebaseAppId !== undefined) {
    if (updates.firebaseAppId) {
      base.firebaseAppId = updates.firebaseAppId;
    } else {
      delete base.firebaseAppId;
    }
    delete base.firebase_app_id;
  }
  if (updates.firebaseProjectNumber !== undefined) {
    if (updates.firebaseProjectNumber) {
      base.firebaseProjectNumber = updates.firebaseProjectNumber;
    } else {
      delete base.firebaseProjectNumber;
    }
    delete base.firebase_project_number;
  }
  if (updates.firebaseStorageBucket !== undefined) {
    if (updates.firebaseStorageBucket) {
      base.firebaseStorageBucket = updates.firebaseStorageBucket;
    } else {
      delete base.firebaseStorageBucket;
    }
    delete base.firebase_storage_bucket;
  }
  return base;
}

export interface HeartbeatDeviceInfo {
  device_model: string;
  os_version: string;
  manufacturer: string;
}

export function extractHeartbeatDeviceInfo(
  payloadJson: unknown,
  userAgent = ''
): HeartbeatDeviceInfo {
  const rec =
    payloadJson && typeof payloadJson === 'object' && !Array.isArray(payloadJson)
      ? (payloadJson as Record<string, unknown>)
      : {};
  const deviceModel =
    sanitizeText(rec.device_model ?? rec.deviceModel ?? rec.device ?? rec.device_name, 100) ||
    '';
  const osVersion =
    sanitizeText(rec.os_version ?? rec.osVersion ?? rec.android_version ?? rec.sdk_int, 60) ||
    '';
  const manufacturer = sanitizeText(rec.manufacturer ?? rec.brand, 60) || '';
  if (!deviceModel && userAgent) {
    return {
      device_model: sanitizeText(userAgent, 100),
      os_version: osVersion,
      manufacturer,
    };
  }
  return {
    device_model: deviceModel,
    os_version: osVersion,
    manufacturer,
  };
}

export interface ParsedGoogleServicesConfig {
  project_id: string;
  project_number: string;
  storage_bucket: string;
  clients: Array<{
    package_name: string;
    mobilesdk_app_id: string;
    app_name_suggestion: string;
  }>;
}

export function parseGoogleServicesJson(rawText: string): {
  config?: ParsedGoogleServicesConfig;
  error?: string;
} {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return { error: 'Paste valid google-services.json content.' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'Invalid JSON syntax in google-services.json.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'google-services.json root must be a JSON object.' };
  }
  const root = parsed as Record<string, unknown>;
  const projectInfo =
    root.project_info && typeof root.project_info === 'object' && !Array.isArray(root.project_info)
      ? (root.project_info as Record<string, unknown>)
      : {};

  const projIdCheck = validateFirebaseProjectId(projectInfo.project_id ?? '');
  if (projIdCheck.error) return { error: projIdCheck.error };
  const projNumCheck = validateFirebaseProjectNumber(projectInfo.project_number ?? '');
  if (projNumCheck.error) return { error: projNumCheck.error };
  const bucketCheck = validateFirebaseStorageBucket(projectInfo.storage_bucket ?? '');
  if (bucketCheck.error) return { error: bucketCheck.error };

  const rawClients = Array.isArray(root.client) ? root.client : [];
  const clients: ParsedGoogleServicesConfig['clients'] = [];
  for (const item of rawClients.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const cInfo = (item as Record<string, unknown>).client_info;
    if (!cInfo || typeof cInfo !== 'object') continue;
    const cRec = cInfo as Record<string, unknown>;
    const androidInfo =
      cRec.android_client_info && typeof cRec.android_client_info === 'object'
        ? (cRec.android_client_info as Record<string, unknown>)
        : {};
    const pkg = normalizePackageName(androidInfo.package_name);
    const appIdCheck = validateFirebaseAppId(cRec.mobilesdk_app_id ?? '');
    if (!pkg || !isValidPackageNameFormat(pkg)) continue;
    clients.push({
      package_name: pkg,
      mobilesdk_app_id: appIdCheck.error ? '' : appIdCheck.value,
      app_name_suggestion: deriveAppNameFromPackage(pkg),
    });
  }

  if (!projIdCheck.value && clients.length === 0) {
    return { error: 'No Firebase project_info or Android client package_name found in JSON.' };
  }

  return {
    config: {
      project_id: projIdCheck.value,
      project_number: projNumCheck.value,
      storage_bucket: bucketCheck.value,
      clients,
    },
  };
}

export interface AppConnectionConfig {
  firebase_project_id: string;
  firebase_app_id: string;
  firebase_project_number: string;
  firebase_storage_bucket: string;
  require_sdk_key: boolean;
  auth_mode: 'package_name' | 'api_key' | 'firebase';
  sync_mode: 'aegis_managed' | 'hybrid' | 'external_backend';
  sync_url: string;
}

export function parseVersionCode(raw: unknown, fallback = 1): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) {
    return Math.min(2_147_483_647, Math.floor(raw));
  }
  if (typeof raw === 'string' && raw.trim()) {
    const parsed = Number(raw.trim());
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.min(2_147_483_647, Math.floor(parsed));
    }
  }
  return fallback;
}

export function extractAppVersionCode(settingsJson: unknown): number {
  const rec =
    settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)
      ? (settingsJson as Record<string, unknown>)
      : {};
  if (rec.versionCode !== undefined) {
    return parseVersionCode(rec.versionCode, 1);
  }
  if (rec.lastClientVersionCode !== undefined) {
    return parseVersionCode(rec.lastClientVersionCode, 1);
  }
  return 1;
}

export function sanitizeConnectionConfig(raw: unknown): {
  value: Partial<AppConnectionConfig>;
  error?: string;
} {
  let obj: Record<string, unknown>;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { value: {} };
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { value: {}, error: 'connection_config JSON must be an object.' };
      }
      obj = parsed as Record<string, unknown>;
    } catch {
      return { value: {}, error: 'Invalid JSON syntax in connection_config.' };
    }
  } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (raw === undefined || raw === null) {
    return { value: {} };
  } else {
    return { value: {}, error: 'connection_config must be a JSON object.' };
  }

  const out: Partial<AppConnectionConfig> = {};

  const fbProjRaw = obj.firebase_project_id ?? obj.firebaseProjectId ?? obj.project_id;
  if (fbProjRaw !== undefined) {
    const check = validateFirebaseProjectId(fbProjRaw);
    if (check.error) return { value: {}, error: check.error };
    out.firebase_project_id = check.value;
  }

  const fbAppRaw = obj.firebase_app_id ?? obj.firebaseAppId ?? obj.mobilesdk_app_id;
  if (fbAppRaw !== undefined) {
    const check = validateFirebaseAppId(fbAppRaw);
    if (check.error) return { value: {}, error: check.error };
    out.firebase_app_id = check.value;
  }

  const fbNumRaw = obj.firebase_project_number ?? obj.firebaseProjectNumber ?? obj.project_number;
  if (fbNumRaw !== undefined) {
    const check = validateFirebaseProjectNumber(fbNumRaw);
    if (check.error) return { value: {}, error: check.error };
    out.firebase_project_number = check.value;
  }

  const fbBucketRaw = obj.firebase_storage_bucket ?? obj.firebaseStorageBucket ?? obj.storage_bucket;
  if (fbBucketRaw !== undefined) {
    const check = validateFirebaseStorageBucket(fbBucketRaw);
    if (check.error) return { value: {}, error: check.error };
    out.firebase_storage_bucket = check.value;
  }

  const reqKeyRaw = obj.require_sdk_key ?? obj.requireSdkKey;
  if (reqKeyRaw !== undefined) {
    out.require_sdk_key = Boolean(reqKeyRaw);
  }

  const authModeRaw = typeof (obj.auth_mode ?? obj.authMode) === 'string'
    ? String(obj.auth_mode ?? obj.authMode).trim().toLowerCase()
    : '';
  if (authModeRaw === 'package_name' || authModeRaw === 'api_key' || authModeRaw === 'firebase') {
    out.auth_mode = authModeRaw;
  }

  const syncModeRaw = typeof (obj.sync_mode ?? obj.syncMode) === 'string'
    ? String(obj.sync_mode ?? obj.syncMode).trim().toLowerCase()
    : '';
  if (syncModeRaw === 'aegis_managed' || syncModeRaw === 'hybrid' || syncModeRaw === 'external_backend') {
    out.sync_mode = syncModeRaw;
  }

  const syncUrlRaw = obj.sync_url ?? obj.syncUrl ?? obj.backend_base_url;
  if (syncUrlRaw !== undefined) {
    out.sync_url = sanitizeBannerUrl(syncUrlRaw);
  }

  return { value: out };
}

export function extractConnectionConfig(
  settingsJson: unknown,
  fallback?: { integrationMode?: string; backendBaseUrl?: string }
): AppConnectionConfig {
  const rec =
    settingsJson && typeof settingsJson === 'object' && !Array.isArray(settingsJson)
      ? (settingsJson as Record<string, unknown>)
      : {};
  const fb = extractFirebaseMetadata(rec);
  const rawSyncMode = String(rec.syncMode ?? fallback?.integrationMode ?? 'aegis_managed').toLowerCase();
  const sync_mode: AppConnectionConfig['sync_mode'] =
    rawSyncMode === 'hybrid' || rawSyncMode === 'external_backend' ? rawSyncMode : 'aegis_managed';
  const rawAuthMode = String(rec.authMode ?? '').toLowerCase();
  const auth_mode: AppConnectionConfig['auth_mode'] =
    rawAuthMode === 'api_key' || rawAuthMode === 'firebase' || rawAuthMode === 'package_name'
      ? rawAuthMode
      : rec.requireSdkKeyForPackageSync
        ? 'api_key'
        : fb.firebase_project_id || fb.firebase_app_id
          ? 'firebase'
          : 'package_name';

  return {
    firebase_project_id: fb.firebase_project_id,
    firebase_app_id: fb.firebase_app_id,
    firebase_project_number: fb.firebase_project_number,
    firebase_storage_bucket: fb.firebase_storage_bucket,
    require_sdk_key: Boolean(rec.requireSdkKeyForPackageSync),
    auth_mode,
    sync_mode,
    sync_url: sanitizeBannerUrl(rec.syncUrl ?? fallback?.backendBaseUrl ?? ''),
  };
}

export function withConnectionSettings(
  currentSettings: unknown,
  updates: {
    versionCode?: number;
    connectionConfig?: Partial<AppConnectionConfig>;
  }
): Record<string, unknown> {
  const cfg = updates.connectionConfig || {};
  let base = withFirebaseSettings(currentSettings, {
    firebaseProjectId: cfg.firebase_project_id,
    firebaseAppId: cfg.firebase_app_id,
    firebaseProjectNumber: cfg.firebase_project_number,
    firebaseStorageBucket: cfg.firebase_storage_bucket,
  });

  if (updates.versionCode !== undefined) {
    base.versionCode = parseVersionCode(updates.versionCode, 1);
  }
  if (cfg.require_sdk_key !== undefined) {
    base.requireSdkKeyForPackageSync = Boolean(cfg.require_sdk_key);
  }
  if (cfg.auth_mode !== undefined) {
    base.authMode = cfg.auth_mode;
  }
  if (cfg.sync_mode !== undefined) {
    base.syncMode = cfg.sync_mode;
  }
  if (cfg.sync_url !== undefined) {
    if (cfg.sync_url) base.syncUrl = cfg.sync_url;
    else delete base.syncUrl;
  }
  return base;
}

export interface QuickConnectAppCandidate {
  app_name: string;
  package_name: string;
  version_name: string;
  version_code: number;
  platform: 'android' | 'unity' | 'game' | 'website' | 'ios' | 'api';
  connection_config: Partial<AppConnectionConfig>;
}

export function parseQuickConnectJson(rawText: string): {
  apps?: QuickConnectAppCandidate[];
  sourceFormat?: 'connection_json' | 'google_services_json';
  error?: string;
} {
  const trimmed = typeof rawText === 'string' ? rawText.trim() : '';
  if (!trimmed) {
    return { error: 'Paste a Connection JSON or Android google-services.json payload.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { error: 'Invalid JSON syntax.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { error: 'Quick Connect JSON must be a JSON object or array.' };
  }

  // 1. Detect Android google-services.json structure cleanly
  if (
    !Array.isArray(parsed) &&
    (('project_info' in parsed && typeof (parsed as Record<string, unknown>).project_info === 'object') ||
      Array.isArray((parsed as Record<string, unknown>).client))
  ) {
    const gs = parseGoogleServicesJson(trimmed);
    if (gs.error || !gs.config) {
      return { error: gs.error || 'Could not parse google-services.json.' };
    }
    if (gs.config.clients.length === 0) {
      return { error: 'No valid Android client package_name found inside google-services.json.' };
    }
    return {
      sourceFormat: 'google_services_json',
      apps: gs.config.clients.map((cl) => ({
        app_name: cl.app_name_suggestion,
        package_name: cl.package_name,
        version_name: '1.0.0',
        version_code: 1,
        platform: 'android',
        connection_config: {
          firebase_project_id: gs.config!.project_id,
          firebase_app_id: cl.mobilesdk_app_id,
          firebase_project_number: gs.config!.project_number,
          firebase_storage_bucket: gs.config!.storage_bucket,
          auth_mode: gs.config!.project_id || cl.mobilesdk_app_id ? 'firebase' : 'package_name',
        },
      })),
    };
  }

  // 2. Focused Aegis Connection JSON (single object, array, or { apps: [...] })
  const rawList: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as Record<string, unknown>).apps)
      ? ((parsed as Record<string, unknown>).apps as unknown[])
      : [parsed];

  const candidates: QuickConnectAppCandidate[] = [];
  for (const item of rawList.slice(0, 50)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rec = item as Record<string, unknown>;
    const rawPkg = rec.package_name ?? rec.packageName ?? rec.package_or_domain ?? '';
    const pkg = normalizePackageName(rawPkg);
    if (!pkg || !isValidPackageNameFormat(pkg)) {
      return {
        error: `Invalid or missing package_name "${sanitizeText(String(rawPkg || ''), 80)}". Expected reverse-DNS package like com.company.myapp.`,
      };
    }

    const nestedCfgRaw =
      rec.connection_config ?? rec.connectionConfig ?? rec.config ?? rec.connection;
    const flatCfgRaw: Record<string, unknown> = {
      firebase_project_id: rec.firebase_project_id ?? rec.firebaseProjectId,
      firebase_app_id: rec.firebase_app_id ?? rec.firebaseAppId,
      firebase_project_number: rec.firebase_project_number ?? rec.firebaseProjectNumber,
      firebase_storage_bucket: rec.firebase_storage_bucket ?? rec.firebaseStorageBucket,
      require_sdk_key: rec.require_sdk_key ?? rec.requireSdkKey,
      auth_mode: rec.auth_mode ?? rec.authMode,
      sync_mode: rec.sync_mode ?? rec.syncMode,
      sync_url: rec.sync_url ?? rec.syncUrl,
    };

    const nestedCheck = sanitizeConnectionConfig(nestedCfgRaw);
    if (nestedCheck.error) return { error: nestedCheck.error };
    const flatCheck = sanitizeConnectionConfig(flatCfgRaw);
    if (flatCheck.error) return { error: flatCheck.error };

    const mergedCfg: Partial<AppConnectionConfig> = {
      ...flatCheck.value,
      ...nestedCheck.value,
    };

    const rawPlat = sanitizeText(rec.platform || 'android', 20).toLowerCase();
    const platform: QuickConnectAppCandidate['platform'] =
      rawPlat === 'unity' ||
      rawPlat === 'game' ||
      rawPlat === 'website' ||
      rawPlat === 'ios' ||
      rawPlat === 'api'
        ? rawPlat
        : 'android';

    const appName =
      sanitizeText(rec.app_name ?? rec.appName ?? rec.name, 120) ||
      deriveAppNameFromPackage(pkg);
    const versionName =
      sanitizeText(rec.version_name ?? rec.versionName ?? rec.currentVersion, 40) || '1.0.0';
    const versionCode = parseVersionCode(rec.version_code ?? rec.versionCode, 1);

    candidates.push({
      app_name: appName,
      package_name: pkg,
      version_name: versionName,
      version_code: versionCode,
      platform,
      connection_config: mergedCfg,
    });
  }

  if (candidates.length === 0) {
    return { error: 'No valid app entries found in Connection JSON.' };
  }

  return {
    sourceFormat: 'connection_json',
    apps: candidates,
  };
}



