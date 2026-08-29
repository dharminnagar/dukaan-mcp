# Project Map - dukaan-mcp

## Project purpose

A multi-tenant MCP server for the Razorpay AI Buildathon 2026 (Track 01). A
merchant uploads a catalog and a spend policy. A buyer connects their own AI
agent over MCP. Every money action passes through a policy gate. The gate
returns allow, block or escalate with a reason code. It writes an audit row on
every branch. It reports its own rule coverage. The gate is the product. The
catalog and the MCP server exist so the gate has something to decide about.

## Status, 2026-08-29

The gate is written and tested. 368 tests pass across 20 files. Postgres must be
running for the suite. If tests fail in bulk with connection errors, run
`bun run db:up` before looking for anything else. That has happened twice.

Done: the gate, the Razorpay adapter, the eval harness, the merchant onboarding
UI, the merchant dashboard, buyer registration and self-service provisioning,
three-party spend limits, a merchant-wide aggregate cap, and OAuth 2.1.

Open: the one scored held-out run (DUK-20), the video (DUK-22), the submission
form (DUK-23), deployment (DUK-25, in backlog).

`bun test`, `bun run typecheck` and `bun run lint` are three separate gates.
`bun test` does NOT typecheck. A green suite once hid a broken tree for hours.

## Structure

- `README.md` - the front door. The gate's five checks, who owns which limit,
  the quickstart, the measurement framing, and the limitations.
- `IDEA.md` - the design doc. Problem framing, competitive landscape,
  trade-off table.
- `docs/ARCHITECTURE.md` - the deeper read. Two processes, tenancy, the data
  model, concurrency, OAuth.
- `docs/CLAIMS.md` - what this project may and may not claim, with the correct
  weaker wording for every tempting claim. Read it before writing anything for
  the submission.
- `setup/deploy.md` - deploying the three components, each with a check.
- `TESTING.md` - how to run and read the suite.
- `CLAUDE.md` - project instructions. Mandates projectmem for AI sessions.
- `docker-compose.yml` - Postgres 17 on host port 5433.
- `package.json` - the root Bun workspace. `web/` is the second workspace.

### Migrations

- `0001_init.sql` - seven domain tables and indexes. `audit_events` has no
  foreign keys on purpose.
- `0002_buyer_cap.sql` - `agents.buyer_cap_paise`, nullable. NULL means the
  buyer set no cap.
- `0003_buyers_and_merchant_total_cap.sql` - `buyers`, `buyer_sessions`,
  `agents.buyer_id`, and `policies.merchant_total_cap_paise`. The unique index
  on `(buyer_id, merchant_id)` is PARTIAL, so merchant-minted rows with a NULL
  `buyer_id` are unaffected.
- `0004_oauth.sql` - `oauth_clients` and `oauth_auth_codes`. The code challenge
  method is written as the literal `'S256'`, so `plain` cannot be stored.

Migrations are checksum-locked. Never edit an applied file. Add a new one.

### The gate

- `src/gate/index.ts` - `decide()`. Five ordered checks: authoritative re-read,
  spend cap, category allowlist, approval threshold, allow. A pure function of
  its dependencies. It never imports Razorpay and never makes a network call.
  That property is why the eval can drive it offline.
- `src/gate/limits.ts` - `effectiveCap()` takes the tightest of the buyer,
  merchant and platform caps. `exceedsMerchantTotalCap()` bounds the sum across
  every agent of one merchant. `CapParty` is the three caps that reduce to a
  minimum. `BindingParty` adds `merchant_total`, which is measured against a
  different total.

### Core

- `src/shared/contracts.ts` - the single source of truth. Reason codes, the
  tool-error envelope, `AuditEvent`, domain row types, `TenantContext`,
  `GateOutcome`. It imports nothing from `src/`.
- `src/config.ts` - environment reading. `PLATFORM_SPEND_CEILING_PAISE` is
  optional and rejects a decimal point rather than truncating it.
- `src/db/pool.ts` - the one shared `pg` Pool. Sets the INT8 parser, so BIGINT
  paise return as numbers. Also holds `withAdvisoryLock`.
- `src/db/migrate.ts` - the migration runner. Checksum guard and advisory lock.
- `src/db/repo.ts` - `TenantRepo`. The constructor takes the resolved context,
  so a query without `WHERE merchant_id` cannot be written by accident. Holds
  both the per-agent and the merchant-wide spend queries.
- `src/auth/token.ts` - mint, hash, compare. Raw tokens are never stored.
- `src/auth/resolve.ts` - bearer header to `TenantContext`. Its 401 carries
  `resource_metadata`, which is what lets an MCP client discover OAuth.
- `src/audit/write.ts` - the only module that inserts into `audit_events`.
- `src/catalog/csv.ts` - CSV to `Product`. `rupeesToPaise` uses integer string
  maths, never floats.
- `src/catalog/policy.ts` - policy and window parsing.
- `src/onboard/create-merchant.ts` - merchant, policy, products and one agent in
  a single transaction.
- `src/mcp/http.ts` - the MCP server on `Bun.serve`. Four tools:
  `list_products`, `get_product`, `checkout`, `get_order_status`. Serves
  `/health` and `/.well-known/oauth-protected-resource`. The checkout handler
  wraps `decide()` and the order write in one advisory lock.
- `src/razorpay/index.ts` - the Orders API adapter.

### Buyers and OAuth

- `src/buyer/auth.ts` - registration, login, sessions. Passwords hash through
  `Bun.password`. Session tokens are stored as a SHA-256 only.
- `src/buyer/provision.ts` - `provisionAgentForBuyer` mints one agent for one
  buyer at one merchant. It rejects a blank `buyerId`, because the uniqueness
  index is partial and a NULL would bypass it.
- `src/oauth/clients.ts` - dynamic client registration. Redirect URIs match
  exactly.
- `src/oauth/codes.ts` - authorization codes. Stored hashed, single use, short
  lived. Consuming happens before verification, so a wrong PKCE verifier burns
  the code.
- `src/oauth/urls.ts` - URL helpers with no config import, so a Next route can
  import them safely.

### The eval

`src/eval/` drives the gate directly with scripted transcripts. It bypasses MCP,
so the numbers need no live agent, no network and no API key.

- `run.ts` - `bun run eval`. Replays the whole dataset. Prints catch rates by
  class AND split, so it shows held-out rows.
- `report.ts` - `bun run eval:report`. Train split only by default. The held-out
  split is scored once, at DUK-20.
- `dataset.ts` - the frozen split. `benign.ts`, `hand-attacks.ts` and
  `interrupted.ts` build transcripts. `llm-generate.ts` made the independent
  batch through one live call and wrote a committed fixture.
- `metrics.ts`, `runner.ts`, `transcript.ts`, `prng.ts`, `provision.ts`,
  `catalog-snapshot.ts`, `llm-prompt.ts`, `llm-source.ts` support those.

### The web workspace

Next 15 on port 3000. The MCP server is a separate process on 8787.

- `web/app/page.tsx` - merchant onboarding. Step 1 is upload and column
  mapping. Step 2 is the policy. Step 3 shows the token once.
- `web/app/actions.ts` - `startMapping` and `onboard`.
- `web/app/dashboard/[merchantId]/page.tsx` - revenue, agents registered,
  merchant-wide exposure, and every gate decision. No access control, by
  accepted decision.
- `web/app/buyer/` - buyer login and the merchant directory with a connect
  action.
- `web/app/oauth/authorize/` - the consent screen.
- `web/app/api/oauth/register` and `web/app/api/oauth/token` - the OAuth
  endpoints. `web/app/.well-known/oauth-authorization-server` serves metadata.
- `web/lib/mapping.ts` - CSV parsing. Server only, because it imports
  `csv-parse`. `web/lib/mapping-types.ts` is the client-safe half.
- `web/lib/dashboard-queries.ts`, `web/lib/buyer-queries.ts`,
  `web/lib/buyer-actions.ts` - read and write paths for the two UIs.

### Support

- `scripts/` - `seed-merchant.ts`, `seed-demo.ts`, `audit-print.ts`,
  `smoke-razorpay.ts`, `verify-mcp.ts`, `spike-client.ts`.
- `fixtures/` - two 25-row demo catalogs with their policies, plus
  `shopify-export.csv` for the column mapper, `no-category-column.csv` for the
  fixed-category path, and `no-sku-column.csv`. `fixtures/eval/` holds the
  frozen corpus.
- `tests/` - 368 tests across 20 files, mirroring `src/`.
- `.projectmem/` - decisions, issues and the event log. It ships publicly and is
  evidence for the submission.

## Relationships

- Everything imports `src/shared/contracts.ts`. It imports nothing back.
- `src/gate/index.ts` calls `repo` for the authoritative re-read and both spend
  totals, then `src/audit/write.ts` on every branch. It never calls Razorpay.
- `src/mcp/http.ts` calls `src/auth/resolve.ts`, then `decide()`, then
  `insertOrder`, then `src/razorpay/index.ts` on allow only. The advisory lock
  encloses the first three.
- `src/eval/` calls `decide()` directly and never starts a server.
- `web/app/actions.ts` and `web/lib/buyer-actions.ts` import from `src/`, which
  pulls `src/config.ts` at module load. A missing `DATABASE_URL` therefore shows
  as an unrelated 500.
- OAuth issues a normal agent token. `web/app/api/oauth/token` returns what
  `provisionAgentForBuyer` mints, so `src/mcp/http.ts` validates it with no
  second code path.

## Maintenance note

`summary.md` regenerates from `events.jsonl`. This file does not. `pjm map`
prints it and `pjm map --build` writes a separate cache, so nothing rebuilds
this document. Update it by hand when the structure changes, and record the
update with `pjm note` so the edit is in the log.
