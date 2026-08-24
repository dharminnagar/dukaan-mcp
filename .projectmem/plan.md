# dukaan-mcp — plan

> Editable **intent** file: ideas + plans — what we *mean to do*.
> Issues live in Linear (team Dukaan-mcp, DUK-5..DUK-23). This file is the
> day-by-day shape; Linear holds the detail.

## The number that governs everything

Full build is **51 hours against 39 nominal** (13 days x 3hrs). Cuts applied
below bring it to ~40.5. Slack is ~1.5 hours, which is not slack. Miss two
days and there is no video.

## Schedule

- [x] **D1 (23 Aug)** — DUK-5 repo untangle + scaffold · DUK-6 Razorpay account + real `order_` id (**order_TTgT79PWPuu8Fh**, 24 Aug) · DUK-7 support tickets STILL OPEN
      *Exit: real order id in hand, project is its own repo, `bun run db:migrate` works*
- [ ] **D2 (24 Aug)** — DUK-8 error envelope + AuditEvent contracts · DUK-9 auth tokens + tenancy · DUK-10 CSV to Product + Policy validation
      *Exit: two merchants creatable from CSV, each with a token and a policy*
- [x] **D3 (25 Aug, done early on 24 Aug)** — DUK-11 seed two merchants · DUK-12 MCP server pt1 (Streamable HTTP + catalog tools). 80 tests pass across 9 files. Found DUK-28.
      *Exit: A's token returns A's catalog, B's returns B's*
- [ ] **D4 (26 Aug)** — DUK-13 MCP server pt2 (checkout, order status, transport hardening)
      *Exit: all four tools over HTTP with per-request tenancy. **Risk retired: transport***
- [ ] **D5 (27 Aug)** — DUK-14 the gate
      *Exit: every branch reachable, every branch writes an AuditEvent*
- [ ] **D6 (28 Aug)** — DUK-15 gate tests · DUK-16 Razorpay adapter
      *Exit: allow branch produces a real order id, tests green. **Risk retired: the gate***
- [ ] **D7 (29 Aug)** — DUK-17 buyer agent · **HARD GATE 21:00**
      *Exit: blocked, re-planned, substituted, succeeded — three linked AuditEvents*
      *Not working by 21:00? Switch to scripted transcripts tomorrow. Do NOT debug on D8.*
- [ ] **D8 (30 Aug)** — DUK-18 eval pt1: transcripts + adversarial generation, split frozen
- [ ] **D9 (31 Aug)** — DUK-19 eval pt2: metrics reporter, tuning on training split ONLY
      *Exit: real metrics table with a non-empty escapes list. **Risk retired: the differentiator***
- [ ] **D10 (1 Sept)** — DUK-20 held-out run (ONCE) + onboarding form + audit CLI printer · DUK-27 CSV column mapping + merchant confirm (DROPPABLE, starts only if D5-D9 landed on time)
- [ ] **D11 (2 Sept)** — DUK-21 README + architecture + video script
- [ ] **D12 (3 Sept)** — DUK-22 record + edit video
- [ ] **D13 (4 Sept)** — DUK-23 form narrative + submit (IRREVERSIBLE)

## Cuts already applied

- [x] Headless spike 4-6h down to 1.5h (research already done, issue #0005)
- [x] Eval runs on scripted transcripts, not live Claude sessions (-3h, and decouples the differentiator from the D7 risk)
- [x] Onboarding UI down to one unstyled page (-1.5h)
- [x] Audit view down to a read-only table, no filters (-1.5h)
- [x] Razorpay fixture caching where the allow branch allows it (-1h)
- [x] Audit view to a `bun run audit --session=X` CLI printer, decided up front instead of on slip (-45 min), to part-fund DUK-27

## Cut order if it slips

1. DUK-27 CSV column mapping — the DUK-10 exact-header path stays load-bearing, so dropping it costs a video beat, not a deliverable
2. Onboarding UI to form only
3. Gate tests 18 cases down to 10 — reluctant, contradicts the pitch

**Never cut:** the gate with three outcomes and an AuditEvent on every branch ·
the metrics table with its escapes list and honesty framing · one real `order_`
id on camera · the video · the README · the two long-form form fields.

## Open

- DUK-28 DEPRIORITISED by Dharmin 24 Aug to an end-if-time improvement. Acceptable ONLY because fix (a), the buyer agent sending a stable mcp-session-id header, moved into DUK-17 as a required acceptance criterion. If (b) never ships, the hosted endpoint's audit trail is ungroupable by session for any client we don't own — state that in the README limitations list rather than hiding it.
- DUK-7: Dharmin will raise the tickets himself. Verdict recorded: LOW importance. BharatQR is the only documented headless simulate-payment route, but a working headless authorisation would partly undercut the NPCI-regulation argument the pitch makes, and 2-3 weeks review against ~11 days means it will not land. Raise it for the Build Challenges paragraph, not the capability.
- DUK-6 is mis-statused: account and rzp_test_ key are done, but the smoke POST /v1/orders producing a real `order_` id has never run and scripts/smoke-razorpay.ts does not exist. That order id is on the never-cut list. ~15 min, needs Dharmin (external write with live test credentials).
- DUK-7 support tickets: 2-3 week stated review against a ~12 day deadline. Raise today or kill the line so it stops occupying a slot.
- DUK-25 fixed demo token has no mechanism: createMerchant mints agent id and token via CSPRNG, so both change on every reseed.
- "Why I'm the right fit" content — waiting on real background details from Dharmin. Nothing invented.
- Placement of that section (currently a closing section in IDEA.md, belongs in the video open + form).

## Someday / maybe

- Idempotency keys on Razorpay calls
- Webhook-driven order confirmation instead of polling
- Per-merchant rate limiting
- Live catalog sync replacing CSV
- Partner Auth tenancy (`X-Razorpay-Account`) once Technology Partner status clears
- Align tool schema with UCP + ACP
- Swap human approval for Reserve Pay mandates once UAP clears RBI
- Merchant-facing policy simulator: replay a merchant's audit history against a candidate policy and report benign sessions recovered next to attacks newly admitted. Considered 24 Aug alongside DUK-27, deferred because DUK-27 is cheaper and hits the Instant Checkout onboarding finding directly
- Multi-format catalog ingestion (images, PDFs, Excel, free-text paste) with a hand-labelled extraction accuracy eval. Rejected 24 Aug on cost: 6-9h out of D8-D10

## Shipped

- [x] **D3 done early (24 Aug)** — DUK-11 seed data + DUK-12 MCP catalog tools, via two parallel agents with disjoint file ownership. 80 tests pass across 9 files. Orchestrator verification found DUK-28, which the agents' own tests missed.
- [x] **DUK-6 closed (24 Aug)** — scripts/smoke-razorpay.ts run against the live test API: order_TTgT79PWPuu8Fh, 4999 paise, notes.merchant_id round-tripped. First video asset. Clears a never-cut item.
- [x] Interfaces frozen so concurrent units cannot invent seams: the gate never calls Razorpay (decide returns allow, DUK-13's handler calls the adapter), and the RazorpayAdapter.createOrder signature.

- [x] Hostile review of IDEA.md v1 — two research passes, every factual claim verified or refuted
- [x] Track locked: 01, gate-as-product, Track 02's measurement discipline grafted on
- [x] IDEA.md rewritten twice (reframe, then unslop + four architectural fixes)
- [x] Adversarial feasibility review — 51h vs 39h, four architectural defects found
- [x] 19 issues created in Linear (DUK-5..DUK-23)
