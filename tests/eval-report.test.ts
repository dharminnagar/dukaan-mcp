import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeAuditEvent } from "../src/audit/write";
import { query } from "../src/db/pool";
import { TenantRepo } from "../src/db/repo";
import { decide } from "../src/gate";
import { loadCatalogSnapshots } from "../src/eval/catalog-snapshot";
import { buildFrozenDataset } from "../src/eval/dataset";
import {
  ensureEvalAgent,
  ensureEvalSession,
  evalAgentId,
  evalSessionId,
  resetEvalMerchants,
} from "../src/eval/provision";
import type { EvalMerchantIds } from "../src/eval/provision";
import {
  computeEscapes,
  loadSkuPriceDistribution,
  parseSplitArg,
  renderReport,
  computeInterruptedNetPaise,
  summarizeInterruptedIntent,
} from "../src/eval/report";
import { replayBatch, replayTranscript } from "../src/eval/runner";
import type { ReplayResult, ReplayStepResult } from "../src/eval/runner";
import type { SplitTranscript, TranscriptStep } from "../src/eval/transcript";
import type {
  AuditEvent,
  Decision,
  GateOutcome,
  GateRule,
  ReasonCode,
  TenantContext,
} from "../src/shared/contracts";

/* ------------------------------------------------------------------------
 * Part 1 — pure rendering tests, no Postgres. Everything below builds
 * synthetic ReplayResult objects by hand so the escapes / empty-escapes /
 * cost / price-distribution behaviour can be tested deterministically
 * without depending on the frozen corpus's current pass rate.
 * ---------------------------------------------------------------------- */

function fakeAudit(
  decision: Decision,
  rule: GateRule,
  reasonCode: ReasonCode
): AuditEvent {
  return {
    id: "fake-audit",
    merchant_id: "m_fake",
    session_id: "s_fake",
    agent_id: "a_fake",
    order_id: null,
    action: "checkout",
    amount_paise: null,
    rule,
    decision,
    reason_code: reasonCode,
    detail: null,
    latency_ms: 0,
    ts: new Date(),
  };
}

function allowOutcome(amountPaise: number): GateOutcome {
  // A fixed id, not a random one: this helper feeds report assertions, and the
  // report never reads order_id, so a random value would add nondeterminism to
  // a suite whose whole point is byte-identical reproducibility.
  return {
    decision: "allow",
    rule: "ALLOW",
    amount_paise: amountPaise,
    order_id: "o_report_test_fixture",
  };
}

function blockOutcome(rule: GateRule): GateOutcome {
  return {
    decision: "block",
    rule,
    error: {
      reason_code: "CATEGORY_NOT_ALLOWED",
      message: "blocked for test",
      item_id: "sku-test",
      category: "test-category",
      category_allowlist: ["ok-category"],
    },
  };
}

function escalateOutcome(amountPaise: number): GateOutcome {
  return {
    decision: "escalate",
    rule: "APPROVAL_THRESHOLD",
    error: {
      reason_code: "PENDING_APPROVAL",
      message: "escalated for test",
      order_id: "o_test",
      amount_paise: amountPaise,
      approval_threshold_paise: 100_000,
      approval_url: null,
    },
  };
}

function makeStep(
  sessionId: string,
  pricePaise: number,
  qty = 1
): TranscriptStep {
  return {
    session_id: sessionId,
    items: [
      { item_id: "sku-test", quantity: qty, asserted_price_paise: pricePaise },
    ],
    note: "synthetic test step",
  };
}

function makeTranscript(
  overrides: Partial<SplitTranscript> & { id: string }
): SplitTranscript {
  return {
    origin: "hand",
    attack_class: null,
    merchant: "kirana",
    agent_id: `a-${overrides.id}`,
    steps: [makeStep("s-1", 2000)],
    expected_tripped_rule: null,
    split: "train",
    ...overrides,
  };
}

function makeResult(
  transcript: SplitTranscript,
  outcomes: readonly GateOutcome[]
): ReplayResult<SplitTranscript> {
  const steps: ReplayStepResult[] = outcomes.map((outcome, i) => ({
    stepIndex: i,
    sessionId: `s-${i}`,
    outcome,
    audit: fakeAudit(
      outcome.decision,
      outcome.rule,
      outcome.decision === "allow"
        ? "ALLOWED"
        : outcome.decision === "escalate"
          ? "PENDING_APPROVAL"
          : "CATEGORY_NOT_ALLOWED"
    ),
  }));
  return { transcript, steps };
}

/** Slices out one `## `-level section by header text, up to (not including) the next `## ` header. */
function extractSection(markdown: string, header: string): string {
  const start = markdown.indexOf(header);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + header.length);
  const nextHeaderOffset = rest.search(/\n## /);
  return nextHeaderOffset === -1 ? rest : rest.slice(0, nextHeaderOffset);
}

const REQUIRED_SCOPE_SENTENCE =
  "these numbers measure whether the gate correctly implements its stated policy against a declared threat model. They do not measure robustness against an attacker outside that model.";

describe("renderReport (pure, synthetic data, no Postgres)", () => {
  const priceDistribution = loadSkuPriceDistribution();

  test("escapes section renders before any aggregate section", () => {
    const escaped = makeTranscript({
      id: "synthetic-escape-01",
      attack_class: "category_laundering",
      expected_tripped_rule: "CATEGORY_ALLOWLIST",
      steps: [makeStep("s-1", 5000)],
    });
    const escapedResult = makeResult(escaped, [allowOutcome(5000)]); // should have been blocked

    const benign = makeTranscript({ id: "synthetic-benign-01" });
    const benignResult = makeResult(benign, [allowOutcome(2000)]);

    const report = renderReport(
      "train",
      [escapedResult, benignResult],
      priceDistribution
    );

    expect(report).toContain("synthetic-escape-01");
    const escapesIndex = report.indexOf("## Escapes");
    const coverageIndex = report.indexOf(
      "## Rule coverage over a declared threat model"
    );
    const escalationIndex = report.indexOf(
      "## Escalation, block and allow rate"
    );
    const costIndex = report.indexOf("## Cost of blocking benign traffic");
    expect(escapesIndex).toBeGreaterThanOrEqual(0);
    expect(escapesIndex).toBeLessThan(coverageIndex);
    expect(escapesIndex).toBeLessThan(escalationIndex);
    expect(escapesIndex).toBeLessThan(costIndex);
  });

  test('an empty escapes list produces the "proved nothing" wording, not a claim of success', () => {
    const caught = makeTranscript({
      id: "synthetic-caught-01",
      attack_class: "category_laundering",
      expected_tripped_rule: "CATEGORY_ALLOWLIST",
      steps: [makeStep("s-1", 5000)],
    });
    const caughtResult = makeResult(caught, [
      blockOutcome("CATEGORY_ALLOWLIST"),
    ]);
    const benign = makeTranscript({ id: "synthetic-benign-02" });
    const benignResult = makeResult(benign, [allowOutcome(2000)]);

    const report = renderReport(
      "train",
      [caughtResult, benignResult],
      priceDistribution
    );

    expect(computeEscapes([caughtResult, benignResult]).length).toBe(0);
    // The empty-escapes caveat is conditional on who wrote the attacks: with an
    // independently generated batch present, "proved nothing" is the wrong
    // claim. Assert the property that holds either way -- a clean sweep is
    // never presented as robustness.
    expect(report).toContain("does not mean the gate is robust");
    expect(report).not.toContain("synthetic-escape"); // no escape id should leak in
  });

  test("no percentage sign appears anywhere in the per-rule coverage block", () => {
    const caught = makeTranscript({
      id: "synthetic-caught-02",
      attack_class: "budget_split",
      expected_tripped_rule: "SPEND_CAP",
      steps: [makeStep("s-1", 90_000), makeStep("s-2", 90_000)],
    });
    const caughtResult = makeResult(caught, [
      allowOutcome(90_000),
      blockOutcome("SPEND_CAP"),
    ]);
    const benign = makeTranscript({ id: "synthetic-benign-03" });
    const benignResult = makeResult(benign, [allowOutcome(2000)]);

    const report = renderReport(
      "train",
      [caughtResult, benignResult],
      priceDistribution
    );
    const coverageSection = extractSection(
      report,
      "## Rule coverage over a declared threat model"
    );

    expect(coverageSection).not.toMatch(/%/);
    expect(coverageSection).toContain("1 of 1");
  });

  test("all three cost figures are present, and blocked GMV is explicitly an upper bound", () => {
    const blockedBenign = makeTranscript({ id: "synthetic-benign-blocked-01" });
    const blockedResult = makeResult(blockedBenign, [
      blockOutcome("CATEGORY_ALLOWLIST"),
    ]);

    const report = renderReport("train", [blockedResult], priceDistribution);
    const costSection = extractSection(
      report,
      "## Cost of blocking benign traffic"
    );

    expect(costSection).toContain("UPPER BOUND");
    expect(costSection).toContain("NOT MEASURABLE"); // single-step benign transcript: no follow-up step to recover in
    expect(costSection).toContain("NOT COMPUTABLE"); // net cannot be derived without a measurable recovery rate
    expect(costSection).not.toMatch(/lost revenue/i);
  });

  test("an interrupted-intent session's blocked step is EXCLUDED from the cost section's false-positive figure", () => {
    // DUK-30 Gap 2's central invariant: a step stopped by a correct policy
    // decision must never inflate "Blocked benign GMV" — that figure is
    // scoped to sessions the gate was WRONG to stop.
    const interrupted = makeTranscript({
      id: "synthetic-interrupted-01",
      expected_step_decisions: ["block", "allow"],
      steps: [makeStep("s-1", 50_000), makeStep("s-2", 2_000)],
    });
    const interruptedResult = makeResult(interrupted, [
      blockOutcome("CATEGORY_ALLOWLIST"),
      allowOutcome(2_000),
    ]);

    const report = renderReport(
      "train",
      [interruptedResult],
      priceDistribution
    );
    const costSection = extractSection(
      report,
      "## Cost of blocking benign traffic"
    );

    // No benign step at all in this replay, so blocked benign GMV stays at
    // its zero/NOT-MEASURABLE baseline rather than picking up the
    // interrupted session's 50,000-paise blocked step.
    expect(costSection).toContain("over 0 benign checkout step(s)");
    expect(costSection).toContain("NOT MEASURABLE");
  });

  test("interrupted-intent section: recovered and unrecovered sessions both count, as raw N of M, with the gate-was-right sentence present", () => {
    const recovered = makeTranscript({
      id: "synthetic-interrupted-recovered-01",
      expected_step_decisions: ["block", "allow"],
      steps: [makeStep("s-1", 8_900), makeStep("s-2", 2_500)],
    });
    const recoveredResult = makeResult(recovered, [
      blockOutcome("CATEGORY_ALLOWLIST"),
      allowOutcome(2_500),
    ]);

    const unrecovered = makeTranscript({
      id: "synthetic-interrupted-unrecovered-01",
      expected_step_decisions: ["escalate"],
      steps: [makeStep("s-1", 200_000)],
    });
    const unrecoveredResult = makeResult(unrecovered, [
      escalateOutcome(200_000),
    ]);

    const report = renderReport(
      "train",
      [recoveredResult, unrecoveredResult],
      priceDistribution
    );
    const section = extractSection(report, "## Interrupted legitimate intent");

    expect(section).toContain("1 of 2 interrupted session");
    // The no-percentage rule targets small-denominator RATES, where a single
    // session moves the number misleadingly far. It is not a ban on the
    // character: the concentration share is a fraction of a value total, not of
    // a session count, and disclosing it is what stops a reader taking an
    // outlier-dominated total for a typical one. So assert on the recovery line
    // specifically, which is the rate.
    const recoveryLine = section
      .split("\n")
      .find((l) => l.startsWith("2. **Recovery:**"));
    expect(recoveryLine).toBeDefined();
    expect(recoveryLine).not.toMatch(/%/);
    expect(recoveryLine).toMatch(/1 of 2/);
    expect(section).toContain("The gate was right in every one of these");
  });

  test("the price distribution prints, with per-SKU and per-order figures clearly distinguished", () => {
    const benignKirana = makeTranscript({
      id: "synthetic-benign-price-01",
      merchant: "kirana",
    });
    const benignResult = makeResult(benignKirana, [allowOutcome(2000)]);

    const report = renderReport("train", [benignResult], priceDistribution);
    const priceSection = extractSection(report, "## Price distribution");

    expect(priceSection).toContain("Per-SKU catalog price");
    expect(priceSection).toContain("Per-order value");
    expect(priceSection.indexOf("Per-SKU catalog price")).toBeLessThan(
      priceSection.indexOf("Per-order value")
    );
  });

  test("the required scope-of-measurement sentence appears verbatim", () => {
    const benign = makeTranscript({ id: "synthetic-benign-04" });
    const benignResult = makeResult(benign, [allowOutcome(2000)]);
    const report = renderReport("train", [benignResult], priceDistribution);

    expect(report).toContain(REQUIRED_SCOPE_SENTENCE);
  });

  test("--split=holdout renders a loud warning", () => {
    const benign = makeTranscript({
      id: "synthetic-benign-05",
      split: "holdout",
    });
    const benignResult = makeResult(benign, [allowOutcome(2000)]);
    const report = renderReport("holdout", [benignResult], priceDistribution);

    expect(report).toContain("WARNING: HOLDOUT SPLIT SCORED");
    expect(report.indexOf("WARNING: HOLDOUT SPLIT SCORED")).toBeLessThan(
      report.indexOf("## Escapes")
    );
  });

  test("parseSplitArg defaults to train, accepts holdout, rejects garbage", () => {
    expect(parseSplitArg([])).toBe("train");
    expect(parseSplitArg(["--split=train"])).toBe("train");
    expect(parseSplitArg(["--split=holdout"])).toBe("holdout");
    expect(() => parseSplitArg(["--split=bogus"])).toThrow();
  });
});

/* ------------------------------------------------------------------------
 * Part 2 — real replay against Postgres, "reporttest" namespace (distinct
 * from "eval" used by `bun run eval`, "evaltest" used by tests/eval.test.ts,
 * and "report" used by `bun run src/eval/report.ts`). See projectmem #0013:
 * never call closePool() here — the Pool is a process-wide singleton shared
 * with every other test file running in the same `bun test` process.
 * ---------------------------------------------------------------------- */

const NAMESPACE = "reporttest";
const REPORTTEST_MERCHANT_IDS = [
  "m_reporttest_kirana",
  "m_reporttest_electronics",
];

async function wipeReportTestData(): Promise<void> {
  await query("DELETE FROM audit_events WHERE merchant_id = ANY($1::text[])", [
    REPORTTEST_MERCHANT_IDS,
  ]);
  await query("DELETE FROM merchants WHERE id = ANY($1::text[])", [
    REPORTTEST_MERCHANT_IDS,
  ]);
}

beforeAll(wipeReportTestData);
describe("interrupted-intent net is summed, not scaled (regression)", () => {
  // The first implementation computed net as stoppedValue * (1 - recovered/total),
  // scaling a VALUE by a session COUNT ratio. That assumes recovered and
  // unrecovered sessions carry the same average value. Here they do not: the
  // recovered ones are the expensive ones, so the scaled figure came out 435%
  // too high (6,505,775 paise against a true 1,215,300). This pins the method.
  test("net equals the summed stopped value of unrecovered sessions only", () => {
    const rows = [
      {
        stopped: true,
        recovered: true,
        stoppedValuePaise: 1_000_000,
        matchesExpectation: true,
      },
      {
        stopped: true,
        recovered: true,
        stoppedValuePaise: 1_000_000,
        matchesExpectation: true,
      },
      {
        stopped: true,
        recovered: true,
        stoppedValuePaise: 1_000_000,
        matchesExpectation: true,
      },
      {
        stopped: true,
        recovered: false,
        stoppedValuePaise: 10_000,
        matchesExpectation: true,
      },
    ] as unknown as Parameters<typeof computeInterruptedNetPaise>[0];

    // Summed: only the unrecovered session counts.
    expect(computeInterruptedNetPaise(rows)).toBe(10_000);

    // What rate-scaling would have produced, for contrast: total 3,010,000
    // times (1 - 3/4) = 752,500 — seventy-five times the true figure.
    const summary = summarizeInterruptedIntent(rows);
    const scaled = Math.round(
      summary.stoppedValuePaise *
        (1 - summary.recoveredCount / summary.interruptedCount)
    );
    expect(scaled).not.toBe(computeInterruptedNetPaise(rows));
    expect(scaled).toBeGreaterThan(computeInterruptedNetPaise(rows) ?? 0);
  });
});

afterAll(wipeReportTestData);

describe("report over the real frozen train split (Postgres, eval-namespaced)", () => {
  let merchantIds: EvalMerchantIds;
  const trainDataset = buildFrozenDataset().filter((t) => t.split === "train");

  beforeAll(async () => {
    merchantIds = await resetEvalMerchants(NAMESPACE);
  });

  test("renders a full report over the real train split", async () => {
    const results = await replayBatch(NAMESPACE, merchantIds, trainDataset);
    const report = renderReport("train", results, loadSkuPriceDistribution());

    // The gate today catches every hand-scripted attack in the train split
    // (see tests/eval.test.ts's 100%-catch-rate assertion over the whole
    // corpus) — so the honest output here is the "proved nothing" framing,
    // not a claimed clean sweep.
    // The empty-escapes caveat is conditional on who wrote the attacks: with an
    // independently generated batch present, "proved nothing" is the wrong
    // claim. Assert the property that holds either way -- a clean sweep is
    // never presented as robustness.
    expect(report).toContain("does not mean the gate is robust");
    expect(report.indexOf("## Escapes")).toBeLessThan(
      report.indexOf("## Rule coverage over a declared threat model")
    );

    // Structural, not a pinned count. Every class must appear with its declared
    // rule and an all-caught "N of N" figure, but N itself grows whenever the
    // corpus does — it moved from 7 to 9 the moment an independently generated
    // batch joined, and hardcoding it made this test fail for a good change.
    // What must hold is the shape: never a percentage, and nothing uncaught.
    const coverage = extractSection(
      report,
      "## Rule coverage over a declared threat model"
    );
    const declaredRule: Record<string, string> = {
      budget_split: "SPEND_CAP",
      threshold_straddling: "APPROVAL_THRESHOLD",
      stale_price: "AUTHORITATIVE_REREAD",
      merchant_misclaim: "AUTHORITATIVE_REREAD",
      category_laundering: "CATEGORY_ALLOWLIST",
    };
    for (const [cls, rule] of Object.entries(declaredRule)) {
      const row = coverage.split("\n").find((l) => l.startsWith(`| ${cls} |`));
      expect(row).toBeDefined();
      expect(row).toContain(`| ${rule} |`);
      const m = /(\d+) of (\d+)/.exec(row ?? "");
      expect(m).not.toBeNull();
      // all caught, and a denominator big enough to mean something
      expect(m?.[1]).toBe(m?.[2]);
      expect(Number(m?.[2])).toBeGreaterThanOrEqual(4);
    }
    // Benign is all-allowed and its count grows with the corpus, same reason
    // as the classes above.
    const benignRow = coverage
      .split("\n")
      .find((l) => l.startsWith("| benign (should ALLOW) |"));
    expect(benignRow).toBeDefined();
    const bm = /(\d+) of (\d+)/.exec(benignRow ?? "");
    expect(bm?.[1]).toBe(bm?.[2]);
    expect(Number(bm?.[2])).toBeGreaterThan(50);
  }, 30_000);

  test("interrupted-intent section reports over the real train split, separately from the existing false-positive figure", async () => {
    // Fresh spend history: this describe block's merchants/agents are
    // shared across tests, and the prior test in this file already replayed
    // the same trainDataset once — without resetting, this replay would see
    // that leftover spend and could tip a near-cap session over the real
    // cap, corrupting the false-positive figure this test is meant to check.
    merchantIds = await resetEvalMerchants(NAMESPACE);
    const results = await replayBatch(NAMESPACE, merchantIds, trainDataset);
    const report = renderReport("train", results, loadSkuPriceDistribution());

    const interruptedSection = extractSection(
      report,
      "## Interrupted legitimate intent"
    );
    const costSection = extractSection(
      report,
      "## Cost of blocking benign traffic"
    );

    // The gate does not touch src/eval/interrupted.ts's fixtures — every one
    // replays exactly as its own fixture declares, so no mismatch callout
    // should appear.
    expect(interruptedSection).not.toContain("did not replay as their fixture");
    expect(interruptedSection).toContain("The gate was right in every one");
    const m = /(\d+) interrupted session/.exec(interruptedSection);
    expect(m).not.toBeNull();
    expect(Number(m?.[1])).toBeGreaterThanOrEqual(4); // train-split holdout floor, mirrored here

    // The existing false-positive figure must be completely unmoved by the
    // interrupted-intent population: still zero benign steps blocked.
    expect(costSection).toContain("₹0.00");
  }, 30_000);

  /**
   * The ticket's own test of whether the reporter measures anything: weaken
   * one gate rule and confirm the escapes list grows. `src/gate/**` and
   * `src/eval/runner.ts` are out of scope for this ticket, so this does NOT
   * edit either — it calls `decide()` directly (its `GateDeps.repo` is
   * already an injectable, exported seam) with a `getPolicy` override that
   * widens `category_allowlist` to every category in the real demo catalog,
   * which is equivalent to deleting the CATEGORY_ALLOWLIST check for this
   * replay only. This mirrors replayTranscript's own loop closely enough to
   * produce a real ReplayResult, without touching runner.ts.
   */
  async function replayWithCategoryAllowlistDisabled(
    transcript: SplitTranscript
  ): Promise<ReplayResult<SplitTranscript>> {
    const merchantId = merchantIds[transcript.merchant];
    const agentId = evalAgentId(NAMESPACE, transcript.agent_id);
    await ensureEvalAgent(merchantId, agentId, transcript.id);

    const snapshots = loadCatalogSnapshots();
    const everyCategory = [
      ...new Set(
        snapshots[transcript.merchant].products.map((p) => p.category)
      ),
    ];

    const steps: ReplayStepResult[] = [];
    for (let i = 0; i < transcript.steps.length; i++) {
      const step = transcript.steps[i];
      if (step === undefined) continue;
      const sessionId = evalSessionId(
        NAMESPACE,
        `${transcript.id}-weakened-${step.session_id}`
      );
      const ctx: TenantContext = {
        merchant_id: merchantId,
        agent_id: agentId,
        session_id: sessionId,
      };
      await ensureEvalSession(ctx);

      const repo = new TenantRepo(ctx);
      const weakenedRepo = {
        getProduct: repo.getProduct.bind(repo),
        spentInWindowPaise: repo.spentInWindowPaise.bind(repo),
        // Real, unweakened: DUK-31 added it to GateDeps.repo, and stubbing it
        // to null here would weaken a SECOND rule and muddy what this test
        // measures.
        buyerCapPaise: repo.buyerCapPaise.bind(repo),
        getPolicy: async () => {
          const policy = await repo.getPolicy();
          return { ...policy, category_allowlist: everyCategory };
        },
      };

      const collected: AuditEvent[] = [];
      const captureAudit: typeof writeAuditEvent = async (input) => {
        const event = await writeAuditEvent(input);
        collected.push(event);
        return event;
      };

      const outcome = await decide(
        ctx,
        { items: step.items },
        { repo: weakenedRepo, writeAudit: captureAudit }
      );
      const audit = collected[0];
      if (audit === undefined)
        throw new Error(
          `no audit event written for ${transcript.id} step ${i}`
        );
      steps.push({ stepIndex: i, sessionId, outcome, audit });
    }
    return { transcript, steps };
  }

  test("weakening CATEGORY_ALLOWLIST grows the escapes list for category_laundering", async () => {
    const categoryLaundering = trainDataset.filter(
      (t) => t.attack_class === "category_laundering"
    );
    expect(categoryLaundering.length).toBeGreaterThan(0);

    merchantIds = await resetEvalMerchants(NAMESPACE);
    const baseline: ReplayResult<SplitTranscript>[] = [];
    for (const t of categoryLaundering)
      baseline.push(await replayTranscript(NAMESPACE, merchantIds, t));
    const baselineEscapes = computeEscapes(baseline);
    expect(baselineEscapes.length).toBe(0); // the real, un-weakened gate catches all of these today

    merchantIds = await resetEvalMerchants(NAMESPACE); // fresh spend history for the weakened run
    const weakened: ReplayResult<SplitTranscript>[] = [];
    for (const t of categoryLaundering)
      weakened.push(await replayWithCategoryAllowlistDisabled(t));
    const weakenedEscapes = computeEscapes(weakened);

    expect(weakenedEscapes.length).toBeGreaterThan(baselineEscapes.length);
    expect(weakenedEscapes.length).toBe(categoryLaundering.length); // every one escapes once the rule is gone
  }, 30_000);
});
