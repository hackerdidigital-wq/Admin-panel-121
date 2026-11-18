import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { D1Database, D1PreparedStatement, D1Result } from '../worker/types.ts';

function sanitizeParam(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Uint8Array) return value;
  return JSON.stringify(value);
}

class LocalD1PreparedStatement implements D1PreparedStatement {
  private readonly rawDb: DatabaseSync;
  private readonly query: string;
  private readonly params: SQLInputValue[];

  constructor(rawDb: DatabaseSync, query: string, params: SQLInputValue[] = []) {
    this.rawDb = rawDb;
    this.query = query;
    this.params = params;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new LocalD1PreparedStatement(
      this.rawDb,
      this.query,
      values.map((v) => sanitizeParam(v))
    );
  }

  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const stmt = this.rawDb.prepare(this.query);
    const row = stmt.get(...this.params) as Record<string, unknown> | undefined;
    if (!row) return null;
    if (colName) {
      return (row[colName] ?? null) as T | null;
    }
    return row as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const start = Date.now();
    const stmt = this.rawDb.prepare(this.query);
    const trimmed = this.query.trim().toLowerCase();
    const hasReturning = /\breturning\b/i.test(this.query);
    if (trimmed.startsWith('select') || trimmed.startsWith('pragma') || trimmed.startsWith('with') || hasReturning) {
      const results = stmt.all(...this.params) as T[];
      return {
        results,
        success: true,
        meta: {
          duration: Date.now() - start,
          changes: 0,
          last_row_id: 0,
        },
      };
    }
    const info = stmt.run(...this.params);
    return {
      results: [],
      success: true,
      meta: {
        duration: Date.now() - start,
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
      },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.all<T>();
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const stmt = this.rawDb.prepare(this.query);
    const rows = stmt.all(...this.params) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row) as unknown as T);
  }
}

export function createLocalD1Database(
  sqliteFilePath?: string,
  options: { skipMigrations?: boolean } = {}
): {
  d1: D1Database;
  raw: DatabaseSync;
} {
  const targetPath = sqliteFilePath || path.resolve(process.cwd(), '.data', 'aegis.sqlite');
  if (targetPath !== ':memory:') {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  }
  const rawDb = new DatabaseSync(targetPath);
  rawDb.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

  if (!options.skipMigrations) {
    const migrationPath = path.resolve(process.cwd(), 'migrations', '0001_init.sql');
    if (fs.existsSync(migrationPath)) {
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      rawDb.exec(migrationSql);
    }
  }

  const d1: D1Database = {
    prepare(query: string) {
      return new LocalD1PreparedStatement(rawDb, query);
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const out: D1Result<T>[] = [];
      for (const stmt of statements) {
        out.push(await stmt.all<T>());
      }
      return out;
    },
    async exec(query: string) {
      rawDb.exec(query);
      return { count: 1, duration: 0 };
    },
  };

  return { d1, raw: rawDb };
}

let cachedLocalD1: D1Database | null = null;

export function getLocalD1Database(): D1Database {
  if (!cachedLocalD1) {
    cachedLocalD1 = createLocalD1Database().d1;
  }
  return cachedLocalD1;
}
