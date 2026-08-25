/**
 * `bun run src/eval/report.ts [--split=train|holdout]` — the DUK-19 metrics
 * reporter. Replays one split of the frozen dataset against the real gate
 * and renders a Markdown report designed against one failure mode: a
 * volunteered metric that overclaims and gets torn apart. Concretely, in
 * priority order (see the ticket for the full rationale):
 *
 *   1. Escapes print BEFORE any aggregate — a non-empty escapes list is what
 *      makes every later number believable, and an empty one is called out
 *      as proving nothing rather than dressed up as a clean sweep.
 *   2. Per-class results are raw "N of M caught" integers, never a
 *      percentage — the per-class denominator here is ~5 to ~12.
 *   3. "Rule coverage over a declared threat model", not precision/recall —
 *      these are hand-written thresholds and allowlists, not fitted
 *      parameters.
 *   4. Escalation/block/allow counts print alongside coverage, so a gate
 *      that just escalated or blocked everything would visibly cost
 *      something instead of reading as a free win.
 *   5. Three cost figures together (upper-bound blocked GMV, recovery rate,
 *      net) — never a single "₹X lost" headline the data cannot support.
 *   6. The seeded price distribution is published so a reader can rescale.
 *   7. A fixed disclaimer sentence about what these numbers do and do not
 *      measure.
 *
 * Does NOT extend src/eval/metrics.ts: `scoreReplay`/`summarizeBySplit`
 * already produce exactly the raw caught/total integers the per-class
 * section needs. Everything new here — escapes, cost figures, price stats,
 * outcome counts, origin breakdown — is report-specific presentation logic,
 * not a reusable scoring primitive, so it lives in this file instead.
 *
 * TRAIN SPLIT ONLY BY DEFAULT. The held-out split is scored exactly once, at
 * DUK-20 (Day 10) — see FREEZE_NOTE in ./dataset.ts. Passing --split=holdout
 * prints a loud warning both to stderr and inside the report body itself.
 *
 * Money is integer paise everywhere in this file except at the final
 * `formatRupees` call, matching the project-wide convention.
 */
import { readFileSync } from "node:fs";
import { closePool } from "../db/pool";
import type { GateRule, LineItem } from "../shared/contracts";
import { buildFrozenDataset } from "./dataset";
import { scoreReplay, summarizeBySplit } from "./metrics";
import { resetEvalMerchants } from "./provision";
import { replayBatch } from "./runner";
import type { ReplayResult, ReplayStepResult } from "./runner";
import { EVAL_MERCHANTS, ORIGINS } from "./transcript";
import type {
  AttackClass,
  EvalMerchant,
  Origin,
  Split,
  SplitTranscript,
} from "./transcript";

const REQUIRED_SCOPE_SENTENCE =
  "these numbers measure whether the gate correctly implements its stated policy against a declared threat model. They do not measure robustness against an attacker outside that model.";

function stepValuePaise(step: { readonly items: readonly LineItem[] }): number {
  return step.items.reduce(
    (sum, item) => sum + item.quantity * item.asserted_price_paise,
    0
  );
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

/* --------------------------------------------------------------- escapes */

/**
 * "Escaped" means the transcript's own ground truth (`expected_tripped_rule`)
 * was not the rule that actually fired on its last step — whether the final
 * step was ALLOWed outright, or blocked/escalated by some other rule than
 * the one the fixture was built to exercise. Both count: a defense that
 * fires for the wrong reason didn't do the job it was designed to prove.
 */
export interface Escape {
  readonly transcriptId: string;
  readonly attackClass: AttackClass;
  readonly origin: Origin;
  readonly merchant: EvalMerchant;
  readonly expectedRule: GateRule;
  readonly actualDecision: ReplayStepResult["outcome"]["decision"];
  readonly actualRule: GateRule;
  readonly description: string;
}

function describeEscape(
  transcript: SplitTranscript,
  lastStep: ReplayStepResult
): string {
  if (lastStep.outcome.decision === "allow") {
    return `expected ${transcript.expected_tripped_rule} to block or escalate the final step; it was ALLOWed instead (${lastStep.outcome.amount_paise} paise)`;
  }
  return `expected ${transcript.expected_tripped_rule} to trip; the final step was ${lastStep.outcome.decision} under ${lastStep.outcome.rule} instead`;
}

export function computeEscapes(
  results: readonly ReplayResult<SplitTranscript>[]
): readonly Escape[] {
  const escapes: Escape[] = [];
  for (const result of results) {
    const { transcript, steps } = result;
    if (
      transcript.attack_class === null ||
      transcript.expected_tripped_rule === null
    )
      continue;
    if (scoreReplay(result).caught) continue;
    const lastStep = steps[steps.length - 1];
    if (lastStep === undefined) continue; // no steps replayed; nothing to describe
    escapes.push({
      transcriptId: transcript.id,
      attackClass: transcript.attack_class,
      origin: transcript.origin,
      merchant: transcript.merchant,
      expectedRule: transcript.expected_tripped_rule,
      actualDecision: lastStep.outcome.decision,
      actualRule: lastStep.outcome.rule,
      description: describeEscape(transcript, lastStep),
    });
  }
  return escapes;
}

/* --------------------------------------------------------- cost of false positives */

export interface FalsePositive {
  readonly transcriptId: string;
  readonly merchant: EvalMerchant;
  readonly blockedValuePaise: number;
  readonly decision: "block" | "escalate";
  readonly rule: GateRule;
}

export function computeFalsePositives(
  results: readonly ReplayResult<SplitTranscript>[]
): readonly FalsePositive[] {
  const falsePositives: FalsePositive[] = [];
  for (const { transcript, steps } of results) {
    if (transcript.attack_class !== null) continue;
    for (const step of steps) {
      if (step.outcome.decision === "allow") continue;
      const source = transcript.steps[step.stepIndex];
      if (source === undefined) continue; // unreachable: stepIndex always indexes the same transcript
      falsePositives.push({
        transcriptId: transcript.id,
        merchant: transcript.merchant,
        blockedValuePaise: stepValuePaise(source),
        decision: step.outcome.decision,
        rule: step.outcome.rule,
      });
    }
  }
  return falsePositives;
}

/**
 * Recovery means "a blocked benign session that then completed a substitute
 * purchase" — i.e. a LATER step in the SAME transcript that ALLOWed. A
 * benign transcript only counts as eligible if it was blocked AND has a
 * step after the block to check — a single-step transcript that gets
 * blocked has no follow-up recorded at all, so it tells us nothing about
 * recovery either way. If no transcript in the split is eligible, recovery
 * is NOT MEASURABLE from this corpus; reporting 0% in that case would be a
 * fabricated number, not an honest one (see the ticket's caveat B).
 */
export interface RecoveryResult {
  readonly measurable: boolean;
  readonly recoveredCount: number;
  readonly eligibleCount: number;
  readonly rate: number | null;
}

export function computeRecovery(
  results: readonly ReplayResult<SplitTranscript>[]
): RecoveryResult {
  let eligibleCount = 0;
  let recoveredCount = 0;
  for (const { transcript, steps } of results) {
    if (transcript.attack_class !== null) continue;
    const firstBlockedIndex = steps.findIndex(
      (s) => s.outcome.decision !== "allow"
    );
    if (firstBlockedIndex === -1) continue; // never blocked; not a recovery candidate
    if (firstBlockedIndex >= steps.length - 1) continue; // blocked with no follow-up step recorded
    eligibleCount += 1;
    const recovered = steps
      .slice(firstBlockedIndex + 1)
      .some((s) => s.outcome.decision === "allow");
    if (recovered) recoveredCount += 1;
  }
  if (eligibleCount === 0) {
    return {
      measurable: false,
      recoveredCount: 0,
      eligibleCount: 0,
      rate: null,
    };
  }
  return {
    measurable: true,
    recoveredCount,
    eligibleCount,
    rate: recoveredCount / eligibleCount,
  };
}

function computeNetPaise(
  blockedBenignGmvPaise: number,
  recovery: RecoveryResult
): number | null {
  if (!recovery.measurable || recovery.rate === null) return null;
  return Math.round(blockedBenignGmvPaise * (1 - recovery.rate));
}

/* ------------------------------------------------------------- outcome counts */

export interface OutcomeCounts {
  readonly allow: number;
  readonly block: number;
  readonly escalate: number;
  readonly total: number;
}

export function computeOutcomeCounts(
  results: readonly ReplayResult<SplitTranscript>[]
): OutcomeCounts {
  let allow = 0;
  let block = 0;
  let escalate = 0;
  for (const { steps } of results) {
    for (const step of steps) {
      if (step.outcome.decision === "allow") allow += 1;
      else if (step.outcome.decision === "block") block += 1;
      else escalate += 1;
    }
  }
  return { allow, block, escalate, total: allow + block + escalate };
}

/* ------------------------------------------------------------- origin breakdown */

export function computeOriginBreakdown(
  transcripts: readonly SplitTranscript[]
): Readonly<Record<Origin, number>> {
  const counts = Object.fromEntries(
    ORIGINS.map((origin) => [origin, 0])
  ) as Record<Origin, number>;
  for (const t of transcripts) {
    if (t.attack_class !== null) counts[t.origin] += 1;
  }
  return counts;
}

/* --------------------------------------------------------- order value stats */

export interface OrderValueStats {
  readonly count: number;
  readonly minPaise: number;
  readonly maxPaise: number;
  readonly meanPaise: number;
}

/**
 * Mean/min/max ORDER value, computed from the transcripts themselves (each
 * step's items x quantities) — NOT the per-SKU catalog price in
 * fixtures/demo-price-distribution.json, which is a different number (see
 * the ticket's caveat A). Scoped to BENIGN transcripts only: adversarial
 * amounts are deliberately sized at or near policy thresholds/caps and
 * would skew this away from what ordinary shopping looks like, which is the
 * population the blocked-GMV cost figure actually draws from.
 */
export function computeBenignOrderValueStats(
  transcripts: readonly SplitTranscript[]
): Readonly<Record<EvalMerchant, OrderValueStats | null>> {
  const valuesByMerchant = new Map<EvalMerchant, number[]>();
  for (const t of transcripts) {
    if (t.attack_class !== null) continue;
    const values = valuesByMerchant.get(t.merchant) ?? [];
    for (const step of t.steps) values.push(stepValuePaise(step));
    valuesByMerchant.set(t.merchant, values);
  }

  const result = {} as Record<EvalMerchant, OrderValueStats | null>;
  for (const merchant of EVAL_MERCHANTS) {
    const values = valuesByMerchant.get(merchant) ?? [];
    result[merchant] =
      values.length === 0
        ? null
        : {
            count: values.length,
            minPaise: Math.min(...values),
            maxPaise: Math.max(...values),
            meanPaise: Math.round(
              values.reduce((sum, v) => sum + v, 0) / values.length
            ),
          };
  }
  return result;
}

/* ---------------------------------------------------- seeded per-SKU price distribution */

export interface SkuPriceDistributionRow {
  readonly merchant_id: string;
  readonly item_count: number;
  readonly min_price_paise: number;
  readonly max_price_paise: number;
  readonly mean_price_paise: number;
  readonly total_price_paise: number;
}

const PRICE_DISTRIBUTION_PATH = `${import.meta.dir}/../../fixtures/demo-price-distribution.json`;

export function loadSkuPriceDistribution(): readonly SkuPriceDistributionRow[] {
  return JSON.parse(
    readFileSync(PRICE_DISTRIBUTION_PATH, "utf8")
  ) as SkuPriceDistributionRow[];
}

function skuRowForMerchant(
  rows: readonly SkuPriceDistributionRow[],
  merchant: EvalMerchant
): SkuPriceDistributionRow | null {
  return rows.find((r) => r.merchant_id === `m_demo_${merchant}`) ?? null;
}

/* -------------------------------------------------------------------- render */

function renderEscapesSection(
  escapes: readonly Escape[],
  split: Split
): string {
  if (escapes.length === 0) {
    return [
      "## Escapes",
      "",
      `No adversarial transcript escaped detection in the ${split} split of this run.`,
      "",
      "**This does not mean the gate is robust. It means this exercise proved nothing beyond internal agreement between the rules and a fixture corpus written by the same person, in the same sitting** — see Origin below. A clean sweep against a threat model you wrote yourself is not evidence against a threat model you have not tried.",
    ].join("\n");
  }

  const lines = [
    "## Escapes",
    "",
    `${escapes.length} adversarial transcript(s) escaped detection in the ${split} split:`,
    "",
  ];
  for (const e of escapes) {
    lines.push(
      `- **${e.transcriptId}** (${e.attackClass}, origin=${e.origin}, merchant=${e.merchant}): ${e.description}`
    );
  }
  return lines.join("\n");
}

function renderOriginSection(
  results: readonly ReplayResult<SplitTranscript>[],
  originBreakdown: Readonly<Record<Origin, number>>
): string {
  const originsWithData = ORIGINS.filter((o) => originBreakdown[o] > 0);

  if (originsWithData.length <= 1) {
    const total = ORIGINS.reduce((sum, o) => sum + originBreakdown[o], 0);
    return [
      "### Origin",
      "",
      `Every adversarial transcript in this split carries \`origin: "hand"\` (${originBreakdown.hand} of ${total}). All hand-scripted attacks were authored by the same person who wrote the gate's rules — a circularity limitation, disclosed rather than hidden. When an \`origin: "llm"\` batch exists (a separate model call that never saw the gate implementation), this section breaks the numbers out per origin instead of one disclosure sentence.`,
    ].join("\n");
  }

  const buckets = new Map<string, { total: number; caught: number }>();
  for (const result of results) {
    const { transcript } = result;
    if (transcript.attack_class === null) continue;
    const key = `${transcript.attack_class}::${transcript.origin}`;
    const bucket = buckets.get(key) ?? { total: 0, caught: 0 };
    bucket.total += 1;
    if (scoreReplay(result).caught) bucket.caught += 1;
    buckets.set(key, bucket);
  }

  const rows = [...buckets.entries()].map(([key, b]) => {
    const [attackClass = "?", origin = "?"] = key.split("::");
    return `| ${attackClass} | ${origin} | ${b.caught} of ${b.total} |`;
  });
  return [
    "### Origin",
    "",
    "| Threat class | Origin | Caught (raw) |",
    "|---|---|---|",
    ...rows,
  ].join("\n");
}

function renderCoverageSection(
  transcripts: readonly SplitTranscript[],
  results: readonly ReplayResult<SplitTranscript>[],
  split: Split
): string {
  const verdicts = results.map((r) => scoreReplay(r));
  const rows = summarizeBySplit(verdicts).filter((r) => r.split === split);

  const expectedRuleByClass = new Map<string, GateRule>();
  for (const t of transcripts) {
    if (t.attack_class !== null && t.expected_tripped_rule !== null) {
      expectedRuleByClass.set(t.attack_class, t.expected_tripped_rule);
    }
  }

  const tableRows = rows.map((r) => {
    const label = r.group === "benign" ? "benign (should ALLOW)" : r.group;
    const rule =
      r.group === "benign"
        ? "ALLOW"
        : (expectedRuleByClass.get(r.group) ?? "unknown");
    return `| ${label} | ${rule} | ${r.caught} of ${r.total} |`;
  });

  const originBreakdown = computeOriginBreakdown(transcripts);

  return [
    "## Rule coverage over a declared threat model",
    "",
    "This is coverage over a declared threat model, not precision or recall: the gate is hand-written thresholds and allowlists with no fitted parameters, so borrowed ML evaluation vocabulary would claim a rigor this system does not have.",
    "",
    "Figures below are raw integers, never a percentage. At roughly five to twelve sessions per class, a percentage here would carry a confidence interval of roughly plus or minus thirty-five percentage points and would misstate how much a single session moves the number.",
    "",
    "| Threat class | Declared rule | Caught (raw) |",
    "|---|---|---|",
    ...tableRows,
    "",
    renderOriginSection(results, originBreakdown),
  ].join("\n");
}

function renderEscalationSection(outcomes: OutcomeCounts): string {
  const pct = (n: number): string =>
    `${((n / outcomes.total) * 100).toFixed(1)}%`;
  return [
    "## Escalation, block and allow rate",
    "",
    "Printed alongside coverage on purpose: a gate that escalated or blocked every checkout would post the same per-class coverage numbers above without doing any actual filtering. This is the pooled outcome distribution across all replayed checkout attempts, so that reading is checkable.",
    "",
    `| Decision | Count | Share of ${outcomes.total} checkout attempts |`,
    "|---|---|---|",
    `| allow | ${outcomes.allow} | ${pct(outcomes.allow)} |`,
    `| block | ${outcomes.block} | ${pct(outcomes.block)} |`,
    `| escalate | ${outcomes.escalate} | ${pct(outcomes.escalate)} |`,
  ].join("\n");
}

/**
 * Near-boundary benign fixtures are identified by id family. A bare 0.00 for
 * blocked benign GMV is uninterpretable on its own — it reads the same whether
 * the gate is precise or whether nothing in the population could ever have
 * been blocked. So the denominator is reported alongside it: how many benign
 * steps ran, and how many of those were deliberately built to sit close enough
 * to a policy limit that an over-tight rule would have caught them.
 */
const NEAR_BOUNDARY_ID_FAMILIES = [
  "nearcap",
  "nearthreshold",
  "atstock",
  "ambiguous",
] as const;

function isNearBoundary(id: string): boolean {
  return NEAR_BOUNDARY_ID_FAMILIES.some((family) => id.includes(family));
}

function renderCostSection(
  falsePositives: readonly FalsePositive[],
  recovery: RecoveryResult,
  netPaise: number | null,
  results: readonly ReplayResult<SplitTranscript>[]
): string {
  const benign = results.filter((r) => r.transcript.attack_class === null);
  const benignSteps = benign.reduce((n, r) => n + r.steps.length, 0);
  const nearBoundary = benign.filter((r) => isNearBoundary(r.transcript.id));
  const nearBoundarySteps = nearBoundary.reduce(
    (n, r) => n + r.steps.length,
    0
  );
  const blockedGmvPaise = falsePositives.reduce(
    (sum, fp) => sum + fp.blockedValuePaise,
    0
  );

  const recoveryLine = recovery.measurable
    ? `${recovery.recoveredCount} of ${recovery.eligibleCount} blocked benign sessions completed a substitute purchase afterward (${((recovery.rate ?? 0) * 100).toFixed(1)}%).`
    : "NOT MEASURABLE from this corpus, and for a good reason rather than a gap: no benign transcript was blocked at all, so there is no blocked-then-recovered case to observe. Recovery is the fraction of blocked benign sessions that went on to complete a substitute purchase, which requires a benign session to have been wrongly blocked in the first place. Multi-step benign sessions do exist here, so the shape is measurable the moment the gate produces a false positive — it simply has not.";

  const netLine =
    netPaise === null
      ? "NOT COMPUTABLE. A net figure needs the recovery rate above; since that is not measurable from this corpus, no net number is reported rather than silently assuming 0% recovery."
      : `${formatRupees(netPaise)} — blocked benign GMV upper bound net of the measured recovery rate.`;

  return [
    "## Cost of blocking benign traffic",
    "",
    "Three figures together, deliberately: any one of these alone is misleading.",
    "",
    `1. **Blocked benign GMV, UPPER BOUND: ${formatRupees(blockedGmvPaise)}**, over ${benignSteps} benign checkout step(s), of which ${nearBoundarySteps} came from ${nearBoundary.length} session(s) deliberately built to sit close to a policy limit — just under a cap or an approval threshold, at exactly available stock, or in an allowed-but-easily-confused category. That denominator is the point: a zero here means the gate declined the opportunities it was given, not that no opportunity existed. Computed from the checkout amount of every benign-labelled transcript step that did not ALLOW in this split, at the seeded price distribution below. This is an upper bound on what was blocked, not a claim about what disappeared: the totals come from an invented catalog, and a blocked checkout does not vanish from the economy if the agent re-plans and buys something else instead. Merchant GMV, merchant margin and Razorpay MDR are three different numbers; this figure is none of them.`,
    `2. **Recovery rate:** ${recoveryLine}`,
    `3. **Net:** ${netLine}`,
  ].join("\n");
}

function renderPriceDistributionSection(
  transcripts: readonly SplitTranscript[],
  skuRows: readonly SkuPriceDistributionRow[]
): string {
  const orderStats = computeBenignOrderValueStats(transcripts);

  const skuTableRows = EVAL_MERCHANTS.map((merchant) => {
    const row = skuRowForMerchant(skuRows, merchant);
    if (row === null) return `| ${merchant} | (no data) | | | |`;
    return `| ${merchant} | ${row.item_count} | ${formatRupees(row.min_price_paise)} | ${formatRupees(row.mean_price_paise)} | ${formatRupees(row.max_price_paise)} |`;
  });

  const orderTableRows = EVAL_MERCHANTS.map((merchant) => {
    const stats = orderStats[merchant];
    if (stats === null) return `| ${merchant} | 0 | | | |`;
    return `| ${merchant} | ${stats.count} | ${formatRupees(stats.minPaise)} | ${formatRupees(stats.meanPaise)} | ${formatRupees(stats.maxPaise)} |`;
  });

  return [
    "## Price distribution",
    "",
    "Published so a reader can rescale the cost figures above to their own assumptions. Two different numbers, kept distinct:",
    "",
    "### Per-SKU catalog price (listing price of each product — NOT what any order actually spent)",
    "",
    "| Merchant | SKUs | Min | Mean | Max |",
    "|---|---|---|---|---|",
    ...skuTableRows,
    "",
    "### Per-order value (computed from this split's benign checkout attempts — actual basket totals)",
    "",
    "| Merchant | Benign checkouts | Min | Mean | Max |",
    "|---|---|---|---|---|",
    ...orderTableRows,
    "",
    "Adversarial-class amounts are excluded from the per-order figures above: budget_split and threshold_straddling rounds are deliberately sized at or near the policy threshold/cap, which is not representative of ordinary shopping and would skew the mean upward.",
  ].join("\n");
}

function renderScopeSection(split: Split, transcriptCount: number): string {
  return [
    "## Scope",
    "",
    `**${REQUIRED_SCOPE_SENTENCE}**`,
    "",
    `This report scored the **${split}** split (${transcriptCount} transcripts) of the frozen dataset. The held-out split is scored exactly once, at DUK-20 (Day 10) — see \`FREEZE_NOTE\` in \`src/eval/dataset.ts\`.`,
    "",
    "Every adversarial transcript replayed above was hand-authored by whoever wrote the gate's rules (see Origin, under Rule coverage). That is a circularity limitation on everything in this report, not just the escapes section.",
  ].join("\n");
}

export function renderReport(
  split: Split,
  results: readonly ReplayResult<SplitTranscript>[],
  skuPriceDistribution: readonly SkuPriceDistributionRow[]
): string {
  const transcripts = results.map((r) => r.transcript);
  const escapes = computeEscapes(results);
  const falsePositives = computeFalsePositives(results);
  const recovery = computeRecovery(results);
  const netPaise = computeNetPaise(
    falsePositives.reduce((sum, fp) => sum + fp.blockedValuePaise, 0),
    recovery
  );
  const outcomes = computeOutcomeCounts(results);

  const sections: string[] = [];
  if (split === "holdout") {
    sections.push(
      "> **WARNING: HOLDOUT SPLIT SCORED.** The held-out split is scored exactly once, at DUK-20 (Day 10) — see `FREEZE_NOTE` in `src/eval/dataset.ts`. If this run is not that authorized Day-10 scoring, stop and re-run with `--split=train` (the default)."
    );
  }
  sections.push(`# Dukaan gate eval report — ${split} split`);
  sections.push(renderEscapesSection(escapes, split));
  sections.push(renderCoverageSection(transcripts, results, split));
  sections.push(renderEscalationSection(outcomes));
  sections.push(renderCostSection(falsePositives, recovery, netPaise, results));
  sections.push(
    renderPriceDistributionSection(transcripts, skuPriceDistribution)
  );
  sections.push(renderScopeSection(split, transcripts.length));

  return sections.join("\n\n");
}

/* ---------------------------------------------------------------------- CLI */

export function parseSplitArg(argv: readonly string[]): Split {
  const flag = argv.find((a) => a.startsWith("--split="));
  if (flag === undefined) return "train";
  const value = flag.slice("--split=".length);
  if (value !== "train" && value !== "holdout") {
    throw new Error(`--split must be "train" or "holdout", got "${value}"`);
  }
  return value;
}

async function main(): Promise<void> {
  const split = parseSplitArg(process.argv.slice(2));

  if (split === "holdout") {
    console.error("\n" + "!".repeat(70));
    console.error("WARNING: --split=holdout was passed.");
    console.error(
      "The held-out split is scored exactly ONCE, at DUK-20 (Day 10)."
    );
    console.error(
      "Re-run with --split=train unless this is that authorized run."
    );
    console.error("!".repeat(70) + "\n");
  }

  const NAMESPACE = "report";
  const dataset = buildFrozenDataset().filter((t) => t.split === split);
  console.log(
    `replaying ${dataset.length} "${split}"-split transcripts under namespace "${NAMESPACE}"...`
  );

  const merchantIds = await resetEvalMerchants(NAMESPACE);
  const results = await replayBatch(NAMESPACE, merchantIds, dataset);
  const skuPriceDistribution = loadSkuPriceDistribution();

  console.log("\n" + renderReport(split, results, skuPriceDistribution));
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await closePool();
  }
}
