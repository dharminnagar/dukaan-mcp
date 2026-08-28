/**
 * DUK-32's merchant dashboard, tested at the query layer
 * (`web/lib/dashboard-queries.ts`) against real Postgres.
 *
 * `web/app/dashboard/[merchantId]/page.tsx` itself is NOT exercised here:
 * this repo's root workspace has no `react`/`react-dom` in its dependency
 * graph (only `web/package.json` does — `bun -e "import('react-dom/server')"`
 * from the repo root fails with "Cannot find module"), so a root-level test
 * cannot render it as a React server component. The page is a thin
 * server-rendered shell over these query functions with no logic of its own
 * beyond null-handling and formatting, both covered below via the functions
 * it calls; it was verified manually with `bun run web:dev` + `curl`, as
 * noted in this task's report.
 *
 * Fixtures are namespaced `m_dash_*` / `s_dash_*` / `o_dash_*` so they never
 * collide with DUK-11's demo merchants or another test file's data, and are
 * onboarded through `createMerchant` (the same path `web/app/actions.ts`'s
 * `onboard` uses) rather than hand-inserted, so the merchant/policy/agent
 * rows are exactly what onboarding actually produces.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createMerchant } from "../src/onboard/create-merchant";
import { registerBuyer } from "../src/buyer/auth";
import { provisionAgentForBuyer } from "../src/buyer/provision";
import { writeAuditEvent } from "../src/audit/write";
import { pool, query } from "../src/db/pool";
import { TenantRepo } from "../src/db/repo";
import {
  formatRupees,
  loadAgentCounts,
  loadAgentSpend,
  loadMerchantExposure,
  loadRecentDecisions,
  loadRevenueSummary,
} from "../web/lib/dashboard-queries";

const CATALOG_CSV = `sku,name,price,stock,category
toor-dal,Toor Dal 1kg,145.00,40,groceries
paneer,Paneer 200g,90.00,4,dairy
basmati,Basmati Rice 5kg,499.50,15,groceries
handwash,Dettol Handwash,120.00,20,personal-care
`;

async function cleanupMerchant(merchantId: string): Promise<void> {
  // `audit_events` carries a `merchant_id` column but no FK to `merchants`
  // (append-only ledger, deliberately not cascade-deletable — see
  // src/audit/write.ts's module doc), so deleting the merchant alone leaves
  // this fixture's audit rows behind for the next run to double-count.
  await pool.query("DELETE FROM audit_events WHERE merchant_id = $1", [
    merchantId,
  ]);
  await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

// `buyers` rows outlive a merchant delete (agents.buyer_id -> buyers is the
// FK direction, not the reverse), so a buyer-provisioned-agent fixture needs
// its own sweep or a re-run collides on the unique `email`.
async function cleanupBuyers(emails: readonly string[]): Promise<void> {
  await pool.query("DELETE FROM buyers WHERE email = ANY($1::text[])", [
    emails,
  ]);
}

async function onboardTestMerchant(merchantId: string, name: string) {
  return createMerchant({
    merchantId,
    name,
    csv: CATALOG_CSV,
    policyJson: {
      spend_cap_rupees: "500.00",
      approval_threshold_rupees: "20.00",
      category_allowlist: ["groceries", "dairy"],
      window: "24h",
    },
    agentLabel: "dashboard-test-agent",
  });
}

describe("dashboard-queries against real Postgres", () => {
  test("empty state: onboarded merchant with no orders, no decisions", async () => {
    const merchantId = "m_dash_empty";
    await cleanupMerchant(merchantId);
    await onboardTestMerchant(merchantId, "Dash Empty Test");

    const revenue = await loadRevenueSummary(merchantId);
    expect(revenue).not.toBeNull();
    expect(revenue?.revenue_paise).toBe(0);
    expect(revenue?.order_count).toBe(0);

    const spend = await loadAgentSpend(merchantId);
    expect(spend).not.toBeNull();
    expect(spend?.spent_paise).toBe(0);
    expect(spend?.effective_cap.cap_paise).toBe(50_000); // 500.00 rupees
    expect(spend?.effective_cap.bound_by).toBe("merchant");

    const decisions = await loadRecentDecisions(merchantId);
    expect(decisions).toHaveLength(0);

    await cleanupMerchant(merchantId);
  });

  test("revenue, spend, and decisions reflect seeded orders and audit events", async () => {
    const merchantId = "m_dash_seeded";
    await cleanupMerchant(merchantId);
    const { agent } = await onboardTestMerchant(merchantId, "Dash Seeded Test");

    const sessionId = "s_dash_seeded_session";
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3)",
      [sessionId, merchantId, agent.id]
    );

    // An allowed order: 2x Toor Dal @ 145.00 = 290.00 rupees, 29000 paise.
    const allowOrderId = "o_dash_allow_1";
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, razorpay_order_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'authorized', 'order_dashtest1')`,
      [
        allowOrderId,
        merchantId,
        agent.id,
        sessionId,
        JSON.stringify([
          { item_id: "toor-dal", quantity: 2, asserted_price_paise: 14500 },
        ]),
        29000,
      ]
    );
    await writeAuditEvent({
      merchant_id: merchantId,
      session_id: sessionId,
      agent_id: agent.id,
      order_id: null, // matches decide()'s real ALLOW audit shape
      action: "checkout",
      amount_paise: 29000,
      rule: "ALLOW",
      decision: "allow",
      reason_code: "ALLOWED",
      detail: { item_count: 1 },
      latency_ms: 5,
    });

    // A stale-catalog block: Paneer, requested 5, stock is 4.
    await writeAuditEvent({
      merchant_id: merchantId,
      session_id: sessionId,
      agent_id: agent.id,
      order_id: null,
      action: "checkout",
      amount_paise: null,
      rule: "AUTHORITATIVE_REREAD",
      decision: "block",
      reason_code: "STALE_CATALOG",
      detail: {
        item_id: "paneer",
        mismatch: "stock",
        requested_quantity: 5,
        true_stock: 4,
      },
      latency_ms: 3,
    });

    // A category block: Handwash is personal-care, not in the allowlist.
    await writeAuditEvent({
      merchant_id: merchantId,
      session_id: sessionId,
      agent_id: agent.id,
      order_id: null,
      action: "checkout",
      amount_paise: 12000,
      rule: "CATEGORY_ALLOWLIST",
      decision: "block",
      reason_code: "CATEGORY_NOT_ALLOWED",
      detail: { item_id: "handwash", category: "personal-care" },
      latency_ms: 4,
    });

    // An escalate: 4x Basmati above the approval threshold, order row present.
    const escalateOrderId = "o_dash_escalate_1";
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, razorpay_order_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'escalated', NULL)`,
      [
        escalateOrderId,
        merchantId,
        agent.id,
        sessionId,
        JSON.stringify([
          { item_id: "basmati", quantity: 4, asserted_price_paise: 49950 },
        ]),
        199800,
      ]
    );
    await writeAuditEvent({
      merchant_id: merchantId,
      session_id: sessionId,
      agent_id: agent.id,
      order_id: escalateOrderId,
      action: "checkout",
      amount_paise: 199800,
      rule: "APPROVAL_THRESHOLD",
      decision: "escalate",
      reason_code: "PENDING_APPROVAL",
      detail: { approval_threshold_paise: 2000 },
      latency_ms: 6,
    });

    const revenue = await loadRevenueSummary(merchantId);
    // Only 'created'/'authorized' orders count: the allow order (29000),
    // never the escalated one.
    expect(revenue?.revenue_paise).toBe(29000);
    expect(revenue?.order_count).toBe(1);

    const spend = await loadAgentSpend(merchantId);
    expect(spend?.spent_paise).toBe(29000);
    expect(spend?.agent_id).toBe(agent.id);

    const decisions = await loadRecentDecisions(merchantId);
    expect(decisions).toHaveLength(4);
    // Newest first.
    expect(decisions[0]?.reason_code).toBe("PENDING_APPROVAL");
    expect(decisions[0]?.description).toContain("basmati");
    expect(decisions[0]?.description).toContain("x4");

    const categoryBlock = decisions.find(
      (d) => d.reason_code === "CATEGORY_NOT_ALLOWED"
    );
    expect(categoryBlock?.description).toContain("Dettol Handwash");
    expect(categoryBlock?.description).toContain("personal-care");

    const staleCatalog = decisions.find(
      (d) => d.reason_code === "STALE_CATALOG"
    );
    expect(staleCatalog?.description).toContain("Paneer 200g");
    expect(staleCatalog?.description).toContain("stock 4");

    const allowed = decisions.find((d) => d.reason_code === "ALLOWED");
    expect(allowed?.description).toContain(formatRupees(29000));

    await cleanupMerchant(merchantId);
  });

  test("no policy row for the merchant id: everything reads as absent", async () => {
    const revenue = await loadRevenueSummary("m_dash_never_onboarded");
    expect(revenue).toBeNull();
  });
});

describe("the dashboard's spend figure agrees with what the gate enforces", () => {
  /**
   * `web/lib/dashboard-queries.ts` and `src/db/repo.ts`'s SPEND_CAP_SQL are two
   * copies of the same aggregate: same window, same agent scoping, same
   * `status IN ('created','authorized')` filter that keeps escalated orders out
   * of the total. They agree today.
   *
   * Two copies that must stay in sync is the whole problem. If the gate's cap
   * semantics ever change (another status becomes countable, the window moves
   * off Postgres's now()), the dashboard silently keeps showing a number that
   * disagrees with enforcement — a merchant reading "spent X of Y" while the
   * gate blocks on a different X. That is worse than no dashboard.
   *
   * Asserting agreement rather than sharing the SQL string is deliberate: a
   * shared constant only stops divergence by copy-paste, while this catches
   * divergence however it arrives, including someone re-deriving the query.
   */
  test("loadAgentSpend equals TenantRepo.spentInWindowPaise over the same data", async () => {
    const merchantId = "m_dash_agree";
    await cleanupMerchant(merchantId);
    const onboarded = await onboardTestMerchant(merchantId, "Agreement Store");
    const agentId = onboarded.agent.id;

    const session = `s_dash_agree_${Date.now()}`;
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
      [session, merchantId, agentId]
    );

    // One countable order, one escalated one. The escalated row is the case
    // that separates a correct copy from a plausible-looking one.
    const orders: readonly [string, number, string][] = [
      [`o_dash_agree_a`, 29000, "created"],
      [`o_dash_agree_b`, 14500, "authorized"],
      [`o_dash_agree_c`, 99900, "escalated"],
    ];
    for (const [id, amount, status] of orders) {
      await query(
        `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          id,
          merchantId,
          agentId,
          session,
          JSON.stringify([{ item_id: "toor-dal", quantity: 1 }]),
          amount,
          status,
        ]
      );
    }

    const policy = await query<{ window_seconds: number }>(
      "SELECT window_seconds FROM policies WHERE merchant_id = $1",
      [merchantId]
    );
    const windowSeconds = policy[0]!.window_seconds;

    const repo = new TenantRepo({
      merchant_id: merchantId,
      agent_id: agentId,
      session_id: session,
    });
    const enforced = await repo.spentInWindowPaise(windowSeconds);
    const displayed = await loadAgentSpend(merchantId);

    expect(displayed).not.toBeNull();
    expect(displayed!.spent_paise).toBe(enforced);
    // And prove the escalated order really was excluded, so an equality of two
    // identically-wrong queries cannot pass this test.
    expect(enforced).toBe(29000 + 14500);

    await cleanupMerchant(merchantId);
  });
});

describe("the merchant-exposure figure agrees with what the gate enforces", () => {
  /**
   * `loadMerchantExposure` is a second copy of `TenantRepo.merchantSpentInWindowPaise`
   * (MERCHANT_TOTAL_SPEND_SQL, src/db/repo.ts) — same window, same
   * `status IN ('created','authorized')` filter, no `agent_id` predicate on
   * either. Two copies that must stay in sync forever: if the gate's cap
   * semantics ever move, the dashboard would keep showing a number that
   * disagrees with what is actually enforced.
   *
   * Two agents, one escalated order: the escalated row is what separates a
   * correct copy from a plausible one (both queries must exclude it), and
   * the second agent is what proves the `agent_id` predicate is genuinely
   * absent — a per-agent query would only see one of them.
   */
  test("loadMerchantExposure equals TenantRepo.merchantSpentInWindowPaise across two agents, escalated orders excluded", async () => {
    const merchantId = "m_dash_exposure_agree";
    await cleanupMerchant(merchantId);
    const onboarded = await onboardTestMerchant(
      merchantId,
      "Exposure Agreement Store"
    );
    const agentA = onboarded.agent.id;

    const agentB = "ag_dash_exposure_second";
    await query(
      `INSERT INTO agents (id, merchant_id, label, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [agentB, merchantId, "second-agent", "b".repeat(64)]
    );

    const session = `s_dash_exposure_${Date.now()}`;
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3)",
      [session, merchantId, agentA]
    );
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3)",
      [`${session}_b`, merchantId, agentB]
    );

    const orders: readonly [string, string, string, number, string][] = [
      [`o_dash_exposure_a1`, agentA, session, 29000, "created"],
      [`o_dash_exposure_a2`, agentA, session, 14500, "authorized"],
      [`o_dash_exposure_b1`, agentB, `${session}_b`, 50000, "authorized"],
      // Escalated, on the second agent: excluded from both aggregates.
      [`o_dash_exposure_b2`, agentB, `${session}_b`, 99900, "escalated"],
    ];
    for (const [id, agentId, sessionId, amount, status] of orders) {
      await query(
        `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
        [
          id,
          merchantId,
          agentId,
          sessionId,
          JSON.stringify([{ item_id: "toor-dal", quantity: 1 }]),
          amount,
          status,
        ]
      );
    }

    const policy = await query<{ window_seconds: number }>(
      "SELECT window_seconds FROM policies WHERE merchant_id = $1",
      [merchantId]
    );
    const windowSeconds = policy[0]!.window_seconds;

    const repo = new TenantRepo({
      merchant_id: merchantId,
      agent_id: agentA,
      session_id: session,
    });
    const enforced = await repo.merchantSpentInWindowPaise(windowSeconds);
    const displayed = await loadMerchantExposure(merchantId);

    expect(displayed).not.toBeNull();
    expect(displayed!.spent_paise).toBe(enforced);
    // Pin the actual integer too, so two identically-wrong queries cannot
    // pass this test by merely agreeing with each other.
    expect(enforced).toBe(29000 + 14500 + 50000);
    // And prove the sum really does span both agents, not just agentA's
    // orders — the case a per-agent query would fail silently.
    expect(enforced).toBeGreaterThan(29000 + 14500);

    await cleanupMerchant(merchantId);
  });

  /**
   * `policies.merchant_total_cap_paise` is NULL by default (every merchant
   * onboarded without an aggregate cap, which is every merchant before
   * DUK-31) — a real, normal state, not a broken one. The dashboard must be
   * able to render "no cap set" rather than a bar pinned at 0/0.
   */
  test("cap_paise surfaces as null, not 0, when no aggregate cap is set", async () => {
    const merchantId = "m_dash_exposure_null_cap";
    await cleanupMerchant(merchantId);
    await onboardTestMerchant(merchantId, "No Aggregate Cap Store");

    const exposure = await loadMerchantExposure(merchantId);
    expect(exposure).not.toBeNull();
    expect(exposure!.cap_paise).toBeNull();
    expect(exposure!.spent_paise).toBe(0);

    await cleanupMerchant(merchantId);
  });
});

describe("loadAgentCounts: buyer-provisioned vs merchant-minted", () => {
  test("splits agents by buyer_id across both provenances", async () => {
    const merchantId = "m_dash_counts_split";
    await cleanupMerchant(merchantId);
    await onboardTestMerchant(merchantId, "Counts Split Store");
    // onboarding already minted one merchant-minted agent (buyer_id NULL).

    const secondMinted = "ag_dash_counts_second_minted";
    await query(
      `INSERT INTO agents (id, merchant_id, label, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [secondMinted, merchantId, "second-minted", "c".repeat(64)]
    );

    const buyerEmails = [
      "buyer.counts.one@dash-test.example",
      "buyer.counts.two@dash-test.example",
    ];
    const buyerOne = await registerBuyer(buyerEmails[0]!, "correct-horse-1");
    const buyerTwo = await registerBuyer(buyerEmails[1]!, "correct-horse-2");
    await provisionAgentForBuyer({
      buyerId: buyerOne.buyer.id,
      merchantId,
      label: "buyer-one-agent",
      buyerCapPaise: null,
    });
    await provisionAgentForBuyer({
      buyerId: buyerTwo.buyer.id,
      merchantId,
      label: "buyer-two-agent",
      buyerCapPaise: null,
    });

    const counts = await loadAgentCounts(merchantId);
    expect(counts.merchant_minted).toBe(2);
    expect(counts.buyer_registered).toBe(2);

    await cleanupMerchant(merchantId);
    await cleanupBuyers(buyerEmails);
  });

  test("a merchant whose only agent is merchant-minted (today's common case)", async () => {
    const merchantId = "m_dash_counts_minted_only";
    await cleanupMerchant(merchantId);
    await onboardTestMerchant(merchantId, "Minted Only Store");

    const counts = await loadAgentCounts(merchantId);
    expect(counts.merchant_minted).toBe(1);
    expect(counts.buyer_registered).toBe(0);

    await cleanupMerchant(merchantId);
  });

  test("a merchant with no agents at all reads as zero, not an error", async () => {
    const counts = await loadAgentCounts("m_dash_counts_never_onboarded");
    expect(counts.merchant_minted).toBe(0);
    expect(counts.buyer_registered).toBe(0);
  });
});

describe("tenant isolation: one merchant's dashboard never sees another's", () => {
  test("loadMerchantExposure and loadAgentCounts exclude a second merchant's agents and orders", async () => {
    const merchantOneId = "m_dash_isolation_one";
    const merchantTwoId = "m_dash_isolation_two";
    await cleanupMerchant(merchantOneId);
    await cleanupMerchant(merchantTwoId);

    const one = await onboardTestMerchant(merchantOneId, "Isolation Store One");
    const two = await onboardTestMerchant(merchantTwoId, "Isolation Store Two");

    // A second agent on merchant two, so its agent count and spend are both
    // larger than merchant one's — a leak would show up as inflated figures
    // on the wrong side, not just a missing one.
    const secondAgentTwo = "ag_dash_isolation_two_second";
    await query(
      `INSERT INTO agents (id, merchant_id, label, token_hash)
       VALUES ($1, $2, $3, $4)`,
      [secondAgentTwo, merchantTwoId, "isolation-two-second", "d".repeat(64)]
    );

    const sessionOne = `s_dash_isolation_one_${Date.now()}`;
    const sessionTwo = `s_dash_isolation_two_${Date.now()}`;
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3)",
      [sessionOne, merchantOneId, one.agent.id]
    );
    await query(
      "INSERT INTO sessions (id, merchant_id, agent_id) VALUES ($1, $2, $3)",
      [sessionTwo, merchantTwoId, two.agent.id]
    );

    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'authorized')`,
      [
        "o_dash_isolation_one",
        merchantOneId,
        one.agent.id,
        sessionOne,
        JSON.stringify([{ item_id: "toor-dal", quantity: 1 }]),
        29000,
      ]
    );
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, 'authorized')`,
      [
        "o_dash_isolation_two",
        merchantTwoId,
        two.agent.id,
        sessionTwo,
        JSON.stringify([{ item_id: "toor-dal", quantity: 1 }]),
        500000,
      ]
    );

    const exposureOne = await loadMerchantExposure(merchantOneId);
    const exposureTwo = await loadMerchantExposure(merchantTwoId);
    expect(exposureOne!.spent_paise).toBe(29000);
    expect(exposureTwo!.spent_paise).toBe(500000);

    const countsOne = await loadAgentCounts(merchantOneId);
    const countsTwo = await loadAgentCounts(merchantTwoId);
    expect(countsOne.merchant_minted).toBe(1);
    expect(countsTwo.merchant_minted).toBe(2);

    await cleanupMerchant(merchantOneId);
    await cleanupMerchant(merchantTwoId);
  });
});

// Guards against re-introducing bare `process.env.PORT` reads anywhere in
// web/lib/dashboard-queries.ts — the MCP server's port lives on MCP_PORT,
// and this file has no reason to touch either, but a copy-paste from
// web/app/actions.ts could import the mistake.
test("dashboard-queries never reads bare process.env.PORT", async () => {
  const src = await Bun.file(
    new URL("../web/lib/dashboard-queries.ts", import.meta.url)
  ).text();
  expect(src).not.toMatch(/process\.env\[["']PORT["']\]/);
  expect(src).not.toMatch(/process\.env\.PORT\b/);
});

afterAll(async () => {
  // src/db/pool.ts's Pool is a process-wide singleton shared by every test
  // file in the same `bun test` process — never call closePool() here.
});
