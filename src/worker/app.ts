import { eq } from 'drizzle-orm';
import { isSchemaBootstrapped } from '../db/bootstrap.ts';
import { createDb } from '../db/index.ts';
import { apiLogs, systemSettings } from '../db/schema.ts';
import { SlidingWindowLimiter } from '../lib/security.ts';
import {
  applyCorsHeaders,
  applySdkCorsHeaders,
  errorResponse,
  getClientIp,
  isAllowedCorsOrigin,
  verifyCsrfOrigin,
  withSecurityHeaders,
} from './http.ts';
import { WorkerRouter } from './router.ts';
import { registerAuthAndDashboardRoutes } from './routes/authAndDashboard.ts';
import { registerCommerceAndAppRoutes } from './routes/commerceAndApp.ts';
import { registerContentAndCommsRoutes } from './routes/contentAndComms.ts';
import { registerDevDbFilesAiRoutes } from './routes/devDbFilesAi.ts';
import { registerMultiAppAndSdkRoutes } from './routes/multiAppAndSdk.ts';
import { registerOpsAndSecurityRoutes } from './routes/opsAndSecurity.ts';
import { registerUsersAndRolesRoutes } from './routes/usersAndRoles.ts';
import type { WorkerContext, WorkerEnv, WorkerExecutionContext } from './types.ts';

let configuredLimitPerMin = 180;
let rateLimiter = new SlidingWindowLimiter(configuredLimitPerMin, 60_000);
let lastLimitSync = 0;

function createRouter(): WorkerRouter {
  const router = new WorkerRouter();
  registerAuthAndDashboardRoutes(router);
  registerMultiAppAndSdkRoutes(router);
  registerUsersAndRolesRoutes(router);
  registerContentAndCommsRoutes(router);
  registerCommerceAndAppRoutes(router);
  registerOpsAndSecurityRoutes(router);
  registerDevDbFilesAiRoutes(router);
  return router;
}

const router = createRouter();

function decorateResponse(request: Request, response: Response, env: WorkerEnv, isSdkRequest: boolean): Response {
  return withSecurityHeaders(
    isSdkRequest
      ? applySdkCorsHeaders(response)
      : applyCorsHeaders(request, response, env?.APP_URL)
  );
}

export async function handleApiRequest(
  request: Request,
  env: WorkerEnv,
  executionCtx?: WorkerExecutionContext
): Promise<Response> {
  const url = new URL(request.url);
  const clientIp = getClientIp(request);
  const userAgent = request.headers.get('user-agent') || '';
  const isSdkRequest = url.pathname.startsWith('/api/v1/sdk/');

  // CORS preflight handling (SDK endpoints use API key auth without cookies)
  if (request.method.toUpperCase() === 'OPTIONS') {
    if (isSdkRequest) {
      return withSecurityHeaders(applySdkCorsHeaders(new Response(null, { status: 204 })));
    }
    const allowedOrigin = isAllowedCorsOrigin(request, env.APP_URL);
    if (request.headers.get('origin') && !allowedOrigin) {
      return withSecurityHeaders(errorResponse(403, 'Forbidden: Disallowed CORS origin.'));
    }
    return withSecurityHeaders(
      applyCorsHeaders(request, new Response(null, { status: 204 }), env.APP_URL)
    );
  }

  // Strict CSRF Origin/Double-submit enforcement on all Admin browser routes (SDK uses stateless API keys)
  if (!isSdkRequest) {
    const csrfFail = verifyCsrfOrigin(request, env.APP_URL);
    if (csrfFail) {
      return decorateResponse(request, csrfFail, env, false);
    }
  }

  if (!env?.DB) {
    return decorateResponse(
      request,
      errorResponse(
        503,
        'Cloudflare D1 database binding "DB" is not configured. Check wrangler.toml [[d1_databases]] binding.'
      ),
      env,
      isSdkRequest
    );
  }

  const db = createDb(env.DB);

  // Sliding-window rate limit backed by DB setting (only query once schema is bootstrapped)
  const now = Date.now();
  if (isSchemaBootstrapped(env.DB) && now - lastLimitSync > 30_000) {
    lastLimitSync = now;
    try {
      const rows = await db
        .select()
        .from(systemSettings)
        .where(eq(systemSettings.key, 'security.rateLimitPerMinute'))
        .limit(1);
      const val = Number(rows[0]?.value);
      if (Number.isFinite(val) && val >= 20 && val !== configuredLimitPerMin) {
        configuredLimitPerMin = Math.floor(val);
        rateLimiter = new SlidingWindowLimiter(configuredLimitPerMin, 60_000);
      }
    } catch {
      // Keep default limit if setting is unavailable
    }
  }

  const rateResult = rateLimiter.consume(clientIp, now);
  if (!rateResult.allowed) {
    const resp = errorResponse(429, 'Too many requests. Rate limit exceeded.', {
      retryAfterMs: rateResult.resetMs,
    });
    const headers = new Headers(resp.headers);
    headers.set('X-RateLimit-Limit', String(configuredLimitPerMin));
    headers.set('X-RateLimit-Remaining', '0');
    return decorateResponse(request, new Response(resp.body, { status: resp.status, headers }), env, isSdkRequest);
  }

  const matched = router.match(request.method, url.pathname);
  if (!matched) {
    return decorateResponse(request, errorResponse(404, 'API endpoint not found.'), env, isSdkRequest);
  }

  const ctx: WorkerContext = {
    request,
    url,
    params: matched.params,
    env,
    db,
    clientIp,
    userAgent,
    executionCtx,
    sdkAppId: null,
  };

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await matched.handler(ctx);
  } catch (err) {
    console.error(`API route error on ${request.method} ${url.pathname}:`, err);
    response = errorResponse(500, 'Internal server error.');
  }

  const durationMs = Date.now() - startedAt;

  // Record API telemetry asynchronously using ExecutionContext.waitUntil on Cloudflare Workers
  if (url.pathname !== '/api/realtime/snapshot' && isSchemaBootstrapped(env.DB)) {
    const appIdQuery = Number(url.searchParams.get('appId'));
    const loggedAppId =
      ctx.sdkAppId ?? (Number.isFinite(appIdQuery) && appIdQuery > 0 ? appIdQuery : null);
    const telemetryPromise = db
      .insert(apiLogs)
      .values({
        appId: loggedAppId,
        method: request.method.slice(0, 10),
        path: url.pathname.slice(0, 200),
        statusCode: response.status,
        durationMs,
        userId: ctx.adminUser?.id ?? null,
        ipAddress: clientIp,
        errorMessage: response.status >= 400 ? `HTTP ${response.status}` : '',
      })
      .catch(() => {});

    if (executionCtx && typeof executionCtx.waitUntil === 'function') {
      executionCtx.waitUntil(telemetryPromise);
    } else {
      void telemetryPromise;
    }
  }

  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', String(configuredLimitPerMin));
  headers.set('X-RateLimit-Remaining', String(rateResult.remaining));

  return decorateResponse(
    request,
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    }),
    env,
    isSdkRequest
  );
}
