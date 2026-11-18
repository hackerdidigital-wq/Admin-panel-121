import { handleApiRequest } from './app.ts';
import { withSecurityHeaders } from './http.ts';
import type { WorkerEnv, WorkerExecutionContext } from './types.ts';

export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    ctx?: WorkerExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleApiRequest(request, env, ctx);
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status === 404 && !url.pathname.includes('.')) {
        // SPA history fallback
        const indexUrl = new URL('/index.html', url.origin);
        return withSecurityHeaders(await env.ASSETS.fetch(indexUrl.toString()));
      }
      return withSecurityHeaders(assetRes);
    }

    return new Response('Static ASSETS binding not configured.', { status: 404 });
  },
};
