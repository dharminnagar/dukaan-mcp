# dukaan-mcp — plan

> Editable **intent** file: ideas + plans — what we *mean to do*.
> Issues live in Linear (team Dukaan-mcp, DUK-5..DUK-23). This file is the
> day-by-day shape; Linear holds the detail.

## The number that governs everything

Full build is **51 hours against 39 nominal** (13 days x 3hrs). Cuts applied
below bring it to ~40.5. Slack is ~1.5 hours, which is not slack. Miss two
days and there is no video.

## Schedule

- [ ] **D1 (23 Aug)** — DUK-5 repo untangle + scaffold · DUK-6 Razorpay account + real `order_` id · DUK-7 support tickets
      *Exit: real order id in hand, project is its own repo, `bun run db:migrate` works*
- [ ] **D2 (24 Aug)** — DUK-8 error envelope + AuditEvent contracts · DUK-9 auth tokens + tenancy · DUK-10 CSV to Product + Policy validation
      *Exit: two merchants creatable from CSV, each with a token and a policy*
- [ ] **D3 (25 Aug)** — DUK-11 seed two merchants · DUK-12 MCP server pt1 (Streamable HTTP + catalog tools)
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
- [ ] **D10 (1 Sept)** — DUK-20 held-out run (ONCE) + both UIs
- [ ] **D11 (2 Sept)** — DUK-21 README + architecture + video script
- [ ] **D12 (3 Sept)** — DUK-22 record + edit video
- [ ] **D13 (4 Sept)** — DUK-23 form narrative + submit (IRREVERSIBLE)

## Cuts already applied

- [x] Headless spike 4-6h down to 1.5h (research already done, issue #0005)
- [x] Eval runs on scripted transcripts, not live Claude sessions (-3h, and decouples the differentiator from the D7 risk)
- [x] Onboarding UI down to one unstyled page (-1.5h)
- [x] Audit view down to a read-only table, no filters (-1.5h)
- [x] Razorpay fixture caching where the allow branch allows it (-1h)

## Cut order if it slips

1. Audit view to a `bun run audit --session=X` CLI printer (45 min replacement)
2. Onboarding UI to form only
3. Gate tests 18 cases down to 10 — reluctant, contradicts the pitch

**Never cut:** the gate with three outcomes and an AuditEvent on every branch ·
the metrics table with its escapes list and honesty framing · one real `order_`
id on camera · the video · the README · the two long-form form fields.

## Open

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

## Shipped

- [x] Hostile review of IDEA.md v1 — two research passes, every factual claim verified or refuted
- [x] Track locked: 01, gate-as-product, Track 02's measurement discipline grafted on
- [x] IDEA.md rewritten twice (reframe, then unslop + four architectural fixes)
- [x] Adversarial feasibility review — 51h vs 39h, four architectural defects found
- [x] 19 issues created in Linear (DUK-5..DUK-23)
