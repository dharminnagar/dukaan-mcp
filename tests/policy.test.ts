import { afterAll, describe, expect, test } from "bun:test";
import { parsePolicy, parseWindow } from "../src/catalog/policy";
import { pool } from "../src/db/pool";

describe("parseWindow", () => {
  test("24h -> 86400", () => expect(parseWindow("24h")).toBe(86400));
  test("7d -> 604800", () => expect(parseWindow("7d")).toBe(604800));
  test("30m -> 1800", () => expect(parseWindow("30m")).toBe(1800));
  test("3600s -> 3600", () => expect(parseWindow("3600s")).toBe(3600));
  test("rejects an unrecognized unit", () =>
    expect(() => parseWindow("bogus")).toThrow());
  test("rejects a missing unit", () =>
    expect(() => parseWindow("24")).toThrow());
});

describe("parsePolicy", () => {
  const base = {
    spend_cap_rupees: "5000.00",
    approval_threshold_rupees: "1000.00",
    category_allowlist: ["groceries"],
    window: "24h",
  };

  test("parses a valid policy", () => {
    const policy = parsePolicy(base, "m_test");
    expect(policy).toMatchObject({
      merchant_id: "m_test",
      spend_cap_paise: 500000,
      approval_threshold_paise: 100000,
      category_allowlist: ["groceries"],
      window_seconds: 86400,
    });
  });

  test("the merchant-a smoke fixture parses cleanly", async () => {
    const json: unknown = await Bun.file(
      `${import.meta.dir}/../fixtures/merchant-a.policy.json`
    ).json();
    const policy = parsePolicy(json, "m_smoke");
    expect(policy.merchant_id).toBe("m_smoke");
    expect(policy.approval_threshold_paise).toBeLessThanOrEqual(
      policy.spend_cap_paise
    );
  });

  test("rejects an unreachable escalate branch (threshold above cap)", () => {
    const bad = {
      ...base,
      spend_cap_rupees: "500.00",
      approval_threshold_rupees: "1000.00",
    };
    expect(() => parsePolicy(bad, "m_test")).toThrow(/unreachable/);
  });

  test("rejects an empty category allowlist", () => {
    const bad = { ...base, category_allowlist: [] };
    expect(() => parsePolicy(bad, "m_test")).toThrow();
  });

  test("rejects malformed input shape", () => {
    expect(() => parsePolicy({ nonsense: true }, "m_test")).toThrow();
  });

  test("omitting merchant_total_cap_rupees leaves the aggregate cap null", () => {
    // `base` has no such key. Null is "no aggregate constraint", which is the
    // behaviour that predates the column — and is why every already-scored
    // eval transcript decides identically.
    expect(parsePolicy(base, "m_test").merchant_total_cap_paise).toBeNull();
  });

  test("a blank merchant_total_cap_rupees is the same as omitting it", () => {
    const blank = { ...base, merchant_total_cap_rupees: "" };
    expect(parsePolicy(blank, "m_test").merchant_total_cap_paise).toBeNull();
    const whitespace = { ...base, merchant_total_cap_rupees: "   " };
    expect(
      parsePolicy(whitespace, "m_test").merchant_total_cap_paise
    ).toBeNull();
  });

  test("parses a valid merchant_total_cap_rupees to integer paise", () => {
    const withCap = { ...base, merchant_total_cap_rupees: "20,000.50" };
    // Through `rupeesToPaise`, so comma separators work and the fractional part
    // is integer string maths — 0.50 must be exactly 50 paise, never 49.999...
    expect(parsePolicy(withCap, "m_test").merchant_total_cap_paise).toBe(
      2_000_050
    );
  });

  test("an aggregate cap BELOW spend_cap_paise is legal, not an error", () => {
    // The load-bearing case. "Each agent may spend up to ₹5,000, but all of
    // them together may not exceed ₹1,000" is a coherent and useful policy, so
    // there is deliberately no `>= spend_cap_paise` refine. A merchant going
    // multi-buyer will often want exactly this shape.
    const tighter = { ...base, merchant_total_cap_rupees: "1000.00" };
    const policy = parsePolicy(tighter, "m_test");
    expect(policy.merchant_total_cap_paise).toBe(100_000);
    expect(policy.merchant_total_cap_paise).toBeLessThan(
      policy.spend_cap_paise
    );
  });

  test("rejects a zero aggregate cap rather than reading it as no cap", () => {
    // Zero means "allow nothing"; storing it as NULL would mean the opposite.
    const zero = { ...base, merchant_total_cap_rupees: "0" };
    expect(() => parsePolicy(zero, "m_test")).toThrow(
      /must be greater than zero/
    );
  });

  test("rejects a non-numeric aggregate cap", () => {
    const bad = { ...base, merchant_total_cap_rupees: "lots" };
    expect(() => parsePolicy(bad, "m_test")).toThrow(/Invalid rupee amount/);
  });
});

describe("policy_threshold_reachable — Postgres CHECK constraint", () => {
  test("the database independently rejects an unreachable escalate branch", async () => {
    await pool.query(
      `INSERT INTO merchants (id, name) VALUES ('m_policy_check', 'Policy Check')
       ON CONFLICT (id) DO NOTHING`
    );

    let caught: Error | null = null;
    try {
      await pool.query(
        `INSERT INTO policies
           (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds)
         VALUES ('m_policy_check', 50000, 100000, ARRAY['groceries'], 86400)`
      );
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught?.message).toMatch(/policy_threshold_reachable/);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM merchants WHERE id = 'm_policy_check'`);
    // src/db/pool.ts exports ONE process-wide Pool singleton shared by every
    // test file in the same `bun test` process. Closing it here would break
    // whichever file runs next, so it is deliberately left open; bun exits
    // regardless.
  });
});
