import { desc } from 'drizzle-orm';
import type { AegisDatabase } from '../db/index.ts';
import { auditLogs } from '../db/schema.ts';
import { computeAuditHash } from '../lib/security.ts';

export interface AuditInput {
  actorId?: number | null;
  actorEmail?: string;
  action: string;
  module: string;
  targetType?: string;
  targetId?: string | number;
  details?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  status?: 'success' | 'failure' | 'denied';
}

export async function writeAuditLog(db: AegisDatabase, input: AuditInput): Promise<void> {
  try {
    const latest = await db
      .select({ entryHash: auditLogs.entryHash })
      .from(auditLogs)
      .orderBy(desc(auditLogs.id))
      .limit(1);

    const prevHash = latest[0]?.entryHash || 'GENESIS';
    const createdAt = new Date();
    const actorEmail = input.actorEmail || 'system';
    const targetType = input.targetType || '';
    const targetId = input.targetId !== undefined ? String(input.targetId) : '';
    const details = input.details ?? {};
    const status = input.status ?? 'success';

    const entryHash = await computeAuditHash({
      prevHash,
      actorEmail,
      action: input.action,
      module: input.module,
      targetType,
      targetId,
      details,
      status,
      createdAtIso: createdAt.toISOString(),
    });

    await db.insert(auditLogs).values({
      actorId: input.actorId ?? null,
      actorEmail,
      action: input.action,
      module: input.module,
      targetType,
      targetId,
      details,
      ipAddress: input.ipAddress || '',
      userAgent: (input.userAgent || '').slice(0, 300),
      status,
      prevHash,
      entryHash,
      createdAt,
    });
  } catch (error) {
    console.error('Audit log write failed:', error);
  }
}

export async function verifyAuditChain(
  db: AegisDatabase,
  limit = 500
): Promise<{
  checked: number;
  valid: boolean;
  brokenAtId: number | null;
}> {
  const rows = await db
    .select()
    .from(auditLogs)
    .orderBy(auditLogs.id)
    .limit(limit);

  let expectedPrev = 'GENESIS';
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return { checked: rows.length, valid: false, brokenAtId: row.id };
    }
    const recomputed = await computeAuditHash({
      prevHash: row.prevHash,
      actorEmail: row.actorEmail,
      action: row.action,
      module: row.module,
      targetType: row.targetType,
      targetId: row.targetId,
      details: (row.details ?? {}) as Record<string, unknown>,
      status: row.status,
      createdAtIso: new Date(row.createdAt).toISOString(),
    });
    if (recomputed !== row.entryHash) {
      return { checked: rows.length, valid: false, brokenAtId: row.id };
    }
    expectedPrev = row.entryHash;
  }

  return { checked: rows.length, valid: true, brokenAtId: null };
}
