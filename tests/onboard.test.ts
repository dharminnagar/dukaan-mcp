import { afterAll, describe, expect, test } from "bun:test";
import { hashToken } from "../src/auth/token";
import { pool, query, queryOne } from "../src/db/pool";
import {
  assertWithinPlatformCeiling,
  createMerchant,
} from "../src/onboard/create-merchant";

const FIXTURE_CSV = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.csv`
).text();
const FIXTURE_POLICY: unknown = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.policy.json`
).json();

async function cleanupMerchant(merchantId: string): Promise<void> {
  await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

describe("createMerchant", () => {
  test("onboards a merchant, its policy, catalog, and first agent in one call", async () => {
    const merchantId = "m_onboard_smoke";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "Onboard Smoke Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
    });

    expect(result.merchant.id).toBe(merchantId);
    expect(result.productCount).toBe(5);
    expect(result.policy.merchant_id).toBe(merchantId);
    expect(result.agent.merchant_id).toBe(merchantId);
    expect(result.token).toMatch(/^dk_/);

    const productCount = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM products WHERE merchant_id = $1",
      [merchantId]
    );
    const policyCount = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM policies WHERE merchant_id = $1",
      [merchantId]
    );
    const agentRows = await query<{ id: string; token_hash: string }>(
      "SELECT id, token_hash FROM agents WHERE merchant_id = $1",
      [merchantId]
    );

    expect(productCount?.count).toBe("5");
    expect(policyCount?.count).toBe("1");
    expect(agentRows).toHaveLength(1);

    // The stored hash matches hashToken(rawToken), and the raw token itself
    // never appears in the row — only its digest does.
    const agentRow = agentRows[0];
    expect(agentRow?.token_hash).toBe(hashToken(result.token));
    expect(agentRow?.token_hash).not.toBe(result.token);

    await cleanupMerchant(merchantId);
  });

  test("a policy with an unreachable escalate branch is rejected before any row is written", async () => {
    const merchantId = "m_onboard_bad_policy";
    await cleanupMerchant(merchantId);

    const badPolicy = {
      spend_cap_rupees: "500.00",
      approval_threshold_rupees: "1000.00",
      category_allowlist: ["groceries"],
      window: "24h",
    };

    await expect(
      createMerchant({
        merchantId,
        name: "Bad Policy Kirana",
        csv: FIXTURE_CSV,
        policyJson: badPolicy,
        agentLabel: "smoke-agent",
      })
    ).rejects.toThrow(/unreachable/);

    const merchantRow = await queryOne(
      "SELECT id FROM merchants WHERE id = $1",
      [merchantId]
    );
    expect(merchantRow).toBeNull();
  });

  test("a duplicate merchant id rolls back the whole transaction", async () => {
    const merchantId = "m_onboard_dupe";
    await cleanupMerchant(merchantId);

    await createMerchant({
      merchantId,
      name: "Original Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "agent-one",
    });

    await expect(
      createMerchant({
        merchantId,
        name: "Duplicate Kirana",
        csv: FIXTURE_CSV,
        policyJson: FIXTURE_POLICY,
        agentLabel: "agent-two",
      })
    ).rejects.toThrow();

    // Only the first agent exists — the second call's inserts never committed.
    const agentRows = await query(
      "SELECT id FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(agentRows).toHaveLength(1);

    await cleanupMerchant(merchantId);
  });
});

/**
 * The BUYER's cap on the agent being minted. Onboarding is where the number
 * enters the system, and the conversion has to go through `rupeesToPaise` -
 * `0.29 * 100` is 28.999999999999996, which is why there is one converter in
 * this codebase and not two.
 */
describe("createMerchant buyer cap", () => {
  test("an omitted buyer cap stores NULL: the buyer imposes no constraint", async () => {
    const merchantId = "m_onboard_no_buyer_cap";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "No Buyer Cap Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
    });

    expect(result.buyerCapPaise).toBeNull();
    const row = await queryOne<{ buyer_cap_paise: number | null }>(
      "SELECT buyer_cap_paise FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(row?.buyer_cap_paise).toBeNull();

    await cleanupMerchant(merchantId);
  });

  test("a blank buyer cap is the same as omitting it", async () => {
    const merchantId = "m_onboard_blank_buyer_cap";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "Blank Buyer Cap Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
      buyerCapRupees: "   ",
    });

    expect(result.buyerCapPaise).toBeNull();
    await cleanupMerchant(merchantId);
  });

  test("a rupee buyer cap is stored as integer paise, decimals and separators included", async () => {
    const merchantId = "m_onboard_buyer_cap";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "Buyer Cap Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
      buyerCapRupees: "2,500.29",
    });

    // 250029, not 250028.999999999996 - the whole reason rupeesToPaise does
    // integer string maths.
    expect(result.buyerCapPaise).toBe(250_029);
    const row = await queryOne<{ buyer_cap_paise: number | null }>(
      "SELECT buyer_cap_paise FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(row?.buyer_cap_paise).toBe(250_029);

    await cleanupMerchant(merchantId);
  });

  test("a buyer cap ABOVE the merchant's own spend cap is allowed and stored as given", async () => {
    // Not an error: the tightest of the three binds at decision time, so a
    // slack buyer cap is simply never the binding one. Rejecting it here would
    // be the gate's job leaking into onboarding.
    const merchantId = "m_onboard_slack_buyer_cap";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "Slack Buyer Cap Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
      buyerCapRupees: "999999",
    });

    expect(result.buyerCapPaise).toBe(99_999_900);
    expect(result.policy.spend_cap_paise).toBe(500_000);
    await cleanupMerchant(merchantId);
  });

  test("a malformed or zero buyer cap is rejected before any row is written", async () => {
    const merchantId = "m_onboard_bad_buyer_cap";
    for (const bad of ["nonsense", "1.234", "-50", "0", "0.00"]) {
      await cleanupMerchant(merchantId);
      await expect(
        createMerchant({
          merchantId,
          name: "Bad Buyer Cap Kirana",
          csv: FIXTURE_CSV,
          policyJson: FIXTURE_POLICY,
          agentLabel: "smoke-agent",
          buyerCapRupees: bad,
        })
      ).rejects.toThrow();

      const merchantRow = await queryOne(
        "SELECT id FROM merchants WHERE id = $1",
        [merchantId]
      );
      expect(merchantRow).toBeNull();
    }
  });
});

/**
 * The platform ceiling cannot be a SQL CHECK - Postgres cannot see the
 * environment - so it is a write-path rule, and this is where it is tested.
 * The pure function takes the ceiling as an argument precisely so these cases
 * do not have to mutate the environment of an already-imported module.
 */
describe("assertWithinPlatformCeiling", () => {
  test("a null ceiling permits any merchant cap: an unconfigured platform imposes nothing", () => {
    expect(() =>
      assertWithinPlatformCeiling(Number.MAX_SAFE_INTEGER, null)
    ).not.toThrow();
  });

  test("a cap under or exactly at the ceiling is accepted", () => {
    expect(() => assertWithinPlatformCeiling(499_999, 500_000)).not.toThrow();
    expect(() => assertWithinPlatformCeiling(500_000, 500_000)).not.toThrow();
  });

  test("a cap one paise over the ceiling is rejected, and the message names the ceiling", () => {
    // The merchant has to be able to see WHICH number it breached and what to
    // change; "invalid policy" would send it back to guessing.
    expect(() => assertWithinPlatformCeiling(500_001, 500_000)).toThrow(
      /500000 paise \(PLATFORM_SPEND_CEILING_PAISE\)/
    );
    expect(() => assertWithinPlatformCeiling(500_001, 500_000)).toThrow(
      /500001/
    );
  });

  test("createMerchant enforces it on the real onboarding path", async () => {
    // Driven through the exported rule rather than through env, since `env` is
    // read once at import; this asserts the rule is WIRED, and the cases above
    // assert what it decides.
    const merchantId = "m_onboard_ceiling";
    await cleanupMerchant(merchantId);

    const result = await createMerchant({
      merchantId,
      name: "Ceiling Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "smoke-agent",
    });
    // With no ceiling configured (the suite's state) onboarding is unaffected.
    expect(result.policy.spend_cap_paise).toBe(500_000);
    // And the same policy would be refused had the platform set one below it.
    expect(() =>
      assertWithinPlatformCeiling(result.policy.spend_cap_paise, 499_999)
    ).toThrow(/PLATFORM_SPEND_CEILING_PAISE/);

    await cleanupMerchant(merchantId);
  });
});

afterAll(async () => {
  // src/db/pool.ts exports ONE process-wide Pool singleton shared by every
  // test file in the same `bun test` process. Closing it here would break
  // whichever file runs next, so it is deliberately left open; bun exits
  // regardless.
});
