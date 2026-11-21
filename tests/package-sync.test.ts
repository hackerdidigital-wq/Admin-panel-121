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
  extractAppVersionCode,
  extractConnectionConfig,
  extractFirebaseMetadata,
  extractHeartbeatDeviceInfo,
  isValidPackageNameFormat,
  normalizePackageName,
  parseFlexibleTimestampMs,
  parseGoogleServicesJson,
  parseQuickConnectJson,
  parseVersionCode,
  sanitizeBannerUrl,
  sanitizeConnectionConfig,
  sanitizeRemoteBanner,
  sanitizeRemoteFlags,
  toActiveBinary,
  validateFirebaseAppId,
  validateFirebaseProjectId,
  validateFirebaseProjectNumber,
  validateFirebaseStorageBucket,
  withConnectionSettings,
  withFirebaseSettings,
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

  assert.deepEqual(validateFirebaseProjectId('  Psychic-Advantage-Nsmzh '), {
    value: 'psychic-advantage-nsmzh',
  });
  assert.ok(validateFirebaseProjectId('BAD PROJECT!!').error);
  assert.deepEqual(validateFirebaseProjectId(''), { value: '' });

  assert.deepEqual(
    validateFirebaseAppId('1:663704095886:android:51917d3b7fb6839b798ddf'),
    { value: '1:663704095886:android:51917d3b7fb6839b798ddf' }
  );
  assert.ok(validateFirebaseAppId('not-a-firebase-app-id').error);

  assert.deepEqual(
    validateFirebaseProjectNumber('663704095886'),
    { value: '663704095886' }
  );
  assert.ok(validateFirebaseProjectNumber('abc').error);

  assert.deepEqual(
    validateFirebaseStorageBucket('  Psychic-Advantage-Nsmzh.firebasestorage.app '),
    { value: 'psychic-advantage-nsmzh.firebasestorage.app' }
  );
  assert.ok(validateFirebaseStorageBucket('bad..bucket').error);

  const mergedSettings = withFirebaseSettings(
    { customKey: 1 },
    {
      firebaseProjectId: 'psychic-advantage-nsmzh',
      firebaseAppId: '1:663704095886:android:51917d3b7fb6839b798ddf',
      firebaseProjectNumber: '663704095886',
      firebaseStorageBucket: 'psychic-advantage-nsmzh.firebasestorage.app',
    }
  );
  assert.deepEqual(extractFirebaseMetadata(mergedSettings), {
    firebase_project_id: 'psychic-advantage-nsmzh',
    firebase_app_id: '1:663704095886:android:51917d3b7fb6839b798ddf',
    firebase_project_number: '663704095886',
    firebase_storage_bucket: 'psychic-advantage-nsmzh.firebasestorage.app',
  });

  const clearedSettings = withFirebaseSettings(mergedSettings, {
    firebaseProjectId: '',
    firebaseAppId: '',
    firebaseProjectNumber: '',
    firebaseStorageBucket: '',
  });
  assert.deepEqual(extractFirebaseMetadata(clearedSettings), {
    firebase_project_id: '',
    firebase_app_id: '',
    firebase_project_number: '',
    firebase_storage_bucket: '',
  });
  assert.equal(clearedSettings.customKey, 1);

  assert.deepEqual(
    extractHeartbeatDeviceInfo({
      device_model: 'Pixel 8 Pro',
      os_version: 'Android 15',
      manufacturer: 'Google',
    }),
    {
      device_model: 'Pixel 8 Pro',
      os_version: 'Android 15',
      manufacturer: 'Google',
    }
  );
  assert.deepEqual(extractHeartbeatDeviceInfo({}, 'Dalvik/2.1.0 (Linux; Android 14)'), {
    device_model: 'Dalvik/2.1.0 (Linux; Android 14)',
    os_version: '',
    manufacturer: '',
  });

  const sampleGoogleServices = JSON.stringify({
    project_info: {
      project_number: '663704095886',
      project_id: 'psychic-advantage-nsmzh',
      storage_bucket: 'psychic-advantage-nsmzh.firebasestorage.app',
    },
    client: [
      {
        client_info: {
          mobilesdk_app_id: '1:663704095886:android:3f1232edee382fb4798ddf',
          android_client_info: { package_name: 'com.cyberking.shayarilok' },
        },
        api_key: [{ current_key: 'FAKE_TEST_API_KEY_NOT_REAL' }],
      },
      {
        client_info: {
          mobilesdk_app_id: '1:663704095886:android:51917d3b7fb6839b798ddf',
          android_client_info: { package_name: 'com.cyberking.candymindmatch' },
        },
        api_key: [{ current_key: 'FAKE_TEST_API_KEY_NOT_REAL_2' }],
      },
    ],
  });
  const gsParsed = parseGoogleServicesJson(sampleGoogleServices);
  assert.equal(gsParsed.error, undefined);
  assert.equal(gsParsed.config?.project_id, 'psychic-advantage-nsmzh');
  assert.equal(gsParsed.config?.project_number, '663704095886');
  assert.equal(gsParsed.config?.storage_bucket, 'psychic-advantage-nsmzh.firebasestorage.app');
  assert.equal(gsParsed.config?.clients.length, 2);
  assert.deepEqual(gsParsed.config?.clients[1], {
    package_name: 'com.cyberking.candymindmatch',
    mobilesdk_app_id: '1:663704095886:android:51917d3b7fb6839b798ddf',
    app_name_suggestion: 'Candymindmatch',
  });
  assert.equal(JSON.stringify(gsParsed).includes('FAKE_TEST_API_KEY'), false);
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
        firebase_project_id: 'psychic-advantage-nsmzh',
        firebase_app_id: '1:663704095886:android:51917d3b7fb6839b798ddf',
        firebase_project_number: '663704095886',
        firebase_storage_bucket: 'psychic-advantage-nsmzh.firebasestorage.app',
        device_model: 'Pixel 8',
        os_version: 'Android 14',
      },
    });
    assert.equal(hbFirst.status, 201);
    assert.equal(hbFirst.headers.get('access-control-allow-origin'), '*');
    assert.equal(
      hbFirst.headers.get('cache-control'),
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    assert.equal(hbFirst.headers.get('pragma'), 'no-cache');
    const hbFirstJson = (await hbFirst.json()) as {
      ok: boolean;
      registered: boolean;
      package_name: string;
      heartbeat: {
        version_name: string;
        version_code: number;
        status: string;
        device_model: string;
        os_version: string;
      };
    };
    assert.equal(hbFirstJson.ok, true);
    assert.equal(hbFirstJson.registered, true);
    assert.equal(hbFirstJson.package_name, 'com.cyberking.candymindmatch');
    assert.equal(hbFirstJson.heartbeat.version_name, '1.4.2');
    assert.equal(hbFirstJson.heartbeat.version_code, 42);
    assert.equal(hbFirstJson.heartbeat.device_model, 'Pixel 8');
    assert.equal(hbFirstJson.heartbeat.os_version, 'Android 14');

    // Second heartbeat updates existing app without creating duplicate (200)
    const hbSecond = await apiCall(env, 'POST', '/api/v1/sdk/heartbeat', {
      body: {
        package_name: 'com.cyberking.candymindmatch',
        version_name: '1.4.3',
        version_code: 43,
        platform: 'android',
        status: 'online',
        event: 'level_complete',
        device_model: 'Samsung Galaxy S24',
        os_version: 'Android 15',
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
      data: Array<{
        id: number;
        appUid: string;
        packageName: string;
        name: string;
        firebaseProjectId?: string;
        firebaseAppId?: string;
        firebaseProjectNumber?: string;
        firebaseStorageBucket?: string;
      }>;
    };
    assert.equal(lookupJson.data.length, 1);
    assert.equal(lookupJson.data[0].packageName, 'com.cyberking.candymindmatch');
    assert.equal(lookupJson.data[0].firebaseProjectId, 'psychic-advantage-nsmzh');
    assert.equal(lookupJson.data[0].firebaseAppId, '1:663704095886:android:51917d3b7fb6839b798ddf');
    assert.equal(lookupJson.data[0].firebaseProjectNumber, '663704095886');
    assert.equal(lookupJson.data[0].firebaseStorageBucket, 'psychic-advantage-nsmzh.firebasestorage.app');
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

    // Create a second isolated Android app sharing the same Firebase project (like google-services.json)
    const secondAppRes = await apiCall(env, 'POST', '/api/apps', {
      cookie: superCookie,
      body: {
        name: 'Shayari Lok',
        platform: 'android',
        packageName: 'com.cyberking.shayarilok',
        firebaseProjectId: 'psychic-advantage-nsmzh',
        firebaseAppId: '1:663704095886:android:3f1232edee382fb4798ddf',
        firebaseProjectNumber: '663704095886',
        firebaseStorageBucket: 'psychic-advantage-nsmzh.firebasestorage.app',
      },
    });
    assert.equal(secondAppRes.status, 201);
    const secondAppJson = (await secondAppRes.json()) as {
      app: { id: number; appUid: string; packageName: string };
      initialApiKey: string;
    };
    assert.equal(secondAppJson.app.packageName, 'com.cyberking.shayarilok');

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
    assert.equal(
      sdkAnnRes.headers.get('cache-control'),
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    assert.equal(sdkAnnRes.headers.get('expires'), '0');
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

    // Reject invalid Firebase metadata with 400 without corrupting existing config
    const badFbRc = await apiCall(env, 'PUT', `/api/apps/${candyAppId}/remote-config`, {
      cookie: superCookie,
      body: {
        firebase_project_id: 'INVALID SPACE!',
      },
    });
    assert.equal(badFbRc.status, 400);

    // 6. Remote Config PUT -> GET /api/v1/sdk/remote-config + optional require_sdk_key & mismatch guard
    const putRc = await apiCall(env, 'PUT', `/api/apps/${candyAppId}/remote-config`, {
      cookie: superCookie,
      body: {
        maintenance: true,
        kill_switch: true,
        ads_enabled: false,
        admob_app_id: 'ca-app-pub-3940256099942544~3347511713',
        firebase_project_id: 'psychic-advantage-nsmzh',
        firebase_app_id: '1:663704095886:android:51917d3b7fb6839b798ddf',
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
          rewarded_ads_enabled: true,
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
    assert.equal(
      sdkRcRes.headers.get('cache-control'),
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    const sdkRcJson = (await sdkRcRes.json()) as {
      package_name: string;
      maintenance: boolean;
      kill_switch: boolean;
      maintenance_message: string;
      banner: { enabled: boolean; title: string };
      ads: { enabled: boolean; admob_app_id: string };
      firebase: {
        configured: boolean;
        project_id: string;
        app_id: string;
        project_number: string;
        storage_bucket: string;
      };
      flags: Record<string, unknown>;
    };
    assert.equal(sdkRcJson.package_name, 'com.cyberking.candymindmatch');
    assert.equal(sdkRcJson.maintenance, true);
    assert.equal(sdkRcJson.kill_switch, true);
    assert.equal(sdkRcJson.maintenance_message, 'Upgrading match servers cleanly.');
    assert.equal(sdkRcJson.banner.enabled, true);
    assert.equal(sdkRcJson.banner.title, 'Season 5');
    assert.equal(sdkRcJson.ads.enabled, false);
    assert.equal(sdkRcJson.ads.admob_app_id, 'ca-app-pub-3940256099942544~3347511713');
    assert.equal(sdkRcJson.firebase.configured, true);
    assert.equal(sdkRcJson.firebase.project_id, 'psychic-advantage-nsmzh');
    assert.equal(sdkRcJson.firebase.app_id, '1:663704095886:android:51917d3b7fb6839b798ddf');
    assert.equal(sdkRcJson.firebase.project_number, '663704095886');
    assert.equal(sdkRcJson.firebase.storage_bucket, 'psychic-advantage-nsmzh.firebasestorage.app');
    assert.equal(sdkRcJson.flags.daily_bonus_enabled, true);
    assert.equal(sdkRcJson.flags.rewarded_ads_enabled, true);
    assert.equal(sdkRcJson.flags.starting_moves, 30);
    assert.equal(sdkRcJson.flags.theme_variant, 'candy_neon');

    // Second app on the SAME Firebase project remains online with kill_switch=false, its own app_id, and zero flag leakage
    const secondRcRes = await apiCall(
      env,
      'GET',
      '/api/v1/sdk/remote-config?package_name=com.cyberking.shayarilok'
    );
    assert.equal(secondRcRes.status, 200);
    const secondRcJson = (await secondRcRes.json()) as {
      kill_switch: boolean;
      firebase: {
        configured: boolean;
        project_id: string;
        app_id: string;
        project_number: string;
        storage_bucket: string;
      };
      flags: Record<string, unknown>;
    };
    assert.equal(secondRcJson.kill_switch, false);
    assert.equal(secondRcJson.firebase.configured, true);
    assert.equal(secondRcJson.firebase.project_id, 'psychic-advantage-nsmzh');
    assert.equal(secondRcJson.firebase.app_id, '1:663704095886:android:3f1232edee382fb4798ddf');
    assert.equal(secondRcJson.firebase.project_number, '663704095886');
    assert.equal(secondRcJson.firebase.storage_bucket, 'psychic-advantage-nsmzh.firebasestorage.app');
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
      '/api/v1/sdk/remote-config?package_name=com.cyberking.shayarilok'
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
      '/api/v1/sdk/remote-config?package_name=com.cyberking.shayarilok',
      {
        headers: {
          'x-app-id': secondAppJson.app.appUid,
          'x-api-key': secondAppJson.initialApiKey,
          'x-package-name': 'com.cyberking.shayarilok',
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
    const hbListJson = (await hbListRes.json()) as {
      total: number;
      data: Array<{ package_name: string; device_model: string; os_version: string }>;
    };
    assert.equal(hbListJson.total, 2);
    assert.equal(hbListJson.data[0].package_name, 'com.cyberking.candymindmatch');
    assert.equal(hbListJson.data[0].device_model, 'Samsung Galaxy S24');
    assert.equal(hbListJson.data[0].os_version, 'Android 15');

    assert.equal(wsRes.status, 200);
    const wsJson = (await wsRes.json()) as {
      app: {
        firebaseProjectId?: string;
        firebaseAppId?: string;
        firebaseProjectNumber?: string;
        firebaseStorageBucket?: string;
      };
      announcements: unknown[];
      heartbeats: Array<{ device_model: string; os_version: string }>;
      remoteConfig: {
        kill_switch: boolean;
        firebase: {
          configured: boolean;
          project_id: string;
          app_id: string;
          project_number: string;
          storage_bucket: string;
        };
      };
    };
    assert.equal(wsJson.app.firebaseProjectId, 'psychic-advantage-nsmzh');
    assert.equal(wsJson.app.firebaseAppId, '1:663704095886:android:51917d3b7fb6839b798ddf');
    assert.equal(wsJson.app.firebaseProjectNumber, '663704095886');
    assert.equal(wsJson.app.firebaseStorageBucket, 'psychic-advantage-nsmzh.firebasestorage.app');
    assert.equal(wsJson.announcements.length, 1);
    assert.equal(wsJson.heartbeats.length, 2);
    assert.equal(wsJson.heartbeats[0].device_model, 'Samsung Galaxy S24');
    assert.equal(wsJson.heartbeats[0].os_version, 'Android 15');
    assert.equal(wsJson.remoteConfig.kill_switch, true);
    assert.equal(wsJson.remoteConfig.firebase.project_id, 'psychic-advantage-nsmzh');
    assert.equal(wsJson.remoteConfig.firebase.project_number, '663704095886');
    assert.equal(wsJson.remoteConfig.firebase.storage_bucket, 'psychic-advantage-nsmzh.firebasestorage.app');
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

test('Quick JSON Connect, sanitizeConnectionConfig & version_code pure helpers work generically', () => {
  assert.equal(parseVersionCode(42, 1), 42);
  assert.equal(parseVersionCode('108', 1), 108);
  assert.equal(parseVersionCode(-5, 7), 7);

  const connCheck = sanitizeConnectionConfig({
    firebase_project_id: '  My-App-Proj ',
    firebase_app_id: '1:999888777666:android:112233445566',
    require_sdk_key: true,
    auth_mode: 'firebase',
    sync_mode: 'hybrid',
    sync_url: 'https://sync.acme.example',
    unrelated_secret: 'SHOULD_BE_DROPPED',
  });
  assert.equal(connCheck.error, undefined);
  assert.deepEqual(connCheck.value, {
    firebase_project_id: 'my-app-proj',
    firebase_app_id: '1:999888777666:android:112233445566',
    require_sdk_key: true,
    auth_mode: 'firebase',
    sync_mode: 'hybrid',
    sync_url: 'https://sync.acme.example/',
  });
  assert.equal('unrelated_secret' in connCheck.value, false);

  const badConn = sanitizeConnectionConfig('not json');
  assert.ok(badConn.error);

  const settings = withConnectionSettings(
    {},
    { versionCode: 19, connectionConfig: connCheck.value }
  );
  assert.equal(extractAppVersionCode(settings), 19);
  const extracted = extractConnectionConfig(settings);
  assert.equal(extracted.firebase_project_id, 'my-app-proj');
  assert.equal(extracted.require_sdk_key, true);
  assert.equal(extracted.auth_mode, 'firebase');

  // Focused Connection JSON (single app & batch)
  const singleQuick = parseQuickConnectJson(
    JSON.stringify({
      app_name: 'Acme Alpha',
      package_name: 'Com.Acme.AlphaApp',
      version_name: '2.1.0',
      version_code: 210,
      connection_config: {
        firebase_project_id: 'acme-proj',
        firebase_app_id: '1:100200300400:android:abcdef123456',
      },
    })
  );
  assert.equal(singleQuick.error, undefined);
  assert.equal(singleQuick.sourceFormat, 'connection_json');
  assert.equal(singleQuick.apps?.length, 1);
  assert.deepEqual(singleQuick.apps?.[0], {
    app_name: 'Acme Alpha',
    package_name: 'com.acme.alphaapp',
    version_name: '2.1.0',
    version_code: 210,
    platform: 'android',
    connection_config: {
      firebase_project_id: 'acme-proj',
      firebase_app_id: '1:100200300400:android:abcdef123456',
    },
  });

  // google-services.json auto-parses via parseQuickConnectJson and strips API keys
  const gsQuick = parseQuickConnectJson(
    JSON.stringify({
      project_info: {
        project_number: '100200300400',
        project_id: 'acme-firebase-hub',
        storage_bucket: 'acme-firebase-hub.firebasestorage.app',
      },
      client: [
        {
          client_info: {
            mobilesdk_app_id: '1:100200300400:android:deadbeef01',
            android_client_info: { package_name: 'com.acme.client_one' },
          },
          api_key: [{ current_key: 'SECRET_SHOULD_NOT_SURVIVE' }],
        },
      ],
    })
  );
  assert.equal(gsQuick.error, undefined);
  assert.equal(gsQuick.sourceFormat, 'google_services_json');
  assert.equal(gsQuick.apps?.length, 1);
  assert.equal(gsQuick.apps?.[0].package_name, 'com.acme.client_one');
  assert.equal(gsQuick.apps?.[0].app_name, 'Client One');
  assert.equal(JSON.stringify(gsQuick).includes('SECRET_SHOULD_NOT_SURVIVE'), false);
});

test('Unlimited Multi-App Registration, Quick JSON Connect, SQL Pagination & Package Isolation', async () => {
  const { env, close } = createTestEnv();
  try {
    const setupRes = await apiCall(env, 'POST', '/api/auth/setup', {
      body: { password: 'SuperPassword#2026' },
    });
    assert.equal(setupRes.status, 201);
    const cookie = extractCookieValue(setupRes);

    // 1. Standard Connect via POST /api/apps with app_name, package_name, version_name, version_code, connection_config
    const alphaCreate = await apiCall(env, 'POST', '/api/apps', {
      cookie,
      body: {
        app_name: 'Alpha Utility',
        package_name: 'com.acme.alphaapp',
        version_name: '1.2.0',
        version_code: 12,
        platform: 'android',
        connection_config: {
          firebase_project_id: 'acme-cloud-1',
          firebase_app_id: '1:111222333444:android:aaa111',
          auth_mode: 'firebase',
        },
      },
    });
    assert.equal(alphaCreate.status, 201);
    const alphaJson = (await alphaCreate.json()) as {
      app: {
        id: number;
        packageName: string;
        currentVersion: string;
        versionCode: number;
        connectionConfig: { firebase_project_id: string };
      };
      initialApiKey: string;
    };
    assert.equal(alphaJson.app.packageName, 'com.acme.alphaapp');
    assert.equal(alphaJson.app.currentVersion, '1.2.0');
    assert.equal(alphaJson.app.versionCode, 12);
    assert.equal(alphaJson.app.connectionConfig.firebase_project_id, 'acme-cloud-1');
    assert.ok(alphaJson.initialApiKey);

    // 2. Quick JSON Connect (multi-app batch)
    const quickBatch = await apiCall(env, 'POST', '/api/apps/quick-connect', {
      cookie,
      body: {
        apps: [
          {
            app_name: 'Beta Reader',
            package_name: 'com.acme.betaapp',
            version_name: '2.0.0',
            version_code: 20,
            connection_config: { firebase_project_id: 'acme-cloud-2' },
          },
          {
            app_name: 'Gamma Player',
            package_name: 'com.acme.gammaapp',
            version_name: '3.5.1',
            version_code: 351,
          },
        ],
      },
    });
    assert.equal(quickBatch.status, 201);
    const quickBatchJson = (await quickBatch.json()) as {
      connectedCount: number;
      connected: Array<{ app: { id: number; packageName: string; versionCode: number } }>;
    };
    assert.equal(quickBatchJson.connectedCount, 2);
    assert.equal(quickBatchJson.connected[0].app.packageName, 'com.acme.betaapp');
    assert.equal(quickBatchJson.connected[0].app.versionCode, 20);
    assert.equal(quickBatchJson.connected[1].app.versionCode, 351);

    // Partial conflict handling: re-sending com.acme.betaapp + new com.acme.deltaapp connects Delta and reports conflict on Beta
    const partialBatch = await apiCall(env, 'POST', '/api/apps/quick-connect', {
      cookie,
      body: {
        apps: [
          { app_name: 'Beta Dup', package_name: 'com.acme.betaapp' },
          { app_name: 'Delta Studio', package_name: 'com.acme.deltaapp', version_code: 5 },
        ],
      },
    });
    assert.equal(partialBatch.status, 201);
    const partialJson = (await partialBatch.json()) as {
      connectedCount: number;
      conflicts: Array<{ package_name: string }>;
    };
    assert.equal(partialJson.connectedCount, 1);
    assert.equal(partialJson.conflicts.length, 1);
    assert.equal(partialJson.conflicts[0].package_name, 'com.acme.betaapp');

    // 3. SQL Pagination & Search across 4 connected apps
    const [page1Res, page2Res, searchRes] = await Promise.all([
      apiCall(env, 'GET', '/api/apps/overview?page=1&limit=2', { cookie }),
      apiCall(env, 'GET', '/api/apps/overview?page=2&limit=2', { cookie }),
      apiCall(env, 'GET', '/api/apps/overview?page=1&limit=10&search=gammaapp', { cookie }),
    ]);
    assert.equal(page1Res.status, 200);
    assert.equal(page2Res.status, 200);
    assert.equal(searchRes.status, 200);

    const p1 = (await page1Res.json()) as {
      summary: { totalApps: number };
      pagination: { page: number; limit: number; total: number; totalPages: number };
      apps: Array<{ packageName: string }>;
    };
    const p2 = (await page2Res.json()) as {
      pagination: { page: number; totalPages: number };
      apps: Array<{ packageName: string }>;
    };
    const sr = (await searchRes.json()) as {
      pagination: { total: number };
      apps: Array<{ packageName: string }>;
    };

    assert.equal(p1.summary.totalApps, 4);
    assert.equal(p1.pagination.total, 4);
    assert.equal(p1.pagination.totalPages, 2);
    assert.equal(p1.apps.length, 2);
    assert.equal(p2.apps.length, 2);
    assert.equal(sr.pagination.total, 1);
    assert.equal(sr.apps[0].packageName, 'com.acme.gammaapp');

    // 4. PATCH version_code + Remote Config + Announcements strict package isolation + no-store
    const patchAlpha = await apiCall(env, 'PATCH', `/api/apps/${alphaJson.app.id}`, {
      cookie,
      body: { version_name: '1.3.0', version_code: 13 },
    });
    assert.equal(patchAlpha.status, 200);
    const patchAlphaJson = (await patchAlpha.json()) as {
      app: { currentVersion: string; versionCode: number };
    };
    assert.equal(patchAlphaJson.app.currentVersion, '1.3.0');
    assert.equal(patchAlphaJson.app.versionCode, 13);

    const betaAppId = quickBatchJson.connected[0].app.id;
    await apiCall(env, 'POST', `/api/apps/${alphaJson.app.id}/announcements`, {
      cookie,
      body: { title: 'Alpha Only Update', body: 'Version 1.3.0 is live', active: 1, priority: 5 },
    });
    await apiCall(env, 'PUT', `/api/apps/${alphaJson.app.id}/remote-config`, {
      cookie,
      body: {
        maintenance: true,
        kill_switch: false,
        maintenance_message: 'Alpha maintenance window',
        flags: { alpha_flag: true },
      },
    });

    const [alphaSdkRc, betaSdkRc, betaSdkAnn] = await Promise.all([
      apiCall(env, 'GET', '/api/v1/sdk/remote-config?package_name=com.acme.alphaapp'),
      apiCall(env, 'GET', '/api/v1/sdk/remote-config?package_name=com.acme.betaapp'),
      apiCall(env, 'GET', '/api/v1/sdk/announcements?package_name=com.acme.betaapp&active=1'),
    ]);
    assert.equal(alphaSdkRc.status, 200);
    assert.equal(
      alphaSdkRc.headers.get('cache-control'),
      'no-store, no-cache, must-revalidate, max-age=0'
    );
    const alphaRcJson = (await alphaSdkRc.json()) as {
      maintenance: boolean;
      version_gate: { current_version: string; version_code: number };
      flags: Record<string, unknown>;
    };
    assert.equal(alphaRcJson.maintenance, true);
    assert.equal(alphaRcJson.version_gate.current_version, '1.3.0');
    assert.equal(alphaRcJson.version_gate.version_code, 13);
    assert.equal(alphaRcJson.flags.alpha_flag, true);

    const betaRcJson = (await betaSdkRc.json()) as {
      appId: number;
      maintenance: boolean;
      version_gate: { version_code: number };
      flags: Record<string, unknown>;
    };
    assert.equal(betaRcJson.appId, betaAppId);
    assert.equal(betaRcJson.maintenance, false);
    assert.equal(betaRcJson.version_gate.version_code, 20);
    assert.equal(betaRcJson.flags.alpha_flag, undefined);

    const betaAnnJson = (await betaSdkAnn.json()) as { announcements: unknown[] };
    assert.equal(betaAnnJson.announcements.length, 0);
  } finally {
    close();
  }
});

