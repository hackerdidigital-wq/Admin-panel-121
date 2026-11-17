# Aegis Enterprise Console — Technical Documentation

## 1. Zero-Cost Architecture Overview (₹0 Infrastructure)

- **Frontend**: React 19 + TypeScript + Tailwind CSS v4 + Lucide Icons (`lucide-react`), bundled by Vite into `./dist`.
- **Backend API**: Web-Standard Cloudflare Workers TypeScript router (`src/worker/index.ts`, `src/worker/app.ts`) serving both `/api/*` REST routes and static assets (`env.ASSETS`).
- **Local Development Adapter**: `server.ts` mounts Vite middleware on port `3000` and forwards every `/api/*` request directly into `handleApiRequest()` backed by Node 22 `node:sqlite` (`src/db/local-d1.ts`, `.data/aegis.sqlite`). Local dev and Cloudflare Workers execute identical route, auth, RBAC, and SQLite logic.
- **Database**: Cloudflare D1 SQLite managed via Drizzle ORM (`src/db/schema.ts`, 26 relational tables) and SQL migration (`migrations/0001_init.sql`).
- **Authentication**: First-party password-only administrator authentication (zero Google/OAuth login, no email or username required) with PBKDF2-SHA256 password hashing (100,000 iterations), `HttpOnly; SameSite=Lax` SHA-256 hashed sessions in `user_sessions`, sliding-window rate limiting, optional RFC-6238 TOTP two-factor authentication, and zero hardcoded or randomly generated passwords.

## 2. Database Schema & Migrations (26 Tables)

Defined in `src/db/schema.ts` and `migrations/0001_init.sql`:
- **Identity & RBAC**: `roles`, `permissions`, `role_permissions`, `users`, `user_permission_overrides`, `user_sessions`, `user_notes`
- **Content & Media**: `categories`, `content_items`, `content_versions`, `files`
- **Communications & Support**: `notification_templates`, `notifications`, `support_tickets`, `ticket_messages`, `support_templates`
- **Commerce & Ads**: `transactions`, `ad_configs`
- **App Governance**: `system_settings`, `feature_flags`, `app_releases`, `saved_views`
- **Operations & Integrity**: `audit_logs`, `api_logs`, `background_jobs`, `backups`

Apply migrations locally with Wrangler:
```bash
npm run db:migrate:local
```

## 3. First-Time Super Admin Bootstrap & Authentication Lifecycle

1. On startup or first `/api/auth/status` call, `ensureSystemSeeded()` populates system roles, permission definitions, baseline settings keys, and category/flag defaults (never creating dummy users or sample business metrics).
2. When no active administrator has a configured `password_hash`, `GET /api/auth/status` returns `{ needsSetup: true }`, and the UI displays **First-Time Installation: Create Administrator Password**.
3. Submitting the setup form (`POST /api/auth/setup`) hashes the owner's chosen password with PBKDF2-SHA256, preserves any existing administrator record in-place (or creates the initial `super_admin` row), opens an active session cookie, and locks `/api/auth/setup` (`HTTP 409` thereafter).
4. Subsequent logins use password-only `POST /api/auth/login` (requiring only the administrator password and optional TOTP verification, without locking the owner out).
5. Self-service password changes (`POST /api/auth/change-password`) and admin-initiated password updates (`PATCH /api/users/:id`) are recorded in the tamper-evident audit chain.

## 4. Security Architecture

- **Server-Side Session Verification**: Every protected `/api/*` endpoint executes `requireAuth` (`src/worker/auth.ts`), hashing the `aegis_session` cookie token with SHA-256, verifying active non-expired rows in `user_sessions`, checking account status (`active` only), and enforcing global + per-user IP allowlists.
- **Granular RBAC**: `requirePermission('module.action')` evaluates role permissions merged with per-user allow/deny overrides (`user_permission_overrides`).
- **Tamper-Evident Audit Chain**: Every state-changing endpoint invokes `writeAuditLog()` (`src/worker/audit.ts`), computing `SHA-256([prevHash, actorEmail, action, module, targetType, targetId, details, status, createdAtIso])`. Chain integrity is verified via `GET /api/audit/verify`.
- **CSRF, Headers & Rate Limiting**: `verifyCsrfOrigin` validates `Origin` vs `Host` on mutating requests; `SlidingWindowLimiter` enforces configurable per-IP API & login limits; `withSecurityHeaders` attaches `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, and `Permissions-Policy`.

## 5. Complete API Surface

- `GET /api/health` — Public D1 connectivity & query latency check.
- `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`, `POST /api/auth/forgot-password`, `POST /api/auth/logout`, `GET /api/auth/session`, `PATCH /api/auth/preferences`, `POST /api/auth/change-password`, `POST /api/auth/2fa/setup`, `POST /api/auth/2fa/verify`, `POST /api/auth/2fa/disable`.
- `GET /api/realtime/snapshot` — Live presence (`onlineUserIds`), active session count, and latest audit events.
- `GET /api/dashboard/overview`, `PUT /api/dashboard/layout`, `GET /api/search`.
- `GET/POST /api/users`, `GET /api/users/export.csv`, `POST /api/users/import`, `POST /api/users/bulk`, `GET/PATCH /api/users/:id`, `POST /api/users/:id/status`, `POST /api/users/:id/force-logout`, `POST /api/users/:id/notes`, `POST|PUT /api/users/:id/permissions`, `GET/POST /api/roles`, `PUT /api/roles/:id/permissions`, `GET /api/permissions`.
- `GET/POST /api/content`, `PATCH /api/content/:id`, `GET /api/content/:id/versions`, `POST /api/content/:id/rollback`, `POST /api/content/bulk-publish`, `GET/POST /api/categories`.
- `GET/POST /api/notifications`, `POST /api/notifications/templates`, `GET/POST /api/support/tickets`, `GET/POST /api/support/tickets/:id/messages`, `PATCH /api/support/tickets/:id`, `POST /api/support/templates`.
- `GET /api/finance/overview`, `GET /api/finance/transactions`, `POST /api/finance/transactions`, `POST /api/finance/transactions/:id/refund`, `GET/POST /api/ads`, `PATCH /api/ads/:id`.
- `GET /api/app/overview`, `POST /api/app/flags`, `PATCH /api/app/flags/:id`, `POST /api/app/releases`, `PUT /api/app/maintenance`.
- `GET /api/analytics/overview`, `GET /api/security/overview`, `PUT /api/security/ip-allowlist`, `POST /api/security/sessions/:id/revoke`, `GET /api/system/overview`, `POST /api/system/jobs`, `GET /api/settings`, `PUT /api/settings/:key`, `GET /api/audit/logs`, `GET /api/audit/verify`.
- `GET /api/github/overview`, `PUT /api/github/repository`, `GET /api/database/overview`, `GET /api/database/records/:table`, `POST /api/database/backups`, `POST /api/database/backups/:id/verify`, `GET /api/database/backups/:id/download`, `GET /api/files`, `POST /api/files/upload`, `GET /api/files/:id/download`, `DELETE /api/files/:id`, `POST /api/ai/analyze`.

## 6. Backup & Recovery

- **Logical D1 Backups**: Triggered via **Database Mgmt -> Create Verified Backup** (`POST /api/database/backups`), serializing core relational tables into JSON with a SHA-256 verification digest stored in `backups`.
- **Integrity Verification**: `POST /api/database/backups/:id/verify` recomputes SHA-256 over the stored snapshot payload; `GET /api/database/backups/:id/download` exports the JSON archive.

## 7. GitHub CI/CD & Rollback Guide

- **CI Pipeline (`.github/workflows/ci.yml`)**: Runs `npm ci` (cached against `package-lock.json`), verifies `migrations/0001_init.sql` creates all 26 SQLite tables + foreign keys + indexes in Node 22 `node:sqlite`, runs `npm run typecheck`, `npm run eslint`, `npm test`, `npm run build`, and validates the Worker bundle with `npx wrangler deploy --dry-run`.
- **Cloudflare Workers Deploy (`.github/workflows/deploy-cloudflare.yml`)**: Runs the full `verify` job first, then (using `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, and either `wrangler.toml` `database_id` or `CLOUDFLARE_D1_DATABASE_ID` secret) applies `wrangler d1 migrations apply aegis-enterprise-db --remote`, deploys via `wrangler deploy`, and verifies `/api/health` and `/api/auth/status` over HTTPS.
- **Rollback**: Trigger `Deploy to Cloudflare Workers & D1 (Free Tier)` via **Actions -> workflow_dispatch** with an earlier tag (`v1.0.0`) or commit SHA in the `ref` input.

## 8. External Provider & Free-Tier Boundaries

1. **Email & Password Reset Delivery (`EMAIL_PROVIDER_URL`)**: Password resets and email-channel notifications require configuring an external HTTP email webhook (`EMAIL_PROVIDER_URL`). When unset, the backend transparently reports that no email provider is configured and never fakes delivery; Super Admins can reset user passwords in **User Management**.
2. **Push Notification Delivery (`PUSH_PROVIDER_URL`)**: In-app notifications are persisted directly in D1 SQLite; push notifications require `PUSH_PROVIDER_URL` and otherwise record `push_provider_unconfigured`.
3. **GitHub Integration (`GITHUB_TOKEN`)**: Public repositories work read-only within GitHub's unauthenticated rate limits; private repositories and higher limits require setting `GITHUB_TOKEN` as a Worker/server secret.
4. **D1 Inline Asset Storage**: To avoid paid object-storage dependencies, uploaded files are stored inline in D1 SQLite up to **750 KB** per file (`ALLOWED_FILE_MIMES` enforced).
5. **Cloudflare Free-Tier Quotas**: Workers free tier includes 100,000 requests/day and 10 ms CPU time per invocation; D1 free tier includes 5 GB storage, 5M rows read/day, and 100k rows written/day.
6. **Optional AI Advisor (`GEMINI_API_KEY`)**: Powered by Gemini REST API (`gemini-4-hydrogen`); optional and non-blocking when unset.
