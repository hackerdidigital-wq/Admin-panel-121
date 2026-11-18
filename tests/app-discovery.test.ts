import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBackendNamespace,
  generateCollectionMigrationSql,
  generatePlatformIntegrationSnippets,
  inspectAppSpecification,
  parseModelSpecToCollections,
} from '../src/lib/appDiscovery.ts';

test('buildBackendNamespace & generateCollectionMigrationSql produce clean isolated D1 DDL', () => {
  const ns = buildBackendNamespace('Unity Strike Arena', 'app_abc123');
  assert.ok(ns.startsWith('ns_unity_strike_arena_'));

  const sql = generateCollectionMigrationSql(ns, 'tournaments', [
    { name: 'title', label: 'Title', type: 'text', required: true },
    { name: 'prize_pool', label: 'Prize Pool', type: 'number', required: true },
    { name: 'active', label: 'Active', type: 'boolean', required: false },
  ]);

  assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS ${ns}__tournaments`));
  assert.ok(sql.includes('title TEXT NOT NULL'));
  assert.ok(sql.includes('prize_pool REAL NOT NULL'));
  assert.ok(sql.includes('active INTEGER'));
  assert.ok(!sql.toUpperCase().includes('PRAGMA'));
});

test('parseModelSpecToCollections supports DSL and JSON schema inputs', () => {
  const cols = parseModelSpecToCollections(
    'ns_test_01',
    'tournaments(title:text, prize_pool:number, live:boolean); guilds(name:text, meta:json)'
  );
  assert.equal(cols.length, 2);
  assert.equal(cols[0].slug, 'tournaments');
  assert.equal(cols[0].fields[1].type, 'number');
  assert.equal(cols[0].fields[2].type, 'boolean');
  assert.equal(cols[1].slug, 'guilds');
  assert.equal(cols[1].fields[1].type, 'json');
});

test('inspectAppSpecification accurately distinguishes full_managed vs unverified external APIs', () => {
  const unityReport = inspectAppSpecification({
    name: 'Unity Strike',
    platform: 'unity',
    integrationMode: 'aegis_managed',
    modelsText: 'clans(name:text, members:number)',
  });
  assert.equal(unityReport.fullControlAvailable, true);
  assert.equal(unityReport.controlLevel, 'full_managed');
  assert.ok(unityReport.proposedCollections.some((c) => c.slug === 'leaderboard'));
  assert.ok(unityReport.proposedCollections.some((c) => c.slug === 'clans'));

  // Read-only external OpenAPI without write endpoints must NOT claim full control
  const readOnlyReport = inspectAppSpecification({
    name: 'External Catalog API',
    platform: 'api',
    integrationMode: 'external_backend',
    backendBaseUrl: 'https://api.example.com',
    openapiSpec: {
      openapi: '3.0.0',
      paths: {
        '/items': {
          get: { summary: 'List items' },
        },
      },
      components: {
        schemas: {
          CatalogItem: {
            required: ['sku'],
            properties: {
              sku: { type: 'string' },
              price: { type: 'number' },
            },
          },
        },
      },
    },
  });

  assert.equal(readOnlyReport.fullControlAvailable, false);
  assert.equal(readOnlyReport.controlLevel, 'read_only');
  assert.ok(readOnlyReport.missingCapabilities.some((m) => m.includes('No write/mutation endpoints')));
  assert.ok(readOnlyReport.proposedCollections.some((c) => c.slug === 'catalogitem'));

  // Unreachable remote probe flags partial_unverified honestly
  const failedProbeReport = inspectAppSpecification({
    name: 'Broken Remote Backend',
    platform: 'website',
    integrationMode: 'hybrid',
    backendBaseUrl: 'https://down.example.com',
    probeResult: {
      attempted: true,
      reachable: false,
      httpStatus: 502,
      errorMessage: 'Bad Gateway',
    },
  });
  assert.equal(failedProbeReport.fullControlAvailable, false);
  assert.equal(failedProbeReport.controlLevel, 'partial_unverified');
});

test('generatePlatformIntegrationSnippets outputs platform-specific SDK code for all 5 languages', () => {
  const snips = generatePlatformIntegrationSnippets({
    apiBaseUrl: 'https://aegis.workers.dev',
    appUid: 'app_demo_01',
    apiKey: 'aegis_live_secret_123',
    platform: 'unity',
    collections: [{ slug: 'leaderboard', name: 'Leaderboard' }],
  });
  assert.ok(snips.unity.includes('UnityWebRequest'));
  assert.ok(snips.android.includes('OkHttpClient'));
  assert.ok(snips.website.includes('/api/v1/sdk/data/leaderboard'));
  assert.ok(snips.ios.includes('URLSession'));
  assert.ok(snips.curl.includes('X-App-Id: app_demo_01'));
});
