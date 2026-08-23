# The gate: underwriting for agentic commerce on UPI rails

Razorpay AI Buildathon 2026, Track 01: AI Growth & Agentic Commerce

## What this is

Razorpay's agentic commerce runs today with Zomato, Swiggy, Zepto, Vi and BigBasket. Five brands, hand-picked, closed pilot. They are hand-picked because Razorpay can vouch for them.

Opening the same capability to a merchant Razorpay has never met means vouching at scale. Someone has to decide, on every money action, whether this agent should be allowed to spend this amount against this merchant's claims.

That decision layer is what I'm building. It returns allow, block, or escalate, with a reason code, on every agent transaction. Then it reports how often it was right, and how often it was wrong, and which attacks got past it. Merchant onboarding and a multi-tenant MCP catalog exist so the gate has something to decide about. They are the plumbing, not the point.

## Project summary

| | |
|---|---|
| Track | 01, AI Growth & Agentic Commerce |
| The product | The gate. A policy decision layer on every agent-initiated money action |
| The plumbing | Self-serve merchant onboarding and one multi-tenant MCP server |
| One-liner | Razorpay can't let an arbitrary merchant sell to AI agents because it can't vouch for them. This is the underwriting layer that makes self-serve safe, and it publishes its own rule coverage, its escapes, and what it costs a merchant when it's wrong. |
| The bar this targets | "Every money action explainable, bounded and gated. Show the audit trail and one failure handled gracefully." |
| Borrowed bar, Track 02 | "Honest metrics including false-positive cost." Supplied voluntarily. Track 01 doesn't ask for it. |

## The problem

This is an India and UPI problem. It is not a global one, and the pitch says so.

Globally, self-serve agent-transactability is solved. Shopify shipped UCP to general availability and self-serve on 17 June 2026. Every store gets an MCP endpoint automatically, with, in Shopify's words, "no approval committee." Their Agentic Plan extends the same infrastructure to non-Shopify brands at no monthly fee. Stripe's Agentic Commerce Suite, from 11 December 2025, is upload your catalog, pick your agents, and Stripe handles discovery, checkout and payments. Shoppable's Universal Checkout MCP, launched 12 May 2026, is multi-tenant catalog-to-MCP across 500M+ items, live on Claude.

Any pitch claiming nobody has solved this is wrong, and a Razorpay panel will say so in the first minute.

What nobody has solved is the same problem on UPI rails:

- Razorpay's official MCP server exposes about 45 tools across Payments, Payment Links, Orders, Refunds, QR Codes, Settlements, Payouts and Tokens. None of them are buyer-side. There is no product, catalog, cart, search, or inventory tool.
- Razorpay's agentic-payments product line ships three things: In-App Commerce in live beta, on LLMs, and Voice AI. All payments. No discovery or catalog anywhere.
- The launches with Zomato, Swiggy and Zepto at the India AI Impact Summit on 20 February 2026, plus superU AI, Vi and BigBasket, are bespoke integrations serving a closed pilot user set.

There is also a proof point that onboarding, not checkout, is the hard part. OpenAI retired Instant Checkout in March 2026, about six months after launch, because fewer than 15 of Shopify's millions of merchants ever went live. The protocol survived. The product died on merchant onboarding.

So the open question on UPI rails isn't "can an agent complete a checkout." It's this: on what basis would Razorpay let a merchant it has never met sell to an agent it has never met?

## The idea

Five pieces, in dependency order. Only the last two are the pitch.

1. Catalog normalization. CSV upload or a short form, into one product schema, whatever the merchant's source system. Deliberately dumb, so onboarding takes seconds.
2. One multi-tenant MCP server. The server reads `merchant_id` from the auth token per request and loads catalog and policy dynamically. Tool names stay identical across merchants, so a buyer agent that works with Merchant A works with Merchant B with no code change. This is competent engineering, not a differentiator. Per-request token verification with no server-side token storage is the documented standard pattern for multi-tenant MCP, and the doc says so.
3. Policy as config. Spend cap, category allowlist, approval threshold, one JSON object per merchant, read by one generic gate. Onboarding a merchant means filling a form, not writing gating code.
4. The gate. Every money action passes through one decision layer that returns allow, block, or escalate, plus a reason code, and writes an `AuditEvent` on every branch whether it passed or failed. Price and stock get re-read from the source of truth at decision time. What the agent cached at `list_products` is never trusted.
5. The measurement layer. The gate gets evaluated against a declared threat model over a held-out set of scripted sessions, benign and adversarial, reporting per-rule coverage as raw counts, escalation rate, the attacks that got through, and what the blocks cost a merchant in rupees.

### Who the merchant is, and what they need before they start

The merchant is already a Razorpay merchant. That is the whole addressable base and it is the point.

This does not onboard anyone to payments. Razorpay already did that, for millions of businesses that are activated, KYC-complete and taking money today. What none of them have is a way for an AI agent to discover and buy from them, because Razorpay's MCP server has no buyer-side tools at all. So this adds a capability to an existing account rather than asking anyone to migrate anything.

In production that means the merchant authorizes this platform through Partner OAuth, and every Order is created against their own Razorpay account via `X-Razorpay-Account`. The money lands with the merchant. This layer never holds it and never becomes a payment aggregator.

The build ships the logical-tenancy version instead, because Technology Partner status takes two to three weeks plus full KYC and the deadline is two weeks out. In the demo a merchant needs nothing: upload a CSV, set a policy, get a token. Orders are created under one test account with `notes.merchant_id` recording who they belong to. The trade-off table and the limitations section both say so, and so does the video.

### Why the gate is framed as ACP-aligned rather than novel

ACP's checkout spec, stable version 2026-04-17, already makes the merchant authoritative. Every `POST /checkout_sessions` and every session update returns the full cart state: items, pricing, taxes, fees, shipping, discounts, totals, status. The agent never transacts on a cached price. ACP also publishes a Product Feed Spec with `item_id`, `title`, `price`, `availability`, `is_eligible_search` and `is_eligible_checkout`, as gzipped JSONL, CSV or XML, refreshable every 15 minutes.

So the honest claim is that I'm implementing an established ACP-aligned invariant on Razorpay rails, because Razorpay has no catalog layer on which to enforce it. Same code. Defensible framing. And it shows I read the spec.

### Why the measurement layer is the differentiator

Track 01's bar is qualitative. It's the only one of the five tracks without a quantitative requirement. Tracks 02, 03 and 04 all demand measured evidence.

Razorpay's own agentic system, Bumblebee, is pitched entirely in numbers. Merchant evaluation under 90 seconds. Around 800 hours a month of manual review replaced. Detection accuracy from 88% to over 99%.

Supplying numbers nobody asked for, on the one track that doesn't ask, is cheap differentiation. And these particular numbers fit this particular track for a specific reason:

> A false positive in the gate is a legitimate purchase blocked, which costs the merchant a sale.

The track is called AI Growth & Agentic Commerce. The cost of over-blocking, in rupees, is the Track 02 honesty metric and the Track 01 growth metric at the same time. One number closing both halves. It costs a scripted session generator, not another subsystem.

The rest of this section is about not overclaiming with it, which is where a volunteered metric usually goes wrong.

## Deliverables and constraints

This isn't a hackathon. It's a student-only hiring funnel for a 6 or 12 month AI Builder Internship at ₹75,000 a month, in person in Bangalore from September. No fixed build window, no stage, no live demo.

Submission is a single Google Form. Among twelve required fields it collects Selected Track as a locked dropdown, Project Name, Project Objectives, a GitHub repository URL, a 5-minute pitch video link, and Build Challenges & Technical Obstacles. The final checkbox reads "I understand that no further changes or edits can be made after submitting." There is no separate later upload step. I don't touch the form until the build is done.

| | |
|---|---|
| Time | About 3 focused hours a day, solo, to a roughly 5 September deadline. 39 hours nominal. |
| Deadline confidence | 5 September comes from third-party sources only. It appears on no Razorpay-owned page. Build to it, treat the date as unconfirmed risk. |
| Stack | Bun, TypeScript, Next.js, SQLite |
| Payments | Razorpay test mode, which needs signup only and no KYC. Their docs: "The Test mode is available to you as soon as you complete the sign-up process." |
| Judged artifacts | Public repo, 5-minute video, architecture. Engineers read the repo on an unhurried timeline, so "we only had 48 hours" isn't available as an excuse. |

An adversarial schedule review put the full build at 51 hours against those 39. The cuts that close the gap are recorded in the scope section below, and the two that matter are that the evaluation suite runs on scripted transcripts rather than live agent sessions, and that both UIs ship deliberately ugly.

## System design

### Requirements

Functional. Merchant onboarding, catalog and policy, in seconds. One multi-tenant MCP server exposing `list_products`, `get_product`, `checkout` and `get_order_status`. A gate enforcing spend cap, category allowlist, approval threshold and price/stock integrity, returning allow, block or escalate with a reason code. A Claude-API buyer agent that shops within budget and handles a structured tool error without crashing. A queryable audit trail. Real Razorpay test-mode Orders. An evaluation suite producing per-rule coverage and cost figures over a held-out session set. One failure handled gracefully.

Non-functional. Gate decisions well under human-perceptible latency. The architecture has to generalize across merchants with no code change, because the pitch leans on that claim. Every gate decision has to be reconstructible after the fact from the audit log alone.

Constraints. Solo, roughly 39 hours, Razorpay test mode only, and the payment-authorization limit described below. That last one is imposed from outside, not a scoping choice.

### Architecture

```
Onboarding UI                    Buyer agent
(catalog CSV + policy)           (Claude API + MCP client)
      |                                |
      v                                v
Merchant service  ------------->  MCP server
(catalog + policy store)          (Streamable HTTP,
      ^                            merchant_id from bearer token)
      |                                |
      |                                v
      |                          ==================        Scripted
      |                          |   THE GATE     |<------ transcripts
      +--------- re-read ------->| allow / block  |        (eval suite,
        (price, stock,           |   / escalate   |         no live agent)
         authoritative)          ==================
                                   /      |      \
                                  v       v       v
                        Audit log    Razorpay    Metrics
                        (every       adapter     reporter
                         branch)     (Orders API,
                            |         allow branch     per-rule counts,
                            v         only)            escapes, blocked
                        Audit view       |             benign GMV,
                        + reason         v             recovery, net
                          codes      Razorpay test-mode API
```

The eval suite drives the gate directly with scripted transcripts. It does not go through the Claude agent. That keeps the metrics deterministic, reproducible by anyone who clones the repo, free of API spend, and independent of the riskiest component in the build.

### Data model

```
Merchant    { id, name, policy, created_at }
Policy      { spend_cap, category_allowlist, approval_threshold, window }
Product     { id, merchant_id, name, price, stock, category, updated_at }
Agent       { id, merchant_id, token_hash, created_at }
Session     { id, merchant_id, agent_id, started_at }
Order       { id, merchant_id, session_id, agent_id, items[], amount,
              status, razorpay_order_id }
AuditEvent  { id, merchant_id, session_id, agent_id, order_id?, action,
              amount?, rule, decision, reason_code, latency_ms, ts }
```

`merchant_id` is the tenancy key on every row.

`agent_id` is the enforcement key, and getting this wrong is the most obvious hole in a system like this. An earlier draft scoped the spend cap to `session_id`. That fails the same way a global cap fails: a global cap dies when the agent opens a new conversation, and a session-scoped cap dies when the agent opens a new session. Nothing stops it minting them. So the cap is enforced over `(merchant_id, agent_id, window)`, and `session_id` exists for audit grouping and display only.

The residual is worth stating rather than hiding: `agent_id` is only as trustworthy as the credential it comes from. This build issues one token per agent per merchant and derives `agent_id` from the token, so an agent cannot rename itself. It cannot stop a determined actor from registering as several agents, because nothing here verifies who an agent is. Agent identity is exactly the gap NPCI's Unified Agent Protocol is being written to fill, and the README says so.

### The gate

Runs on every `checkout` call, between the MCP tool handler and the Razorpay adapter. Checks are ordered so the cheapest and most often decisive run first, and so nothing reaches Razorpay unless it's going to be allowed.

1. Authoritative re-read. Fetch price and stock from the catalog at decision time and compare against what the agent asserts. Mismatch blocks with reason `STALE_CATALOG`. This is the ACP-aligned invariant. The agent never transacts on a cached number.
2. Spend cap. Cumulative order total for this `(merchant_id, agent_id)` pair over `policy.window`, against `policy.spend_cap`. Exceeded blocks with `SPEND_CAP_EXCEEDED`. Sessions do not reset this.
3. Category allowlist. Every line item's category against `policy.category_allowlist`. Violation blocks with `CATEGORY_NOT_ALLOWED`.
4. Approval threshold. Over `policy.approval_threshold` escalates with `PENDING_APPROVAL`. Razorpay never gets called.
5. Allow. Only now does the Razorpay adapter create the Order.

Every branch writes an `AuditEvent` carrying its rule, decision, reason code and latency, including the allow branch. The evaluation suite reads that log directly. It isn't a display feature bolted on afterwards.

Three outcomes, not two. Escalate is what keeps the gate honest. A system that turns every uncertain case into a block scores beautifully on catch rate and costs the merchant every sale it touches. So escalation rate gets reported next to everything else. A gate that escalates everything is as useless as one that blocks everything, and the numbers have to show it.

### The measurement layer, and what it does not prove

This is the differentiator, so it's the part most worth being careful about. Volunteered metrics that don't survive a question do more damage than no metrics at all.

**What gets generated.** A seeded generator produces session transcripts, which are JSON arrays of tool calls with asserted prices and quantities. Benign sessions are ordinary shopping within policy. Adversarial sessions each target a rule.

| Attack | What it probes |
|---|---|
| Budget-split evasion | Many small orders that clear the cap individually and breach it cumulatively, including across fresh sessions |
| Category laundering | Mislabeled or ambiguously categorized line items |
| Stale-price exploit | Agent replays a price cached from an earlier `list_products` |
| Threshold straddling | Repeated orders sitting just under the approval threshold |
| Merchant-side misclaim | Catalog advertises one price or stock level, checkout asserts another |

**Breaking the circularity, partly.** If I write the rules and I write the attacks, the attack set can only contain attacks I already thought of. Coverage measured over that set tells you the gate implements its spec. It tells you nothing about an adversary I didn't imagine. So the adversarial transcripts are generated by a separate Claude call whose context holds the MCP tool schema and the merchant's policy JSON and nothing else. It never sees the gate implementation. That is a genuinely different author, and anything it finds is a real finding rather than a scripted one.

It is a partial fix, not a solution, and the README says so in these words: *these numbers measure whether the gate correctly implements its stated policy against a declared threat model. They do not measure robustness against an attacker outside that model.*

**Hold-out discipline instead of a train/test split.** Hand-written rules have no fitted parameters, so there is nothing to overfit in the statistical sense and borrowing that vocabulary would imply a rigor this doesn't have. What the split actually controls for is me tuning thresholds after looking at failures. So: the split is frozen before any tuning, the training split is the only data I'm allowed to look at while tuning, and the held-out split runs exactly once at the end. Whatever it reports is what gets published. Running it twice with tuning in between means it was never held out, and the README states which of those happened.

**Counts, not percentages.** At 200 sessions split 70:30 benign to adversarial and 60:40 train to held-out, the held-out set carries roughly 24 adversarial sessions across five attack classes. That's about five per class, where a per-rule percentage has a confidence interval near ±35 points. So per-rule results are reported as raw integers, "4 of 5 caught," and percentages are reserved for pooled figures where the denominator reaches the dozens.

**Escapes first.** The report leads with the adversarial sessions that got through, named and described, before any aggregate. A non-empty escapes list is what makes every other number believable. If it comes back empty, the exercise proved nothing and the README says that instead.

**What over-blocking costs, stated so it survives interrogation.** The tempting version is "₹X of lost revenue," and it doesn't hold up: the order totals come from a price distribution I invented, blocked GMV isn't lost when the agent re-plans and substitutes, and merchant GMV, merchant margin and Razorpay's MDR are three different numbers. So the report gives three figures instead of one. Blocked benign GMV over the held-out benign population, at the seeded price distribution, labelled an upper bound. A recovery rate, meaning the fraction of blocked benign sessions that completed a substitute purchase after re-planning. And the net of the two. The seeded price distribution, mean order value and range, is published alongside so a reader can rescale it to their own assumptions.

### The payment loop, and why authorization is a human step

An agent cannot autonomously authorize a UPI payment. That's Indian payments regulation, not a gap in my implementation. It's the reason UPI Reserve Pay and NPCI's Unified Agent Protocol exist at all, and UAP is still in industry consultation pending RBI approval.

The verified constraints, which shape the design rather than getting worked around:

- Every server-to-server payment route on Razorpay is gated. S2S Redirect and S2S JSON v1 and v2 all require a support request to enable, and S2S generally requires PCI-DSS certification.
- UPI Collect, the server-side VPA flow, was deprecated on 28 February 2026 per NPCI. New integrations have to use UPI Intent.
- UPI Payment Links aren't supported in test mode. Smart Collect test payments only work from a Dashboard button. Standard Checkout in test mode requires clicking a mock bank page and entering an OTP in a browser.
- Auto-capture is the account default for Orders-API payments. Capture isn't the constraint. Authorization is.

So the loop closes like this. The agent shops, the gate decides, a real Order gets created through `POST /v1/orders`, and authorization is a bounded human approval step. That's the only currently legal shape, and the submission says so with the regulatory citation instead of staging an autonomy the law forbids. When Reserve Pay opens, the gate is the layer that was already sitting there.

Support tickets for S2S JSON v2 and BharatQR test activation go in on day one. If either lands, the loop upgrades. Neither is in the plan.

### Error handling, and the failure handled gracefully

The structured error envelope gets designed before the gate and before the agent, because both consume it and deferring it means paying for it twice. It returns as an MCP tool result with `isError`, never a thrown exception, and it carries `reason_code`, a human-readable message, and machine-readable fields: `item_id`, `true_stock`, `remaining_budget`, `cap`, `window`.

Primary case, stock-out mid-session. Stock drops between `list_products` and `checkout`. The gate blocks with `STALE_CATALOG` and the true stock. The buyer agent receives it as a normal tool result, re-plans within remaining budget, and substitutes another item. The audit log shows the block, the reason, and the successful retry as three linked events.

Secondary case, Razorpay 429. Razorpay documents a rate limiter but publishes no numbers, and advises watching for HTTP 429 with randomized exponential backoff. The adapter does exactly that. Retries cap at 1, and a persistent failure goes to the human rather than getting retried into the ground.

### Trade-offs

| Decision | Chose | Over | Because |
|---|---|---|---|
| Payment rail | Orders API | Payment Links | Payment Links cap at 30 per business in test mode, and they're a human-facing object an autonomous buyer agent has no business creating |
| Tenancy | One test account, `merchant_id` as logical tenancy, stated openly | Partner Auth OAuth with `X-Razorpay-Account` | Partner OAuth needs Technology Partner status. Everyone onboards as a Service Partner by default, and the type switch is manually reviewed over "around 2 to 3 weeks" plus full KYC. The deadline is about 2 weeks out. Partner Auth is the right production answer and the doc names it as such |
| Payment authorization | Human-approved handoff after a real Order | Playwright driving the hosted checkout | 6 to 10 hours to fake an autonomy NPCI doesn't currently permit. The honest version costs less and reads better |
| Eval input | Deterministic scripted transcripts | Live Claude agent sessions | Reproducible by anyone who clones the repo, runs in seconds, no API spend, and it decouples the differentiator from the riskiest component in the build |
| Cap scope | `(merchant_id, agent_id, window)` | `session_id` | A session-scoped cap dies the moment an agent opens a new session, which is the first adversarial class in the suite |
| Buyer agent | Custom Claude-API MCP client | Live inside Claude Desktop | Reasoning trace, tool calls and gate decisions can sit side by side in the video, and one hero session is all the video needs |
| Razorpay integration | Direct REST calls in the adapter | Passthrough Razorpay's own MCP server | Razorpay's MCP has no catalog tools, so passthrough was never an option. Direct calls also give control over error shaping and audit formatting |
| Storage | SQLite | Postgres | Single node, single writer, no durability requirement. A choice on the merits, not on a clock |
| Spend limits | App-level gate only | Gate plus UPI Reserve Pay | Reserve Pay has no public API reference and no test-mode sandbox. It's a closed pilot. Citing it as part of the build would mean claiming something unbuildable |

### Scope, and what gets cut first

Both UIs ship, deliberately ugly. The onboarding UI is one unstyled page: file input, four policy fields, submit. No CSV column-mapping preview, no component library. On video it's fifteen seconds, and fifteen seconds is all the "self-serve, takes seconds" claim needs. The audit view is a second route rendering a read-only `AuditEvent` table for one session. No filters, no pagination, no search. The bar is "show the audit trail," not "ship an admin console."

The evaluation suite is built before both of them. Last-scheduled is first-cut, and this is the one component whose absence changes what the project is. Without the metrics table this is a multi-tenant catalog MCP server, which is Razorpay's own listed example for Track 01 and therefore the crowded shape.

Cut order if the schedule slips: the audit view goes first, replaced by a `bun run audit --session=X` CLI printer, which next to a terminal agent trace arguably reads better on video anyway. Then the onboarding UI loses everything but the form. Then Razorpay fixture caching. Gate tests are last and reluctant, because untested gating logic contradicts the whole pitch.

Never cut, at any point: the gate with all three outcomes and an `AuditEvent` on every branch including allow, the metrics table with its escapes list and its honesty framing, one real `order_` id from `POST /v1/orders` visible on camera, the video, the README, and the two long-form form fields.

### Verified landscape

Recorded because the pitch depends on getting these right, and a Razorpay panel follows this space.

ACP, from OpenAI and Stripe, Apache 2.0, in beta, stable spec 2026-04-17. Covers checkout, delegate payment, cart, feed, orders, authentication and MCP. Merchant-authoritative by design.

UCP, from Google and Shopify, announced at NRF on 11 January 2026 with 20+ retailers, Apache 2.0. Transports include REST, GraphQL, JSON-RPC, A2A and MCP. Universal Cart spans Search, Gemini, YouTube Shopping and Gmail. The largest 2026 development in this space.

AP2, from Google. Payment authorization through cryptographically signed mandates. Not a catalog layer.

x402, from Coinbase and Cloudflare, under the Linux Foundation since April 2026. Machine-to-machine micropayments for API access, not a commerce catalog protocol. Around $28,000 in daily volume against a roughly $7B ecosystem valuation, and about half of that volume is gamified.

NPCI UAP, which is Unified Agent Protocol, not Unified Agentic Protocol. Agent registration, verification and authorization inside UPI. In consultation, not launched, pending RBI approval. It concerns agent identity, not catalog discoverability.

### Known limitations

Collected in one place, because a reader finding them scattered assumes I hid them.

- Agent identity is unauthenticated. A token binds `agent_id` so an agent can't rename itself mid-flight, but nothing stops one actor registering as several agents. This is the gap UAP is being written to fill.
- The threat model is mine. Adversarial sessions come from a model that never sees the gate implementation, which breaks the circularity partly. It does not make the attack set exhaustive.
- Cost figures rest on a price distribution I seeded. It's published so a reader can rescale it, and the blocked-GMV number is labelled an upper bound.
- Tenancy is logical, not Razorpay-native. Production would use Partner Auth with `X-Razorpay-Account`.
- Payment authorization is a human step because UPI regulation currently requires one.
- Catalog truth is asserted by the merchant at upload. The gate enforces internal consistency between what the catalog says and what checkout claims. It cannot detect a merchant who is wrong about their own stock.

### Out of scope, and what comes next

Left out deliberately: idempotency keys on Razorpay calls, webhook-driven order confirmation instead of polling, per-merchant rate limiting, live catalog sync replacing CSV, and Partner Auth tenancy.

If this continued past the submission, the next step is aligning the tool schema with UCP and ACP rather than only Razorpay's ecosystem, then swapping the human approval step for Reserve Pay mandates once UAP clears RBI. At that point the gate is the piece that was already in place.

## Why I'm the right person to build this

> **Placeholder.** This section needs Dharmin's actual background: prior MCP servers with links, any payments or multi-tenancy or rules-engine work, the tool-calling work and whether anyone used it, and any evidence of measuring his own systems rather than demoing them. Nothing invented. It belongs in the video's opening and the form's Project Objectives field; keeping it here as a closing section rather than an opening one, since a design doc that opens with a personal pitch reads oddly to an engineer browsing the repo.
