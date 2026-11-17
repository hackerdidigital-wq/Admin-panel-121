export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiRequest<T = unknown>(
  path: string,
  options: RequestInit & { timeoutMs?: number } = {}
): Promise<T> {
  const { timeoutMs = 12_000, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers);
  if (fetchOptions.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
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
      }
      throw new ApiError(response.status, message);
    }

    if (contentType.includes('application/json')) {
      return (await response.json()) as T;
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
