import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { TenantContext } from "../src/shared/contracts";
import { hashToken } from "../src/auth/token";
import { TenantRepo } from "../src/db/repo";
import { query } from "../src/db/pool";

const MERCHANT_A = "m_u4_repo_a";
const MERCHANT_B = "m_u4_repo_b";
const AGENT_A_WINDOW = "ag_u4_repo_a_window";
const AGENT_A_MULTISESSION = "ag_u4_repo_a_multisession";
const AGENT_B = "ag_u4_repo_b";

const ctxAWindow: TenantContext = {
  merchant_id: MERCHANT_A,
  agent_id: AGENT_A_WINDOW,
  session_id: "s_u4_repo_a_window",
};

/**
 * The buyer cap is read from `agents`, not `policies`, so it gets its own
 * fixtures: two agents under the SAME merchant, one capped and one not, which
 * is what makes a cross-agent leak visible rather than plausible.
 */
const AGENT_A_BUYER_CAPPED = "ag_u4_repo_a_buyer_capped";
const BUYER_CAP_PAISE = 25_000;

const ctxABuyerCapped: TenantContext = {
  merchant_id: MERCHANT_A,
  agent_id: AGENT_A_BUYER_CAPPED,
  session_id: "s_u4_repo_a_buyer_capped",
};

async function insertOrderAt(args: {
  id: string;
  merchantId: string;
  agentId: string;
  sessionId: string;
  amountPaise: number;
  createdAt: string; // interval expression, e.g. "now() - interval '2 hours'"
  status?: "created" | "authorized" | "escalated" | "failed";
}): Promise<void> {
  await query(
    `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, ${args.createdAt})`,
    [
      args.id,
      args.merchantId,
      args.agentId,
      args.sessionId,
      JSON.stringify([
        { item_id: "p1", quantity: 1, asserted_price_paise: args.amountPaise },
      ]),
      args.amountPaise,
      args.status ?? "created",
    ]
  );
}

beforeAll(async () => {
  await query("DELETE FROM merchants WHERE id IN ($1, $2)", [
    MERCHANT_A,
    MERCHANT_B,
  ]);

  await query("INSERT INTO merchants (id, name) VALUES ($1, $2), ($3, $4)", [
    MERCHANT_A,
    "Repo Test Merchant A",
    MERCHANT_B,
    "Repo Test Merchant B",
  ]);

  for (const [id, merchantId, label, buyerCapPaise] of [
    [AGENT_A_WINDOW, MERCHANT_A, "A Window Agent", null],
    [AGENT_A_MULTISESSION, MERCHANT_A, "A Multisession Agent", null],
    [AGENT_B, MERCHANT_B, "B Agent", null],
    [AGENT_A_BUYER_CAPPED, MERCHANT_A, "A Buyer-Capped Agent", BUYER_CAP_PAISE],
  ] as const) {
    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash, buyer_cap_paise) VALUES ($1, $2, $3, $4, $5)",
      [
        id,
        merchantId,
        label,
        // Not a real credential — repo tests bypass resolve.ts entirely and
        // construct TenantContext directly, so only a valid, unique digest
        // shape matters here.
        hashToken(id),
        buyerCapPaise,
      ]
    );
  }

  await query(
    "INSERT INTO products (merchant_id, id, name, price_paise, stock, category) VALUES ($1, $2, $3, $4, $5, $6)",
    [MERCHANT_A, "p_a1", "Product A1", 10000, 5, "staples"]
  );
  await query(
    "INSERT INTO products (merchant_id, id, name, price_paise, stock, category) VALUES ($1, $2, $3, $4, $5, $6)",
    [MERCHANT_B, "p_b1", "Product B1", 20000, 5, "staples"]
  );

  await query(
    "INSERT INTO policies (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds) VALUES ($1, $2, $3, $4, $5)",
    [MERCHANT_A, 10_00000, 5_00000, ["staples"], 86400]
  );

  await new TenantRepo(ctxAWindow).ensureSession();
});

describe("buyerCapPaise", () => {
  test("returns null for an agent the buyer did not cap", async () => {
    // Null is a real answer, not a missing one: "the buyer imposed no
    // constraint", which is what every agent row created before the column
    // existed says.
    expect(await new TenantRepo(ctxAWindow).buyerCapPaise()).toBeNull();
  });

  test("returns the stored cap as a NUMBER, not a BIGINT string", async () => {
    // src/db/pool.ts registers an INT8 type parser globally, so a `parseInt`
    // at the call site would be both redundant and a lie about the type.
    const cap = await new TenantRepo(ctxABuyerCapped).buyerCapPaise();
    expect(cap).toBe(BUYER_CAP_PAISE);
    expect(typeof cap).toBe("number");
  });

  test("one agent's buyer cap is invisible to a sibling agent under the same merchant", async () => {
    expect(await new TenantRepo(ctxABuyerCapped).buyerCapPaise()).toBe(
      BUYER_CAP_PAISE
    );
    expect(await new TenantRepo(ctxAWindow).buyerCapPaise()).toBeNull();
  });

  test("an agent id that exists under merchant A is not reachable through merchant B's repo", async () => {
    // The query is scoped by BOTH ids off this.ctx. Scoping by agent_id alone
    // would make an agent id collision across tenants a cap leak.
    const strayCtx: TenantContext = {
      merchant_id: MERCHANT_B,
      agent_id: AGENT_A_BUYER_CAPPED,
      session_id: "s_u4_repo_b",
    };
    await expect(new TenantRepo(strayCtx).buyerCapPaise()).rejects.toThrow(
      "no agent"
    );
  });

  test("THROWS rather than reporting no cap when the agent row is missing", async () => {
    // Fail loud, not open. Returning null here would turn a tenant-resolution
    // bug into a silently uncapped agent — the exact failure this cap exists
    // to prevent.
    const ghost: TenantContext = {
      merchant_id: MERCHANT_A,
      agent_id: "ag_u4_repo_ghost",
      session_id: "s_u4_repo_a_window",
    };
    await expect(new TenantRepo(ghost).buyerCapPaise()).rejects.toThrow(
      "buyerCapPaise"
    );
  });
});

describe("migration 0002: agents.buyer_cap_paise", () => {
  test("the column is nullable, so agent rows that predate it stay legal", async () => {
    const rows = await query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_name = 'agents' AND column_name = 'buyer_cap_paise'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_nullable).toBe("YES");
    expect(rows[0]?.data_type).toBe("bigint");
  });

  test("a zero or negative buyer cap is rejected by the CHECK, not stored", async () => {
    // A cap of 0 would block every order while reading like "no cap set" to
    // anyone skimming the row; the constraint is what keeps null the only way
    // to say "no cap".
    for (const bad of [0, -1]) {
      await expect(
        query(
          "INSERT INTO agents (id, merchant_id, label, token_hash, buyer_cap_paise) VALUES ($1, $2, $3, $4, $5)",
          [
            "ag_u4_repo_bad_cap",
            MERCHANT_A,
            "Bad Cap Agent",
            hashToken(`bad_cap_${bad}`),
            bad,
          ]
        )
      ).rejects.toThrow();
    }
  });
});

afterAll(async () => {
  await query("DELETE FROM merchants WHERE id IN ($1, $2)", [
    MERCHANT_A,
    MERCHANT_B,
  ]);
  // See tests/auth.test.ts: the pool is a process-wide singleton shared
  // across test files, so it is deliberately left open here.
});

describe("tenancy isolation", () => {
  test("cross-tenant: a product under merchant B is invisible to merchant A's repo", async () => {
    const repoA = new TenantRepo(ctxAWindow);
    const product = await repoA.getProduct("p_b1");
    expect(product).toBeNull();
  });

  test("same-tenant getProduct resolves the product", async () => {
    const repoA = new TenantRepo(ctxAWindow);
    const product = await repoA.getProduct("p_a1");
    expect(product).not.toBeNull();
    expect(product?.id).toBe("p_a1");
    expect(product?.merchant_id).toBe(MERCHANT_A);
  });

  test("listProducts only returns the calling tenant's products", async () => {
    const repoA = new TenantRepo(ctxAWindow);
    const products = await repoA.listProducts();
    expect(products.every((p) => p.merchant_id === MERCHANT_A)).toBe(true);
    expect(products.some((p) => p.id === "p_b1")).toBe(false);
  });

  test("getPolicy resolves the calling tenant's policy", async () => {
    const repoA = new TenantRepo(ctxAWindow);
    const policy = await repoA.getPolicy();
    expect(policy.merchant_id).toBe(MERCHANT_A);
    expect(policy.spend_cap_paise).toBe(10_00000);
  });
});

describe("spentInWindowPaise window boundaries", () => {
  test("excludes an order just outside the window, includes one just inside", async () => {
    await insertOrderAt({
      id: "o_u4_repo_outside",
      merchantId: MERCHANT_A,
      agentId: AGENT_A_WINDOW,
      sessionId: "s_u4_repo_a_window",
      amountPaise: 70000,
      createdAt: "now() - interval '2 hours'",
    });
    await insertOrderAt({
      id: "o_u4_repo_inside",
      merchantId: MERCHANT_A,
      agentId: AGENT_A_WINDOW,
      sessionId: "s_u4_repo_a_window",
      amountPaise: 50000,
      createdAt: "now() - interval '10 minutes'",
    });

    const repoA = new TenantRepo(ctxAWindow);
    const spent = await repoA.spentInWindowPaise(3600); // 1 hour window
    expect(spent).toBe(50000);
  });

  test("excludes escalated orders (no money moved)", async () => {
    await insertOrderAt({
      id: "o_u4_repo_escalated",
      merchantId: MERCHANT_A,
      agentId: AGENT_A_WINDOW,
      sessionId: "s_u4_repo_a_window",
      amountPaise: 99999,
      createdAt: "now() - interval '1 minute'",
      status: "escalated",
    });

    const repoA = new TenantRepo(ctxAWindow);
    const spent = await repoA.spentInWindowPaise(3600);
    expect(spent).toBe(50000); // unchanged from the previous test's inside order
  });
});

describe("multi-session evasion regression (the test that matters most)", () => {
  test("two orders in two DIFFERENT sessions, same (merchant_id, agent_id), sum together", async () => {
    const ctxSession1: TenantContext = {
      merchant_id: MERCHANT_A,
      agent_id: AGENT_A_MULTISESSION,
      session_id: "s_u4_repo_multisession_1",
    };
    const ctxSession2: TenantContext = {
      merchant_id: MERCHANT_A,
      agent_id: AGENT_A_MULTISESSION,
      session_id: "s_u4_repo_multisession_2",
    };

    const repoSession1 = new TenantRepo(ctxSession1);
    const repoSession2 = new TenantRepo(ctxSession2);

    await repoSession1.ensureSession();
    await repoSession2.ensureSession();

    await repoSession1.insertOrder({
      id: "o_u4_repo_multisession_1",
      merchant_id: MERCHANT_A,
      agent_id: AGENT_A_MULTISESSION,
      session_id: ctxSession1.session_id,
      items: [{ item_id: "p_a1", quantity: 1, asserted_price_paise: 25000 }],
      amount_paise: 25000,
      status: "created",
      razorpay_order_id: null,
    });

    await repoSession2.insertOrder({
      id: "o_u4_repo_multisession_2",
      merchant_id: MERCHANT_A,
      agent_id: AGENT_A_MULTISESSION,
      session_id: ctxSession2.session_id,
      items: [{ item_id: "p_a1", quantity: 1, asserted_price_paise: 25000 }],
      amount_paise: 25000,
      status: "created",
      razorpay_order_id: null,
    });

    // Scope is (merchant_id, agent_id) — NEVER session_id. If someone
    // reverts the query to also filter on session_id, each of these would
    // see only its own 25000 instead of the 50000 total, and this fails.
    expect(await repoSession1.spentInWindowPaise(3600)).toBe(50000);
    expect(await repoSession2.spentInWindowPaise(3600)).toBe(50000);
  });
});

describe("insertOrder / getOrder", () => {
  test("insertOrder ignores the tenant fields on its input and forces this.ctx instead", async () => {
    const repoB = new TenantRepo({
      merchant_id: MERCHANT_B,
      agent_id: AGENT_B,
      session_id: "s_u4_repo_b",
    });
    await repoB.ensureSession();

    const inserted = await repoB.insertOrder({
      id: "o_u4_repo_b_1",
      // Deliberately wrong tenant fields to prove they are not trusted.
      merchant_id: "m_not_this_one",
      agent_id: "ag_not_this_one",
      session_id: "s_not_this_one",
      items: [{ item_id: "p_b1", quantity: 1, asserted_price_paise: 20000 }],
      amount_paise: 20000,
      status: "created",
      razorpay_order_id: null,
    });

    expect(inserted.merchant_id).toBe(MERCHANT_B);
    expect(inserted.agent_id).toBe(AGENT_B);
    expect(inserted.session_id).toBe("s_u4_repo_b");

    const fetched = await repoB.getOrder("o_u4_repo_b_1");
    expect(fetched).not.toBeNull();
    expect(fetched?.merchant_id).toBe(MERCHANT_B);
  });

  test("getOrder returns null for an order under a different tenant", async () => {
    const repoA = new TenantRepo(ctxAWindow);
    const fetched = await repoA.getOrder("o_u4_repo_b_1");
    expect(fetched).toBeNull();
  });
});
