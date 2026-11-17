import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.ts';
import type { D1Database } from '../worker/types.ts';

export type AegisDatabase = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): AegisDatabase {
  // Drizzle D1 expects Cloudflare's D1Database structural interface
  return drizzle(d1 as unknown as Parameters<typeof drizzle>[0], { schema });
}
