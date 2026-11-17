import type { WorkerContext } from './types.ts';

export const SESSION_COOKIE_NAME = 'aegis_session';
export const CSRF_COOKIE_NAME = 'aegis_csrf';

export function getClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.trim();
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return '127.0.0.1';
}

export function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isLoopbackHost(host: string): boolean {
  const clean = host.trim().toLowerCase();
  return (
    clean === 'localhost' ||
    clean.startsWith('localhost:') ||
    clean === '127.0.0.1' ||
    clean.startsWith('127.0.0.1:') ||
    clean === '0.0.0.0' ||
    clean.startsWith('0.0.0.0:') ||
    clean === '[::1]' ||
    clean.startsWith('[::1]:')
  );
}

function normalizeHostCandidate(rawHost: string | null | undefined): string | null {
  if (!rawHost) return null;
  const first = rawHost.split(',')[0]?.trim().toLowerCase();
  if (!first || /[\s/@\\]/.test(first)) return null;
  try {
    return new URL(`https://${first}`).host.toLowerCase();
  } catch {
    return null;
  }
}

export function getTrustedHosts(request: Request, configuredAppUrl?: string): Set<string> {
  const trusted = new Set<string>();
  const rawHostHeader = request.headers.get('host');
  const headerHost = normalizeHostCandidate(rawHostHeader);
  if (headerHost) {
    trusted.add(headerHost);
  }

  let urlHost: string | null = null;
  try {
    urlHost = new URL(request.url).host.toLowerCase();
    if (urlHost) trusted.add(urlHost);
  } catch {
    // ignore invalid request.url
  }

  if (configuredAppUrl) {
    try {
      const appHost = new URL(configuredAppUrl).host.toLowerCase();
      if (appHost) trusted.add(appHost);
    } catch {
      // ignore invalid APP_URL
    }
  }

  // Only honor X-Forwarded-Host when the backend is reached on a local/loopback proxy host
  // (e.g. Cloud Run NGINX forwarding localhost:3000 + X-Forwarded-Host: <public-host>).
  // Public Worker hostnames are never loopback, preventing header spoofing in production.
  const effectiveHost = headerHost || urlHost || '';
  if (isLoopbackHost(effectiveHost)) {
    const forwardedHost = normalizeHostCandidate(request.headers.get('x-forwarded-host'));
    if (forwardedHost) {
      trusted.add(forwardedHost);
    }
  }

  return trusted;
}

export function isAllowedCorsOrigin(request: Request, configuredAppUrl?: string): string | null {
  const origin = request.headers.get('origin');
  if (!origin) return null;
  try {
    const originUrl = new URL(origin);
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
      return null;
    }
    const trustedHosts = getTrustedHosts(request, configuredAppUrl);
    if (trustedHosts.has(originUrl.host.toLowerCase())) {
      return originUrl.origin;
    }
    return null;
  } catch {
    return null;
  }
}

export function applyCorsHeaders(
  request: Request,
  response: Response,
  configuredAppUrl?: string
): Response {
  const allowedOrigin = isAllowedCorsOrigin(request, configuredAppUrl);
  const headers = new Headers(response.headers);
  headers.set('Vary', 'Origin');
  if (allowedOrigin) {
    headers.set('Access-Control-Allow-Origin', allowedOrigin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-CSRF-Token, X-Requested-With'
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function jsonResponse(
  data: unknown,
  status = 200,
  extraHeaders?: Record<string, string | string[]>
): Response {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      if (Array.isArray(v)) {
        for (const item of v) headers.append(k, item);
      } else {
        headers.set(k, v);
      }
    }
  }
  return new Response(JSON.stringify(data), { status, headers });
}

export function errorResponse(
  status: number,
  message: string,
  extra?: Record<string, unknown>
): Response {
  return jsonResponse({ error: message, ...(extra ?? {}) }, status);
}

export function parseCookies(request: Request): Record<string, string> {
  const cookieHeader = request.headers.get('cookie') || '';
  const map: Record<string, string> = {};
  for (const part of cookieHeader.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        map[key] = decodeURIComponent(val);
      } catch {
        map[key] = val;
      }
    }
  }
  return map;
}

export function isHttpsRequest(request: Request): boolean {
  try {
    const u = new URL(request.url);
    if (u.protocol === 'https:') return true;

    const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
    if (forwardedProto === 'https') return true;

    const origin = request.headers.get('origin')?.trim().toLowerCase();
    if (origin?.startsWith('https://')) return true;

    const referer = request.headers.get('referer')?.trim().toLowerCase();
    if (referer?.startsWith('https://')) return true;

    const cfVisitor = request.headers.get('cf-visitor')?.toLowerCase();
    if (cfVisitor?.includes('"https"')) return true;

    return false;
  } catch {
    return false;
  }
}

export function buildSessionCookieHeader(
  token: string,
  maxAgeSeconds: number,
  secure: boolean
): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    // Over HTTPS (Workers production + AI Studio cross-site iframe), SameSite=None; Secure; Partitioned
    // ensures the session cookie persists both in top-level tabs and embedded preview iframes.
    secure ? 'SameSite=None' : 'SameSite=Lax',
    `Max-Age=${Math.max(60, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) {
    parts.push('Secure', 'Partitioned');
  }
  return parts.join('; ');
}

export function clearSessionCookieHeader(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=0',
  ];
  if (secure) {
    parts.push('Secure', 'Partitioned');
  }
  return parts.join('; ');
}

export function buildCsrfCookieHeader(token: string, secure: boolean): string {
  const parts = [
    `${CSRF_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    secure ? 'SameSite=None' : 'SameSite=Lax',
    'Max-Age=86400',
  ];
  if (secure) {
    parts.push('Secure', 'Partitioned');
  }
  return parts.join('; ');
}

export async function readJsonBody<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    const text = await request.text();
    if (!text) return {} as T;
    return JSON.parse(text) as T;
  } catch {
    return {} as T;
  }
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyCsrfOrigin(request: Request, configuredAppUrl?: string): Response | null {
  const method = request.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    return null;
  }

  const trustedHosts = getTrustedHosts(request, configuredAppUrl);
  const origin = request.headers.get('origin');
  let originVerified = false;

  if (origin) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
        return errorResponse(403, 'Forbidden: Invalid Origin protocol.');
      }
      if (!trustedHosts.has(originUrl.host.toLowerCase())) {
        return errorResponse(403, 'Forbidden: Cross-origin state mutation rejected.');
      }
      originVerified = true;
    } catch {
      return errorResponse(403, 'Forbidden: Invalid Origin header.');
    }
  } else {
    const referer = request.headers.get('referer');
    if (referer) {
      try {
        const refUrl = new URL(referer);
        if (!trustedHosts.has(refUrl.host.toLowerCase())) {
          return errorResponse(403, 'Forbidden: Cross-origin referer rejected.');
        }
        originVerified = true;
      } catch {
        return errorResponse(403, 'Forbidden: Invalid Referer header.');
      }
    }
  }

  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'cross-site' && !originVerified) {
    return errorResponse(403, 'Forbidden: Cross-site request blocked.');
  }

  // Double-submit CSRF token enforcement when the browser holds an aegis_csrf cookie
  const cookies = parseCookies(request);
  const csrfCookie = cookies[CSRF_COOKIE_NAME];
  if (csrfCookie) {
    const csrfHeader = request.headers.get('x-csrf-token')?.trim() || '';
    if (!timingSafeStringEqual(csrfCookie, csrfHeader)) {
      return errorResponse(403, 'Forbidden: Missing or invalid CSRF token.');
    }
  }

  return null;
}

export function queryRecord(ctx: WorkerContext): Record<string, string> {
  const obj: Record<string, string> = {};
  ctx.url.searchParams.forEach((v, k) => {
    obj[k] = v;
  });
  return obj;
}
