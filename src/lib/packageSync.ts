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
        error: 'Invalid package_name format. Expected reverse-DNS package like com.cyberking.candymindmatch.',
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
