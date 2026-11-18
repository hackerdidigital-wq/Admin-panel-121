export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let cachedCsrfToken: string | null = null;

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const pairs = document.cookie ? document.cookie.split(';') : [];
  for (const part of pairs) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === 'aegis_csrf') {
      const val = part.slice(idx + 1).trim();
      try {
        return decodeURIComponent(val);
      } catch {
        return val;
      }
    }
  }
  return null;
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 20_000, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);
  const method = (fetchOptions.method || 'GET').toUpperCase();

  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    headers.set('X-Requested-With', 'XMLHttpRequest');
    const csrfToken = readCsrfCookie() || cachedCsrfToken;
    if (csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`/api${path}`, {
      ...fetchOptions,
      credentials: 'include',
      headers,
      signal: fetchOptions.signal ?? controller.signal,
    });

    const contentType = response.headers.get('content-type') || '';
    if (!response.ok) {
      let message = `Request failed (${response.status})`;
      if (contentType.includes('application/json')) {
        const payload = (await response.json()) as { error?: string };
        if (payload?.error) message = payload.error;
      } else if (response.status === 403) {
        message = 'Forbidden (403): Origin or CSRF verification failed. Reload the page and retry.';
      }
      throw new ApiError(response.status, message);
    }

    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as T & { csrfToken?: unknown };
      if (payload && typeof payload === 'object' && typeof payload.csrfToken === 'string') {
        cachedCsrfToken = payload.csrfToken;
      }
      return payload;
    }
    return (await response.text()) as unknown as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new ApiError(408, 'Request timed out while contacting the API server.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadWithAuth(path: string, filename: string): Promise<void> {
  const response = await fetch(`/api${path}`, {
    credentials: 'include',
  });
  if (!response.ok) {
    throw new ApiError(response.status, 'Failed to download file.');
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
