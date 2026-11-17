import { eq } from 'drizzle-orm';
import { createDb } from '../db/index.ts';
import { apiLogs, systemSettings } from '../db/schema.ts';
import { SlidingWindowLimiter } from '../lib/security.ts';
import {
  errorResponse,
  getClientIp,
  verifyCsrfOrigin,
  withSecurityHeaders,
} from './http.ts';
import { WorkerRouter } from './router.ts';
import { registerAuthAndDashboardRoutes } from './routes/authAndDashboard.ts';
import { registerCommerceAndAppRoutes } from './routes/commerceAndApp.ts';
import { registerContentAndCommsRoutes } from './routes/contentAndComms.ts';
import { registerDevDbFilesAiRoutes } from './routes/devDbFilesAi.ts';
import { registerOpsAndSecurityRoutes } from './routes/opsAndSecurity.ts';
import { registerUsersAndRolesRoutes } from './routes/usersAndRoles.ts';
import type { WorkerContext, WorkerEnv } from './types.ts';

let configuredLimitPerMin = 180;
let rateLimiter = new SlidingWindowLimiter(configuredLimitPerMin, 60_000);
let lastLimitSync = 0;

function createRouter(): WorkerRouter {
  const router = new WorkerRouter();
  registerAuthAndDashboardRoutes(router);
  registerUsersAndRolesRoutes(router);
  registerContentAndCommsRoutes(router);
  registerCommerceAndAppRoutes(router);
  registerOpsAndSecurityRoutes(router);
  registerDevDbFilesAiRoutes(router);
  return router;
}

const router = createRouter();

export async function handleApiRequest(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const clientIp = getClientIp(request);
  const userAgent = request.headers.get('user-agent') || '';
  const db = createDb(env.DB);

  // CSRF check on mutating requests
  const csrfFail = verifyCsrfOrigin(request);
  if (csrfFail) {
    return withSecurityHeaders(csrfFail);
  }

  // Sliding-window rate limit backed by DB setting
  const now = Date.now();
  if (now - lastLimitSync > 30_000) {
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
      // Keep default limit before first migration/seed
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
    return withSecurityHeaders(
      new Response(resp.body, { status: resp.status, headers })
    );
  }

  const matched = router.match(request.method, url.pathname);
  if (!matched) {
    return withSecurityHeaders(errorResponse(404, 'API endpoint not found.'));
  }

  const ctx: WorkerContext = {
    request,
    url,
    params: matched.params,
    env,
    db,
    clientIp,
    userAgent,
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

  // Record API telemetry asynchronously without blocking response
  if (url.pathname !== '/api/realtime/snapshot') {
    void db
      .insert(apiLogs)
      .values({
        method: request.method.slice(0, 10),
        path: url.pathname.slice(0, 200),
        statusCode: response.status,
        durationMs,
        userId: ctx.adminUser?.id ?? null,
        ipAddress: clientIp,
        errorMessage: response.status >= 400 ? `HTTP ${response.status}` : '',
      })
      .catch(() => {});
  }

  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', String(configuredLimitPerMin));
  headers.set('X-RateLimit-Remaining', String(rateResult.remaining));

  return withSecurityHeaders(
    new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  );
}
