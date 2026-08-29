# Deploying the three components

Three deployables, each of which can go up on its own:

| Component | What it is | Port | Needs |
| --- | --- | --- | --- |
| Database | Postgres 17 | 5432 | nothing |
| MCP server | `src/mcp/http.ts`, Bun | 8787 | database, Razorpay keys |
| Frontend | `web/`, Next 15 | 3000 | database, OpenRouter key, the MCP server's public URL |

The two services need **disjoint secrets**, which is worth preserving: the MCP
server holds the Razorpay keys and never sees the OpenRouter key; the frontend
holds the OpenRouter key and never sees the Razorpay keys. Nothing about the
deployment needs to break that, so don't.

Deploy in the order above. Each section ends with a check you can run before
moving on.

---

## Read this before deploying the frontend

**The dashboard has no access control, and merchant ids are guessable.** The
route is `/dashboard/<merchant_id>`, there is no session, and the id is derived
from the shop name: "Verma Provisions" becomes `m_verma_provisions`. Anyone who
guesses a shop name reads that merchant's revenue, order count, spend against
cap, and every gate decision.

That is documented as an accepted gap for a local demo. It is **not** acceptable
on a public URL with real merchant data on it. Pick one before you deploy.

- **Deploy the frontend but not publicly.** Keep it on localhost or a private
  network and record the demo from there. Cheapest, and loses nothing for the
  video.
- **Put the whole frontend behind edge auth.** Basic auth or an access policy at
  the platform layer, one config entry on most hosts. Protects onboarding too,
  which is fine because only you use it.
- **Deploy it public with synthetic merchants only.** Defensible for a judged
  demo, as long as no real shop's data is in that database, and as long as the
  README says so rather than leaving a reader to discover it.

Do not paper over it with an unguessable id or a token in the query string. A
check that looks like security without being any is worse than the honest hole,
because it invites trusting it.

**Also**: `.env.example` used to list `ANTHROPIC_API_KEY`, left over from
before this project moved to OpenRouter. Nothing read it, and the line is now
gone, so a fresh clone no longer invites filling in a key that does nothing.

---

## 1. Database

Any managed Postgres 17 works. Nothing in the schema is exotic: one `BIGINT`
money column per table, a `TEXT[]`, two `JSONB` columns, and check constraints.

### Locally

```bash
bun run db:up          # docker compose, waits for healthcheck
bun run db:migrate
```

### Managed

Create the instance, then point `DATABASE_URL` at it and run migrations from
your machine:

```bash
DATABASE_URL='postgresql://user:pass@host:5432/dukaan?sslmode=require' \
  bun run db:migrate
```

Three things to get right:

**TLS.** Managed providers require it and reject plaintext. `pg` reads
`sslmode` from the connection string, so `?sslmode=require` is usually all you
need. The local compose URL uses `?sslmode=disable`; don't copy that forward.

**Migrations are checksum-locked.** `src/db/migrate.ts` records a SHA-256 of
each applied file and refuses to run if a previously-applied file has changed.
This is deliberate. Never edit an applied migration to fix wording, add a new
numbered one instead. If `db:migrate` complains about a checksum mismatch, the file was
edited after it ran, and reverting the edit is the fix.

**Connection budget.** `src/db/pool.ts` opens a pool with `max: 10` per process,
and both services use it. Two instances of each is 40 connections. Small managed
tiers cap around 20-25, so either raise the tier or lower `max`. Exhaustion shows
up as requests hanging rather than erroring, which is a miserable thing to debug
under demo pressure.

### Check

```bash
bun run db:migrate     # second run should report nothing to apply
```

Optionally seed something to look at:

```bash
bun run seed:demo
```

---

## 2. MCP server

A single Bun process serving `/mcp` and `/health`. Stateless per request.
The SDK handler's factory runs once per request and tenancy comes from the
bearer token every time, so horizontal scaling needs no session affinity.

### Environment

```
DATABASE_URL=postgresql://...?sslmode=require   # required
RAZORPAY_KEY_ID=rzp_test_...                    # required for checkout
RAZORPAY_KEY_SECRET=...                         # required for checkout
PORT=8787                                       # optional, defaults to 8787
PLATFORM_SPEND_CEILING_PAISE=10000000           # optional, no ceiling if unset
```

`RAZORPAY_*` are not read at boot, only when a checkout actually calls Razorpay.
That is on purpose so `db:migrate` and `bun run eval` work on a clone with no
Razorpay account. It also means a missing key surfaces as a failed checkout
rather than a failed deploy, so check it explicitly after deploying.

`PLATFORM_SPEND_CEILING_PAISE` is in **paise**, digits only. `2500` is ₹25.00,
not ₹2,500. A value with a decimal point is rejected at boot rather than
truncated. This is precisely so a rupee figure typed here fails loudly
instead of becoming a plausible wrong ceiling.

### Run

```bash
bun install --production
bun run src/mcp/http.ts
```

Bun binds all interfaces by default, so this works in a container as-is. The
startup line prints `http://127.0.0.1:8787/mcp`, which is cosmetic. It is not
the bind address.

### Container

The web workspace imports from `src/`, so **the build context must be the
repository root** for both services, not the subdirectory.

```dockerfile
# Dockerfile.mcp, build from the repo root
FROM oven/bun:1.3.6-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY migrations ./migrations
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/mcp/http.ts"]
```

Point the platform's health check at `/health`, which returns `ok` without
touching the database. If you would rather a failing database marked the
instance unhealthy, that endpoint would need to run a query first; today it does
not.

### Check

```bash
curl -s https://<mcp-host>/health                      # -> ok

curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://<mcp-host>/mcp \
  -H 'authorization: Bearer dk_not_a_real_token' \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'   # -> 401
```

A 401 on a bogus token is the check that matters: it proves the auth gate is in
front of the handler and the database is reachable enough to fail the lookup.
With a real token the same call returns the four tools.

Then confirm Razorpay wiring, which the above does not touch:

```bash
bun run smoke:rzp      # against the deployed env
```

It refuses to run unless the key starts with `rzp_test_`. The Razorpay base URL
is identical for test and live, so that prefix is the only guard against
charging real money. Do not weaken it.

---

## 3. Frontend

Next 15, server-rendered. Two routes: onboarding at `/` and the dashboard at
`/dashboard/[merchantId]`.

### Environment

```
DATABASE_URL=postgresql://...?sslmode=require
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=nvidia/nemotron-3-nano-30b-a3b
MCP_PUBLIC_URL=https://<mcp-host>/mcp
```

**`MCP_PUBLIC_URL` is the one that will bite you.** The success screen hands the
merchant an endpoint to paste into their agent, and without this it composes one
from `MCP_HOST`/`MCP_PORT`, defaulting to `http://127.0.0.1:8787/mcp`. Deployed,
that is a dead address and the single value the whole onboarding flow exists to
produce is useless. Set it to the MCP server's public URL, including `/mcp`.

Never set `PORT` expecting it to mean the MCP server's port. Inside Next, `PORT`
is Next's own. A test asserts no code here reads it.

**Next only reads `web/.env.local`**, never the repository root `.env`. On a
platform you set these as environment variables and no file is involved. If
you deploy from a VM by hand, the file has to be at `web/.env.local` and it has
to carry `DATABASE_URL` too. The onboarding action reaches `src/onboard/`,
which pulls the pool, which requires it at module load. A missing
`DATABASE_URL` there surfaces as a 500 on the mapping step, which touches no
database. That is a confusing hour if you don't know it.

`OPENROUTER_API_KEY` is optional in the sense that the app degrades rather than
breaks. With no key, column mapping falls back to exact-header matching, so a
canonical `sku,name,price,stock,category` CSV still onboards and a Shopify
export proposes nothing. Set it, or the mapping step in the demo does nothing
visible.

### Build and run

```bash
rm -rf web/.next        # do not skip this
bun install
bun run web:build
cd web && bun run start
```

Two failure modes I hit doing exactly this:

**`rm -rf web/.next` is not superstition.** Building while a dev server is
running mixes dev and production artifacts, and the production server then dies
on `Cannot find module './879.js'` from `webpack-runtime.js`. Every route 500s
or 404s while the build log said success. A clean directory fixes it. In CI you
get this for free; from a working machine you do not.

**Use the package script, not `bunx next start`.** Under this workspace's
isolated `node_modules` layout, `bunx` fails to resolve the Next CLI and throws
`MODULE_NOT_FOUND` naming `next/dist/bin/next`. `bun run start` from `web/`
works. Pass a port with `PORT=3100 bun run start` if 3000 is taken.

### Container

```dockerfile
# Dockerfile.web, build from the repo root, because web/ imports src/
FROM oven/bun:1.3.6-alpine AS build
WORKDIR /app
COPY package.json bun.lock ./
COPY web/package.json ./web/
RUN bun install --frozen-lockfile
COPY src ./src
COPY web ./web
RUN cd web && bun run build

FROM oven/bun:1.3.6-alpine
WORKDIR /app
COPY --from=build /app ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["sh", "-c", "cd web && bun run start"]
```

Copying the whole build stage keeps `node_modules` and `src/` alongside the
build output, which the server needs at runtime. `next.config.ts` marks `pg` as
a server-external package, so it is required at runtime rather than bundled.
This is also why it must still be installed in the final image.

### Check

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://<web-host>/
curl -s -o /dev/null -w '%{http_code}\n' https://<web-host>/dashboard/m_does_not_exist   # -> 404
```

Then onboard a merchant through the UI and confirm the success screen shows your
real MCP URL rather than `127.0.0.1`. That is the check worth doing by eye.

Verified locally against a production build: `/` returns 200, a known merchant's
dashboard returns 200, and an unknown one returns 404. Neither `pg` nor
`csv-parse` nor the OpenRouter key appears anywhere in the build output,
including the server chunks. The key is read at runtime, not baked in.

---

## Wiring check, once all three are up

Onboard a merchant through the frontend, then use the token it gave you:

```bash
TOKEN=dk_...   # from the success screen, shown once

curl -s -X POST https://<mcp-host>/mcp \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"list_products","arguments":{}}}'
```

That single call proves the whole chain: the frontend wrote to the database, the
token it minted authenticates against a different process, and that process
reads the catalog the CSV became. Then load the dashboard and confirm the
decision appears.

If you set a buyer cap during onboarding, a checkout above it blocks with
`bound_by: "buyer"` even when the merchant's cap is looser. That is the demo
beat worth rehearsing.

---

## Things that will not work the way you expect

**Error messages disappear in production.** Server actions throw plain `Error`s,
and a production Next build replaces the message with a digest before it reaches
the browser. Dev shows the real text; deployed, the merchant sees something
generic. The fix is returning typed results instead of throwing, which changes a
contract the tests encode, so it is deliberately not done yet. Until then, read
the server logs for the real reason.

**A repeated merchant name is handled; other collisions are not.** Onboarding a
shop whose name already exists gives a clear message naming the collision. Other
constraint violations still surface as raw Postgres errors.

**The platform ceiling has no eval coverage.** It is inert inside `bun run eval`
because the harness builds gate dependencies in a frozen file. That is why the
eval numbers did not move when three-party limits landed. It is a property of
the change rather than a hole in it. But it means the ceiling is only exercised
by the unit tests and by production traffic.

**`bun run eval` needs no network and no keys.** If a deployment step seems to
want them for the eval, something is wrong: generation is split from scoring, and
scoring reads a committed fixture.
