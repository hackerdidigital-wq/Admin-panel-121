import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalD1Database } from '../src/db/local-d1.ts';
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

test('D1 SQLite migration initializes all 26 relational tables', async () => {
  const { d1, raw } = createLocalD1Database(':memory:');
  try {
    const res = await d1
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      )
      .all<{ name: string }>();
    assert.equal(res.results.length, 26);
  } finally {
    raw.close();
  }
});

test('Full Worker Auth Lifecycle: Setup -> Session -> Logout -> Login -> Lockout -> CSRF & Unauthenticated 401', async () => {
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
      body: { email: 'root@aegis.local', displayName: 'Root', password: 'SuperPassword#2026' },
      headers: { origin: 'https://evil.example' },
    });
    assert.equal(csrfRes.status, 403);

    // 4. First-Time Super Admin Setup succeeds & issues HttpOnly cookie
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { email: 'root@aegis.local', displayName: 'Root Admin', password: 'SuperPassword#2026' },
    });
    assert.equal(setupRes.status, 201);
    const setCookieHeader = setupRes.headers.get('set-cookie') || '';
    assert.ok(setCookieHeader.includes('HttpOnly'));
    const adminCookie = extractCookieValue(setupRes);
    assert.ok(adminCookie.startsWith('aegis_session='));

    // 5. Second setup attempt is locked (409)
    const secondSetup = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { email: 'attacker@aegis.local', displayName: 'Attacker', password: 'SuperPassword#2026' },
    });
    assert.equal(secondSetup.status, 409);

    // 6. Session profile returns super_admin & real dashboard stats (no fake data)
    const sessRes = await apiCall(env, 'GET', '/api/auth/session', { cookie: adminCookie });
    assert.equal(sessRes.status, 200);
    const sessBody = (await sessRes.json()) as { user: { roleSlug: string; email: string } };
    assert.equal(sessBody.user.roleSlug, 'super_admin');
    assert.equal(sessBody.user.email, 'root@aegis.local');

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

    // 8. 5 failed password attempts lock account (423 on 6th)
    for (let i = 0; i < 5; i++) {
      const failLogin = await apiCall(env, 'POST', '/api/auth/login', {
        body: { email: 'root@aegis.local', password: 'WrongPassword#999' },
      });
      assert.equal(failLogin.status, 401);
    }
    const lockedLogin = await apiCall(env, 'POST', '/api/auth/login', {
      body: { email: 'root@aegis.local', password: 'SuperPassword#2026' },
    });
    assert.equal(lockedLogin.status, 423);
  } finally {
    close();
  }
});

test('Worker API RBAC enforcement, Backup SHA-256 verification, and Audit Hash Chain integrity', async () => {
  const { env, close } = createTestEnv();
  try {
    // Bootstrap Super Admin
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { email: 'super@aegis.local', displayName: 'Super Admin', password: 'SuperPassword#2026' },
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

    // Login as support_agent
    const agentLoginRes = await apiCall(env, 'POST', '/api/auth/login', {
      body: { email: 'agent@aegis.local', password: 'AgentPassword#2026' },
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
