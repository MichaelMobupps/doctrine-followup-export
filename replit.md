# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)
- **AI**: Anthropic Claude via Replit AI Integrations
- **Gmail API**: googleapis (OAuth2)
- **Scheduling**: node-cron
- **Design System**: Dovah (see `attached_assets/DOVAH_DESIGN_SYSTEM_*.md`)

## Design System (Dovah)

- **Font**: Geist (display + body), Geist Mono (numbers/data/code)
- **Colors**: near-black backgrounds (`#0a0b0d` → `#1e2028`), single blue accent (`#3b82f6`), semantic colors only for data states
- **All colors use CSS variables** defined in `index.css` (e.g. `--bg-primary`, `--accent`, `--success-muted`)
- **No gradients, no shadows on cards, no emoji, no decorative elements**
- **Typography**: 20px page titles, 14px section headers, 13px body, 11px uppercase labels, 24px mono stat values
- **Spacing**: 4px grid, 20px card padding, 24px between cards, 32px between sections
- **Border radius**: 8px cards, 6px buttons/inputs, 4px badges
- **Motion**: 0.15s transitions, fadeUp on load, scale(0.98) on button press
- **Sidebar**: 220px fixed, `--bg-secondary` background, active item has right accent border

## Structure

```text
artifacts-monorepo/
├── artifacts/              # Deployable applications
│   ├── api-server/         # Express API server (Doctrine Follow-up backend)
│   └── dashboard/          # React + Vite web dashboard (Doctrine Follow-up UI)
├── addon/                  # Gmail Workspace Add-on (Google Apps Script) — deploy via clasp
├── lib/                    # Shared libraries
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-anthropic-ai/  # Anthropic AI client via Replit proxy
├── doctrine-integration/   # Drop-in module for Doctrine pipeline labeling
├── scripts/                # Utility scripts (single workspace package)
│   └── src/                # Individual .ts scripts
├── pnpm-workspace.yaml     # pnpm workspace
├── tsconfig.base.json      # Shared TS options
├── tsconfig.json           # Root TS project references
└── package.json            # Root package with hoisted devDeps
```

## Doctrine Follow-up System

### Architecture

The system has three components:

1. **API Server** (`artifacts/api-server/`) — Headless backend that handles:
   - Multi-user Gmail account management (OAuth connect/disconnect per user)
   - Syncing Doctrine-labeled emails from Gmail (cron every 15 min, per connected user)
   - Detecting replies and auto-cancelling queued follow-ups
   - Storing prospect state in PostgreSQL (via Drizzle ORM)
   - Generating follow-up emails via Claude Sonnet (Replit AI integration)
   - Sending follow-ups as threaded Gmail replies on randomized schedules
   - Per-user customizable follow-up timing and settings
   - Exposing REST API for the Gmail add-on and dashboard

2. **Dashboard** (`artifacts/dashboard/`) — React + Vite web UI:
   - Dashboard stats, Prospects, Follow-ups, Email Inspector pages
   - Accounts page: connect/disconnect Gmail accounts, configure per-account follow-up settings
   - API key auth gate (stored in localStorage)

3. **Gmail Add-on** (`addon/`) — Thin sidebar UI inside Gmail:
   - Homepage: stats dashboard, batch groups with "Queue all" buttons
   - Batch detail: prospect list with checkboxes, stage selector
   - Contextual view: shows prospect status when viewing a Doctrine email

### Database Schema

- `users` — Connected Gmail accounts with OAuth tokens, per-user follow-up settings (stage timing, send window, max followups, doctrine label, testMode, requireApproval)
- `prospects` — Synced emails from Gmail with prospect info (name, company, email, vertical, product); has `user_id` FK to `users`; `followup_paused` boolean for per-prospect campaign control
- `followups` — Scheduled follow-up stages (1-3) with status tracking (queued/generating/sent/failed/cancelled/pending_approval)

### Multi-User Architecture

- Users connect their Gmail accounts via OAuth from the dashboard Accounts page
- OAuth flow: `/api/gmail/auth` (nonce-based state) → Google consent → `/api/gmail/callback` (stores tokens in DB)
- Each user has their own refresh token, doctrine label, and follow-up timing settings
- Cron jobs iterate over all connected users for sync and processing
- Legacy fallback: if no connected users exist, falls back to env var `GOOGLE_REFRESH_TOKEN`/`SENDER_EMAIL`
- Per-user settings: follow-up stage timing (min/max days), send window (start/end hours), max followups, doctrine label

### API Endpoints

All under `/api/` prefix. Require `x-api-key` header matching `ADDON_API_KEY`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/stats` | Dashboard summary |
| GET | `/api/prospects` | Grouped prospects (?vertical=, ?replied=) |
| GET | `/api/prospect/by-thread/:threadId` | Single prospect by Gmail thread |
| POST | `/api/queue` | Queue follow-ups (uses per-user timing) |
| POST | `/api/queue-batch` | Queue all unreplied in a batch (uses per-user timing) |
| POST | `/api/sync` | Trigger Gmail sync |
| POST | `/api/process` | Trigger processing due follow-ups |
| GET | `/api/followups` | List follow-ups (?status=queued/sent) |
| POST | `/api/cancel` | Cancel follow-ups by ID |
| GET | `/api/campaign/status` | Get campaign status with per-user campaign breakdown (production + test) with actionable counts |
| POST | `/api/campaign/queue` | Queue next follow-ups for a specific campaign type (production/test) per user |
| POST | `/api/campaign/launch` | Launch test campaign (enable test mode, queue F1s) |
| POST | `/api/campaign/stop` | Stop campaign (cancel queued, disable test mode) |
| POST | `/api/prospect/:id/pause` | Pause follow-ups for a prospect (cancels queued) |
| POST | `/api/prospect/:id/resume` | Resume follow-ups for a prospect (queues next stage) |
| POST | `/api/followup-now/:prospectId` | Immediately trigger up to 3 follow-ups (30s apart) |
| POST | `/api/followups/:id/approve` | Approve & send a pending follow-up |
| POST | `/api/followups/:id/reject` | Reject (cancel) a pending follow-up |
| GET | `/api/gmail/sent-emails` | Inspect sent emails (?userId= for per-user) |
| GET | `/api/gmail/thread/:threadId` | View full email thread |
| GET | `/api/gmail/auth` | Start OAuth flow (?key= for auth) |
| GET | `/api/gmail/callback` | OAuth callback (nonce-validated) |
| GET | `/api/gmail/accounts` | List connected Gmail accounts |
| DELETE | `/api/gmail/accounts/:id` | Disconnect a Gmail account |
| PUT | `/api/gmail/accounts/:id/settings` | Update per-account follow-up settings |

### Cron Jobs

- `*/15 * * * *` — Gmail sync (iterates connected users, fetch new emails, detect replies)
- `5,20,35,50 * * * *` — Process due follow-ups (generate via Claude, send via user's Gmail)
- `*/3 * * * *` — Test-mode tick: processes due follow-ups + auto-queues next stages (3 min apart) for test-mode users

### Auto-Queue System

After each processing cycle, `autoQueueNextStages()` checks test-mode users' prospects:
- Finds prospects with sent follow-ups but no queued/generating/pending stages
- Auto-queues the next stage 3 minutes later (test mode timing)
- Stops at `max_followups` per user setting
- Only operates on unreplied prospects

### AI Follow-up Generation

- Draft: Claude Sonnet generates initial follow-up as JSON `{subject, body}`
- Critic: Claude Opus scores the draft (1-10 on multiple axes); `followup_ack < 4` forces rewrite
- Rewrite: Claude Sonnet rewrites if critic demands it
- Humanizer: Removes AI artifacts (em dashes, curly quotes, AI phrases)
- JSON parser: Extracts JSON from AI responses with fallback regex extraction and retry logic

### Vertical Classifier

- Pass 1: Label/subject keyword matching
- Pass 2: Weighted body-content scoring (gaming/CPS/retargeting signals with thresholds)
- Pass 3: Default `non_gaming_ua`

### Email Summarizer

Uses Claude to generate follow-up-safe context summaries of original emails, stored in `original_body_summary` field on prospects

### Required Environment Variables

- `GOOGLE_CLIENT_ID` — Google Cloud OAuth2 client ID
- `GOOGLE_CLIENT_SECRET` — Google Cloud OAuth2 client secret
- `SENDER_EMAIL` — Legacy fallback sender email (optional if users connected via OAuth)
- `SENDER_NAME` — Legacy fallback display name (optional if users connected via OAuth)
- `DOCTRINE_LABELS` — Legacy fallback Gmail labels (optional, per-user label in DB)
- `ADDON_API_KEY` — API key for authenticating all requests
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — Auto-set by Replit AI integration
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Auto-set by Replit AI integration

### Follow-up Stages (defaults, customizable per user)

| Stage | Default timing | Email angle |
|-------|---------------|-------------|
| 1     | 3–7 days      | New insight or data point |
| 2     | 10–14 days    | Competitor move or case study |
| 3     | 21–28 days    | Brief, direct, easy opt-out |

## TypeScript & Composite Projects

Every package extends `tsconfig.base.json` which sets `composite: true`. The root `tsconfig.json` lists all packages as project references.

- **Always typecheck from the root** — run `pnpm run typecheck`
- **`emitDeclarationOnly`** — we only emit `.d.ts` files during typecheck; actual JS bundling is handled by esbuild/tsx/vite
- **Project references** — when package A depends on package B, A's `tsconfig.json` must list B in its `references` array

## Root Scripts

- `pnpm run build` — runs `typecheck` first, then recursively runs `build` in all packages
- `pnpm run typecheck` — runs `tsc --build --emitDeclarationOnly` using project references

## Packages

### `artifacts/api-server` (`@workspace/api-server`)

Express 5 API server with Doctrine follow-up logic. Routes in `src/routes/`, services in `src/services/`.

- Entry: `src/index.ts` — reads `PORT`, starts Express, initializes cron jobs
- App setup: `src/app.ts` — mounts CORS, JSON/urlencoded parsing, routes at `/api`
- Routes: `src/routes/doctrine.ts` — follow-up API endpoints; `src/routes/gmail-auth.ts` — OAuth + accounts management; `src/routes/email-inspector.ts` — Gmail email inspector
- Services: `src/services/` — gmailClient, gmailSync, scheduler, followupGenerator, timingEngine, followupPrompts
- Cron: `src/cron.ts` — configures scheduled Gmail sync and follow-up processing
- Test dashboard: `public/index.html` — visual API tester at `/` (dev only)
- Scripts: `src/scripts/seed.ts` — populates DB with test prospects; `src/scripts/createLabels.ts` — creates Gmail labels
- Depends on: `@workspace/db`, `@workspace/api-zod`, `@workspace/integrations-anthropic-ai`

### `lib/db` (`@workspace/db`)

Database layer using Drizzle ORM with PostgreSQL.

- `src/schema/users.ts` — users table (connected Gmail accounts with OAuth tokens + per-user settings)
- `src/schema/prospects.ts` — prospects table (synced emails, FK to users)
- `src/schema/followups.ts` — follow-ups table (scheduled/sent stages)
- Push schema: `pnpm --filter @workspace/db run push`

### `lib/integrations-anthropic-ai` (`@workspace/integrations-anthropic-ai`)

Anthropic AI client configured via Replit AI Integrations proxy. No API key needed.

### `lib/api-spec` (`@workspace/api-spec`)

OpenAPI 3.1 spec and Orval codegen config. Run codegen: `pnpm --filter @workspace/api-spec run codegen`

### `artifacts/dashboard` (`@workspace/dashboard`)

React + Vite web dashboard for the Doctrine Follow-up system. Dark-themed professional UI.

- Entry: `src/App.tsx` — routes via Wouter (/, /prospects, /followups, /inspector, /accounts)
- Auth: API key stored in localStorage, shared via React context (`ApiKeyContextProvider`)
- Pages: dashboard (stats), prospects (groups + batch queuing), followups (list + cancel), email-inspector (Gmail detection), accounts (connect/disconnect Gmail + settings)
- Components: `src/components/layout.tsx` (sidebar navigation), `src/components/api-key-provider.tsx` (auth gate)
- Uses generated React Query hooks from `@workspace/api-client-react`
- All API calls include `x-api-key` header from stored API key
- Depends on: `@workspace/api-client-react`

### `addon/` (Gmail Add-on)

Google Apps Script files for the Gmail sidebar. Deploy via clasp. Set Script Properties:
- `BACKEND_URL` = your Replit app URL
- `API_KEY` = same as `ADDON_API_KEY`
