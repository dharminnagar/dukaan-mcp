# Architecture

This document explains the design in depth. Read the README first for what
the system does. This document explains why it is built this way, and what
was rejected along the way.

## The two processes

The system runs as two separate processes.

The MCP server (`src/mcp/http.ts`, Bun, port 8787 by default) speaks the MCP
protocol over HTTP. It holds the Razorpay keys. Buyer agents talk to it.

The Next app (`web/`, port 3000 by default) serves the merchant dashboard,
the buyer-facing pages, and the OAuth authorization server. It holds the
OpenRouter key, used only for the CSV column mapper during onboarding. It
never sees the Razorpay keys, and the MCP server never sees the OpenRouter
key. `setup/deploy.md` states this split and the reason to keep it: a leak of
one service's secrets does not leak the other's.

Both processes share one Postgres database and one connection pool shape
(`src/db/pool.ts`), but each process opens its own pool. `pool.ts` sets
`max: 10`, so two instances of each process use up to 40 connections. Small
managed Postgres tiers cap around 20 to 25, which is why `setup/deploy.md`
calls this out before a real deploy.

### Why the gate is a pure function

`decide()` in `src/gate/index.ts` never imports from `src/razorpay/` and
never makes a network call. It reads from a repo interface and writes to an
audit interface, both passed in as arguments. This one property is why
`src/eval/` can call the gate directly, against a real Postgres schema. The
eval needs no HTTP server, no live payment call, and no non-determinism.
Every number in the README's measurement section rests on this. If the gate
ever imported Razorpay, the eval would need network access and API spend to
run. Its numbers would then stop being reproducible from a clone with no
key.

The gate does not read `src/config.ts` either. The platform's spend ceiling
is passed in as `platformCeilingPaise`, an optional argument, rather than
read from the environment inside `decide()`. A config import inside the gate
would make its verdict depend on ambient state a caller cannot vary, which
breaks the same reproducibility property.

## Tenancy

Every request resolves to a `(merchant_id, agent_id)` pair before any tool
runs. `src/auth/resolve.ts` reads the bearer token from the Authorization
header, hashes it, and looks up the matching agent row. No tool argument
ever supplies a merchant id or agent id. A caller cannot claim a different
tenant by passing a different id in the request body, because no code path
reads one from there.

`createMcpHandler` (from `@modelcontextprotocol/server`) runs its factory
function once per request. The factory receives `{ authInfo, requestInfo }`.
`authInfo` looks like a natural place to carry the resolved tenant, but it
is strictly pass-through. The SDK never populates it from headers and
performs no token verification of its own. This was checked directly
against the SDK's own type declarations before this design was chosen. So
the only route to the token is the raw header, read from `requestInfo`
inside the factory. That is exactly why the factory runs per request rather
than once at server start.

Auth is resolved twice per request. `fetchMcp` resolves it first, so a
missing or bad token returns a real HTTP 401 before the MCP protocol
starts. The factory itself has no way to return an HTTP response of its
own. The factory then resolves the token again. A per-request `TenantRepo`,
scoped to that resolved tenant, can only be built inside the factory, where
the tool handlers can close over it. The second resolution
is cheap and deliberate. The alternative, passing resolved state from
`fetchMcp` into the factory through shared mutable state, is not safe under
concurrent requests. It was rejected for that reason.

`TenantRepo`'s constructor takes the resolved context as an argument. Every
query it exposes is scoped by that context. A query that reads across
merchants cannot be written by accident, because the class holds no method
that takes a merchant id as a parameter.

## The data model

Four migrations, applied in order. `src/db/migrate.ts` records a SHA-256 of
each applied file and refuses to run if a previously applied file changed.
So nobody edits an applied migration's wording after the fact. A new
numbered file is the only way to change behavior.

**`merchants`**: one row per merchant. `id` is checked against
`^m_[a-z0-9_]{1,48}$` at the database, not only in application code.

**`policies`**: one row per merchant, holding `spend_cap_paise`,
`approval_threshold_paise`, `category_allowlist`, and `window_seconds`. A
check constraint requires the approval threshold to be reachable: it cannot
exceed the spend cap. Migration 0003 adds `merchant_total_cap_paise`,
nullable, the merchant-wide aggregate cap described in the README.

**`products`**: one row per (merchant, sku). `price_paise` and `stock` are
the values the gate's authoritative re-read compares an agent's assertion
against.

**`agents`**: one row per issued token. `token_hash` stores a SHA-256 of the
raw token. The raw token itself is never stored anywhere. Migration 0002
adds `buyer_cap_paise`, nullable, written once at mint time and never
updated by any code path in this repository. Migration 0003 adds
`buyer_id`, nullable, which is null for a merchant-minted agent and set for
a buyer-minted one.

**`buyers`**: added in migration 0003. Buyer email and an argon2id password
hash, via `Bun.password.hash`.

**`sessions`**: groups tool calls for display and audit reading. `agent_id`
and `session_id` look similar but serve different jobs. The spend cap never
reads `session_id`. An earlier draft of this project scoped the cap to
`session_id`, which let an agent reset its own budget by opening a new
session. That defect is recorded in the project's own issue log. The
comment above `SPEND_CAP_SQL` in `src/db/repo.ts` names it directly so it
is not repeated.

**`orders`**: written on allow and on escalate, never on block, since a
blocked checkout never becomes an order. A check constraint,
`order_escalated_never_reached_razorpay`, forces `razorpay_order_id` to be
null whenever `status = 'escalated'`. So an escalated order cannot carry
evidence of a Razorpay call that never happened.

**`audit_events`**: append-only, and deliberately carries no foreign keys.
A merchant can be deleted. Its audit trail must not cascade away with it.
This is stated directly in the migration's own comment, with an
instruction not to "fix" it later.

**`oauth_clients`, `oauth_auth_codes`**: added in migration 0004, covered
under OAuth below.

### The partial unique index worth explaining

`idx_agents_buyer_merchant` is a unique index on `(buyer_id, merchant_id)`,
but only `WHERE buyer_id IS NOT NULL`. Without the `WHERE` clause, every
merchant-minted agent (whose `buyer_id` is null) would collide with every
other one under Postgres's null-handling rules. That is not the constraint
this index is for.

What it does enforce: one buyer cannot hold two agents at one merchant. If
a buyer could, they would have two spend caps at that store instead of one.
That would double their own budget without the merchant or the platform
knowing. This also makes the buyer's "connect to this store" action
naturally idempotent. A second click returns the existing agent rather
than minting a second one. `provisionAgentForBuyer` catches the resulting
SQLSTATE 23505 and raises `AlreadyConnectedError`, which the caller shows
as a normal outcome, not a database failure.

## The audit log

Every audit row records four actions (`list_products`, `get_product`,
`checkout`, `get_order_status`), six rules (`AUTHORITATIVE_REREAD`,
`SPEND_CAP`, `CATEGORY_ALLOWLIST`, `APPROVAL_THRESHOLD`, `ALLOW`, `AUTH`),
and eight reason codes (`ALLOWED`, `STALE_CATALOG`, `SPEND_CAP_EXCEEDED`,
`CATEGORY_NOT_ALLOWED`, `PENDING_APPROVAL`, `RAZORPAY_ERROR`,
`UNAUTHENTICATED`, `INVALID_REQUEST`), each enforced by a database check
constraint, not only by application types. The claim this system makes is
that every money action is reconstructible from this log alone.

That claim did not always hold. Before a fix recorded at commit `53880e7`,
the allow branch audited `order_id: null`. The caller minted its own
order id separately and never wrote it back to the audit row. The audit row
and the order row disagreed on which order they described, on the one path
where money actually moves. The fix has the gate itself mint the order id,
on both the allow branch and the escalate branch. It hands that id back to
the caller, so the audit row and the order row always agree.

A related case: a Razorpay-side failure after an allow decision. The audit
schema's `rule` column has no `RAZORPAY` member, and a check constraint,
`audit_allow_implies_allowed`, forces `decision != 'allow'` whenever
`reason_code` is not `ALLOWED`. So a Razorpay failure is audited as
`rule: 'ALLOW'`, `decision: 'block'`, `reason_code: 'RAZORPAY_ERROR'`. This
reuses the rule under which the gate had already allowed the order, rather
than adding a schema member for one failure path. It matches the precedent
the gate itself sets for `INVALID_REQUEST` under `AUTHORITATIVE_REREAD`.

## Concurrency

`decide()` reads the agent's spend total, compares it to the cap, and
returns a verdict. Writing the resulting order is a separate statement, done
by the caller after the gate returns. Two concurrent checkouts from the same
agent can both call `decide()` before either one writes its order. Both read
the same pre-write spend total. Both can pass a cap that the two orders
together break. This was verified directly: three concurrent
decide-then-insert pairs put 150,000 paise behind a 100,000 paise cap.

The fix is a Postgres advisory lock, `withAdvisoryLock` in `src/db/pool.ts`,
scoped to the key `${merchant_id}:${agent_id}`. The MCP checkout handler
wraps the gate call and the order insert inside this one lock. The lock uses
`pg_advisory_xact_lock`, held on a transaction, not a session. Postgres
releases it automatically at commit, rollback, or connection loss, with
nothing for the caller to remember to release by hand.

The lock is scoped per agent, not globally. Two different agents, or two
different merchants, never contend with each other. Only one agent's own
concurrent checkouts serialize behind each other, including behind the
Razorpay network call on the allow path. That call stays inside the lock
deliberately. Releasing the lock after `decide()` and re-acquiring it before
the order write would still leave a window. A second concurrent checkout
could then read the same stale spend total, just a smaller one. The gate
itself stays lock-free and pure. The lock lives in the MCP handler, one
layer up, so `src/eval/` keeps running with no lock, no transaction, and no
server. Anything else that acts on an `allow` verdict must serialize itself
the same way. `src/eval/` does this by replaying its transcripts one at a
time, never in parallel.

## OAuth

Migration 0004 adds an OAuth 2.1 authorization layer onto the agent-token
system that already existed. It introduces no new credential format. The
access token this flow returns is the exact `dk_...` agent token that
`provisionAgentForBuyer` already mints, so `src/auth/resolve.ts` needs no
second validation path. A second path would risk drifting from the gate's
own checks over time; there is only one path, so there is nothing to drift.

The Next app plays two roles that OAuth keeps distinct. It is the
**authorization server**: it exposes `/oauth/authorize`, a consent screen,
and `/api/oauth/token`. It is separately the **resource server**'s
discovery document. The MCP server exposes
`/.well-known/oauth-protected-resource` (RFC 9728). This lets a client that
receives a 401 discover the authorization server without being told its
URL out of band. The MCP server remains the actual resource server; the
Next app never validates a bearer token itself.

Every registered client is a public client under RFC 6749: an agent with no
secure place to hold a `client_secret`. There is no `client_secret` column
in `oauth_clients` at all. PKCE (RFC 7636, S256 only) stands in for it.
Possession of `code_verifier` is what proves continuity between
`/authorize` and `/token`, not a secret baked in at registration. The
database schema only allows the value `'S256'` for `code_challenge_method`.
So the weaker `plain` method is not merely rejected by application code, it
cannot exist as a stored row at all.

The authorization code itself is stored as a SHA-256 hash, mirroring
`agents.token_hash`, so a database read cannot redeem someone else's code.
`consumed_at` is a nullable timestamp, not a boolean: `/token` checks and
marks it in one atomic `UPDATE ... WHERE consumed_at IS NULL`, so two
concurrent redemption attempts, one legitimate and one a replay, cannot both
see the code as unconsumed.

The token endpoint supports one grant: `authorization_code`. There is no
refresh grant. The access token this system issues has no distinct
lifecycle from the agent token it is drawn from: no refresh, no separate
expiry check. This is a stated limitation, not an oversight, and it is
repeated in the README.

## Trade-offs

**Postgres over SQLite.** Both services deploy live, and SQLite on an
ephemeral hosting filesystem does not survive a redeploy. Postgres also
gives real `TEXT[]`, `JSONB`, `TIMESTAMPTZ`, and `INCLUDE` covering indexes,
used directly in `idx_orders_spend_cap`. The cost: every database call in
this codebase is async, and running this locally needs Docker.

**Deterministic scripted transcripts over live LLM agent sessions for the
eval.** A scripted transcript is reproducible by anyone who clones the repo,
runs in seconds, costs no API spend, and decouples the project's
differentiator, the gate, from the riskiest part of the build, a live agent
loop. The cost is that the corpus is a declared threat model, not a claim
about every attack an agent in the wild might attempt. This is stated
directly in the README's measurement section.

**Cap scope of `(merchant_id, agent_id, window)` over `session_id`.** A cap
scoped to a session dies the moment an agent opens a new session, which
would be the easiest evasion in the whole threat model. This is covered
above under Sessions.

**One test Razorpay account, `merchant_id` as logical tenancy, over Partner
Auth OAuth with `X-Razorpay-Account`.** Partner Auth needs Technology
Partner status, which needs manual review over roughly two to three weeks
plus full KYC. Partner Auth is the correct production design, and this
project's own planning documents name it as such, but it did not fit this
project's timeline. Every merchant here shares one underlying Razorpay test
account; tenancy is enforced entirely at this application's own layer, not
by Razorpay.

**A Postgres advisory lock over a database-level serializable transaction
for the spend cap.** The lock is scoped to exactly the resource that needs
serializing, one agent's checkouts, so unrelated agents and merchants never
contend. A broader isolation level would serialize work that has no reason
to wait on itself.

**No refresh grant for OAuth.** Building refresh token rotation and revocation
correctly is a meaningfully larger surface than this project's timeline
allowed, and an access token with no refresh degrades safely: it simply
stops working and the buyer reconnects, rather than failing in a way that
silently keeps working past when it should.
