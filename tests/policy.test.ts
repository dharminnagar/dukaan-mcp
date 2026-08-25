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
