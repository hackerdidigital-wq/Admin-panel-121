import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLocalD1Database } from '../src/db/local-d1.ts';
import {
  deriveAppNameFromPackage,
  derivePackageNameFromInput,
  isValidPackageNameFormat,
  normalizePackageName,
  parseFlexibleTimestampMs,
  sanitizeBannerUrl,
  sanitizeRemoteBanner,
  sanitizeRemoteFlags,
  toActiveBinary,
} from '../src/lib/packageSync.ts';
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
  pathStr: string,
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
  const req = new Request(`http://localhost:3000${pathStr}`, {
    method,
    headers,
    body,
  });
  return handleApiRequest(req, env);
}

test('packageSync pure helpers normalize, validate, and sanitize inputs safely', () => {
  assert.equal(normalizePackageName('  Com.CyberKing.CandyMindMatch  '), 'com.cyberking.candymindmatch');
  assert.equal(normalizePackageName(null), '');

  assert.equal(isValidPackageNameFormat('com.cyberking.candymindmatch'), true);
  assert.equal(isValidPackageNameFormat('com.studio.app_v2'), true);
  assert.equal(isValidPackageNameFormat('invalid'), false);
  assert.equal(isValidPackageNameFormat('https://example.com'), false);
  assert.equal(isValidPackageNameFormat('com..bad'), false);

  const derivedValid = derivePackageNameFromInput(undefined, 'Com.CyberKing.CandyMindMatch');
  assert.equal(derivedValid.error, undefined);
  assert.equal(derivedValid.packageName, 'com.cyberking.candymindmatch');

  const derivedBad = derivePackageNameFromInput('not_a_package', 'not_a_package');
  assert.ok(derivedBad.error);

  const derivedWebsite = derivePackageNameFromInput(undefined, 'https://example.com');
  assert.equal(derivedWebsite.error, undefined);
  assert.equal(derivedWebsite.packageName, '');
  assert.equal(derivedWebsite.packageOrDomain, 'https://example.com');

  assert.equal(deriveAppNameFromPackage('com.cyberking.candymindmatch'), 'Candymindmatch');
  assert.equal(deriveAppNameFromPackage('com.studio.candy_match'), 'Candy Match');

  assert.equal(parseFlexibleTimestampMs(1_700_000_000, 123), 1_700_000_000_000);
  assert.equal(parseFlexibleTimestampMs(1_700_000_000_500, 123), 1_700_000_000_500);
  assert.equal(parseFlexibleTimestampMs('2026-01-01T00:00:00.000Z', 123), Date.parse('2026-01-01T00:00:00.000Z'));
  assert.equal(parseFlexibleTimestampMs('garbage', 999), 999);

  assert.equal(toActiveBinary(1, 0), 1);
  assert.equal(toActiveBinary('true', 0), 1);
  assert.equal(toActiveBinary(0, 1), 0);
  assert.equal(toActiveBinary('false', 1), 0);
  assert.equal(toActiveBinary('unknown', 1), 1);

  assert.equal(sanitizeBannerUrl('javascript:alert(1)'), '');
  assert.equal(sanitizeBannerUrl('https://example.com/offer'), 'https://example.com/offer');

  const cleanBanner = sanitizeRemoteBanner({
    enabled: true,
    title: '<b>Event</b>',
    message: 'Play now',
    ctaLabel: 'Go',
    ctaUrl: 'javascript:evil()',
  });
  assert.equal(cleanBanner.enabled, true);
  assert.equal(cleanBanner.cta_url, '');

  const cleanFlags = sanitizeRemoteFlags({
    __proto__: 'bad',
    daily_bonus: true,
    max_lives: 5,
    promo_code: 'CANDY2026',
  });
  assert.equal(Object.prototype.hasOwnProperty.call(cleanFlags, '__proto__'), false);
  assert.equal(cleanFlags.daily_bonus, true);
  assert.equal(cleanFlags.max_lives, 5);
  assert.equal(cleanFlags.promo_code, 'CANDY2026');
});

test('Package-Name Two-Way Sync: Heartbeat Auto-Register, Collision Protection, Announcements CRUD, Remote Config & Multi-App Isolation', async () => {
  const { env, close } = createTestEnv();
  try {
    // 1. Admin setup
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
    });
    assert.equal(setupRes.status, 201);
    const superCookie = extractCookieValue(setupRes);

    // 2. CORS preflight allows X-Package-Name & Origin * on two-way SDK endpoints
    for (const pathStr of [
      '/api/v1/sdk/heartbeat',
      '/api/v1/sdk/announcements',
      '/api/v1/sdk/remote-config',
    ]) {
      const preflight = await apiCall(env, 'OPTIONS', pathStr, {
        headers: {
          origin: 'https://android-client.example',
          'access-control-request-headers': 'X-Package-Name, Content-Type',
        },
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
      assert.ok((preflight.headers.get('access-control-allow-headers') || '').includes('X-Package-Name'));
    }

    // 3. First-time heartbeat auto-registers com.cyberking.candymindmatch safely (201)
    const hbFirst = await apiCall(env, 'POST', '/api/v1/sdk/heartbeat', {
      headers: { origin: 'https://android-client.example' },
      body: {
        package_name: 'com.cyberking.candymindmatch',
        app_name: 'Candy Mind Match',
        version_name: '1.4.2',
        version_code: 42,
        platform: 'android',
        last_seen_at: 1735689600,
        status: 'online',
        event: 'app_start',
      },
    });
    assert.equal(hbFirst.status, 201);
    assert.equal(hbFirst.headers.get('access-control-allow-origin'), '*');
    const hbFirstJson = (await hbFirst.json()) as {
      ok: boolean;
      registered: boolean;
      package_name: string;
      heartbeat: { version_name: string; version_code: number; status: string };
    };
    assert.equal(hbFirstJson.ok, true);
    assert.equal(hbFirstJson.registered, true);
    assert.equal(hbFirstJson.package_name, 'com.cyberking.candymindmatch');
    assert.equal(hbFirstJson.heartbeat.version_name, '1.4.2');
    assert.equal(hbFirstJson.heartbeat.version_code, 42);

    // Second heartbeat updates existing app without creating duplicate (200)
    const hbSecond = await apiCall(env, 'POST', '/api/v1/sdk/heartbeat', {
      body: {
        package_name: 'com.cyberking.candymindmatch',
        version_name: '1.4.3',
        version_code: 43,
        platform: 'android',
        status: 'online',
        event: 'level_complete',
      },
    });
    assert.equal(hbSecond.status, 200);
    const hbSecondJson = (await hbSecond.json()) as { registered: boolean };
    assert.equal(hbSecondJson.registered, false);

    // Lookup app via GET /api/apps?package_name=...
    const lookupRes = await apiCall(
      env,
      'GET',
      '/api/apps?package_name=com.cyberking.candymindmatch',
      { cookie: superCookie }
    );
    assert.equal(lookupRes.status, 200);
    const lookupJson = (await lookupRes.json()) as {
      data: Array<{ id: number; appUid: string; packageName: string; name: string }>;
    };
    assert.equal(lookupJson.data.length, 1);
    assert.equal(lookupJson.data[0].packageName, 'com.cyberking.candymindmatch');
    const candyAppId = lookupJson.data[0].id;

    // 4. Collision prevention: registering a duplicate package_name returns 409 PACKAGE_NAME_CONFLICT
    const dupRes = await apiCall(env, 'POST', '/api/apps', {
      cookie: superCookie,
      body: {
        name: 'Clone Candy',
        platform: 'android',
        packageName: 'COM.CYBERKING.CANDYMINDMATCH',
      },
    });
    assert.equal(dupRes.status, 409);
    const dupJson = (await dupRes.json()) as { code?: string };
    assert.equal(dupJson.code, 'PACKAGE_NAME_CONFLICT');

    // Create a second isolated Android app
    const secondAppRes = await apiCall(env, 'POST', '/api/apps', {
      cookie: superCookie,
      body: {
        name: 'Puzzle Quest Pro',
        platform: 'android',
        packageName: 'com.studio.puzzlequestpro',
      },
    });
    assert.equal(secondAppRes.status, 201);
    const secondAppJson = (await secondAppRes.json()) as {
      app: { id: number; appUid: string; packageName: string };
      initialApiKey: string;
    };
    assert.equal(secondAppJson.app.packageName, 'com.studio.puzzlequestpro');

    // Updating second app to Candy Mind Match's package_name must return 409
    const collidePatch = await apiCall(env, 'PATCH', `/api/apps/${secondAppJson.app.id}`, {
      cookie: superCookie,
      body: { packageName: 'com.cyberking.candymindmatch' },
    });
    assert.equal(collidePatch.status, 409);

    // 5. Announcements CRUD & active=1/0 filtering + multi-app isolation
    const createAnn1 = await apiCall(env, 'POST', `/api/apps/${candyAppId}/announcements`, {
      cookie: superCookie,
      body: {
        title: 'Low Priority Notice',
        body: 'Normal game update notice.',
        priority: 1,
        active: 1,
      },
    });
    assert.equal(createAnn1.status, 201);
    const ann1Json = (await createAnn1.json()) as { announcement: { id: number; active: number } };
    assert.equal(ann1Json.announcement.active, 1);

    const createAnn2 = await apiCall(env, 'POST', `/api/apps/${candyAppId}/announcements`, {
      cookie: superCookie,
      body: {
        title: 'Weekend Sugar Rush',
        body: '2x coins all weekend!',
        priority: 25,
        action_url: 'https://candymindmatch.example/event',
        active: 1,
      },
    });
    assert.equal(createAnn2.status, 201);
    const ann2Json = (await createAnn2.json()) as { announcement: { id: number } };

    // Add announcement to second app to prove zero cross-app leakage
    await apiCall(env, 'POST', `/api/apps/${secondAppJson.app.id}/announcements`, {
      cookie: superCookie,
      body: {
        title: 'Puzzle Quest Secret',
        body: 'Only for Puzzle Quest Pro',
        priority: 99,
        active: 1,
      },
    });

    // Pause ann1 (active = 0)
    const patchAnn1 = await apiCall(
      env,
      'PATCH',
      `/api/apps/${candyAppId}/announcements/${ann1Json.announcement.id}`,
      {
        cookie: superCookie,
        body: { active: 0 },
      }
    );
    assert.equal(patchAnn1.status, 200);

    // Client GET /api/v1/sdk/announcements?package_name=com.cyberking.candymindmatch&active=1
    const sdkAnnRes = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/announcements?package_name=com.cyberking.candymindmatch&active=1'
    );
    assert.equal(sdkAnnRes.status, 200);
    assert.equal(sdkAnnRes.headers.get('access-control-allow-origin'), '*');
    const sdkAnnJson = (await sdkAnnRes.json()) as {
      package_name: string;
      count: number;
      announcements: Array<{ id: number; package_name: string; title: string; active: number; priority: number }>;
    };
    assert.equal(sdkAnnJson.package_name, 'com.cyberking.candymindmatch');
    assert.equal(sdkAnnJson.count, 1);
    assert.equal(sdkAnnJson.announcements[0].id, ann2Json.announcement.id);
    assert.equal(sdkAnnJson.announcements[0].active, 1);
    assert.strictEqual(typeof sdkAnnJson.announcements[0].active, 'number');

    // Without active filter, returns both active=1 and active=0 for Candy Mind Match only
    const sdkAnnAll = await apiCall(env, 'GET', '/api/v1/sdk/announcements', {
      headers: { 'x-package-name': 'com.cyberking.candymindmatch' },
    });
    assert.equal(sdkAnnAll.status, 200);
    const sdkAnnAllJson = (await sdkAnnAll.json()) as { announcements: Array<{ active: number }> };
    assert.equal(sdkAnnAllJson.announcements.length, 2);

    // Delete ann1
    const delAnn1 = await apiCall(
      env,
      'DELETE',
      `/api/apps/${candyAppId}/announcements/${ann1Json.announcement.id}`,
      { cookie: superCookie }
    );
    assert.equal(delAnn1.status, 200);

    // 6. Remote Config PUT -> GET /api/v1/sdk/remote-config + optional require_sdk_key & mismatch guard
    const putRc = await apiCall(env, 'PUT', `/api/apps/${candyAppId}/remote-config`, {
      cookie: superCookie,
      body: {
        maintenance: true,
        kill_switch: true,
        maintenance_message: 'Upgrading match servers cleanly.',
        banner: {
          enabled: true,
          title: 'Season 5',
          message: 'Claim your bonus pack',
          cta_label: 'Claim',
          cta_url: 'https://candymindmatch.example/claim',
        },
        flags: {
          daily_bonus_enabled: true,
          starting_moves: 30,
          theme_variant: 'candy_neon',
        },
      },
    });
    assert.equal(putRc.status, 200);

    const sdkRcRes = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.cyberking.candymindmatch'
    );
    assert.equal(sdkRcRes.status, 200);
    const sdkRcJson = (await sdkRcRes.json()) as {
      package_name: string;
      maintenance: boolean;
      kill_switch: boolean;
      maintenance_message: string;
      banner: { enabled: boolean; title: string };
      flags: Record<string, unknown>;
    };
    assert.equal(sdkRcJson.package_name, 'com.cyberking.candymindmatch');
    assert.equal(sdkRcJson.maintenance, true);
    assert.equal(sdkRcJson.kill_switch, true);
    assert.equal(sdkRcJson.maintenance_message, 'Upgrading match servers cleanly.');
    assert.equal(sdkRcJson.banner.enabled, true);
    assert.equal(sdkRcJson.banner.title, 'Season 5');
    assert.equal(sdkRcJson.flags.daily_bonus_enabled, true);
    assert.equal(sdkRcJson.flags.starting_moves, 30);
    assert.equal(sdkRcJson.flags.theme_variant, 'candy_neon');

    // Second app remains online with kill_switch=false
    const secondRcRes = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.studio.puzzlequestpro'
    );
    assert.equal(secondRcRes.status, 200);
    const secondRcJson = (await secondRcRes.json()) as { kill_switch: boolean; flags: Record<string, unknown> };
    assert.equal(secondRcJson.kill_switch, false);
    assert.equal(secondRcJson.flags.starting_moves, undefined);

    // Enable require_sdk_key on second app & verify 401 without key, 403 on package mismatch, 200 with matching key
    const lockRc = await apiCall(env, 'PUT', `/api/apps/${secondAppJson.app.id}/remote-config`, {
      cookie: superCookie,
      body: { require_sdk_key: true },
    });
    assert.equal(lockRc.status, 200);

    const lockedDenied = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.studio.puzzlequestpro'
    );
    assert.equal(lockedDenied.status, 401);

    const mismatchDenied = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.cyberking.candymindmatch',
      {
        headers: {
          'x-app-id': secondAppJson.app.appUid,
          'x-api-key': secondAppJson.initialApiKey,
          'x-package-name': 'com.cyberking.candymindmatch',
        },
      }
    );
    assert.equal(mismatchDenied.status, 403);

    const lockedAllowed = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.studio.puzzlequestpro',
      {
        headers: {
          'x-app-id': secondAppJson.app.appUid,
          'x-api-key': secondAppJson.initialApiKey,
          'x-package-name': 'com.studio.puzzlequestpro',
        },
      }
    );
    assert.equal(lockedAllowed.status, 200);

    // 7. Workspace & Heartbeats endpoint return recorded telemetry cleanly
    const [hbListRes, wsRes] = await Promise.all([
      apiCall(env, 'GET', `/api/apps/${candyAppId}/heartbeats`, { cookie: superCookie }),
      apiCall(env, 'GET', `/api/apps/${candyAppId}/workspace`, { cookie: superCookie }),
    ]);
    assert.equal(hbListRes.status, 200);
    const hbListJson = (await hbListRes.json()) as { total: number; data: Array<{ package_name: string }> };
    assert.equal(hbListJson.total, 2);
    assert.equal(hbListJson.data[0].package_name, 'com.cyberking.candymindmatch');

    assert.equal(wsRes.status, 200);
    const wsJson = (await wsRes.json()) as {
      announcements: unknown[];
      heartbeats: unknown[];
      remoteConfig: { kill_switch: boolean };
    };
    assert.equal(wsJson.announcements.length, 1);
    assert.equal(wsJson.heartbeats.length, 2);
    assert.equal(wsJson.remoteConfig.kill_switch, true);
  } finally {
    close();
  }
});

test('Pre-versioned legacy SQLite DB upgrades cleanly through migration 0004 without losing rows', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-legacy-0004-'));
  const dbPath = path.join(tmpDir, 'legacy.sqlite');
  try {
    // Seed a database with only migrations 0001-0003 and NO __aegis_migrations table
    const preDb = new DatabaseSync(dbPath);
    for (const mig of [
      '0001_init.sql',
      '0002_multi_app.sql',
      '0003_universal_master_control.sql',
    ]) {
      const sqlText = fs.readFileSync(path.join(process.cwd(), 'migrations', mig), 'utf8');
      preDb.exec(sqlText);
    }
    preDb
      .prepare(
        "INSERT INTO connected_apps (app_uid, slug, name, platform, package_or_domain) VALUES ('app_leg1', 'candy-legacy', 'Candy Legacy', 'android', 'Com.CyberKing.CandyMindMatch')"
      )
      .run();
    preDb.close();

    // Open with createLocalD1Database -> should apply 0004 and backfill package_name cleanly
    const { d1, raw } = createLocalD1Database(dbPath);
    try {
      const tables = await d1
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all<{ name: string }>();
      assert.equal(tables.results.length, 39);

      const appRow = await d1
        .prepare("SELECT package_name FROM connected_apps WHERE app_uid = 'app_leg1'")
        .first<{ package_name: string }>();
      assert.equal(appRow?.package_name, 'com.cyberking.candymindmatch');
    } finally {
      raw.close();
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
