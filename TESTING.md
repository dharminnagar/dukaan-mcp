# TESTING

Verification checklist. Run top to bottom.

## 0. Prerequisites

```bash
docker compose ps  # dukaan-postgres ... Up (healthy) ... 0.0.0.0:5433->5432/tcp
```

If it's not there: `bun run db:up` then `bun run db:migrate` (prints
`= 0001_init.sql` / `migrations: up to date`). `.env` must exist (`cp
.env.example .env`, fill in `RAZORPAY_KEY_ID`/`SECRET`, `OPENROUTER_API_KEY`
for sections 8/10).

## 1. The gate

```bash
bun run typecheck  # tsc --noEmit, no output means pass
bun run lint       # eslint . && prettier --check ., prints "All matched files use Prettier code style!"
bun run test       # bun test tests/, 371 pass, 0 fail, 2205 expect() calls, 20 files
```

Red output is self-explanatory. Read the assertion.

## 2. Independence check, the important one

This step proves the committed LLM-generation prompt never saw the gate's own
logic. That is what makes the `origin: "llm"` eval half count as
independent, not self-graded.

```bash
grep -nE 'SPEND_CAP|spentInWindowPaise|AUTHORITATIVE_REREAD|decide\(|CATEGORY_ALLOWLIST|approval_threshold_paise' fixtures/eval/llm-generation-prompt.md
echo "exit=$?"   # no output, exit=1
```

Any match, or exit `0`, voids the independence claim. Stop and investigate.

## 3. Seed data

```bash
bun run seed:merchant -- --merchant-id=m_x --name="X" --csv=fixtures/merchant-a.csv --policy=fixtures/merchant-a.policy.json
bun run seed:demo
```

**Do not run `seed:demo` casually**. It deletes and recreates `m_demo_kirana`
and `m_demo_electronics`, cascading through policies, products, agents,
sessions, and orders (`audit_events` has no FK, so it survives). It also
mints a fresh agent token that silently breaks any connector using the old
one. On recording day: seed first, record, and do not reseed until footage
is captured. This has already cost real demo data once. Not run here;
demo merchants and a live server are already up.

## 4. MCP server and cross-tenant check

```bash
bun run mcp:dev  # bun --watch src/mcp/http.ts, listens on :8787. EADDRINUSE means one is already running; reuse it
bun run verify:mcp
# PASS: real MCP client round-tripped both tools under two different merchant tokens
```

This seeds two throwaway merchants, confirms `get_product` returns `null`
for a SKU belonging to the other tenant, and cleans both up itself. Anything
other than `PASS` means tenancy is leaking.

## 5. Eval, generation determinism

```bash
shasum -a 256 fixtures/eval/transcripts.json
bun run eval:generate
shasum -a 256 fixtures/eval/transcripts.json   # must be identical
```

Identical means the committed corpus is exactly what the generator produces
today. A mismatch means the fixture on disk is stale relative to the code.
That happened once, when the split key changed to `(origin, class)` and the
fixture was never regenerated. It left a committed split of 144/97 against a
generated 143/98. `bun run test` now catches that: `tests/eval.test.ts` has
"the COMMITTED fixture matches what the generator currently produces". If it
goes red, run `bun run eval:generate` and commit the result deliberately,
since the split is meant to be frozen. DUK-20 scores the held-out half
exactly once.

## 6. Eval, the report

```bash
bun run eval:report  # ~1s locally, replays the train split (143 transcripts) against the real gate
```

It reads: escapes first, per-class "N of M" counts (never a percentage),
then allow/block/escalate share, cost figures, price distribution, and a
scope disclaimer. Use `--split=holdout` only once, at real DUK-20 scoring.
It warns loudly.

## 7. Audit printer

```bash
bun run audit  # no filter -> usage, not a table (exit 0)
bun run audit --merchant=m_demo_kirana --limit=5   # real filter -> a colored table, newest first
bun run audit --session=<id from the table above>  # confirm block -> re-plan -> success groups in order
```

## 8. Not run: money, live API, minutes

```bash
bun run smoke:rzp          # creates a REAL Razorpay test-mode order; not idempotent, run deliberately
bun run eval:generate:llm  # live OpenRouter call, several minutes; only needed to re-freeze the LLM eval half
```

## 9. Browser pieces (`setup/`), open directly, no server needed

- `setup/razorpay-setup.html`: enabling Razorpay test mode and getting API keys.
- `setup/bharatqr-setup.html`: BharatQR / S2S JSON v2 support-request checklist.
- `setup/complete-payment.html`: drives a real test-mode payment to completion.

## 10. Live and manual flow: third-party client over a tunnel

```bash
bun run mcp:dev
ngrok http 8787
```

Point a real MCP client (Claude Desktop, or anything speaking Streamable
HTTP + bearer auth) at `https://<ngrok-id>.ngrok-free.app/mcp` with
`Authorization: Bearer <agent token>`. Make a few tool calls within 30
minutes (`list_products`, `get_product`, a rule-tripping `checkout`, then a
successful one). Then run `bun run audit --agent=<agent id>` and confirm
every call lands under one `session_id`, reading as one shopping session,
not one row per call. Calls over 30 minutes apart
(`SESSION_REUSE_WINDOW_SECONDS`, `src/auth/resolve.ts`) start a new session
by design.
