import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeAuditEvent } from "../src/audit/write";
import { hashToken } from "../src/auth/token";
import { pool, query, queryOne } from "../src/db/pool";
import { TenantRepo } from "../src/db/repo";
import { decide } from "../src/gate";
import type { CheckoutRequest, GateDeps } from "../src/gate";
import { FakeRazorpayAdapter } from "../src/razorpay";
import type { TenantContext } from "../src/shared/contracts";

/**
 * m_gate_* / ag_gate_* namespace, so this file cannot collide with the
 * concurrent DUK-13/razorpay agent's own fixtures or with any other test
 * file's data.
 */
const MERCHANT = "m_gate_test";

const PRODUCT_BASIC = {
  id: "p_gate_basic",
  name: "Basic Item",
  price_paise: 10_000,
  stock: 5,
  category: "groceries",
};
const PRODUCT_DISALLOWED_CATEGORY = {
  id: "p_gate_electronics",
  name: "Gadget",
  price_paise: 20_000,
  stock: 3,
  category: "electronics",
};
const PRODUCT_MULTISESSION = {
  id: "p_gate_multisession",
  name: "Multisession Item",
  price_paise: 50_000,
  stock: 10,
  category: "groceries",
};
const PRODUCT_APPROVAL = {
  id: "p_gate_approval",
  name: "Approval Item",
  price_paise: 60_000,
  stock: 10,
  category: "groceries",
};
const PRODUCT_WINDOW = {
  id: "p_gate_window",
  name: "Window Item",
  price_paise: 20_000,
  stock: 10,
  category: "groceries",
};
const PRODUCT_LOW_STOCK = {
  id: "p_gate_low_stock",
  name: "Low Stock Item",
  price_paise: 15_000,
  stock: 2,
  category: "groceries",
};
const PRODUCT_CAP_EDGE = {
  id: "p_gate_cap_edge",
  name: "Cap Edge Item",
  price_paise: 40_000,
  stock: 10,
  category: "groceries",
};

const SPEND_CAP_PAISE = 100_000;
const APPROVAL_THRESHOLD_PAISE = 50_000;

// Priced exactly at, and one paise past, APPROVAL_THRESHOLD_PAISE so the
// threshold boundary tests don't have to reconstruct the number from
// multiple line items.
const PRODUCT_THRESHOLD_AT = {
  id: "p_gate_threshold_at",
  name: "Threshold At Item",
  price_paise: APPROVAL_THRESHOLD_PAISE,
  stock: 10,
  category: "groceries",
};
const PRODUCT_THRESHOLD_OVER = {
  id: "p_gate_threshold_over",
  name: "Threshold Over Item",
  price_paise: APPROVAL_THRESHOLD_PAISE + 1,
  stock: 10,
  category: "groceries",
};

/**
 * A second, fully independent merchant for the cross-tenant isolation tests.
 * Its policy is deliberately shaped so that applying MERCHANT's policy to a
 * MERCHANT_2 order and applying MERCHANT_2's own policy produce DIFFERENT
 * decisions - see the "cross-tenant policy isolation" describe block below.
 */
const MERCHANT_2 = "m_gate_test_tenant2";
const TENANT2_SPEND_CAP_PAISE = 3_000;
const TENANT2_APPROVAL_THRESHOLD_PAISE = 3_000;
const PRODUCT_TENANT2_PERMISSIVE = {
  id: "p_gate_tenant2_permissive",
  name: "Tenant2 Permissive Item",
  price_paise: 1_000,
  stock: 10,
  category: "electronics",
};
const PRODUCT_TENANT2_CAP_EDGE = {
  id: "p_gate_tenant2_cap_edge",
  name: "Tenant2 Cap Edge Item",
  price_paise: 3_500,
  stock: 10,
  category: "electronics",
};

async function makeAgentCtx(
  agentSuffix: string,
  sessionSuffix = agentSuffix,
  merchantId = MERCHANT
): Promise<TenantContext> {
  const agentId = `ag_gate_${agentSuffix}`;
  await query(
    "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
    [
      agentId,
      merchantId,
      `gate test agent ${agentSuffix}`,
      // Not a real credential - decide() is driven directly with a TenantContext,
      // bypassing auth/resolve.ts entirely, so only a valid unique digest shape matters.
      hashToken(agentId),
    ]
  );
  const ctx: TenantContext = {
    merchant_id: merchantId,
    agent_id: agentId,
    session_id: `s_gate_${sessionSuffix}`,
  };
  await new TenantRepo(ctx).ensureSession();
  return ctx;
}

function makeDeps(ctx: TenantContext): GateDeps {
  return { repo: new TenantRepo(ctx), writeAudit: writeAuditEvent };
}

async function countCheckoutAudits(
  agentId: string,
  merchantId = MERCHANT
): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE merchant_id = $1 AND agent_id = $2 AND action = 'checkout'`,
    [merchantId, agentId]
  );
  return Number.parseInt(row?.count ?? "0", 10);
}

beforeAll(async () => {
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [MERCHANT]);
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT]);
  await query("INSERT INTO merchants (id, name) VALUES ($1, $2)", [
    MERCHANT,
    "Gate Test Kirana",
  ]);
  await query(
    `INSERT INTO policies (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      MERCHANT,
      SPEND_CAP_PAISE,
      APPROVAL_THRESHOLD_PAISE,
      ["groceries", "dairy"],
      3600,
    ]
  );
  for (const p of [
    PRODUCT_BASIC,
    PRODUCT_DISALLOWED_CATEGORY,
    PRODUCT_MULTISESSION,
    PRODUCT_APPROVAL,
    PRODUCT_WINDOW,
    PRODUCT_LOW_STOCK,
    PRODUCT_CAP_EDGE,
    PRODUCT_THRESHOLD_AT,
    PRODUCT_THRESHOLD_OVER,
  ]) {
    await query(
      "INSERT INTO products (merchant_id, id, name, price_paise, stock, category) VALUES ($1, $2, $3, $4, $5, $6)",
      [MERCHANT, p.id, p.name, p.price_paise, p.stock, p.category]
    );
  }

  // MERCHANT_2: a fully separate tenant with a deliberately different
  // policy (tighter cap/threshold, an allowlist that only overlaps with
  // MERCHANT's on nothing) so a leak of MERCHANT's policy into a MERCHANT_2
  // decision is visible as a DIFFERENT decision or a DIFFERENT numeric
  // field, not just a coincidentally-matching one.
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [MERCHANT_2]);
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT_2]);
  await query("INSERT INTO merchants (id, name) VALUES ($1, $2)", [
    MERCHANT_2,
    "Gate Test Tenant2 Kirana",
  ]);
  await query(
    `INSERT INTO policies (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      MERCHANT_2,
      TENANT2_SPEND_CAP_PAISE,
      TENANT2_APPROVAL_THRESHOLD_PAISE,
      ["electronics"],
      3600,
    ]
  );
  for (const p of [PRODUCT_TENANT2_PERMISSIVE, PRODUCT_TENANT2_CAP_EDGE]) {
    await query(
      "INSERT INTO products (merchant_id, id, name, price_paise, stock, category) VALUES ($1, $2, $3, $4, $5, $6)",
      [MERCHANT_2, p.id, p.name, p.price_paise, p.stock, p.category]
    );
  }
});

afterAll(async () => {
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [MERCHANT]);
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT]);
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [MERCHANT_2]);
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT_2]);
  // src/db/pool.ts exports ONE process-wide Pool singleton shared across
  // every test file in the same `bun test` process. Closing it here would
  // break whichever file runs next (projectmem #0013); bun exits fine
  // without it, so it is deliberately left open.
});

describe("check 1: authoritative re-read", () => {
  test('asserted price below catalog price -> STALE_CATALOG with mismatch "price" and the true price', async () => {
    const ctx = await makeAgentCtx("stale_price");
    const req: CheckoutRequest = {
      items: [
        { item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: 9_000 },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("AUTHORITATIVE_REREAD");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("price");
    expect(outcome.error.true_price_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(outcome.error.item_id).toBe(PRODUCT_BASIC.id);
  });

  test('asserted qty above stock -> STALE_CATALOG with mismatch "stock"', async () => {
    const ctx = await makeAgentCtx("stale_stock");
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: PRODUCT_BASIC.stock + 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("stock");
    expect(outcome.error.true_stock).toBe(PRODUCT_BASIC.stock);
  });

  test('unknown item id -> STALE_CATALOG with mismatch "missing"', async () => {
    const ctx = await makeAgentCtx("stale_missing");
    const req: CheckoutRequest = {
      items: [
        {
          item_id: "p_gate_does_not_exist",
          quantity: 1,
          asserted_price_paise: 5_000,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("missing");
    expect(outcome.error.true_price_paise).toBeNull();
    expect(outcome.error.true_stock).toBeNull();
  });

  test("an authoritative-re-read block writes exactly one AuditEvent", async () => {
    const ctx = await makeAgentCtx("stale_audit_count");
    const req: CheckoutRequest = {
      items: [
        { item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: 1 },
      ],
    };

    await decide(ctx, req, makeDeps(ctx));

    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

describe("check 2: spend cap", () => {
  test("an order taking the agent past spend_cap_paise within window -> SPEND_CAP_EXCEEDED", async () => {
    const ctx = await makeAgentCtx("cap");
    // Prior spend of 95_000, leaving only 5_000 of headroom under the 100_000 cap.
    await new TenantRepo(ctx).insertOrder({
      id: "o_gate_cap_prior",
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: 95_000,
        },
      ],
      amount_paise: 95_000,
      status: "created",
      razorpay_order_id: null,
    });

    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("SPEND_CAP");
    expect(outcome.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcome.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcome.error.spent_paise).toBe(95_000);
    expect(outcome.error.attempted_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(outcome.error.cap_paise).toBe(SPEND_CAP_PAISE);
    expect(outcome.error.remaining_budget_paise).toBe(5_000);
  });

  test("THE regression that matters most: NEW SESSION, SAME AGENT, cumulative total past cap -> STILL BLOCKED", async () => {
    const agentId = `ag_gate_multisession`;
    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
      [agentId, MERCHANT, "gate test multisession agent", hashToken(agentId)]
    );

    const ctxSession1: TenantContext = {
      merchant_id: MERCHANT,
      agent_id: agentId,
      session_id: "s_gate_multisession_1",
    };
    const ctxSession2: TenantContext = {
      merchant_id: MERCHANT,
      agent_id: agentId,
      session_id: "s_gate_multisession_2",
    };
    await new TenantRepo(ctxSession1).ensureSession();
    await new TenantRepo(ctxSession2).ensureSession();

    // Session 1 spends 60_000 and then the agent starts a BRAND NEW session.
    await new TenantRepo(ctxSession1).insertOrder({
      id: "o_gate_multisession_1",
      merchant_id: ctxSession1.merchant_id,
      agent_id: ctxSession1.agent_id,
      session_id: ctxSession1.session_id,
      items: [
        {
          item_id: PRODUCT_MULTISESSION.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_MULTISESSION.price_paise,
        },
      ],
      amount_paise: 60_000,
      status: "created",
      razorpay_order_id: null,
    });

    // Session 2 (different session_id, SAME merchant_id + agent_id) tries to
    // spend another 50_000. 60_000 + 50_000 = 110_000 > the 100_000 cap.
    // If the cap were (wrongly) scoped to session_id, this would see 0 prior
    // spend and be allowed - exactly the bug projectmem issue #0009 flags.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_MULTISESSION.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_MULTISESSION.price_paise,
        },
      ],
    };
    const outcome = await decide(ctxSession2, req, makeDeps(ctxSession2));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcome.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcome.error.spent_paise).toBe(60_000);
  });

  test("window boundary: an order just OUTSIDE window_seconds does not count toward the cap", async () => {
    const ctx = await makeAgentCtx("window");
    await new TenantRepo(ctx).ensureSession();

    // Backdated directly via SQL (the same technique tests/repo.test.ts
    // uses) rather than sleeping or mocking a clock: the enforcement query
    // (repo.spentInWindowPaise) filters on Postgres's own `now()`, so the
    // deterministic way to place an order "outside the window" is to give
    // it a created_at that is provably outside it relative to that same
    // now(), computed in the same SQL statement.
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now() - interval '2 hours')`,
      [
        "o_gate_window_outside",
        ctx.merchant_id,
        ctx.agent_id,
        ctx.session_id,
        JSON.stringify([
          {
            item_id: PRODUCT_WINDOW.id,
            quantity: 1,
            asserted_price_paise: 90_000,
          },
        ]),
        90_000,
        "created",
      ]
    );

    // Policy window is 3600s (1 hour). If the 90_000 order above counted,
    // 90_000 + 20_000 = 110_000 would exceed the 100_000 cap and this would
    // block. Because it is 2 hours old, it must not count, and this must allow.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_WINDOW.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_WINDOW.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("allow");
  });

  test("window boundary from the other side: an order just INSIDE window_seconds DOES count toward the cap", async () => {
    const ctx = await makeAgentCtx("window_inside");
    await new TenantRepo(ctx).ensureSession();

    // Same technique and same 90_000/20_000 shape as the OUTSIDE test above,
    // but backdated only 30 minutes into the 3600s (1 hour) window.
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now() - interval '30 minutes')`,
      [
        "o_gate_window_inside",
        ctx.merchant_id,
        ctx.agent_id,
        ctx.session_id,
        JSON.stringify([
          {
            item_id: PRODUCT_WINDOW.id,
            quantity: 1,
            asserted_price_paise: 90_000,
          },
        ]),
        90_000,
        "created",
      ]
    );

    // 30 minutes old is still inside the 1-hour window, so this 90_000 MUST
    // count: 90_000 + 20_000 = 110_000 > the 100_000 cap -> block.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_WINDOW.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_WINDOW.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcome.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcome.error.spent_paise).toBe(90_000);
  });

  test("cap boundary: spending exactly TO spend_cap_paise is allowed", async () => {
    const ctx = await makeAgentCtx("cap_boundary_allow");
    // Prior spend of 60_000 plus this 40_000 order lands at EXACTLY the
    // 100_000 cap. The check is `spent + attempted > cap`, so equality must
    // not block.
    await new TenantRepo(ctx).insertOrder({
      id: "o_gate_cap_boundary_allow_prior",
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [
        {
          item_id: PRODUCT_CAP_EDGE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_CAP_EDGE.price_paise,
        },
      ],
      amount_paise: 60_000,
      status: "created",
      razorpay_order_id: null,
    });

    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_CAP_EDGE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_CAP_EDGE.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("allow");
    if (outcome.decision !== "allow") throw new Error("unreachable");
    expect(outcome.amount_paise).toBe(PRODUCT_CAP_EDGE.price_paise);
  });

  test("cap boundary: one paise past spend_cap_paise is blocked", async () => {
    const ctx = await makeAgentCtx("cap_boundary_block");
    // Prior spend of 60_001 plus this 40_000 order lands at 100_001 - one
    // paise past the 100_000 cap. This must block where the previous test,
    // one paise lower, allows: pins the `>` vs `>=` off-by-one from the
    // other side.
    await new TenantRepo(ctx).insertOrder({
      id: "o_gate_cap_boundary_block_prior",
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [
        {
          item_id: PRODUCT_CAP_EDGE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_CAP_EDGE.price_paise,
        },
      ],
      amount_paise: 60_001,
      status: "created",
      razorpay_order_id: null,
    });

    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_CAP_EDGE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_CAP_EDGE.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcome.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcome.error.spent_paise).toBe(60_001);
    expect(outcome.error.remaining_budget_paise).toBe(39_999);
  });
});

describe("check 3: category allowlist", () => {
  test("a line item outside the allowlist -> CATEGORY_NOT_ALLOWED", async () => {
    const ctx = await makeAgentCtx("category");
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_DISALLOWED_CATEGORY.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_DISALLOWED_CATEGORY.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("CATEGORY_ALLOWLIST");
    expect(outcome.error.reason_code).toBe("CATEGORY_NOT_ALLOWED");
    if (outcome.error.reason_code !== "CATEGORY_NOT_ALLOWED")
      throw new Error("unreachable");
    expect(outcome.error.category).toBe("electronics");
    expect(outcome.error.category_allowlist).toEqual(["groceries", "dairy"]);
  });

  test("multi-item basket: one allowed item plus one disallowed item names the disallowed item, not the allowed one", async () => {
    const ctx = await makeAgentCtx("category_multi");
    // PRODUCT_BASIC (groceries, allowed) is listed FIRST so a bug that
    // reports the wrong line item, or stops checking after the first item
    // passes, would surface as this test asserting on the wrong item_id.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
        {
          item_id: PRODUCT_DISALLOWED_CATEGORY.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_DISALLOWED_CATEGORY.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("CATEGORY_ALLOWLIST");
    expect(outcome.error.reason_code).toBe("CATEGORY_NOT_ALLOWED");
    if (outcome.error.reason_code !== "CATEGORY_NOT_ALLOWED")
      throw new Error("unreachable");
    expect(outcome.error.item_id).toBe(PRODUCT_DISALLOWED_CATEGORY.id);
    expect(outcome.error.category).toBe("electronics");
  });
});

describe("check 4: approval threshold", () => {
  test("amount above approval_threshold_paise -> PENDING_APPROVAL, and does not fall through to allow", async () => {
    const ctx = await makeAgentCtx("approval");
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_APPROVAL.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_APPROVAL.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("escalate");
    if (outcome.decision !== "escalate") throw new Error("unreachable");
    expect(outcome.rule).toBe("APPROVAL_THRESHOLD");
    expect(outcome.error.reason_code).toBe("PENDING_APPROVAL");
    expect(outcome.error.amount_paise).toBe(PRODUCT_APPROVAL.price_paise);
    expect(outcome.error.approval_threshold_paise).toBe(
      APPROVAL_THRESHOLD_PAISE
    );
    expect(outcome.error.order_id).toMatch(/^o_[a-zA-Z0-9_-]+$/);

    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });

  test("threshold boundary: an amount exactly AT approval_threshold_paise does NOT escalate", async () => {
    const ctx = await makeAgentCtx("threshold_boundary_allow");
    // The check is `attempted > threshold`, so equality must fall through
    // to allow, not escalate.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_THRESHOLD_AT.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_THRESHOLD_AT.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("allow");
    if (outcome.decision !== "allow") throw new Error("unreachable");
    expect(outcome.amount_paise).toBe(APPROVAL_THRESHOLD_PAISE);
  });

  test("threshold boundary: one paise above approval_threshold_paise DOES escalate", async () => {
    const ctx = await makeAgentCtx("threshold_boundary_escalate");
    // Mirrors DUK-11 seed data: on merchant B (threshold 100000), 120000
    // escalates; on merchant A (threshold 150000), it doesn't. Same shape
    // here, pinned from the low side of the boundary.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_THRESHOLD_OVER.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_THRESHOLD_OVER.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("escalate");
    if (outcome.decision !== "escalate") throw new Error("unreachable");
    expect(outcome.error.amount_paise).toBe(APPROVAL_THRESHOLD_PAISE + 1);
    expect(outcome.error.approval_threshold_paise).toBe(
      APPROVAL_THRESHOLD_PAISE
    );
  });

  test("escalating an order never calls the Razorpay adapter and writes exactly one AuditEvent", async () => {
    const ctx = await makeAgentCtx("escalate_no_razorpay");
    // decide()'s GateDeps has no adapter field at all - see src/gate/index.ts's
    // module comment, "it NEVER imports from src/razorpay/". The honest form
    // of "escalate makes zero Razorpay calls" is therefore: construct a fake
    // adapter with an EMPTY response queue (so any call to it throws
    // immediately) and hold it off to the side, unused by decide(), then
    // assert its callCount afterwards. If a future refactor ever threaded an
    // adapter into decide() and called it on the escalate path, this queue
    // being empty would make that call throw and fail this test outright.
    const adapter = new FakeRazorpayAdapter();
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_APPROVAL.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_APPROVAL.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("escalate");
    expect(adapter.callCount).toBe(0);
    expect(adapter.calls).toHaveLength(0);
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

describe("check 5: allow", () => {
  test("a clean order allows, with amount_paise, and writes exactly one allow AuditEvent", async () => {
    const ctx = await makeAgentCtx("allow");
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 2,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("allow");
    if (outcome.decision !== "allow") throw new Error("unreachable");
    expect(outcome.rule).toBe("ALLOW");
    expect(outcome.amount_paise).toBe(PRODUCT_BASIC.price_paise * 2);

    const events = await query<{
      decision: string;
      reason_code: string;
      latency_ms: number;
    }>(
      `SELECT decision, reason_code, latency_ms FROM audit_events WHERE merchant_id = $1 AND agent_id = $2 AND action = 'checkout'`,
      [MERCHANT, ctx.agent_id]
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.decision).toBe("allow");
    expect(events[0]?.reason_code).toBe("ALLOWED");
    expect(events[0]?.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("multi-item baskets: the right rule names the right item", () => {
  test("one item within stock plus one item over stock names the over-stock item, not the fine one", async () => {
    const ctx = await makeAgentCtx("multi_stock");
    // PRODUCT_BASIC (qty 1, well within its stock of 5) is listed FIRST.
    // PRODUCT_LOW_STOCK has stock 2 and is asserted at qty 3. A bug that
    // reports the wrong item, or short-circuits the aggregate-stock pass on
    // the first item it looks at, would surface here as the wrong item_id
    // or true_stock.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
        {
          item_id: PRODUCT_LOW_STOCK.id,
          quantity: 3,
          asserted_price_paise: PRODUCT_LOW_STOCK.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("AUTHORITATIVE_REREAD");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("stock");
    expect(outcome.error.item_id).toBe(PRODUCT_LOW_STOCK.id);
    expect(outcome.error.true_stock).toBe(PRODUCT_LOW_STOCK.stock);
    expect(outcome.error.asserted_quantity).toBe(3);
  });
});

/**
 * Tenancy isolation. Both describe blocks below exist because the cap key is
 * (merchant_id, agent_id, window) and the policy lookup is keyed on
 * merchant_id alone: a bug collapsing either scope to something coarser
 * would be invisible to every test above, all of which use exactly one
 * agent under exactly one merchant at a time.
 */
describe("tenancy: multi-agent isolation under one merchant", () => {
  test("blocks cumulative overspend for agent A but does not let agent A's spend count against agent B", async () => {
    const ctxA = await makeAgentCtx("multiagent_a");
    const ctxB = await makeAgentCtx("multiagent_b");

    // Agent A spends 95_000 of the shared merchant's 100_000 cap.
    await new TenantRepo(ctxA).insertOrder({
      id: "o_gate_multiagent_a_prior",
      merchant_id: ctxA.merchant_id,
      agent_id: ctxA.agent_id,
      session_id: ctxA.session_id,
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
      amount_paise: 95_000,
      status: "created",
      razorpay_order_id: null,
    });

    // Agent B, same merchant, has spent nothing. If the cap query were
    // (wrongly) scoped to merchant_id alone - dropping agent_id - this
    // decide() call would see A's 95_000 as B's own prior spend, and
    // 95_000 + 10_000 = 105_000 would exceed the 100_000 cap and block.
    // Correctly scoped, B's own spend is 0 and this must allow.
    const reqB: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };
    const outcomeB = await decide(ctxB, reqB, makeDeps(ctxB));

    expect(outcomeB.decision).toBe("allow");
    if (outcomeB.decision !== "allow") throw new Error("unreachable");
    expect(outcomeB.amount_paise).toBe(PRODUCT_BASIC.price_paise);
    // B's own audit trail has exactly one checkout event, and it is not A's.
    expect(await countCheckoutAudits(ctxB.agent_id)).toBe(1);
    expect(await countCheckoutAudits(ctxA.agent_id)).toBe(0);

    // Meanwhile agent A, attempting the same order on top of its own
    // 95_000, DOES get blocked - proving this is isolation, not a cap that
    // silently stopped enforcing.
    const reqA: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };
    const outcomeA = await decide(ctxA, reqA, makeDeps(ctxA));

    expect(outcomeA.decision).toBe("block");
    if (outcomeA.decision !== "block") throw new Error("unreachable");
    expect(outcomeA.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcomeA.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcomeA.error.spent_paise).toBe(95_000);
  });
});

describe("tenancy: cross-merchant policy isolation", () => {
  test("merchant B's category allowlist governs merchant B's checkout, not merchant A's", async () => {
    const ctx = await makeAgentCtx(
      "tenant2_category",
      "tenant2_category",
      MERCHANT_2
    );
    // electronics is disallowed under MERCHANT's own policy (['groceries',
    // 'dairy']) but IS allowed, and well under cap/threshold, under
    // MERCHANT_2's own policy. If MERCHANT's policy leaked into a MERCHANT_2
    // decision, this would block with CATEGORY_NOT_ALLOWED; correctly
    // scoped, it must allow.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_TENANT2_PERMISSIVE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_TENANT2_PERMISSIVE.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("allow");
    if (outcome.decision !== "allow") throw new Error("unreachable");
    expect(outcome.amount_paise).toBe(PRODUCT_TENANT2_PERMISSIVE.price_paise);
  });

  test("merchant B's spend cap value governs merchant B's checkout, not merchant A's", async () => {
    const ctx = await makeAgentCtx("tenant2_cap", "tenant2_cap", MERCHANT_2);
    // 3_500 paise is well under MERCHANT's 100_000 cap but over MERCHANT_2's
    // own 3_000 cap. If MERCHANT's policy leaked in, this would evaluate
    // against a 100_000 cap (and then MERCHANT's allowlist, which also
    // excludes electronics) and either allow or block for the WRONG reason;
    // correctly scoped to MERCHANT_2, this blocks on MERCHANT_2's own cap
    // number, and the reported cap_paise proves which policy was used.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_TENANT2_CAP_EDGE.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_TENANT2_CAP_EDGE.price_paise,
        },
      ],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("SPEND_CAP");
    expect(outcome.error.reason_code).toBe("SPEND_CAP_EXCEEDED");
    if (outcome.error.reason_code !== "SPEND_CAP_EXCEEDED")
      throw new Error("unreachable");
    expect(outcome.error.cap_paise).toBe(TENANT2_SPEND_CAP_PAISE);
    expect(outcome.error.spent_paise).toBe(0);
  });
});

/**
 * Regressions for projectmem issue #0016 — three holes in check 1 found by
 * adversarial probes after DUK-14 landed, none covered by the original suite.
 * All three are shapes an adversary reaches for, so they stay tested.
 */
describe("check 1 regressions: per-line vs per-aggregate validation", () => {
  test("duplicate line items may not oversell stock (3 + 3 against stock 5)", async () => {
    const ctx = await makeAgentCtx("dupstock");
    // Each line passes an independent `quantity > stock` test (3 <= 5), but the
    // aggregate is 6 against 5. Validating per line would ship goods that do
    // not exist.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 3,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 3,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("AUTHORITATIVE_REREAD");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("stock");
    // The reported quantity is the aggregate, not one line's share.
    expect(outcome.error.asserted_quantity).toBe(6);
    expect(outcome.error.true_stock).toBe(PRODUCT_BASIC.stock);
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });

  test("the same item twice at different asserted prices is caught on the second line", async () => {
    const ctx = await makeAgentCtx("dupprice");
    // Deduping the catalog read must not dedupe the PRICE check: if only the
    // first occurrence were validated, the agent would underpay on the rest.
    const req: CheckoutRequest = {
      items: [
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise,
        },
        {
          item_id: PRODUCT_BASIC.id,
          quantity: 1,
          asserted_price_paise: PRODUCT_BASIC.price_paise - 5_000,
        },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.error.reason_code).toBe("STALE_CATALOG");
    if (outcome.error.reason_code !== "STALE_CATALOG")
      throw new Error("unreachable");
    expect(outcome.error.mismatch).toBe("price");
    expect(outcome.error.true_price_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });

  test("an empty basket is INVALID_REQUEST, never a 0-paise allow", async () => {
    const ctx = await makeAgentCtx("emptyitems");
    // src/eval/ calls decide() directly with no zod layer in front of it, and
    // `orders` could not store a 0-paise, 0-item row anyway.
    const outcome = await decide(ctx, { items: [] }, makeDeps(ctx));

    expect(outcome.decision).toBe("block");
    if (outcome.decision !== "block") throw new Error("unreachable");
    expect(outcome.rule).toBe("AUTHORITATIVE_REREAD");
    expect(outcome.error.reason_code).toBe("INVALID_REQUEST");
    if (outcome.error.reason_code !== "INVALID_REQUEST")
      throw new Error("unreachable");
    expect(outcome.error.field).toBe("items");
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

afterAll(async () => {
  // Belt-and-braces: prove no test in this file ever opened a second
  // connection pool or otherwise left the shared pool in a bad state.
  expect(pool.ended).toBe(false);
});
