import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalD1Database } from '../src/db/local-d1.ts';
import { hashPassword } from '../src/lib/security.ts';
import { handleApiRequest } from '../src/worker/app.ts';
import type { WorkerEnv } from '../src/worker/types.ts';

function createTestEnv(sqlitePath = ':memory:'): {
  env: WorkerEnv;
  close: () => void;
} {
  const { d1, raw } = createLocalD1Database(sqlitePath);
  return {
    env: {
      DB: d1,
      APP_ENV: 'test',
    },
    close: () => raw.close(),
  };
}

function extractCookieValue(res: Response, name = 'aegis_session'): string {
  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(new RegExp(`${name}=([^;]+)`));
  return match ? `${name}=${match[1]}` : '';
}

async function apiCall(
  env: WorkerEnv,
  method: string,
  path: string,
  options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}
): Promise<Response> {
  const headers = new Headers({
    host: 'localhost:3000',
    ...(options.headers ?? {}),
  });
  if (options.cookie) {
    headers.set('cookie', options.cookie);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }
  const req = new Request(`http://localhost:3000${path}`, {
    method,
    headers,
    body,
  });
  return handleApiRequest(req, env);
}

test('D1 SQLite migration initializes all 26 relational tables, foreign keys, and indexes', async () => {
  const { d1, raw } = createLocalD1Database(':memory:');
  try {
    const tables = await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all<{ name: string }>();
    assert.equal(tables.results.length, 26);

    const indexes = await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'"
      )
      .all<{ name: string }>();
    assert.ok(indexes.results.length >= 15);

    const fkCheck = raw.prepare('PRAGMA foreign_key_check').all();
    assert.equal(fkCheck.length, 0);
  } finally {
    raw.close();
  }
});

test('Worker enforces strict same-origin CORS preflight and security headers', async () => {
  const { env, close } = createTestEnv();
  try {
    const sameOriginPreflight = await apiCall(env, 'OPTIONS', '/api/health', {
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(sameOriginPreflight.status, 204);
    assert.equal(sameOriginPreflight.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(sameOriginPreflight.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(sameOriginPreflight.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(sameOriginPreflight.headers.get('x-frame-options'), 'SAMEORIGIN');

    const evilPreflight = await apiCall(env, 'OPTIONS', '/api/health', {
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(evilPreflight.status, 403);
    assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);
  } finally {
    close();
  }
});

test('Full Worker Password-Only Auth Lifecycle: Setup -> Session -> Logout -> Login -> No Lockout -> CSRF & Unauthenticated 401', async () => {
  const { env, close } = createTestEnv();
  try {
    // 1. Health & initial setup status
    const healthRes = await apiCall(env, 'GET', '/api/health');
    assert.equal(healthRes.status, 200);
    const healthBody = (await healthRes.json()) as { status: string; engine: string };
    assert.equal(healthBody.status, 'ok');
    assert.equal(healthBody.engine, 'cloudflare-d1-sqlite');

    const statusRes = await apiCall(env, 'GET', '/api/auth/status');
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { needsSetup: boolean; emailProviderConfigured: boolean };
    assert.equal(statusBody.needsSetup, true);
    assert.equal(statusBody.emailProviderConfigured, false);

    // 2. Unauthenticated dashboard request returns 401
    const unauthDash = await apiCall(env, 'GET', '/api/dashboard/overview');
    assert.equal(unauthDash.status, 401);

    // 3. Cross-origin mutation rejected with 403
    const csrfRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(csrfRes.status, 403);

    // 4. First-Time Password-Only Setup succeeds (no email/username) & issues HttpOnly cookie
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
    });
    assert.equal(setupRes.status, 201);
    const setCookieHeader = setupRes.headers.get('set-cookie') || '';
    assert.ok(setCookieHeader.includes('HttpOnly'));
    const adminCookie = extractCookieValue(setupRes);
    assert.ok(adminCookie.startsWith('aegis_session='));

    // 5. Second setup attempt is locked (409)
    const secondSetup = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'AnotherPassword#2026' },
    });
    assert.equal(secondSetup.status, 409);

    // 6. Session profile returns super_admin & real dashboard stats (no fake data)
    const sessRes = await apiCall(env, 'GET', '/api/auth/session', { cookie: adminCookie });
    assert.equal(sessRes.status, 200);
    const sessBody = (await sessRes.json()) as { user: { roleSlug: string } };
    assert.equal(sessBody.user.roleSlug, 'super_admin');

    const dashRes = await apiCall(env, 'GET', '/api/dashboard/overview', { cookie: adminCookie });
    assert.equal(dashRes.status, 200);
    const dashBody = (await dashRes.json()) as { kpis: { totalUsers: number; totalTransactions: number } };
    assert.equal(dashBody.kpis.totalUsers, 1);
    assert.equal(dashBody.kpis.totalTransactions, 0);

    // 7. Logout revokes session
    const logoutRes = await apiCall(env, 'POST', '/api/auth/logout', { cookie: adminCookie });
    assert.equal(logoutRes.status, 200);
    const afterLogoutSess = await apiCall(env, 'GET', '/api/auth/session', { cookie: adminCookie });
    assert.equal(afterLogoutSess.status, 401);

    // 8. Wrong password attempts return 401 without locking the administrator out
    for (let i = 0; i < 5; i++) {
      const failLogin = await apiCall(env, 'POST', '/api/auth/login', {
        body: { password: 'WrongPassword#999' },
      });
      assert.equal(failLogin.status, 401);
    }

    // 9. Password-only login succeeds immediately after wrong attempts (no email required)
    const validLogin = await apiCall(env, 'POST', '/api/auth/login', {
      body: { password: 'SuperPassword#2026' },
    });
    assert.equal(validLogin.status, 200);
    const reloginCookie = extractCookieValue(validLogin);
    assert.ok(reloginCookie.startsWith('aegis_session='));
  } finally {
    close();
  }
});

test('Password-only setup preserves existing admin record and avoids lockout', async () => {
  const { env, close } = createTestEnv();
  try {
    // Seed an existing admin row without passwordHash (simulating legacy/OAuth migration)
    await env.DB.prepare(
      "INSERT INTO users (uid, email, display_name, status, is_admin, locked_until, failed_login_attempts) VALUES ('adm_legacy', 'legacy-admin@aegis.local', 'Legacy Owner', 'active', 1, 9999999999999, 5)"
    ).run();

    const statusRes = await apiCall(env, 'GET', '/api/auth/status');
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { needsSetup: boolean };
    assert.equal(statusBody.needsSetup, true);

    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'OwnerChosen#Password1' },
    });
    assert.equal(setupRes.status, 201);

    // Existing row preserved in-place instead of wiped or duplicated
    const rows = await env.DB.prepare('SELECT id, email, display_name, locked_until FROM users').all<{
      id: number;
      email: string;
      display_name: string;
      locked_until: number | null;
    }>();
    assert.equal(rows.results.length, 1);
    assert.equal(rows.results[0].email, 'legacy-admin@aegis.local');
    assert.equal(rows.results[0].display_name, 'Legacy Owner');
    assert.equal(rows.results[0].locked_until, null);

    // Direct password-only login works
    const loginRes = await apiCall(env, 'POST', '/api/auth/login', {
      body: { password: 'OwnerChosen#Password1' },
    });
    assert.equal(loginRes.status, 200);
  } finally {
    close();
  }
});

test('Worker API RBAC enforcement, Backup SHA-256 verification, and Audit Hash Chain integrity', async () => {
  const { env, close } = createTestEnv();
  try {
    // Bootstrap Super Admin with password only
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
    });
    assert.equal(setupRes.status, 201);
    const superCookie = extractCookieValue(setupRes);

    // Fetch roles to find support_agent ID
    const rolesRes = await apiCall(env, 'GET', '/api/roles', { cookie: superCookie });
    assert.equal(rolesRes.status, 200);
    const rolesBody = (await rolesRes.json()) as { roles: Array<{ id: number; slug: string }> };
    const supportRole = rolesBody.roles.find((r) => r.slug === 'support_agent');
    assert.ok(supportRole);

    // Create support_agent user with real PBKDF2 password
    const createAgentRes = await apiCall(env, 'POST', '/api/users', {
      cookie: superCookie,
      body: {
        email: 'agent@aegis.local',
        displayName: 'Support Agent',
        password: 'AgentPassword#2026',
        roleId: supportRole.id,
      },
    });
    assert.equal(createAgentRes.status, 201);

    // Create and verify a D1 JSON Backup as Super Admin
    const backupCreateRes = await apiCall(env, 'POST', '/api/database/backups', {
      cookie: superCookie,
      body: {},
    });
    assert.equal(backupCreateRes.status, 201);
    const backupBody = (await backupCreateRes.json()) as { backup: { id: number; checksumSha256: string } };
    assert.ok(backupBody.backup.id > 0);
    assert.equal(backupBody.backup.checksumSha256.length, 64);

    const backupVerifyRes = await apiCall(
      env,
      'POST',
      `/api/database/backups/${backupBody.backup.id}/verify`,
      { cookie: superCookie, body: {} }
    );
    assert.equal(backupVerifyRes.status, 200);
    const verifyBody = (await backupVerifyRes.json()) as { valid: boolean };
    assert.equal(verifyBody.valid, true);

    // Login as support_agent with password
    const agentLoginRes = await apiCall(env, 'POST', '/api/auth/login', {
      body: { password: 'AgentPassword#2026' },
    });
    assert.equal(agentLoginRes.status, 200);
    const agentCookie = extractCookieValue(agentLoginRes);
    assert.ok(agentCookie.startsWith('aegis_session='));

    // Support Agent MUST receive 403 on privileged admin routes
    const roleCreateDenied = await apiCall(env, 'POST', '/api/roles', {
      cookie: agentCookie,
      body: { name: 'Rogue Role', hierarchyLevel: 50 },
    });
    assert.equal(roleCreateDenied.status, 403);

    const dbInspectDenied = await apiCall(env, 'GET', '/api/database/records/users', {
      cookie: agentCookie,
    });
    assert.equal(dbInspectDenied.status, 403);

    const settingsUpdateDenied = await apiCall(env, 'PUT', '/api/settings/general.siteName', {
      cookie: agentCookie,
      body: { value: 'Hacked Console' },
    });
    assert.equal(settingsUpdateDenied.status, 403);

    // Support Agent MUST succeed on permitted routes
    const ticketRes = await apiCall(env, 'POST', '/api/support/tickets', {
      cookie: agentCookie,
      body: {
        subject: 'Cannot upload invoice PDF',
        description: 'Customer receives 400 when attempting >750 KB file.',
        priority: 'high',
      },
    });
    assert.equal(ticketRes.status, 201);

    const contentRes = await apiCall(env, 'GET', '/api/content', { cookie: agentCookie });
    assert.equal(contentRes.status, 200);

    // Verify tamper-evident SHA-256 audit log chain as Super Admin
    const auditVerifyRes = await apiCall(env, 'GET', '/api/audit/verify', { cookie: superCookie });
    assert.equal(auditVerifyRes.status, 200);
    const auditVerifyBody = (await auditVerifyRes.json()) as { valid: boolean; checked: number };
    assert.equal(auditVerifyBody.valid, true);
    assert.ok(auditVerifyBody.checked >= 5);
  } finally {
    close();
  }
});

test('Reverse-proxy CSRF Origin validation, X-Forwarded-Host spoofing guard, double-submit CSRF token, and HTTPS iframe cookies', async () => {
  const { env, close } = createTestEnv();
  env.APP_URL = 'https://ais-dev-example.asia-southeast1.run.app';
  try {
    // 1. Cross-origin spoofed X-Forwarded-Host on non-loopback production host MUST still be rejected (403)
    const spoofedProd = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
      headers: {
        host: 'aegis.example.workers.dev',
        origin: 'https://evil.example',
        'x-forwarded-host': 'evil.example',
      },
    });
    assert.equal(spoofedProd.status, 403);

    // 2. Fetch status to get CSRF cookie & token under AI Studio Preview reverse-proxy headers
    const statusRes = await apiCall(env, 'GET', '/api/auth/status', {
      headers: {
        host: 'localhost:3000',
        'x-forwarded-host': 'ais-pre-example.asia-southeast1.run.app',
        origin: 'https://ais-pre-example.asia-southeast1.run.app',
      },
    });
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { needsSetup: boolean; csrfToken: string };
    assert.equal(statusBody.needsSetup, true);
    assert.ok(statusBody.csrfToken.length >= 32);
    const csrfCookie = extractCookieValue(statusRes, 'aegis_csrf');
    assert.ok(csrfCookie.startsWith('aegis_csrf='));

    // 3. When aegis_csrf cookie is present, missing/wrong X-CSRF-Token header MUST be rejected (403)
    const missingCsrfHeader = await apiCall(env, 'POST', '/api/auth/setup', {
      cookie: csrfCookie,
      body: { password: 'SuperPassword#2026' },
      headers: {
        host: 'localhost:3000',
        'x-forwarded-host': 'ais-pre-example.asia-southeast1.run.app',
        origin: 'https://ais-pre-example.asia-southeast1.run.app',
      },
    });
    assert.equal(missingCsrfHeader.status, 403);

    // 4. Reverse-proxied setup with valid Origin + X-Forwarded-Host + matching X-CSRF-Token succeeds (201)
    //    and emits SameSite=None; Secure; Partitioned for cross-site HTTPS iframes
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      cookie: csrfCookie,
      body: { password: 'SuperPassword#2026' },
      headers: {
        host: 'localhost:3000',
        'x-forwarded-host': 'ais-pre-example.asia-southeast1.run.app',
        'x-forwarded-proto': 'http', // Simulate NGINX rewriting proto while Origin is https://
        origin: 'https://ais-pre-example.asia-southeast1.run.app',
        'x-csrf-token': statusBody.csrfToken,
      },
    });
    assert.equal(setupRes.status, 201);
    const setCookies = setupRes.headers.getSetCookie();
    const sessionHeader = setCookies.find((c) => c.startsWith('aegis_session=')) || '';
    assert.ok(sessionHeader.includes('HttpOnly'));
    assert.ok(sessionHeader.includes('SameSite=None'));
    assert.ok(sessionHeader.includes('Secure'));
    assert.ok(sessionHeader.includes('Partitioned'));
  } finally {
    close();
  }
});

test('Auto-upgrades empty minimal 3-column users table on Cloudflare D1 without 503 errors', async () => {
  const { d1, raw } = createLocalD1Database(':memory:', { skipMigrations: true });
  try {
    // Recreate exact minimal table from user report with no other tables
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    const env: WorkerEnv = { DB: d1, APP_ENV: 'test' };

    const statusRes = await apiCall(env, 'GET', '/api/auth/status');
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { needsSetup: boolean; databaseReady: boolean };
    assert.equal(statusBody.needsSetup, true);
    assert.equal(statusBody.databaseReady, true);

    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'WorkerD1#Setup2026' },
    });
    assert.equal(setupRes.status, 201);
    const cookie = extractCookieValue(setupRes);
    assert.ok(cookie.startsWith('aegis_session='));

    const sessionRes = await apiCall(env, 'GET', '/api/auth/session', { cookie });
    assert.equal(sessionRes.status, 200);
    const sessionBody = (await sessionRes.json()) as { user: { roleSlug: string } };
    assert.equal(sessionBody.user.roleSlug, 'super_admin');

    const logoutRes = await apiCall(env, 'POST', '/api/auth/logout', { cookie });
    assert.equal(logoutRes.status, 200);

    const loginRes = await apiCall(env, 'POST', '/api/auth/login', {
      body: { password: 'WorkerD1#Setup2026' },
    });
    assert.equal(loginRes.status, 200);
  } finally {
    raw.close();
  }
});

test('Preserves existing password hash when auto-upgrading minimal 3-column users table and grants super_admin access', async () => {
  const { d1, raw } = createLocalD1Database(':memory:', { skipMigrations: true });
  try {
    raw.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const existingHash = await hashPassword('PreExisting#Admin99');
    raw
      .prepare('INSERT INTO users (id, password_hash, created_at) VALUES (?, ?, ?)')
      .run('adm_manual_01', existingHash, '2026-11-17T00:00:00.000Z');

    const env: WorkerEnv = { DB: d1, APP_ENV: 'test' };

    const statusRes = await apiCall(env, 'GET', '/api/auth/status');
    assert.equal(statusRes.status, 200);
    const statusBody = (await statusRes.json()) as { needsSetup: boolean };
    assert.equal(statusBody.needsSetup, false);

    const loginRes = await apiCall(env, 'POST', '/api/auth/login', {
      body: { password: 'PreExisting#Admin99' },
    });
    assert.equal(loginRes.status, 200);
    const cookie = extractCookieValue(loginRes);

    const sessionRes = await apiCall(env, 'GET', '/api/auth/session', { cookie });
    assert.equal(sessionRes.status, 200);
    const sessionBody = (await sessionRes.json()) as {
      user: { uid: string; roleSlug: string };
      permissions: string[];
    };
    assert.equal(sessionBody.user.uid, 'adm_manual_01');
    assert.equal(sessionBody.user.roleSlug, 'super_admin');
    assert.ok(sessionBody.permissions.includes('database.inspect'));
  } finally {
    raw.close();
  }
});

test('Missing D1 binding returns clean 503 JSON, ExecutionContext.waitUntil records telemetry, and warm requests skip seeding queries', async () => {
  const missingDbRes = await handleApiRequest(
    new Request('http://localhost:3000/api/auth/status', {
      headers: { host: 'localhost:3000' },
    }),
    {} as WorkerEnv
  );
  assert.equal(missingDbRes.status, 503);
  const missingBody = (await missingDbRes.json()) as { error: string };
  assert.ok(missingBody.error.includes('DB'));

  const { d1, raw } = createLocalD1Database(':memory:');
  try {
    let prepareCalls = 0;
    const countedD1: typeof d1 = {
      prepare(q: string) {
        prepareCalls += 1;
        return d1.prepare(q);
      },
      batch(stmts) {
        return d1.batch(stmts);
      },
      exec(q: string) {
        return d1.exec(q);
      },
    };
    const env: WorkerEnv = { DB: countedD1, APP_ENV: 'test' };
    const waitUntilPromises: Promise<unknown>[] = [];

    // Cold call initializes seed via batched statements
    const coldRes = await handleApiRequest(
      new Request('http://localhost:3000/api/auth/status', {
        headers: { host: 'localhost:3000' },
      }),
      env,
      {
        waitUntil(p) {
          waitUntilPromises.push(p);
        },
      }
    );
    assert.equal(coldRes.status, 200);
    await Promise.all(waitUntilPromises);
    assert.ok(waitUntilPromises.length >= 1);

    // Warm call must NOT re-run seed inserts (only auth/status + rate limit reads <= 5 prepares)
    prepareCalls = 0;
    const warmRes = await handleApiRequest(
      new Request('http://localhost:3000/api/auth/status', {
        headers: { host: 'localhost:3000' },
      }),
      env
    );
    assert.equal(warmRes.status, 200);
    assert.ok(prepareCalls <= 6, `Expected <= 6 prepares on warm request, got ${prepareCalls}`);
  } finally {
    raw.close();
  }
});


