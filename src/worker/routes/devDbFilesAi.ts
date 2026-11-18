import { desc, eq, sql } from 'drizzle-orm';
import type { AegisDatabase } from '../../db/index.ts';
import {
  apiLogs,
  auditLogs,
  backups,
  files,
  roles,
  systemSettings,
  users,
} from '../../db/schema.ts';
import { computeSha256, sanitizeText } from '../../lib/security.ts';
import { isValidRepoName } from '../../lib/validation.ts';
import { writeAuditLog } from '../audit.ts';
import { requirePermission } from '../auth.ts';
import { errorResponse, jsonResponse, readJsonBody } from '../http.ts';
import type { WorkerRouter } from '../router.ts';
import type { D1Database, WorkerContext } from '../types.ts';

const ALLOWED_TABLES = new Set([
  'roles',
  'permissions',
  'role_permissions',
  'users',
  'user_permission_overrides',
  'user_sessions',
  'user_notes',
  'connected_apps',
  'app_api_keys',
  'app_users',
  'app_events',
  'webhooks',
  'webhook_deliveries',
  'user_app_permissions',
  'categories',
  'content_items',
  'content_versions',
  'notification_templates',
  'notifications',
  'transactions',
  'ad_configs',
  'support_tickets',
  'ticket_messages',
  'support_templates',
  'system_settings',
  'feature_flags',
  'app_releases',
  'files',
  'audit_logs',
  'api_logs',
  'background_jobs',
  'backups',
  'saved_views',
]);

const BACKUP_TABLES = [
  'roles',
  'connected_apps',
  'app_users',
  'app_events',
  'webhooks',
  'user_app_permissions',
  'categories',
  'content_items',
  'notification_templates',
  'notifications',
  'transactions',
  'ad_configs',
  'support_tickets',
  'system_settings',
  'feature_flags',
  'app_releases',
] as const;

const APP_SCOPED_BACKUP_TABLES = new Set([
  'app_users',
  'app_events',
  'webhooks',
  'user_app_permissions',
  'content_items',
  'notifications',
  'transactions',
  'ad_configs',
  'support_tickets',
  'feature_flags',
  'app_releases',
]);

const RESTORE_DELETE_ORDER = [
  'app_events',
  'app_users',
  'ad_configs',
  'transactions',
  'notifications',
  'support_tickets',
  'app_releases',
  'feature_flags',
  'content_items',
  'user_app_permissions',
] as const;

const RESTORE_INSERT_ORDER = [
  'roles',
  'connected_apps',
  'webhooks',
  'user_app_permissions',
  'app_users',
  'app_events',
  'categories',
  'content_items',
  'notification_templates',
  'notifications',
  'transactions',
  'ad_configs',
  'support_tickets',
  'system_settings',
  'feature_flags',
  'app_releases',
] as const;

export async function createFullBackupSnapshot(
  db: AegisDatabase,
  d1: D1Database,
  actorId: number | null,
  backupType: 'manual' | 'scheduled' | 'export' = 'manual',
  appId: number | null = null
): Promise<{
  id: number;
  filename: string;
  sizeBytes: number;
  checksumSha256: string;
  rowCount: number;
}> {
  const snapshotData: Record<string, unknown[]> = {};
  const tablesIncluded: string[] = [];
  let totalRows = 0;

  for (const tbl of BACKUP_TABLES) {
    let rows: Record<string, unknown>[];
    if (appId !== null && tbl === 'connected_apps') {
      const r = await d1.prepare(`SELECT * FROM "connected_apps" WHERE id = ?`).bind(appId).all<Record<string, unknown>>();
      rows = r.results;
    } else if (appId !== null && APP_SCOPED_BACKUP_TABLES.has(tbl)) {
      const r = await d1.prepare(`SELECT * FROM "${tbl}" WHERE app_id = ?`).bind(appId).all<Record<string, unknown>>();
      rows = r.results;
    } else if (appId !== null && (tbl === 'roles' || tbl === 'system_settings' || tbl === 'categories' || tbl === 'notification_templates')) {
      continue;
    } else {
      const r = await d1.prepare(`SELECT * FROM "${tbl}"`).all<Record<string, unknown>>();
      rows = r.results;
    }
    snapshotData[tbl] = rows;
    tablesIncluded.push(tbl);
    totalRows += rows.length;
  }

  const jsonString = JSON.stringify(snapshotData);
  const checksumSha256 = await computeSha256(jsonString);
  const sizeBytes = new TextEncoder().encode(jsonString).byteLength;
  const scopeLabel = appId ? `app-${appId}` : 'multi-app';
  const filename = `aegis-d1-${scopeLabel}-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  const created = await db
    .insert(backups)
    .values({
      appId,
      filename,
      type: backupType,
      status: 'verified',
      sizeBytes,
      checksumSha256,
      tablesIncluded,
      rowCount: totalRows,
      snapshotData,
      verifiedAt: new Date(),
      createdBy: actorId,
    })
    .returning();

  return {
    id: created[0].id,
    filename,
    sizeBytes,
    checksumSha256,
    rowCount: totalRows,
  };
}

async function restoreSnapshotDataToD1(
  d1: D1Database,
  snapshotData: Record<string, unknown>,
  mode: 'merge' | 'replace',
  scopedAppId: number | null
): Promise<{ restoredTables: string[]; restoredRows: number }> {
  const restoredTables: string[] = [];
  let restoredRows = 0;

  if (mode === 'replace') {
    for (const tbl of RESTORE_DELETE_ORDER) {
      if (!Array.isArray(snapshotData[tbl])) continue;
      if (scopedAppId !== null && APP_SCOPED_BACKUP_TABLES.has(tbl)) {
        await d1.prepare(`DELETE FROM "${tbl}" WHERE app_id = ?`).bind(scopedAppId).run();
      } else if (scopedAppId === null) {
        await d1.prepare(`DELETE FROM "${tbl}"`).run();
      }
    }
  }

  for (const tbl of RESTORE_INSERT_ORDER) {
    const rawRows = snapshotData[tbl];
    if (!Array.isArray(rawRows) || rawRows.length === 0) continue;

    const colInfo = await d1
      .prepare(`SELECT name FROM pragma_table_info('${tbl}')`)
      .all<{ name: string }>();
    const validCols = colInfo.results.map((c) => c.name);
    if (validCols.length === 0) continue;

    const validColSet = new Set(validCols);
    restoredTables.push(tbl);

    for (const item of rawRows) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const cols = Object.keys(rec).filter((c) => validColSet.has(c));
      if (cols.length === 0) continue;

      const placeholders = cols.map(() => '?').join(', ');
      const colSql = cols.map((c) => `"${c}"`).join(', ');
      const values = cols.map((c) => {
        const v = rec[c];
        if (v === undefined) return null;
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v;
      });

      if (tbl === 'connected_apps') {
        const updateCols = cols.filter((c) => c !== 'id' && c !== 'app_uid');
        if (updateCols.length > 0) {
          const updateSet = updateCols.map((c) => `"${c}" = excluded."${c}"`).join(', ');
          await d1
            .prepare(
              `INSERT INTO "connected_apps" (${colSql}) VALUES (${placeholders}) ON CONFLICT(id) DO UPDATE SET ${updateSet}`
            )
            .bind(...values)
            .run();
        } else {
          await d1
            .prepare(`INSERT OR IGNORE INTO "connected_apps" (${colSql}) VALUES (${placeholders})`)
            .bind(...values)
            .run();
        }
      } else {
        await d1
          .prepare(`INSERT OR REPLACE INTO "${tbl}" (${colSql}) VALUES (${placeholders})`)
          .bind(...values)
          .run();
      }
      restoredRows += 1;
    }
  }

  return { restoredTables, restoredRows };
}

const ALLOWED_FILE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
]);

function decodeBase64Bytes(base64Str: string): Uint8Array {
  const binary = atob(base64Str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function registerDevDbFilesAiRoutes(router: WorkerRouter): void {
  // ---- MODULE M: GITHUB & DEVELOPER CENTER ----
  router.get('/api/github/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'github.read');
    if (permFail) return permFail;

    const repoRows = await ctx.db
      .select()
      .from(systemSettings)
      .where(eq(systemSettings.key, 'github.repository'))
      .limit(1);
    const configuredRepo = sanitizeText(
      String(repoRows[0]?.value || ctx.env.GITHUB_DEFAULT_REPO || ''),
      120
    );
    const hasToken = Boolean(ctx.env.GITHUB_TOKEN);

    if (!configuredRepo || !isValidRepoName(configuredRepo)) {
      return jsonResponse({
        configured: false,
        repository: configuredRepo,
        hasServerToken: hasToken,
        message: 'GitHub integration not configured',
      });
    }

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Aegis-Enterprise-Console',
    };
    if (ctx.env.GITHUB_TOKEN) {
      headers.Authorization = `Bearer ${ctx.env.GITHUB_TOKEN}`;
    }

    const fetchGh = async (path: string) => {
      const r = await fetch(`https://api.github.com/repos/${configuredRepo}${path}`, { headers });
      if (!r.ok) {
        const text = await r.text();
        throw new Error(`GitHub API ${r.status}: ${text.slice(0, 160)}`);
      }
      return r.json();
    };

    try {
      const [repo, branches, commits, pulls, workflows, releases, deployments] = await Promise.all([
        fetchGh(''),
        fetchGh('/branches?per_page=15'),
        fetchGh('/commits?per_page=15'),
        fetchGh('/pulls?state=all&per_page=10').catch(() => []),
        fetchGh('/actions/runs?per_page=12').catch(() => ({ workflow_runs: [] })),
        fetchGh('/releases?per_page=10').catch(() => []),
        fetchGh('/deployments?per_page=10').catch(() => []),
      ]);

      return jsonResponse({
        configured: true,
        repository: configuredRepo,
        hasServerToken: hasToken,
        repo,
        branches,
        commits,
        pulls,
        workflows: (workflows as { workflow_runs?: unknown[] }).workflow_runs ?? [],
        releases,
        deployments,
      });
    } catch (err) {
      return jsonResponse({
        configured: true,
        repository: configuredRepo,
        hasServerToken: hasToken,
        error: err instanceof Error ? err.message : 'GitHub API lookup failed',
      });
    }
  });

  router.put('/api/github/repository', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'github.manage');
    if (permFail) return permFail;

    const body = await readJsonBody<{ repository?: string }>(ctx.request);
    const repository = sanitizeText(body.repository || '', 120);
    if (repository && !isValidRepoName(repository)) {
      return errorResponse(400, 'Repository must follow owner/repo format.');
    }

    await ctx.db
      .insert(systemSettings)
      .values({
        key: 'github.repository',
        category: 'integrations',
        value: repository,
        isSecret: false,
        description: 'Connected GitHub repository (owner/repo)',
        updatedBy: ctx.adminUser!.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: systemSettings.key,
        set: { value: repository, updatedBy: ctx.adminUser!.id, updatedAt: new Date() },
      });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'github.repository_updated',
      module: 'github',
      targetType: 'repository',
      targetId: repository || 'cleared',
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ repository });
  });

  // ---- MODULE N: DATABASE MANAGEMENT (Cloudflare D1 / SQLite) ----
  router.get('/api/database/overview', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.read');
    if (permFail) return permFail;

    const tablesQuery = await ctx.env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name`
    ).all<{ name: string }>();

    const tables: Array<{
      table_name: string;
      estimated_rows: number;
      total_size_bytes: number;
    }> = [];

    for (const t of tablesQuery.results) {
      if (!ALLOWED_TABLES.has(t.name)) continue;
      const cntRow = await ctx.env.DB.prepare(
        `SELECT cast(count(*) as integer) AS cnt FROM "${t.name}"`
      ).first<{ cnt: number }>();
      tables.push({
        table_name: t.name,
        estimated_rows: Number(cntRow?.cnt ?? 0),
        total_size_bytes: 0,
      });
    }

    const appIdParam = ctx.url.searchParams.get('appId');
    const scopedAppId = appIdParam && appIdParam !== 'all' && Number.isFinite(Number(appIdParam)) ? Number(appIdParam) : null;

    const backupRows = await ctx.db
      .select({
        id: backups.id,
        appId: backups.appId,
        filename: backups.filename,
        type: backups.type,
        status: backups.status,
        sizeBytes: backups.sizeBytes,
        checksumSha256: backups.checksumSha256,
        tablesIncluded: backups.tablesIncluded,
        rowCount: backups.rowCount,
        verifiedAt: backups.verifiedAt,
        createdAt: backups.createdAt,
      })
      .from(backups)
      .where(scopedAppId ? eq(backups.appId, scopedAppId) : undefined)
      .orderBy(desc(backups.createdAt))
      .limit(30);

    return jsonResponse({ tables, backups: backupRows });
  });

  const inspectRecordsHandler = async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.inspect');
    if (permFail) return permFail;

    const table = sanitizeText(ctx.params.table || '', 64);
    if (!ALLOWED_TABLES.has(table)) {
      return errorResponse(400, 'Table is not in the permitted inspection allowlist.');
    }

    const result = await ctx.env.DB.prepare(`SELECT * FROM "${table}" LIMIT 50`).all<
      Record<string, unknown>
    >();
    const safeRows = result.results.map((r) => {
      const clone = { ...r };
      if ('two_factor_secret' in clone) clone.two_factor_secret = '[REDACTED]';
      if ('password_hash' in clone) clone.password_hash = '[REDACTED]';
      if ('key_hash' in clone) clone.key_hash = '[REDACTED]';
      if ('signing_secret' in clone) clone.signing_secret = '[REDACTED]';
      if ('webhook_secret' in clone) clone.webhook_secret = '[REDACTED]';
      if ('content_base64' in clone) clone.content_base64 = '[BINARY_OMITTED]';
      return clone;
    });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'database.table_inspected',
      module: 'database',
      targetType: 'table',
      targetId: table,
      details: { rowCount: safeRows.length },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ table, rows: safeRows });
  };

  router.get('/api/database/records/:table', inspectRecordsHandler);
  router.get('/api/database/tables/:table/records', inspectRecordsHandler);

  router.post('/api/database/backups', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.inspect');
    if (permFail) return permFail;

    const body = await readJsonBody<{ appId?: number | null; type?: string }>(ctx.request);
    const appId =
      body.appId !== undefined && body.appId !== null && Number.isFinite(Number(body.appId)) && Number(body.appId) > 0
        ? Math.floor(Number(body.appId))
        : null;

    const backup = await createFullBackupSnapshot(ctx.db, ctx.env.DB, ctx.adminUser!.id, 'manual', appId);

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'database.backup_created',
      module: 'database',
      targetType: 'backup',
      targetId: backup.id,
      details: { ...backup, appId },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ backup }, 201);
  });

  router.post('/api/database/backups/:id/verify', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.read');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(backups).where(eq(backups.id, id)).limit(1);
    const backup = rows[0];
    if (!backup) return errorResponse(404, 'Backup record not found.');

    const recomputed = await computeSha256(JSON.stringify(backup.snapshotData));
    const valid = recomputed === backup.checksumSha256;

    await ctx.db
      .update(backups)
      .set({
        status: valid ? 'verified' : 'failed',
        verifiedAt: new Date(),
      })
      .where(eq(backups.id, id));

    return jsonResponse({ id, valid, checksumSha256: recomputed });
  });

  router.post('/api/database/backups/:id/restore', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.restore');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(backups).where(eq(backups.id, id)).limit(1);
    const backup = rows[0];
    if (!backup) return errorResponse(404, 'Backup record not found.');

    const recomputed = await computeSha256(JSON.stringify(backup.snapshotData));
    if (recomputed !== backup.checksumSha256) {
      return errorResponse(400, 'Backup integrity checksum verification failed; restore aborted.');
    }

    const body = await readJsonBody<{ mode?: string }>(ctx.request);
    const mode = body.mode === 'merge' ? 'merge' : 'replace';

    const result = await restoreSnapshotDataToD1(
      ctx.env.DB,
      (backup.snapshotData ?? {}) as Record<string, unknown>,
      mode,
      backup.appId ?? null
    );

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'database.backup_restored',
      module: 'database',
      targetType: 'backup',
      targetId: id,
      details: { mode, appId: backup.appId, ...result },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ restored: true, backupId: id, mode, ...result });
  });

  router.post('/api/database/restore', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.restore');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      mode?: string;
      snapshotData?: Record<string, unknown>;
      appId?: number | null;
    }>(ctx.request);

    if (!body.snapshotData || typeof body.snapshotData !== 'object' || Array.isArray(body.snapshotData)) {
      return errorResponse(400, 'Valid snapshotData JSON object is required.');
    }

    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const appId =
      body.appId !== undefined && body.appId !== null && Number.isFinite(Number(body.appId)) && Number(body.appId) > 0
        ? Math.floor(Number(body.appId))
        : null;

    const result = await restoreSnapshotDataToD1(ctx.env.DB, body.snapshotData, mode, appId);

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'database.snapshot_imported',
      module: 'database',
      targetType: 'database',
      targetId: appId ? `app-${appId}` : 'full',
      details: { mode, ...result },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ restored: true, mode, ...result });
  });

  router.get('/api/database/backups/:id/download', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'database.inspect');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(backups).where(eq(backups.id, id)).limit(1);
    const backup = rows[0];
    if (!backup) return errorResponse(404, 'Backup record not found.');

    return new Response(JSON.stringify(backup.snapshotData, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${backup.filename}"`,
      },
    });
  });

  // ---- MODULE O: FILE & MEDIA MANAGEMENT (D1 Free-Tier Storage, Max 750KB) ----
  router.get('/api/files', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'files.read');
    if (permFail) return permFail;

    const category = sanitizeText(ctx.url.searchParams.get('category') || 'all', 30);
    const unusedOnly = ctx.url.searchParams.get('unused') === 'true';

    const rows = await ctx.db
      .select({
        id: files.id,
        filename: files.filename,
        originalName: files.originalName,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        category: files.category,
        checksumSha256: files.checksumSha256,
        isPublic: files.isPublic,
        usageCount: files.usageCount,
        createdAt: files.createdAt,
      })
      .from(files)
      .where(sql`${files.deletedAt} IS NULL`)
      .orderBy(desc(files.createdAt));

    const filtered = rows.filter((r) => {
      if (category !== 'all' && r.category !== category) return false;
      if (unusedOnly && r.usageCount > 0) return false;
      return true;
    });

    const totalBytes = rows.reduce((sum, r) => sum + r.sizeBytes, 0);
    return jsonResponse({ data: filtered, totalBytes });
  });

  router.post('/api/files/upload', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'files.write');
    if (permFail) return permFail;

    const body = await readJsonBody<{
      filename?: string;
      mimeType?: string;
      base64Data?: string;
      isPublic?: boolean;
    }>(ctx.request);

    const originalName = sanitizeText(body.filename, 140).replace(/[^A-Za-z0-9._-]/g, '_');
    const mimeType = sanitizeText(body.mimeType, 80);
    const rawBase64 = typeof body.base64Data === 'string' ? body.base64Data.replace(/^data:[^;]+;base64,/, '') : '';

    if (!originalName || !rawBase64) {
      return errorResponse(400, 'Filename and file payload are required.');
    }
    if (!ALLOWED_FILE_MIMES.has(mimeType)) {
      return errorResponse(400, `Unsupported or unsafe MIME type "${mimeType}". Allowed: PNG, JPEG, WEBP, SVG, PDF, TXT, CSV, JSON.`);
    }

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64Bytes(rawBase64);
    } catch {
      return errorResponse(400, 'Invalid base64 payload.');
    }

    if (bytes.byteLength > 750 * 1024) {
      return errorResponse(400, 'File exceeds the 750 KB D1 free-tier inline asset limit.');
    }

    const storedName = `${Date.now()}-${originalName}`;
    const checksumSha256 = await computeSha256(bytes);
    const category = mimeType.startsWith('image/')
      ? 'image'
      : mimeType === 'application/pdf' || mimeType.startsWith('text/')
        ? 'document'
        : 'other';

    const created = await ctx.db
      .insert(files)
      .values({
        filename: storedName,
        originalName,
        mimeType,
        sizeBytes: bytes.byteLength,
        category,
        storagePath: `d1://files/${storedName}`,
        contentBase64: rawBase64,
        checksumSha256,
        isPublic: Boolean(body.isPublic),
        uploadedBy: ctx.adminUser!.id,
      })
      .returning({
        id: files.id,
        filename: files.filename,
        originalName: files.originalName,
        mimeType: files.mimeType,
        sizeBytes: files.sizeBytes,
        category: files.category,
        checksumSha256: files.checksumSha256,
        createdAt: files.createdAt,
      });

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'files.uploaded',
      module: 'files',
      targetType: 'file',
      targetId: created[0].id,
      details: { originalName, sizeBytes: bytes.byteLength, mimeType },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ file: created[0] }, 201);
  });

  router.get('/api/files/:id/download', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'files.read');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(files).where(eq(files.id, id)).limit(1);
    const row = rows[0];
    if (!row || row.deletedAt || !row.contentBase64) {
      return errorResponse(404, 'File not found.');
    }

    const bytes = decodeBase64Bytes(row.contentBase64);
    const bodyBuf = new Uint8Array(bytes.byteLength);
    bodyBuf.set(bytes);
    return new Response(bodyBuf.buffer, {
      status: 200,
      headers: {
        'Content-Type': row.mimeType,
        'Content-Disposition': `attachment; filename="${row.originalName}"`,
      },
    });
  });

  router.delete('/api/files/:id', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'files.delete');
    if (permFail) return permFail;

    const id = Number(ctx.params.id);
    const rows = await ctx.db.select().from(files).where(eq(files.id, id)).limit(1);
    const target = rows[0];
    if (!target) return errorResponse(404, 'File not found.');

    await ctx.db
      .update(files)
      .set({ deletedAt: new Date(), contentBase64: null })
      .where(eq(files.id, id));

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'files.deleted',
      module: 'files',
      targetType: 'file',
      targetId: id,
      details: { originalName: target.originalName },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({ deleted: true });
  });

  // ---- OPTIONAL AI OPERATIONS ANALYSIS (Gemini REST API via fetch; zero mandatory paid key) ----
  router.post('/api/ai/analyze', async (ctx: WorkerContext) => {
    const permFail = await requirePermission(ctx, 'ai.analyze');
    if (permFail) return permFail;

    const apiKey = ctx.env.GEMINI_API_KEY;
    if (!apiKey) {
      return errorResponse(
        503,
        'GEMINI_API_KEY is not configured in server secrets. Core admin features continue operating normally.'
      );
    }

    const body = await readJsonBody<{ mode?: string; question?: string }>(ctx.request);
    const mode = sanitizeText(body.mode || 'security_audit', 40);
    const question = sanitizeText(body.question || '', 500);

    const [recentAudit, recentErrors, userCounts] = await Promise.all([
      ctx.db
        .select({
          action: auditLogs.action,
          module: auditLogs.module,
          status: auditLogs.status,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .orderBy(desc(auditLogs.createdAt))
        .limit(20),
      ctx.db
        .select({
          method: apiLogs.method,
          path: apiLogs.path,
          statusCode: apiLogs.statusCode,
        })
        .from(apiLogs)
        .where(sql`${apiLogs.statusCode} >= 400`)
        .orderBy(desc(apiLogs.createdAt))
        .limit(15),
      ctx.db
        .select({
          status: users.status,
          roleName: roles.name,
        })
        .from(users)
        .leftJoin(roles, eq(users.roleId, roles.id))
        .limit(50),
    ]);

    const prompt = [
      `You are assisting an enterprise system administrator inside Aegis Enterprise Console.`,
      `Mode: ${mode}`,
      question ? `Administrator Focus Question: ${question}` : '',
      `Live Sanitized Operational Telemetry (no PII):`,
      `- User Statuses: ${JSON.stringify(userCounts)}`,
      `- Recent Audit Events: ${JSON.stringify(recentAudit)}`,
      `- Recent API 4xx/5xx Responses: ${JSON.stringify(recentErrors)}`,
      `Provide a concise, actionable assessment of operational anomalies, RBAC posture, and recommended defensive steps based strictly on the telemetry above.`,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: 'HIGH' },
          },
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      return errorResponse(502, `Gemini API error (${response.status}): ${errText.slice(0, 160)}`);
    }

    const payload = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      payload.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join('')
        .trim() || 'No response returned.';

    await writeAuditLog(ctx.db, {
      actorId: ctx.adminUser!.id,
      actorEmail: ctx.adminUser!.email,
      action: 'ai.analysis_executed',
      module: 'ai',
      details: { mode },
      ipAddress: ctx.clientIp,
      userAgent: ctx.userAgent,
    });

    return jsonResponse({
      model: 'gemini-4-hydrogen',
      thinkingLevel: 'HIGH',
      analysis: text,
    });
  });
}
