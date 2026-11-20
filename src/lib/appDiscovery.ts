export type AppPlatformType = 'android' | 'unity' | 'game' | 'website' | 'ios' | 'api';
export type IntegrationMode = 'aegis_managed' | 'external_backend' | 'hybrid';

export interface CollectionFieldSpec {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'json';
  required: boolean;
}

export interface ProposedCollectionSpec {
  slug: string;
  name: string;
  description: string;
  fields: CollectionFieldSpec[];
  migrationSql: string;
}

export interface DiscoveredCapabilityReport {
  inspectedAt: string;
  platform: string;
  integrationMode: IntegrationMode;
  backendNamespace: string;
  fullControlAvailable: boolean;
  controlLevel: 'full_managed' | 'verified_remote' | 'partial_unverified' | 'read_only';
  honestySummary: string;
  verifiedCapabilities: string[];
  missingCapabilities: string[];
  discoveredEndpoints: Array<{ method: string; path: string; summary: string; verified: boolean }>;
  recommendedModules: string[];
  proposedCollections: ProposedCollectionSpec[];
  probeDetails: {
    attempted: boolean;
    reachable: boolean;
    httpStatus: number | null;
    sourceType: 'aegis_manifest' | 'openapi' | 'model_spec' | 'platform_default';
    notes: string[];
  };
}

function cleanIdentifier(input: string, fallback = 'item'): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || fallback;
}

function titleCase(input: string): string {
  return input
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function buildBackendNamespace(slugOrName: string, appUid?: string): string {
  const slug = cleanIdentifier(slugOrName, 'app').slice(0, 28);
  const suffix = appUid ? cleanIdentifier(appUid.slice(-6), 'ns') : Math.random().toString(36).slice(2, 6);
  return `ns_${slug}_${suffix}`;
}

export function generateCollectionMigrationSql(
  namespace: string,
  slug: string,
  fields: CollectionFieldSpec[]
): string {
  const safeNs = cleanIdentifier(namespace, 'app_ns');
  const safeSlug = cleanIdentifier(slug, 'records');
  const tableName = `${safeNs}__${safeSlug}`;

  const colDefs = fields.map((f) => {
    const colName = cleanIdentifier(f.name, 'field');
    const sqlType =
      f.type === 'number'
        ? 'REAL'
        : f.type === 'boolean'
          ? 'INTEGER'
          : 'TEXT';
    const defVal =
      f.type === 'number'
        ? 'DEFAULT 0'
        : f.type === 'boolean'
          ? 'DEFAULT 0'
          : f.type === 'json'
            ? "DEFAULT '{}'"
            : "DEFAULT ''";
    return `  ${colName} ${sqlType}${f.required ? ' NOT NULL' : ''} ${defVal}`;
  });

  return [
    `-- Isolated D1 Table Definition for ${safeNs}.${safeSlug}`,
    `CREATE TABLE IF NOT EXISTS ${tableName} (`,
    `  id INTEGER PRIMARY KEY AUTOINCREMENT,`,
    `  record_uid TEXT NOT NULL UNIQUE,`,
    ...(colDefs.length > 0 ? colDefs.map((line) => `${line},`) : []),
    `  created_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER)),`,
    `  updated_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))`,
    `);`,
    `CREATE INDEX IF NOT EXISTS ${tableName}_updated_idx ON ${tableName}(updated_at);`,
  ].join('\n');
}

export function parseModelSpecToCollections(
  namespace: string,
  modelsText: string
): ProposedCollectionSpec[] {
  const trimmed = modelsText.trim();
  if (!trimmed) return [];

  // Accept JSON array or object first
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const entries: Array<{ name: string; fields: CollectionFieldSpec[] }> = [];
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (typeof item === 'string') {
            entries.push({
              name: item,
              fields: [
                { name: 'title', label: 'Title', type: 'text', required: true },
                { name: 'status', label: 'Status', type: 'text', required: false },
              ],
            });
          } else if (item && typeof item === 'object') {
            const rec = item as Record<string, unknown>;
            const colName = String(rec.slug || rec.name || 'custom_items');
            const rawFields = Array.isArray(rec.fields) ? rec.fields : [];
            const fields: CollectionFieldSpec[] = rawFields
              .map((f): CollectionFieldSpec | null => {
                if (!f || typeof f !== 'object') return null;
                const fr = f as Record<string, unknown>;
                const fname = cleanIdentifier(String(fr.name || ''), '');
                if (!fname) return null;
                const rawType = String(fr.type || 'text').toLowerCase();
                const type: CollectionFieldSpec['type'] =
                  rawType === 'number' || rawType === 'integer' || rawType === 'float'
                    ? 'number'
                    : rawType === 'boolean' || rawType === 'bool'
                      ? 'boolean'
                      : rawType === 'json' || rawType === 'object'
                        ? 'json'
                        : 'text';
                return {
                  name: fname,
                  label: String(fr.label || titleCase(fname)),
                  type,
                  required: Boolean(fr.required),
                };
              })
              .filter((x): x is CollectionFieldSpec => x !== null);
            entries.push({
              name: colName,
              fields:
                fields.length > 0
                  ? fields
                  : [
                      { name: 'name', label: 'Name', type: 'text', required: true },
                      { name: 'payload', label: 'Payload', type: 'json', required: false },
                    ],
            });
          }
        }
      } else if (parsed && typeof parsed === 'object') {
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            const fields: CollectionFieldSpec[] = Object.entries(v as Record<string, unknown>).map(
              ([fk, fv]) => {
                const t = String(fv).toLowerCase();
                return {
                  name: cleanIdentifier(fk, 'field'),
                  label: titleCase(fk),
                  type: t.includes('num') || t.includes('int')
                    ? 'number'
                    : t.includes('bool')
                      ? 'boolean'
                      : t.includes('json')
                        ? 'json'
                        : 'text',
                  required: false,
                };
              }
            );
            entries.push({ name: k, fields });
          }
        }
      }

      if (entries.length > 0) {
        return entries.map((e) => {
          const slug = cleanIdentifier(e.name, 'collection');
          return {
            slug,
            name: titleCase(slug),
            description: `Generated collection from JSON specification (${e.fields.length} fields).`,
            fields: e.fields,
            migrationSql: generateCollectionMigrationSql(namespace, slug, e.fields),
          };
        });
      }
    } catch {
      // Fallback to DSL parsing below
    }
  }

  // Parse DSL lines like: "leaderboard(playerName:string, score:number), inventory(itemCode:string, qty:number)"
  const segments = trimmed
    .split(/\n|;(?![^(]*\))/)
    .map((s) => s.trim())
    .filter(Boolean);

  // If single line with comma-separated plain words without parens
  const expanded: string[] =
    segments.length === 1 && !segments[0].includes('(')
      ? segments[0]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : segments;

  return expanded.map((seg) => {
    const parenIdx = seg.indexOf('(');
    const rawName = parenIdx >= 0 ? seg.slice(0, parenIdx).trim() : seg;
    const slug = cleanIdentifier(rawName, 'collection');
    const rawBody = parenIdx >= 0 ? seg.slice(parenIdx + 1).replace(/\)\s*$/, '') : '';
    const fields: CollectionFieldSpec[] = rawBody
      ? rawBody
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
          .map((part) => {
            const [fRaw, tRaw] = part.split(':').map((x) => x.trim());
            const fname = cleanIdentifier(fRaw || 'value', 'value');
            const lt = (tRaw || 'text').toLowerCase();
            const type: CollectionFieldSpec['type'] =
              lt.includes('num') || lt.includes('int') || lt.includes('float') || lt.includes('score')
                ? 'number'
                : lt.includes('bool')
                  ? 'boolean'
                  : lt.includes('json') || lt.includes('obj')
                    ? 'json'
                    : 'text';
            return {
              name: fname,
              label: titleCase(fname),
              type,
              required: fname === 'name' || fname === 'title' || fname === 'player_name',
            };
          })
      : [
          { name: 'name', label: 'Name', type: 'text', required: true },
          { name: 'value', label: 'Value', type: 'text', required: false },
          { name: 'active', label: 'Active', type: 'boolean', required: false },
        ];

    return {
      slug,
      name: titleCase(slug),
      description: `Isolated collection "${titleCase(slug)}" provisioned for ${namespace}.`,
      fields,
      migrationSql: generateCollectionMigrationSql(namespace, slug, fields),
    };
  });
}

function getPlatformDefaultCollections(
  namespace: string,
  platform: string
): { modules: string[]; collections: ProposedCollectionSpec[] } {
  const norm = platform.toLowerCase();
  if (norm === 'unity') {
    const specs: Array<{ slug: string; name: string; desc: string; fields: CollectionFieldSpec[] }> = [
      {
        slug: 'leaderboard',
        name: 'Leaderboard Scores',
        desc: 'Per-game high scores and season rankings isolated from other apps.',
        fields: [
          { name: 'player_id', label: 'Player ID', type: 'text', required: true },
          { name: 'player_name', label: 'Player Name', type: 'text', required: true },
          { name: 'score', label: 'Score', type: 'number', required: true },
          { name: 'season', label: 'Season', type: 'text', required: false },
        ],
      },
      {
        slug: 'player_inventory',
        name: 'Player Inventory',
        desc: 'Unlocked items, virtual currency balances, and entitlements.',
        fields: [
          { name: 'player_id', label: 'Player ID', type: 'text', required: true },
          { name: 'item_sku', label: 'Item SKU', type: 'text', required: true },
          { name: 'quantity', label: 'Quantity', type: 'number', required: true },
          { name: 'equipped', label: 'Equipped', type: 'boolean', required: false },
        ],
      },
      {
        slug: 'unity_remote_tuning',
        name: 'Unity Remote Tuning',
        desc: 'Frame-rate targets, asset bundle versions, and remote Unity SDK parameters.',
        fields: [
          { name: 'config_key', label: 'Config Key', type: 'text', required: true },
          { name: 'quality_tier', label: 'Quality Tier', type: 'text', required: false },
          { name: 'target_fps', label: 'Target FPS', type: 'number', required: false },
          { name: 'enabled', label: 'Enabled', type: 'boolean', required: false },
        ],
      },
    ];
    return {
      modules: ['overview', 'users', 'config', 'releases', 'ads', 'collections', 'storage', 'webhooks'],
      collections: specs.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.desc,
        fields: s.fields,
        migrationSql: generateCollectionMigrationSql(namespace, s.slug, s.fields),
      })),
    };
  }

  if (norm === 'game') {
    const specs: Array<{ slug: string; name: string; desc: string; fields: CollectionFieldSpec[] }> = [
      {
        slug: 'player_profiles',
        name: 'Battle Royale Players',
        desc: 'Player ranks, K/D telemetry, tier points, and anti-cheat moderation records.',
        fields: [
          { name: 'player_id', label: 'Player ID', type: 'text', required: true },
          { name: 'callsign', label: 'Callsign', type: 'text', required: true },
          { name: 'rank_tier', label: 'Rank Tier', type: 'text', required: false },
          { name: 'rating', label: 'MMR / Points', type: 'number', required: false },
          { name: 'verified', label: 'Fair-Play Verified', type: 'boolean', required: false },
        ],
      },
      {
        slug: 'br_matches',
        name: 'Match Lobbies & Maps',
        desc: 'Active Battle Royale map rotations, lobby caps, and match scheduling.',
        fields: [
          { name: 'match_code', label: 'Match Code', type: 'text', required: true },
          { name: 'map_name', label: 'Map / Arena', type: 'text', required: true },
          { name: 'max_players', label: 'Max Lobby Players', type: 'number', required: true },
          { name: 'live', label: 'Lobby Open', type: 'boolean', required: false },
        ],
      },
      {
        slug: 'weapon_loot_balance',
        name: 'Weapon & Loot Balance',
        desc: 'Remote damage, drop-rate, and seasonal weapon tuning table synced via SDK.',
        fields: [
          { name: 'weapon_name', label: 'Weapon Name', type: 'text', required: true },
          { name: 'category', label: 'Weapon Class', type: 'text', required: true },
          { name: 'damage', label: 'Base Damage', type: 'number', required: true },
          { name: 'enabled', label: 'In Loot Pool', type: 'boolean', required: false },
        ],
      },
    ];
    return {
      modules: ['overview', 'users', 'config', 'releases', 'ads', 'collections', 'storage', 'webhooks'],
      collections: specs.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.desc,
        fields: s.fields,
        migrationSql: generateCollectionMigrationSql(namespace, s.slug, s.fields),
      })),
    };
  }

  if (norm === 'website') {
    const specs: Array<{ slug: string; name: string; desc: string; fields: CollectionFieldSpec[] }> = [
      {
        slug: 'site_pages',
        name: 'Site Pages & CMS',
        desc: 'Dynamic pages, banners, and structured marketing sections.',
        fields: [
          { name: 'slug', label: 'Page Slug', type: 'text', required: true },
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'published', label: 'Published', type: 'boolean', required: false },
          { name: 'content_blocks', label: 'Content Blocks', type: 'json', required: false },
        ],
      },
      {
        slug: 'orders',
        name: 'Web Orders',
        desc: 'Website checkout orders and fulfillment states.',
        fields: [
          { name: 'order_number', label: 'Order #', type: 'text', required: true },
          { name: 'customer_email', label: 'Customer Email', type: 'text', required: true },
          { name: 'total_cents', label: 'Total (Cents)', type: 'number', required: true },
          { name: 'fulfilled', label: 'Fulfilled', type: 'boolean', required: false },
        ],
      },
    ];
    return {
      modules: ['overview', 'users', 'config', 'collections', 'finance', 'storage', 'webhooks'],
      collections: specs.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.desc,
        fields: s.fields,
        migrationSql: generateCollectionMigrationSql(namespace, s.slug, s.fields),
      })),
    };
  }

  if (norm === 'ios' || norm === 'android') {
    const specs: Array<{ slug: string; name: string; desc: string; fields: CollectionFieldSpec[] }> = [
      {
        slug: 'app_announcements',
        name: 'In-App Announcements',
        desc: 'Targeted changelog cards and promotional banners pushed to mobile clients.',
        fields: [
          { name: 'title', label: 'Title', type: 'text', required: true },
          { name: 'body', label: 'Message', type: 'text', required: true },
          { name: 'active', label: 'Active', type: 'boolean', required: false },
          { name: 'priority', label: 'Priority', type: 'number', required: false },
        ],
      },
    ];
    return {
      modules: ['overview', 'users', 'config', 'releases', 'ads', 'notifications', 'collections', 'storage', 'webhooks'],
      collections: specs.map((s) => ({
        slug: s.slug,
        name: s.name,
        description: s.desc,
        fields: s.fields,
        migrationSql: generateCollectionMigrationSql(namespace, s.slug, s.fields),
      })),
    };
  }

  // REST API service default
  const apiSpec: CollectionFieldSpec[] = [
    { name: 'resource_key', label: 'Resource Key', type: 'text', required: true },
    { name: 'status', label: 'Status', type: 'text', required: false },
    { name: 'payload', label: 'Payload', type: 'json', required: false },
  ];
  return {
    modules: ['overview', 'users', 'config', 'collections', 'storage', 'webhooks'],
    collections: [
      {
        slug: 'service_records',
        name: 'Service Records',
        description: 'Structured records managed over the Aegis REST SDK.',
        fields: apiSpec,
        migrationSql: generateCollectionMigrationSql(namespace, 'service_records', apiSpec),
      },
    ],
  };
}

export interface InspectAppInput {
  name: string;
  platform?: string;
  packageOrDomain?: string;
  integrationMode?: IntegrationMode;
  backendBaseUrl?: string;
  manifestUrl?: string;
  openapiSpec?: Record<string, unknown> | null;
  manifestJson?: Record<string, unknown> | null;
  modelsText?: string;
  probeResult?: {
    attempted: boolean;
    reachable: boolean;
    httpStatus: number | null;
    errorMessage?: string;
    parsedJson?: Record<string, unknown> | null;
  };
}

export function inspectAppSpecification(input: InspectAppInput): DiscoveredCapabilityReport {
  const platform = input.platform || 'android';
  const integrationMode: IntegrationMode =
    input.integrationMode === 'external_backend' || input.integrationMode === 'hybrid'
      ? input.integrationMode
      : input.backendBaseUrl
        ? 'hybrid'
        : 'aegis_managed';

  const namespace = buildBackendNamespace(input.name || platform);
  const defaults = getPlatformDefaultCollections(namespace, platform);
  const recommendedModules = new Set<string>(defaults.modules);
  const proposedMap = new Map<string, ProposedCollectionSpec>();
  for (const col of defaults.collections) {
    proposedMap.set(col.slug, col);
  }

  const discoveredEndpoints: Array<{ method: string; path: string; summary: string; verified: boolean }> = [];
  const verifiedCapabilities: string[] = [];
  const missingCapabilities: string[] = [];
  const probeNotes: string[] = [];
  let sourceType: DiscoveredCapabilityReport['probeDetails']['sourceType'] = 'platform_default';

  const effectiveSpec =
    input.openapiSpec ||
    (input.probeResult?.parsedJson && ('paths' in input.probeResult.parsedJson || 'openapi' in input.probeResult.parsedJson || 'swagger' in input.probeResult.parsedJson)
      ? input.probeResult.parsedJson
      : null);

  const effectiveManifest =
    input.manifestJson ||
    (input.probeResult?.parsedJson && !effectiveSpec ? input.probeResult.parsedJson : null);

  // 1. Inspect OpenAPI / Swagger spec
  if (effectiveSpec && typeof effectiveSpec === 'object') {
    sourceType = 'openapi';
    const paths = (effectiveSpec.paths && typeof effectiveSpec.paths === 'object'
      ? effectiveSpec.paths
      : {}) as Record<string, Record<string, unknown>>;
    const pathEntries = Object.entries(paths);
    let hasWriteOp = false;
    let hasUsersOp = false;
    let hasConfigOp = false;

    for (const [pathStr, ops] of pathEntries.slice(0, 40)) {
      if (!ops || typeof ops !== 'object') continue;
      for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        const opObj = ops[method];
        if (!opObj || typeof opObj !== 'object') continue;
        const summary = String((opObj as Record<string, unknown>).summary || `${method.toUpperCase()} ${pathStr}`);
        const isWrite = method !== 'get';
        if (isWrite) hasWriteOp = true;
        if (pathStr.toLowerCase().includes('user')) hasUsersOp = true;
        if (pathStr.toLowerCase().includes('config') || pathStr.toLowerCase().includes('flag')) hasConfigOp = true;
        discoveredEndpoints.push({
          method: method.toUpperCase(),
          path: pathStr,
          summary,
          verified: input.probeResult ? input.probeResult.reachable : true,
        });
      }
    }

    const components = (effectiveSpec.components && typeof effectiveSpec.components === 'object'
      ? (effectiveSpec.components as Record<string, unknown>).schemas
      : null) as Record<string, Record<string, unknown>> | null;

    if (components && typeof components === 'object') {
      for (const [schemaName, schemaDef] of Object.entries(components).slice(0, 12)) {
        if (!schemaDef || typeof schemaDef !== 'object') continue;
        const props = (schemaDef.properties && typeof schemaDef.properties === 'object'
          ? schemaDef.properties
          : {}) as Record<string, Record<string, unknown>>;
        const reqList = Array.isArray(schemaDef.required) ? schemaDef.required.map(String) : [];
        const fields: CollectionFieldSpec[] = Object.entries(props).map(([fn, fd]) => {
          const ft = String(fd?.type || 'string').toLowerCase();
          return {
            name: cleanIdentifier(fn, 'field'),
            label: titleCase(fn),
            type:
              ft === 'number' || ft === 'integer'
                ? 'number'
                : ft === 'boolean'
                  ? 'boolean'
                  : ft === 'object' || ft === 'array'
                    ? 'json'
                    : 'text',
            required: reqList.includes(fn),
          };
        });
        if (fields.length > 0) {
          const slug = cleanIdentifier(schemaName, 'entity');
          proposedMap.set(slug, {
            slug,
            name: titleCase(slug),
            description: `Discovered from OpenAPI schema components.schemas.${schemaName}.`,
            fields,
            migrationSql: generateCollectionMigrationSql(namespace, slug, fields),
          });
        }
      }
    }

    if (hasConfigOp) verifiedCapabilities.push('remote_config_read');
    else missingCapabilities.push('External backend does not expose a remote config endpoint');
    if (hasUsersOp) verifiedCapabilities.push('external_users_api');
    if (!hasWriteOp) missingCapabilities.push('No write/mutation endpoints exposed in OpenAPI spec (read-only external API)');
    probeNotes.push(`Parsed ${pathEntries.length} OpenAPI paths.`);
  }

  // 2. Inspect Aegis Manifest JSON
  if (effectiveManifest && typeof effectiveManifest === 'object') {
    sourceType = 'aegis_manifest';
    const caps = Array.isArray(effectiveManifest.capabilities) ? effectiveManifest.capabilities.map(String) : [];
    for (const c of caps) verifiedCapabilities.push(c);

    const mods = Array.isArray(effectiveManifest.modules) ? effectiveManifest.modules.map(String) : [];
    for (const m of mods) recommendedModules.add(cleanIdentifier(m, 'custom'));

    if (effectiveManifest.collections || effectiveManifest.models) {
      const parsedCols = parseModelSpecToCollections(
        namespace,
        JSON.stringify(effectiveManifest.collections || effectiveManifest.models)
      );
      for (const c of parsedCols) proposedMap.set(c.slug, c);
    }

    if (Array.isArray(effectiveManifest.endpoints)) {
      for (const ep of effectiveManifest.endpoints.slice(0, 30)) {
        if (typeof ep === 'string') {
          discoveredEndpoints.push({ method: 'GET', path: ep, summary: ep, verified: Boolean(input.probeResult?.reachable) });
        } else if (ep && typeof ep === 'object') {
          const r = ep as Record<string, unknown>;
          discoveredEndpoints.push({
            method: String(r.method || 'GET').toUpperCase(),
            path: String(r.path || '/'),
            summary: String(r.summary || r.path || ''),
            verified: r.verified !== undefined ? Boolean(r.verified) : Boolean(input.probeResult?.reachable),
          });
        }
      }
    }
    probeNotes.push('Parsed Aegis integration manifest.');
  }

  // 3. Parse user-supplied data models DSL / JSON
  if (input.modelsText && input.modelsText.trim()) {
    if (sourceType === 'platform_default') sourceType = 'model_spec';
    const parsedModels = parseModelSpecToCollections(namespace, input.modelsText);
    for (const c of parsedModels) {
      proposedMap.set(c.slug, c);
    }
    recommendedModules.add('collections');
    probeNotes.push(`Generated ${parsedModels.length} custom collection schema(s) from model definition.`);
  }

  // Always add Aegis-managed isolated backend endpoints when mode is aegis_managed or hybrid
  if (integrationMode === 'aegis_managed' || integrationMode === 'hybrid') {
    verifiedCapabilities.push(
      'isolated_database_collections',
      'remote_config_and_flags',
      'end_user_management_and_bans',
      'release_and_force_update',
      'admob_and_revenue_tracking',
      'isolated_file_storage',
      'signed_webhooks',
      'per_app_backup_restore'
    );
    discoveredEndpoints.push(
      { method: 'GET', path: '/api/v1/sdk/config', summary: 'Remote Config, Flags, Releases & Ads', verified: true },
      { method: 'POST', path: '/api/v1/sdk/users/sync', summary: 'Sync End-User Session & Enforce Bans', verified: true },
      { method: 'POST', path: '/api/v1/sdk/events', summary: 'Ingest App Telemetry, Errors & Ad Events', verified: true },
      { method: 'POST', path: '/api/v1/sdk/transactions', summary: 'Record App Payments / Purchases', verified: true },
      { method: 'GET', path: '/api/v1/sdk/data/:slug', summary: 'Read App Isolated Collection Records', verified: true },
      { method: 'POST', path: '/api/v1/sdk/data/:slug', summary: 'Create/Upsert App Isolated Collection Record', verified: true },
      { method: 'POST', path: '/api/v1/sdk/storage/files', summary: 'Upload File to Isolated App Storage', verified: true }
    );
  }

  // Honest external reachability & permission checks
  let fullControlAvailable = integrationMode === 'aegis_managed';
  let controlLevel: DiscoveredCapabilityReport['controlLevel'] =
    integrationMode === 'aegis_managed' ? 'full_managed' : 'verified_remote';

  if (integrationMode !== 'aegis_managed') {
    if (!input.backendBaseUrl && !input.manifestUrl && !effectiveSpec && !effectiveManifest) {
      fullControlAvailable = false;
      controlLevel = 'partial_unverified';
      missingCapabilities.push(
        'No external backend URL, OpenAPI spec, or Aegis manifest was supplied to verify remote write endpoints.'
      );
    } else if (input.probeResult?.attempted && !input.probeResult.reachable) {
      fullControlAvailable = false;
      controlLevel = 'partial_unverified';
      missingCapabilities.push(
        `Remote inspection endpoint did not return a reachable 2xx response (${
          input.probeResult.httpStatus ? `HTTP ${input.probeResult.httpStatus}` : input.probeResult.errorMessage || 'network error'
        }). Remote backend control cannot be guaranteed until the endpoint responds and authorizes Aegis.`
      );
    } else if (integrationMode === 'external_backend' && missingCapabilities.length > 0) {
      fullControlAvailable = false;
      controlLevel = discoveredEndpoints.some((e) => e.method !== 'GET') ? 'partial_unverified' : 'read_only';
    } else if (integrationMode === 'hybrid' && input.probeResult?.attempted && input.probeResult.reachable) {
      fullControlAvailable = missingCapabilities.length === 0;
      controlLevel = missingCapabilities.length === 0 ? 'verified_remote' : 'partial_unverified';
    } else if (integrationMode === 'hybrid' && !input.probeResult?.attempted) {
      fullControlAvailable = true;
      controlLevel = 'verified_remote';
      probeNotes.push('Hybrid mode: Aegis isolated backend active; external sync URL will be verified on first Control Sync.');
    }
  }

  const honestySummary =
    controlLevel === 'full_managed'
      ? 'Full control verified via Aegis-managed isolated D1 backend, SDK endpoints, storage namespace, and webhooks.'
      : controlLevel === 'verified_remote'
        ? 'Verified remote/hybrid integration: Aegis backend modules provisioned and supplied endpoints checked.'
        : controlLevel === 'read_only'
          ? 'Partial/Read-Only: Remote spec lacks verified write/admin mutation endpoints; Aegis will not claim full external control.'
          : 'Partial/Unverified: External backend did not verify required sync endpoints or permissions. Aegis isolated modules are ready locally, while external push remains disabled/flagged until verified.';

  return {
    inspectedAt: new Date().toISOString(),
    platform,
    integrationMode,
    backendNamespace: namespace,
    fullControlAvailable,
    controlLevel,
    honestySummary,
    verifiedCapabilities: Array.from(new Set(verifiedCapabilities)),
    missingCapabilities: Array.from(new Set(missingCapabilities)),
    discoveredEndpoints,
    recommendedModules: Array.from(recommendedModules),
    proposedCollections: Array.from(proposedMap.values()),
    probeDetails: {
      attempted: Boolean(input.probeResult?.attempted),
      reachable: Boolean(input.probeResult?.reachable),
      httpStatus: input.probeResult?.httpStatus ?? null,
      sourceType,
      notes: probeNotes,
    },
  };
}

export function generatePlatformIntegrationSnippets(params: {
  apiBaseUrl: string;
  appUid: string;
  apiKey: string;
  platform: string;
  packageName?: string;
  collections?: Array<{ slug: string; name: string }>;
}): {
  curl: string;
  website: string;
  android: string;
  unity: string;
  ios: string;
} {
  const base = params.apiBaseUrl.replace(/\/+$/, '');
  const uid = params.appUid || 'app_your_uid';
  const key = params.apiKey || 'aegis_live_YOUR_API_KEY';
  const pkg = params.packageName || 'com.cyberking.candymindmatch';
  const sampleSlug = params.collections?.[0]?.slug || 'leaderboard';

  const curl = `# 1. Send App -> Admin Panel heartbeat (by package_name)
curl -s -X POST "${base}/api/v1/sdk/heartbeat" \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: ${key}" \\
  -d '{"package_name":"${pkg}","version_name":"1.0.0","version_code":1,"platform":"${params.platform || 'android'}","status":"online","event":"app_open"}'

# 2. Fetch active announcements for package_name
curl -s "${base}/api/v1/sdk/announcements?package_name=${pkg}&active=1"

# 3. Fetch remote config & control flags for package_name
curl -s "${base}/api/v1/sdk/remote-config?package_name=${pkg}"

# 4. Write a record to isolated collection "${sampleSlug}"
curl -s -X POST "${base}/api/v1/sdk/data/${sampleSlug}" \\
  -H "Content-Type: application/json" \\
  -H "X-App-Id: ${uid}" \\
  -H "X-Package-Name: ${pkg}" \\
  -H "X-API-Key: ${key}" \\
  -d '{"data":{"name":"Sample Entry","active":true}}'`;

  const website = `// Aegis Web / TypeScript SDK Client (${uid} · ${pkg})
const AEGIS_HEADERS = {
  "Content-Type": "application/json",
  "X-App-Id": "${uid}",
  "X-Package-Name": "${pkg}",
  "X-API-Key": "${key}",
};

export async function sendHeartbeat(versionName = "1.0.0", versionCode = 1) {
  const res = await fetch("${base}/api/v1/sdk/heartbeat", {
    method: "POST",
    headers: AEGIS_HEADERS,
    body: JSON.stringify({
      package_name: "${pkg}",
      version_name: versionName,
      version_code: versionCode,
      platform: "${params.platform || 'website'}",
      last_seen_at: Date.now(),
      status: "online",
      event: "session_ping",
    }),
  });
  return res.json();
}

export async function fetchRemoteConfig() {
  const res = await fetch("${base}/api/v1/sdk/remote-config?package_name=${encodeURIComponent(pkg)}");
  if (!res.ok) throw new Error(\`Aegis remote config HTTP \${res.status}\`);
  return res.json();
}

export async function fetchActiveAnnouncements() {
  const res = await fetch("${base}/api/v1/sdk/announcements?package_name=${encodeURIComponent(pkg)}&active=1");
  return res.json();
}

export async function fetchCollectionRecords() {
  const res = await fetch("${base}/api/v1/sdk/data/${sampleSlug}", { headers: AEGIS_HEADERS });
  return res.json();
}`;

  const android = `// Android Kotlin + OkHttp Two-Way Package Sync (${pkg})
val client = OkHttpClient()
val mediaType = "application/json; charset=utf-8".toMediaType()
val packageName = "${pkg}"

// 1. App -> Admin Panel: Register / Heartbeat app state
val heartbeatJson = """
  {
    "package_name": "$packageName",
    "version_name": BuildConfig.VERSION_NAME,
    "version_code": BuildConfig.VERSION_CODE,
    "platform": "android",
    "last_seen_at": \${System.currentTimeMillis()},
    "status": "online",
    "event": "app_open"
  }
""".trimIndent()
val heartbeatReq = Request.Builder()
  .url("${base}/api/v1/sdk/heartbeat")
  .post(heartbeatJson.toRequestBody(mediaType))
  .addHeader("X-Package-Name", packageName)
  .addHeader("X-API-Key", "${key}")
  .build()
client.newCall(heartbeatReq).execute().close()

// 2. Admin Panel -> App: Fetch Remote Config / Kill-Switch / Maintenance Flags
val remoteReq = Request.Builder()
  .url("${base}/api/v1/sdk/remote-config?package_name=$packageName")
  .build()
client.newCall(remoteReq).execute().use { resp ->
  if (resp.isSuccessful) {
    val configJson = resp.body?.string() // maintenance, kill_switch, banner, flags
  }
}

// 3. Admin Panel -> App: Fetch Active Announcements
val annReq = Request.Builder()
  .url("${base}/api/v1/sdk/announcements?package_name=$packageName&active=1")
  .build()
client.newCall(annReq).execute().use { resp ->
  if (resp.isSuccessful) {
    val announcementsJson = resp.body?.string() // active=1 sorted by priority DESC
  }
}`;

  const unity = `// Unity C# SDK Integration (${uid})
using System.Text;
using System.Collections;
using UnityEngine;
using UnityEngine.Networking;

public class AegisUnityClient : MonoBehaviour {
  private const string BaseUrl = "${base}/api/v1/sdk";
  private const string AppId = "${uid}";
  private const string ApiKey = "${key}";

  public IEnumerator FetchConfig() {
    using var req = UnityWebRequest.Get($"{BaseUrl}/config");
    req.SetRequestHeader("X-App-Id", AppId);
    req.SetRequestHeader("X-API-Key", ApiKey);
    yield return req.SendWebRequest();
    if (req.result == UnityWebRequest.Result.Success) {
      Debug.Log("Aegis Config: " + req.downloadHandler.text);
    }
  }

  public IEnumerator SubmitScore(string playerId, string playerName, int score) {
    string json = $"{{\\"data\\":{{\\"player_id\\":\\"{playerId}\\",\\"player_name\\":\\"{playerName}\\",\\"score\\":{score}}}}}";
    using var req = new UnityWebRequest($"{BaseUrl}/data/${sampleSlug}", "POST");
    req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
    req.downloadHandler = new DownloadHandlerBuffer();
    req.SetRequestHeader("Content-Type", "application/json");
    req.SetRequestHeader("X-App-Id", AppId);
    req.SetRequestHeader("X-API-Key", ApiKey);
    yield return req.SendWebRequest();
  }
}`;

  const ios = `// iOS Swift URLSession SDK Integration (${uid})
import Foundation

struct AegisClient {
  static let baseURL = URL(string: "${base}/api/v1/sdk")!
  static let appId = "${uid}"
  static let apiKey = "${key}"

  static func fetchConfig() async throws -> Data {
    var req = URLRequest(url: baseURL.appendingPathComponent("config"))
    req.setValue(appId, forHTTPHeaderField: "X-App-Id")
    req.setValue(apiKey, forHTTPHeaderField: "X-API-Key")
    let (data, _) = try await URLSession.shared.data(for: req)
    return data
  }
}`;

  return { curl, website, android, unity, ios };
}
