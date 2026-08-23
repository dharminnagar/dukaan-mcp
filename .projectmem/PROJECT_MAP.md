# Project Map - dukaan-mcp

## Project purpose
Hackathon project for the Razorpay Buildathon (Track 01 — AI Growth & Agentic Commerce). Intended build: a multi-tenant MCP server that lets any Razorpay merchant self-serve onboard a normalized catalog + spend policy, so third-party AI buyer agents can discover, shop, and check out against that merchant through one stable tool surface — with a gating middleware (spend cap, category allowlist, approval threshold, price/stock integrity) and a live audit trail over real Razorpay test-mode APIs. Personal goal behind the project: win/stand out at the buildathon and land a Razorpay internship.

Status as of 2026-08-22: **pre-code**. Only the idea doc exists. Idea is being stress-tested before any implementation.

## Structure
- `IDEA.md` — the full idea doc: problem framing, differentiators, demo script, system design (architecture diagram, data model, gating middleware deep dive, error handling, trade-off table, post-demo roadmap). Single source of truth for the concept.
- `CLAUDE.md` — project instructions; mandates projectmem usage for all AI sessions.
- `.projectmem/` — persistent project memory (events, summary, map, plan).

## Relationships
- `IDEA.md` defines the intended system; no source tree exists yet to map against it.
- `CLAUDE.md` points all AI sessions at `.projectmem/` before touching any file.
