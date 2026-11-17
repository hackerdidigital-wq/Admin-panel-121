# Aegis Enterprise Console

A zero-cost (`₹0`), production-oriented enterprise administration platform running on **Cloudflare Workers**, **Cloudflare D1 SQLite**, **Workers Static Assets** (`workers.dev` free tier), **React 19 + TypeScript + Tailwind CSS v4**, and **GitHub Actions CI/CD**. Every metric, table row, audit record, backup snapshot, and health indicator is sourced directly from D1 SQLite and live runtime endpoints—with zero hardcoded credentials, zero dummy data, and zero simulated delivery statuses.

## Core Capabilities

- **17 Integrated Administration Modules (A–Q)**:
  - **Overview**: Real-time D1 SQLite KPIs, API/DB/Job health checks, customizable widget layout persistence (`saved_views`), recent admin actions, critical alerts, and Live Sync telemetry (`GET /api/realtime/snapshot`).
  - **User Management**: Server-side pagination/filtering/sorting, CSV RFC-4180 export with formula-injection protection, CSV bulk import, bulk status transitions, force logout, admin password reset, and a 14-tab User Detail Workspace.
  - **Roles & Permissions**: Granular server-side RBAC (`super_admin`, `admin`, `manager`, `moderator`, `support_agent`, plus custom roles), module/page/action permission matrix, and per-user allow/deny permission overrides.
  - **Content Management**: Multi-stage editorial lifecycle (draft, pending review, scheduled, published, archived, trash), version snapshots with rollback, categories, and tags.
  - **Notifications Center**: In-app persisted notifications, reusable templates, scheduled queues, and honest provider reporting (`EMAIL_PROVIDER_URL` / `PUSH_PROVIDER_URL` show explicit unconfigured status when unset rather than faking delivery).
  - **Financial & Advertisement Management**: Transaction ledger, refunds, fraud alerts, payout tracking, and configurable ad network/placement rules.
  - **Application Management & Support**: Feature flags, maintenance mode, minimum supported version enforcement, release changelog, support ticket queue, threaded replies, and response templates.
  - **Analytics, Security & Audit**: Interactive SVG analytics, PBKDF2-SHA256 password hashing (100k iterations), `HttpOnly` session cookies, 5-attempt account lockout, RFC-6238 TOTP two-factor authentication, IP allowlists, sliding-window rate limiting, CSRF origin protection, SHA-256 hash-chained audit logs with chain integrity verification, and optional Gemini security analysis (`GEMINI_API_KEY`).
  - **System, GitHub, Database & Files**: Live Worker/D1 health probes, maintenance jobs, GitHub REST API repository/PR/workflow/deployment inspection, D1 SQLite table/record inspector (26 tables), verified JSON logical backups with SHA-256 checksums, D1 inline file storage (750 KB free-tier asset limit), and workspace preferences.

## Quickstart (Local Zero-Cost Mode)

1. **Install dependencies**:
   ```bash
   npm install
   ```
2. **Optional environment configuration**:
   Copy `.env.example` to `.env` if you want to configure optional integrations (`GITHUB_TOKEN`, `GITHUB_DEFAULT_REPO`, `GEMINI_API_KEY`, `EMAIL_PROVIDER_URL`, `PUSH_PROVIDER_URL`). Core admin operations require zero external secrets.
3. **Run typecheck, tests, and production client build**:
   ```bash
   npm run lint
   npm test
   npm run build
   ```
4. **Start the local development server** (uses Node 22 `node:sqlite` backed `.data/aegis.sqlite` executing `migrations/0001_init.sql` via the exact Worker API handler):
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000`. On an empty `users` table, the console opens the **First-Time Super Admin Setup** workflow so you can create the initial `super_admin` account directly.

## Free-Tier Cloudflare Workers & D1 Deployment

1. Create your free D1 database:
   ```bash
   npx wrangler d1 create aegis-enterprise-db
   ```
2. Put the returned `database_id` into `wrangler.toml`.
3. Apply migrations & deploy to your free `*.workers.dev` subdomain:
   ```bash
   npx wrangler d1 migrations apply aegis-enterprise-db --remote
   npm run deploy:cloudflare
   ```
4. For automated GitHub Actions deployment and rollback, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in **GitHub Repository Settings -> Secrets and variables -> Actions**.

## Documentation

See [`docs/SYSTEM_DOCUMENTATION.md`](docs/SYSTEM_DOCUMENTATION.md) for architecture details, 26-table D1 schema reference, complete REST API documentation, security & RBAC design, backup/recovery procedures, GitHub CI/CD & rollback steps, and honest provider boundaries.
