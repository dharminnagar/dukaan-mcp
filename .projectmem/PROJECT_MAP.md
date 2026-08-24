# Project Map - dukaan-mcp

## Project purpose
A multi-tenant MCP server for the Razorpay AI Buildathon 2026 (Track 01). Any Razorpay merchant uploads a catalogue and a spend policy, and third-party AI buyer agents then shop and check out against it through one stable set of tools. Every money action passes through a policy gate that returns allow, block or escalate with a reason code, writes an audit row on every branch, and reports its own rule coverage and false-positive cost. The gate is the product; the catalogue and the MCP server exist so the gate has something to decide about.

Status 2026-08-24: Day 1 and Day 2 complete. 58 tests pass. The gate itself is not written yet (DUK-14).

## Structure

- `IDEA.md` - the design doc. Problem framing, competitive landscape, system design, trade-offs, known limitations.
- `CLAUDE.md` - project instructions. Mandates projectmem for all AI sessions.
- `docker-compose.yml` - Postgres 17 on host port 5433. Named volume, healthcheck.
- `package.json` - one root Bun package. `web/` workspace arrives with DUK-20.
- `setup/razorpay-setup.html` - interactive Razorpay account setup checklist.

- `migrations/`
  - `migrations/0001_init.sql` - seven domain tables plus indexes. `idx_orders_spend_cap` is the covering index the gate depends on. `audit_events` has no foreign keys on purpose.

- `src/shared/`
  - `src/shared/contracts.ts` - the single source of truth. Reason-code union, discriminated tool-error envelope, `AuditEvent`, all domain row types, `TenantContext`, `GateOutcome`. Everything imports this; it imports nothing from `src/`.

- `src/db/`
  - `src/db/pool.ts` - the one shared `pg` Pool. Also sets the INT8 type parser so BIGINT paise return as numbers.
  - `src/db/migrate.ts` - migration runner. Checksum guard, advisory lock, owns the transaction.
  - `src/db/repo.ts` - `TenantRepo`. Constructor takes the resolved context, so a query without `WHERE merchant_id` cannot be written by accident. Holds the spend-cap query.

- `src/auth/`
  - `src/auth/token.ts` - mint, hash, compare. Raw tokens are never stored.
  - `src/auth/resolve.ts` - bearer header to `TenantContext`, or an `UNAUTHENTICATED` envelope.

- `src/audit/`
  - `src/audit/write.ts` - the only module allowed to insert into `audit_events`.

- `src/catalog/`
  - `src/catalog/csv.ts` - CSV to `Product`. `rupeesToPaise` uses integer string maths, never floats.
  - `src/catalog/policy.ts` - policy parsing and window parsing. Reuses the `Policy` schema from contracts.

- `src/onboard/`
  - `src/onboard/create-merchant.ts` - merchant, policy, products and one agent token in a single transaction. Validates before opening it.

- `src/mcp/`
  - `src/mcp/http.ts` - the MCP server on `Bun.serve`. `createMcpHandler` runs its factory per request; the bearer header is read from `ctx.requestInfo`. Currently the spike `whoami` tool only.

- `src/gate/` - empty. DUK-14.
- `src/razorpay/` - empty. DUK-16.
- `src/eval/` - empty. DUK-18 and DUK-19.

- `scripts/`
  - `scripts/seed-merchant.ts` - create a merchant from a CSV and a policy file. Prints the raw token once.
  - `scripts/spike-client.ts` - MCP client proving per-request auth. Seed of the DUK-17 buyer agent.

- `fixtures/` - a 5-row smoke catalogue and its policy. The real 25-SKU catalogues are DUK-11.
- `tests/` - 58 tests across 7 files, mirroring `src/`.
- `.projectmem/` - decisions, issues and the event log. Ships publicly; it is evidence for the submission form.

## Relationships
- Everything imports `src/shared/contracts.ts`; it imports nothing back.
- `src/db/repo.ts`, `src/audit/write.ts` and `src/onboard/create-merchant.ts` all use the single Pool from `src/db/pool.ts`.
- `src/mcp/http.ts` will call `src/auth/resolve.ts`, then the gate, then `src/db/repo.ts`.
- `src/gate/` (when written) calls `src/db/repo.ts` for the authoritative re-read and the spend total, then `src/audit/write.ts` on every branch, then `src/razorpay/` on allow only.
- `src/eval/` will drive the gate directly with scripted transcripts, bypassing MCP, so the metrics run without a live agent.
- `src/onboard/create-merchant.ts` imports `mintAgentToken` from `src/auth/token.ts`; it writes raw SQL rather than using `TenantRepo`, because onboarding runs before a tenant exists.
