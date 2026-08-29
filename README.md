# dukaan-mcp

A multi-tenant MCP server with in-built auth layer and audit capabilities for Razorpay's AI Buildathon 2026 (Track 01).

NOTE: The architecture and design of this project is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). This README focuses on the gate, its threat model, and its measurement.

## What this is

A merchant uploads a catalog and a spend policy. A buyer connects their own
AI agent to the merchant's store over MCP. Every checkout the agent attempts
passes through the gate. The gate returns allow, block, or escalate, with a
reason code. The gate writes an audit row on every branch. The gate is the
product. The catalog and the MCP server exist so the gate has something to
decide about.

## The problem

An AI agent can already place an order. Nothing stands between the agent and
the merchant's payment API to check whether that order is safe.

The dangerous case is not always a hacked agent. It is also a well-behaved agent that might
trust stale data. It reads a product price, holds that price in its context
for a few turns, and checks out against a price the merchant already
changed. Or it buys inside a category the buyer never approved, because the
category label on the product looks close enough. Or it has no budget bound
at all, because nobody ever set one for it. None of these need an attacker.
They only need a normal agent and a policy nobody enforced.

## The Gate

The gate is one function, `decide()` in [`src/gate/index.ts`](src/gate/index.ts). It runs five
checks in order. Each check can stop the request. Nothing after a failed
check runs.

1. **Authoritative re-read.** The gate re-reads the catalog at decision
   time and compares it to what the agent asserted. The gate checks price
   per line item, because the same product can appear twice in one order
   with two different asserted prices. The gate also checks stock per
   product, summed across all line items in the order. Two line items for
   the same product can each look fine alone and still oversell the
   product together. A mismatch returns `STALE_CATALOG` and blocks the
   order before it touches money.
2. **Spend cap.** The buyer, the merchant, and the platform can each set a
   spend cap. The gate compares the order to the tightest of the three. A
   breach returns `SPEND_CAP_EXCEEDED` with all three cap figures and the
   window they cover. See the next section for why three parties, not one.
3. **Category allowlist.** Each product has a category. Each agent has a
   policy that names the categories it may buy from. A product outside that
   list returns `CATEGORY_NOT_ALLOWED`.
4. **Approval threshold.** An order above the merchant's threshold does not
   block. It returns `PENDING_APPROVAL` and waits for merchant sign-off.
5. **Allow.** The order clears every check above. The gate mints an order id,
   writes an `ALLOWED` audit row, and hands the order back to the caller,
   which then calls Razorpay.

The gate never imports Razorpay and never makes a network call. It is a pure
function of its inputs. This is why `src/eval/` can run the gate directly,
against a real Postgres schema, with no server and no live payment call.
Every number in the measurement section below comes from that property.

Atomicity is not the gate's job. Two concurrent checkouts from the same
agent can both read the same pre-write spend total. Both can then pass a cap
that neither one individually breaks. The MCP checkout handler fixes this
with a Postgres advisory lock around the gate call and the order write
together, scoped per merchant and agent. See `docs/ARCHITECTURE.md` for the
mechanism and the test that catches a regression here.

## Who owns which limit

The spend cap used to be one number, set by the merchant alone. That is a real
number a merchant wants, an exposure limit, but it is not a buyer protection.
The merchant profits when that number is loose, so "the agent cannot
overspend" rested on the goodwill of the party being restrained. And realistically the merchant would always keep the number high to blocking any order and keeping to increase their revenue. The buyer has no control over that number, and the merchant has no incentive to keep it low. That is why the gate now reads three numbers and enforces the tightest one.

Three parties now each set a number, and the tightest one binds:

- **The buyer** sets a cap when their agent is minted. Nothing in the code
  raises it after that point.
- **The merchant** sets the existing policy cap. Unchanged from before.
- **The platform** sets a ceiling on what any merchant may set for itself,
  from deployment config.

For this MVP, the merchant still mints the agent token, so the merchant
currently sets the buyer's cap too. Moving that choice to the buyer only
changes who calls the gate, not the gate itself. The gate already reads
whichever cap the token carries and enforces the tightest one. That is
future work, not done work. This README says so plainly rather than
implying the buyer already controls it.

There is also a merchant-wide aggregate cap, separate from the per-agent cap
above. Once buyers mint their own agents, one merchant can have many agents,
each with the full per-agent cap. With N agents, the merchant's real
exposure becomes N times the cap, and the cap stops being an exposure limit
at all. The aggregate cap bounds the sum across every agent of one merchant.
A partial unique index also stops one buyer from holding two agents at one
merchant, which would otherwise double that buyer's own cap silently. See
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the constraint and the query it supports.

## Quickstart

Every command below was run against a fresh checkout of this repo.

```bash
git clone <this repo> && cd dukaan-mcp
bun install
cp .env.example .env          # fill in RAZORPAY_KEY_ID/SECRET only if you plan to run smoke:rzp
bun run db:up                 # Postgres 17 in Docker, waits for its healthcheck
bun run db:migrate            # applies migrations/0001 through 0004
bun test tests/               # 368 pass, 0 fail
bun run typecheck             # tsc --noEmit, no output on success
bun run lint                  # eslint . && prettier --check .
```

None of the commands above need `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
`OPENROUTER_API_KEY`, or `OPENROUTER_MODEL`.

For demo, there are two ways tests can run.

1.  Use a fake Razorpay adapter. The gate never calls Razorpay itself here
2.  Use a real Razorpay account & adapter in smoke tests. This requires a Razorpay account and key pair set in `.env`

Seed a merchant and try the gate against it.

```bash
bun run seed:merchant -- --merchant-id=m_x --name="X" --csv=fixtures/merchant-a.csv --policy=fixtures/merchant-a.policy.json
bun run mcp:dev                # MCP server on :8787
```

Point an MCP client at `http://127.0.0.1:8787/mcp` with the printed bearer
token to call `list_products`, `get_product`, `checkout`, and
`get_order_status`.

Run the merchant dashboard and the buyer-facing onboarding pages.

```bash
bun run web:dev                # Next app on :3000, needs the database and, for
                                # the CSV column mapper, an OPENROUTER_API_KEY
```

Full deployment steps are in [`setup/deploy.md`](setup/deploy.md). They
cover the two services' disjoint secrets and a warning you should read
before putting the dashboard on a public URL.

## Measurement

Run it yourself:

```bash
bun run eval           # replays 261 frozen transcripts, prints catch rate by class and split
bun run eval:report    # scores the train split (155 transcripts) and prints the full report below
```

Both commands run with no API keys set and no network call. They read a
fixture already committed at `fixtures/eval/transcripts.json`.

**This measures rule coverage over a declared threat model, not precision or
recall.** The gate is hand-written thresholds and allowlists with no fitted
parameters. Precision and recall describe a model checked against a
population it was fit to. That vocabulary would claim a kind of rigor this
system does not have. `bun run eval:report` refuses those words in its own
output. This README refuses them too.

On the train split, every declared class is fully caught:

| Threat class          | Rule that should catch it | Caught   |
| --------------------- | ------------------------- | -------- |
| benign (should allow) | ALLOW                     | 99 of 99 |
| budget_split          | SPEND_CAP                 | 9 of 9   |
| category_laundering   | CATEGORY_ALLOWLIST        | 9 of 9   |
| merchant_misclaim     | AUTHORITATIVE_REREAD      | 7 of 7   |
| stale_price           | AUTHORITATIVE_REREAD      | 11 of 11 |
| threshold_straddling  | APPROVAL_THRESHOLD        | 8 of 8   |

A clean sweep proves little on its own. 35 of these adversarial transcripts
were hand-written by whoever wrote the gate's rules. A rule catching its own
author's attacks mostly proves the two agree. 9 of them came from a
different source: a separate model. That model saw only the MCP tool
contracts, the published policy, and the catalog, and never the gate's
code. The gate caught all 9 of those too. That is the one number here that
a self-authored suite cannot produce by construction.

**That independent batch cannot be regenerated.** The model that authored
it, recorded under the OpenRouter slug `stealth/ox-alpha`, was an anonymous
preview whose testing period has since ended. The slug now returns HTTP 404.
It requested 67 transcripts back and kept 41 after validation against the
real catalog. Any transcript that asserted a total above the published
approval threshold while labelled benign was rejected. A few other shapes
were rejected too, for a 39% rejection rate overall. That is a point in the
method's favor, not a flaw. The transcripts were checked against the real
catalog rather than trusted, so a rejected transcript would otherwise have
counted as a false positive. The gate never actually made that. Because the
authoring model is gone, that batch is committed as a fixture rather than
generated on demand. Every number above still reproduces from that fixture
with no key and no network call.

Three limits bound how far that independent batch actually reaches. It
never asserted a quantity above available stock, so the `merchant_misclaim`
class stays entirely self-authored. Every generated transcript is a single
checkout step. So its `budget_split` and `threshold_straddling` cases test
one oversized order, not the multi-step evasion those class names describe.
And the independent model produced no attack shape the hand-written batch
did not already have.

**No false-positive rate is reported, because none is measurable from this
corpus.** Zero benign sessions were blocked across 164 benign checkout
steps. 82 of those steps were built deliberately close to a policy limit.
Each was just under a cap, at exactly the stock on hand, or in a category
easy to confuse with a disallowed one. A zero here means the gate declined
every close call it was given, not that no close call existed.
`bun run eval:report` prints `NOT MEASURABLE` rather than assuming zero
recovery from an empty set.

**Interrupted legitimate intent is measured separately, and it is not a
gate error.** Twelve sessions here are a real shopper stopped by a correct
policy decision: a genuine category exclusion, a real stock shortfall, a
real over-threshold order. The gate was right in every one of them.
Together they stopped ₹2,60,231.00 of asserted checkout value. One session
made up 85% of that total, so the median, ₹1,299.00, is the representative
figure, and the total is only an upper bound. Nine of the twelve sessions
went on to complete a substitute purchase. The three that did not sum to
₹12,153.00 in value that did not convert.

**Rule coverage for the platform ceiling has no eval coverage.** The eval
harness builds its gate dependencies from a frozen path that predates the
ceiling, so the ceiling never enters a replayed transcript. That is why the
numbers above did not move when the three-party cap landed. It is a
consequence of that change, not a gap it introduced. The ceiling itself is
untested by this suite.

**The held-out split's rule coverage has been observed throughout
development, and the full metrics report over it has not.** `bun run eval`
replays both splits and prints a catch-rate table for each. That table has
been run many times while building this. What has not run is
`bun run eval:report --split=holdout`, the full report scored over the
held-out split. That report carries the GMV, interrupted-intent, recovery,
and net figures above. It happens exactly once. The reason a held-out
split means anything here is checkable, not just promised. Every gate
change in this project was verified against a byte-identical
`bun run eval` output, compared to a stored baseline. So the held-out
numbers never moved, and so they never drove a change to the gate.

## Limitations

- **The held-out split has not been scored with the full metrics report.**
  See above.
- **The merchant dashboard has no access control.** Its route is
  `/dashboard/<merchant_id>`, with no session and no login. A merchant id
  guessed from a shop name is enough to read that merchant's revenue, order
  count, and every gate decision. `setup/deploy.md` gives three ways to
  close this before a public deploy. None of them is done by default.
- **OAuth gives discoverability, not token lifecycle.** A buyer's agent can
  discover the authorization server and register itself, but the resulting
  access token has no refresh and no distinct expiry path from the agent
  token it is minted from.
- **The merchant still mints the buyer's cap.** See "Who owns which limit"
  above. The mechanism enforces whichever cap is tightest. Only the party
  who sets the buyer's number is not yet the buyer.
- **The eval remains a declared threat model.** An attack neither the gate's
  author nor the independent model imagined is still unmeasured, by
  construction.
- **The platform ceiling has no eval coverage.** See above.

## Architecture

`docs/ARCHITECTURE.md` covers the two processes and why they stay separate,
the data model table by table, the audit log's reconstructibility claim, the
concurrency fix for the spend cap, the OAuth design, and the trade-offs taken
along the way.
