import type { AegisDatabase } from '../db/index.ts';

export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: {
    duration?: number;
    changes?: number;
    last_row_id?: number;
  };
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  raw<T = unknown[]>(): Promise<T[]>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export interface AssetsFetcher {
  fetch(request: Request | string): Promise<Response>;
}

export interface WorkerEnv {
  DB: D1Database;
  ASSETS?: AssetsFetcher;
  GITHUB_TOKEN?: string;
  GITHUB_DEFAULT_REPO?: string;
  GEMINI_API_KEY?: string;
  EMAIL_PROVIDER_URL?: string;
  PUSH_PROVIDER_URL?: string;
  APP_ENV?: string;
}

export interface AuthenticatedAdmin {
  id: number;
  uid: string;
  email: string;
  displayName: string;
  avatarUrl: string;
  status: string;
  roleId: number | null;
  roleSlug: string;
  roleName: string;
  hierarchyLevel: number;
  twoFactorEnabled: boolean;
  permissions: Set<string>;
  preferences: Record<string, unknown>;
  sessionId: number;
}

export interface WorkerContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  env: WorkerEnv;
  db: AegisDatabase;
  clientIp: string;
  userAgent: string;
  adminUser?: AuthenticatedAdmin;
}
