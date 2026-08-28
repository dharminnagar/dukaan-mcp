/**
 * `effectiveCap` (src/gate/limits.ts) is pure, so this file is too: no
 * Postgres, no pool import, no fixtures. Every case is a table row.
 *
 * Two properties are worth more than any single row and are asserted over the
 * whole grid at the bottom:
 *   1. `cap_paise` is the minimum of the caps that are present.
 *   2. `bound_by` names a party whose own cap EQUALS `cap_paise` — so the
 *      reported party can never be one that did not actually bind.
 *
 * The tie rule under test is deliberate, not incidental: ties resolve to the
 * earliest of buyer, merchant, platform, so a shared figure is attributed to
 * the party being protected rather than the one being restrained.
 */
import { describe, expect, test } from "bun:test";
import { parsePositivePaiseEnv } from "../src/config";
import { effectiveCap, exceedsMerchantTotalCap } from "../src/gate/limits";
import type { CapParty } from "../src/gate/limits";
import {
  BindingPartyCode,
  SpendCapExceededError,
} from "../src/shared/contracts";

interface Row {
  readonly name: string;
  readonly buyer: number | null;
  readonly merchant: number;
  readonly platform: number | null;
  readonly cap: number;
  readonly bound: CapParty;
}

const TABLE: readonly Row[] = [
  // ---- nothing but the merchant: the behaviour that predates all of this ---
  {
    name: "buyer null, platform null -> merchant, unchanged from before",
    buyer: null,
    merchant: 100_000,
    platform: null,
    cap: 100_000,
    bound: "merchant",
  },

  // ---- buyer only ---------------------------------------------------------
  {
    name: "buyer below merchant -> buyer",
    buyer: 40_000,
    merchant: 100_000,
    platform: null,
    cap: 40_000,
    bound: "buyer",
  },
  {
    name: "buyer above merchant -> merchant",
    buyer: 250_000,
    merchant: 100_000,
    platform: null,
    cap: 100_000,
    bound: "merchant",
  },
  {
    name: "TIE buyer == merchant -> buyer, the protected party",
    buyer: 100_000,
    merchant: 100_000,
    platform: null,
    cap: 100_000,
    bound: "buyer",
  },

  // ---- platform only ------------------------------------------------------
  {
    name: "platform below merchant -> platform",
    buyer: null,
    merchant: 100_000,
    platform: 60_000,
    cap: 60_000,
    bound: "platform",
  },
  {
    name: "platform above merchant -> merchant",
    buyer: null,
    merchant: 100_000,
    platform: 500_000,
    cap: 100_000,
    bound: "merchant",
  },
  {
    name: "TIE merchant == platform -> merchant, the earlier party",
    buyer: null,
    merchant: 100_000,
    platform: 100_000,
    cap: 100_000,
    bound: "merchant",
  },

  // ---- all three present --------------------------------------------------
  {
    name: "buyer lowest of three -> buyer",
    buyer: 10_000,
    merchant: 50_000,
    platform: 90_000,
    cap: 10_000,
    bound: "buyer",
  },
  {
    name: "merchant lowest of three -> merchant",
    buyer: 90_000,
    merchant: 10_000,
    platform: 50_000,
    cap: 10_000,
    bound: "merchant",
  },
  {
    name: "platform lowest of three -> platform, overriding a merchant that set itself more",
    buyer: 90_000,
    merchant: 50_000,
    platform: 10_000,
    cap: 10_000,
    bound: "platform",
  },
  {
    name: "TIE all three equal -> buyer",
    buyer: 70_000,
    merchant: 70_000,
    platform: 70_000,
    cap: 70_000,
    bound: "buyer",
  },
  {
    name: "TIE buyer == merchant, both under platform -> buyer",
    buyer: 70_000,
    merchant: 70_000,
    platform: 90_000,
    cap: 70_000,
    bound: "buyer",
  },
  {
    name: "TIE merchant == platform, both under buyer -> merchant",
    buyer: 90_000,
    merchant: 70_000,
    platform: 70_000,
    cap: 70_000,
    bound: "merchant",
  },
  {
    name: "TIE buyer == platform, both under merchant -> buyer",
    buyer: 70_000,
    merchant: 90_000,
    platform: 70_000,
    cap: 70_000,
    bound: "buyer",
  },
  {
    name: "platform below a buyer that is itself below the merchant -> platform",
    buyer: 50_000,
    merchant: 90_000,
    platform: 20_000,
    cap: 20_000,
    bound: "platform",
  },
  {
    name: "buyer below a platform that is itself below the merchant -> buyer",
    buyer: 20_000,
    merchant: 90_000,
    platform: 50_000,
    cap: 20_000,
    bound: "buyer",
  },

  // ---- one paise, because off-by-ones are where caps actually fail --------
  {
    name: "buyer one paise under merchant -> buyer",
    buyer: 99_999,
    merchant: 100_000,
    platform: null,
    cap: 99_999,
    bound: "buyer",
  },
  {
    name: "buyer one paise over merchant -> merchant",
    buyer: 100_001,
    merchant: 100_000,
    platform: null,
    cap: 100_000,
    bound: "merchant",
  },
  {
    name: "platform one paise under merchant -> platform",
    buyer: null,
    merchant: 100_000,
    platform: 99_999,
    cap: 99_999,
    bound: "platform",
  },
  {
    name: "platform one paise over merchant -> merchant",
    buyer: null,
    merchant: 100_000,
    platform: 100_001,
    cap: 100_000,
    bound: "merchant",
  },
];

describe("effectiveCap truth table", () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const result = effectiveCap(row.buyer, row.merchant, row.platform);
      expect(result.cap_paise).toBe(row.cap);
      expect(result.bound_by).toBe(row.bound);
    });
  }

  test("every BindingParty is reachable — the table is not silently testing two of three", () => {
    const reached = new Set(
      TABLE.map(
        (row) => effectiveCap(row.buyer, row.merchant, row.platform).bound_by
      )
    );
    expect([...reached].sort()).toEqual(["buyer", "merchant", "platform"]);
  });
});

describe("effectiveCap properties over a grid", () => {
  const VALUES: readonly number[] = [1, 999, 10_000, 10_001, 70_000, 100_000];
  const NULLABLE: readonly (number | null)[] = [null, ...VALUES];

  test("cap_paise is always the minimum of the caps actually present", () => {
    for (const buyer of NULLABLE) {
      for (const merchant of VALUES) {
        for (const platform of NULLABLE) {
          const present = [buyer, merchant, platform].filter(
            (v): v is number => v !== null
          );
          const result = effectiveCap(buyer, merchant, platform);
          expect(result.cap_paise).toBe(Math.min(...present));
        }
      }
    }
  });

  test("bound_by always names a party whose own cap equals the effective cap", () => {
    for (const buyer of NULLABLE) {
      for (const merchant of VALUES) {
        for (const platform of NULLABLE) {
          const result = effectiveCap(buyer, merchant, platform);
          const byParty: Record<CapParty, number | null> = {
            buyer,
            merchant,
            platform,
          };
          expect(byParty[result.bound_by]).toBe(result.cap_paise);
        }
      }
    }
  });

  test("a null party is NEVER reported as the binding one", () => {
    for (const merchant of VALUES) {
      expect(effectiveCap(null, merchant, null).bound_by).toBe("merchant");
      for (const other of VALUES) {
        expect(effectiveCap(null, merchant, other).bound_by).not.toBe("buyer");
        expect(effectiveCap(other, merchant, null).bound_by).not.toBe(
          "platform"
        );
      }
    }
  });
});

describe("the wire shape accepts what effectiveCap produces", () => {
  test("every bound_by the truth table produces parses as a BindingPartyCode", () => {
    for (const row of TABLE) {
      const { bound_by } = effectiveCap(row.buyer, row.merchant, row.platform);
      expect(BindingPartyCode.parse(bound_by)).toBe(bound_by);
    }
  });

  test("a SPEND_CAP_EXCEEDED payload carrying all three inputs round-trips", () => {
    const cap = effectiveCap(40_000, 100_000, 60_000);
    const parsed = SpendCapExceededError.parse({
      reason_code: "SPEND_CAP_EXCEEDED",
      message: "blocked",
      cap_paise: cap.cap_paise,
      bound_by: cap.bound_by,
      buyer_cap_paise: 40_000,
      merchant_cap_paise: 100_000,
      platform_ceiling_paise: 60_000,
      spent_paise: 0,
      remaining_budget_paise: 40_000,
      attempted_paise: 45_000,
      window_seconds: 3600,
      merchant_total_cap_paise: null,
      merchant_total_spent_paise: null,
    });
    expect(parsed.bound_by).toBe("buyer");
    expect(parsed.cap_paise).toBe(40_000);
  });

  test("a null buyer cap and a null platform ceiling are both valid on the wire", () => {
    const parsed = SpendCapExceededError.parse({
      reason_code: "SPEND_CAP_EXCEEDED",
      message: "blocked",
      cap_paise: 100_000,
      bound_by: "merchant",
      buyer_cap_paise: null,
      merchant_cap_paise: 100_000,
      platform_ceiling_paise: null,
      spent_paise: 100_000,
      remaining_budget_paise: 0,
      attempted_paise: 1,
      window_seconds: 3600,
      merchant_total_cap_paise: null,
      merchant_total_spent_paise: null,
    });
    expect(parsed.buyer_cap_paise).toBeNull();
    expect(parsed.platform_ceiling_paise).toBeNull();
  });

  test("a merchant_total block round-trips with the aggregate figures set", () => {
    const parsed = SpendCapExceededError.parse({
      reason_code: "SPEND_CAP_EXCEEDED",
      message: "blocked by the aggregate cap",
      cap_paise: 500_000,
      bound_by: "merchant_total",
      buyer_cap_paise: null,
      merchant_cap_paise: 300_000,
      platform_ceiling_paise: null,
      spent_paise: 480_000,
      remaining_budget_paise: 20_000,
      attempted_paise: 50_000,
      window_seconds: 3600,
      merchant_total_cap_paise: 500_000,
      merchant_total_spent_paise: 480_000,
    });
    expect(parsed.bound_by).toBe("merchant_total");
    // An aggregate cap TIGHTER than one agent's per-agent cap is legal, and the
    // wire shape must not quietly reject it: 500_000 total against a 300_000
    // per-agent figure only looks inverted if you assume the two bound the same
    // total, which is exactly the confusion `bound_by` exists to settle.
    expect(parsed.merchant_total_cap_paise).toBe(500_000);
    expect(parsed.remaining_budget_paise).toBe(
      parsed.merchant_total_cap_paise! - parsed.merchant_total_spent_paise!
    );
  });
});

/**
 * The aggregate bound. `effectiveCap` cannot express it — those three caps all
 * bound ONE agent and reduce to a minimum, while this is measured against the
 * sum over every agent — so it is a separate predicate with its own boundary.
 */
describe("exceedsMerchantTotalCap", () => {
  test("null never blocks, whatever the figures", () => {
    expect(exceedsMerchantTotalCap(0, 1, null)).toBe(false);
    expect(exceedsMerchantTotalCap(999_999_999, 999_999_999, null)).toBe(false);
  });

  test("boundary: exactly AT the cap is allowed", () => {
    // 90_000 already spent + 10_000 attempted == a 100_000 cap. `>` not `>=`,
    // the same boundary the per-agent check uses, so a merchant who sizes an
    // order to land exactly on their cap is not blocked for arithmetic reasons.
    expect(exceedsMerchantTotalCap(90_000, 10_000, 100_000)).toBe(false);
  });

  test("boundary: ONE paise over is blocked", () => {
    expect(exceedsMerchantTotalCap(90_000, 10_001, 100_000)).toBe(true);
  });

  test("an aggregate cap tighter than any one agent's cap still binds", () => {
    // The whole point: each agent is under its own 300_000 cap, but the
    // merchant capped the total at 100_000 and the sum has reached it.
    expect(exceedsMerchantTotalCap(100_000, 1, 100_000)).toBe(true);
  });

  test("spend already past the cap keeps blocking rather than wrapping", () => {
    expect(exceedsMerchantTotalCap(150_000, 1, 100_000)).toBe(true);
  });
});

/**
 * The platform ceiling is the one cap that comes from deployment config rather
 * than from a table, so its PARSER is the place a bad figure gets in. Tested
 * through the exported pure function, not by mutating process.env: `env` is
 * evaluated once at import and a test that re-imported it would be testing
 * module caching.
 */
describe("PLATFORM_SPEND_CEILING_PAISE parsing", () => {
  const NAME = "PLATFORM_SPEND_CEILING_PAISE";

  test("unset, empty, and whitespace-only all mean no ceiling", () => {
    expect(parsePositivePaiseEnv(NAME, undefined)).toBeNull();
    expect(parsePositivePaiseEnv(NAME, "")).toBeNull();
    expect(parsePositivePaiseEnv(NAME, "   ")).toBeNull();
  });

  test("a positive integer parses to that many paise", () => {
    expect(parsePositivePaiseEnv(NAME, "250000")).toBe(250_000);
    expect(parsePositivePaiseEnv(NAME, " 1 ")).toBe(1);
  });

  test("a decimal is REJECTED rather than truncated — parseInt('2500.75') would silently be 2500", () => {
    expect(() => parsePositivePaiseEnv(NAME, "2500.75")).toThrow(NAME);
    expect(() => parsePositivePaiseEnv(NAME, "2500.00")).toThrow(NAME);
  });

  test("trailing junk is rejected rather than partially parsed", () => {
    expect(() => parsePositivePaiseEnv(NAME, "250000paise")).toThrow(NAME);
    expect(() => parsePositivePaiseEnv(NAME, "2e5")).toThrow(NAME);
    expect(() => parsePositivePaiseEnv(NAME, "abc")).toThrow(NAME);
  });

  test("zero and negatives are rejected: a ceiling of 0 would block every order", () => {
    expect(() => parsePositivePaiseEnv(NAME, "0")).toThrow(NAME);
    expect(() => parsePositivePaiseEnv(NAME, "-1")).toThrow(NAME);
  });

  test("beyond Number.MAX_SAFE_INTEGER is rejected, not silently rounded", () => {
    expect(() => parsePositivePaiseEnv(NAME, "9007199254740993")).toThrow(NAME);
  });

  test("absence parses to null rather than throwing", () => {
    // The reproducibility claim depends on this: `bun run eval` on a fresh
    // clone with no ceiling configured must print the same numbers, not throw
    // at boot.
    expect(parsePositivePaiseEnv(NAME, undefined)).toBeNull();
    expect(parsePositivePaiseEnv(NAME, "")).toBeNull();
    expect(parsePositivePaiseEnv(NAME, "   ")).toBeNull();
  });

  test("config never makes the ceiling required", async () => {
    /**
     * Checked over the SOURCE, not over `process.env`. The earlier version of
     * this test asserted the variable was unset in the ambient environment,
     * which passed only for as long as nobody actually configured the feature
     * — it broke the moment the ceiling was switched on locally, and would
     * have broken any CI that sets it. Ambient state is not the invariant.
     *
     * The real regression to catch is someone moving this name under
     * `required()`, which would turn a fresh clone's `bun run eval` from
     * "prints the same numbers" into "throws at boot".
     */
    const src = await Bun.file(
      new URL("../src/config.ts", import.meta.url)
    ).text();
    const flat = src.replace(/\s+/g, " ");

    expect(flat).not.toMatch(
      /required\(\s*["']PLATFORM_SPEND_CEILING_PAISE["']\s*\)/
    );
    expect(flat).toContain("parsePositivePaiseEnv(");
  });
});

describe("buyer_cap_paise immutability is enforced, not just intended", () => {
  /**
   * The buyer cap is worth nothing unless the party it limits cannot raise it.
   * migrations/0002 states that guarantee and argues, reasonably, against a
   * BEFORE UPDATE trigger: a deployment that mints tokens from the buyer's side
   * wants its own write path to that column, and a trigger would block it.
   *
   * That leaves the guarantee resting on "nothing in src/ issues such an
   * UPDATE", which is true and completely unenforced. One helpful patch adding
   * an "edit agent limits" endpoint would silently hollow out the claim while
   * every test stayed green.
   *
   * So the convention is checked the same way this repo already guards its
   * other conventions (see the bare-PORT guard in tests/web-onboard.test.ts and
   * the gate-identifier guard over the eval prompt): statically, over the
   * source, so a regression turns the suite red rather than going quietly
   * false. This is deliberately weaker than a database constraint, and the
   * README should say so in those words rather than implying the column is
   * immutable at rest.
   */
  test("no code path in src/ updates buyer_cap_paise after mint", async () => {
    const { Glob } = await import("bun");
    const offenders: string[] = [];

    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const src = await Bun.file(file).text();
      // Collapse whitespace so a statement broken across lines is still caught.
      const flat = src.replace(/\s+/g, " ");
      const updates = flat.match(/UPDATE\s+agents[^;`"']*/gi) ?? [];
      for (const stmt of updates) {
        if (/buyer_cap_paise/i.test(stmt))
          offenders.push(`${file}: ${stmt.slice(0, 90)}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("only the two provisioning paths set the column; the eval provisioner leaves it null", async () => {
    const { Glob } = await import("bun");
    const inserters: string[] = [];
    const settersOfColumn: string[] = [];

    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const flat = (await Bun.file(file).text()).replace(/\s+/g, " ");
      const inserts =
        flat.match(/INSERT\s+INTO\s+agents\s*\(([^)]*)\)/gi) ?? [];
      if (inserts.length === 0) continue;
      inserters.push(file);
      if (inserts.some((stmt) => /buyer_cap_paise/i.test(stmt))) {
        settersOfColumn.push(file);
      }
    }

    expect(inserters.sort()).toEqual([
      "src/buyer/provision.ts",
      "src/eval/provision.ts",
      "src/onboard/create-merchant.ts",
    ]);

    // The second half is the load-bearing one. `src/eval/provision.ts` must
    // never populate this column: leaving it NULL is what keeps every frozen
    // transcript on the original two-party path, and is why `bun run eval`
    // output is byte-identical across DUK-31. A well-meaning addition of a
    // buyer cap to the eval fixtures would move published numbers under a
    // holdout split that is scored exactly once.
    expect(settersOfColumn.sort()).toEqual([
      "src/buyer/provision.ts",
      "src/onboard/create-merchant.ts",
    ]);
  });
});
