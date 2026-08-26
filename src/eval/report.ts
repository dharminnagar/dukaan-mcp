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
    // Interrupted-intent transcripts are excluded on purpose (DUK-30 Gap
    // 2): a step stopped there is stopped by a CORRECT policy decision, not
    // a wrong one, so it must never count toward this figure. See
    // computeInterruptedIntent below for where its cost is reported instead.
    if (
      transcript.attack_class !== null ||
      transcript.expected_step_decisions !== undefined
    )
      continue;
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
    // Interrupted-intent transcripts are excluded here too — this figure is
    // recovery over WRONGLY blocked benign sessions specifically. Their own
    // recovery is computed separately by computeInterruptedIntent below.
    if (
      transcript.attack_class !== null ||
      transcript.expected_step_decisions !== undefined
    )
      continue;
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

/* --------------------------------------------------- interrupted legitimate intent */

/**
 * DUK-30 Gap 2's reframe, made concrete: a session carrying
 * `expected_step_decisions` is a legitimate shopper whose FIRST non-allow
 * step is a CORRECT policy decision (a real category exclusion, a real
 * stock shortfall, a real over-threshold order), not a gate mistake.
 * Recovery lives here, never in `computeFalsePositives`/`computeRecovery`
 * above, which stay scoped to sessions the gate was WRONG to stop.
 *
 * `stopped` is false when a replay did not produce the fixture's expected
 * interruption at all (its first step ALLOWed outright) — that is a
 * genuine finding, not a session to silently drop, so it is reported via
 * `matchesExpectation` rather than excluded.
 */
export interface InterruptedIntentResult {
  readonly transcriptId: string;
  readonly merchant: EvalMerchant;
  readonly stopped: boolean;
  readonly stoppedDecision: "block" | "escalate" | null;
  readonly stoppedValuePaise: number;
  readonly recovered: boolean;
  readonly matchesExpectation: boolean;
}

export function computeInterruptedIntent(
  results: readonly ReplayResult<SplitTranscript>[]
): readonly InterruptedIntentResult[] {
  const rows: InterruptedIntentResult[] = [];
  for (const result of results) {
    const { transcript, steps } = result;
    if (transcript.expected_step_decisions === undefined) continue;

    const stoppedIndex = steps.findIndex((s) => s.outcome.decision !== "allow");
    const stopped = stoppedIndex !== -1;
    const stoppedDecision = stopped
      ? (steps[stoppedIndex]!.outcome.decision as "block" | "escalate")
      : null;
    const stoppedSourceStep = stopped
      ? transcript.steps[stoppedIndex]
      : undefined;
    const stoppedValuePaise =
      stoppedSourceStep === undefined ? 0 : stepValuePaise(stoppedSourceStep);
    const recovered =
      stopped &&
      steps.slice(stoppedIndex + 1).some((s) => s.outcome.decision === "allow");

    rows.push({
      transcriptId: transcript.id,
      merchant: transcript.merchant,
      stopped,
      stoppedDecision,
      stoppedValuePaise,
      recovered,
      matchesExpectation: scoreReplay(result).caught,
    });
  }
  return rows;
}

export interface InterruptedIntentSummary {
  readonly interruptedCount: number;
  readonly stoppedValuePaise: number;
  readonly medianStoppedValuePaise: number;
  readonly largestShare: number;
  readonly recoveredCount: number;
  readonly mismatches: readonly InterruptedIntentResult[];
}

export function summarizeInterruptedIntent(
  rows: readonly InterruptedIntentResult[]
): InterruptedIntentSummary {
  const stopped = rows.filter((r) => r.stopped);
  const values = stopped.map((r) => r.stoppedValuePaise).sort((a, b) => a - b);
  const total = values.reduce((sum, v) => sum + v, 0);
  return {
    interruptedCount: stopped.length,
    stoppedValuePaise: total,
    // A total alone hides concentration. In the train split one fixture is 85%
    // of it, and the median is a seventeenth of the mean, so a reader given only
    // the total would take it for a typical figure. The report already refuses
    // to let adversarial amounts skew the per-order distribution for exactly
    // this reason; the same discipline has to apply here.
    medianStoppedValuePaise:
      values.length === 0 ? 0 : (values[values.length >> 1] ?? 0),
    largestShare: total === 0 ? 0 : (values[values.length - 1] ?? 0) / total,
    recoveredCount: stopped.filter((r) => r.recovered).length,
    mismatches: rows.filter((r) => !r.matchesExpectation),
  };
}

/**
 * Net is the stopped value of the sessions that did NOT recover. Summed
 * directly, never derived from the recovery RATE.
 *
 * Scaling the total stopped value by `recoveredCount / interruptedCount` looks
 * equivalent and is not: it assumes recovered and unrecovered sessions carry
 * the same average value. They do not, and not by a little. In the train split
 * the recovered sessions average 27,564 paise of stopped value and the
 * unrecovered ones 4,051 — so the count-scaled figure came out at 6,505,775
 * paise against a true 1,215,300, overstating the net by 435%.
 *
 * A metric this project asks a reader to trust cannot be a proportional
 * approximation presented as a measurement.
 */
export function computeInterruptedNetPaise(
  rows: readonly InterruptedIntentResult[]
): number | null {
  const stopped = rows.filter((r) => r.stopped);
  if (stopped.length === 0) return null;
  return stopped
    .filter((r) => !r.recovered)
    .reduce((sum, r) => sum + r.stoppedValuePaise, 0);
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
    // Interrupted-intent transcripts are excluded for the same reason
    // adversarial ones are: their blocked-step amount is a deliberately
    // out-of-policy ask, not an ordinary basket, and would skew this away
    // from what ordinary shopping looks like.
    if (t.attack_class !== null || t.expected_step_decisions !== undefined)
      continue;
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

/**
 * What an empty escapes list is worth depends entirely on WHO wrote the
 * attacks, so the wording is conditional rather than fixed. A clean sweep over
 * attacks written by the same person who wrote the rules proves only that the
 * two agree. A clean sweep that also covers attacks from a source that never
 * saw the gate is a weaker claim than robustness but a real one, and the count
 * of independently-authored attacks is the number that carries it.
 */
function renderEscapesSection(
  escapes: readonly Escape[],
  split: Split,
  adversarialByOrigin: ReadonlyMap<Origin, number>
): string {
  const independent = adversarialByOrigin.get("llm") ?? 0;
  const selfAuthored = adversarialByOrigin.get("hand") ?? 0;

  if (escapes.length === 0) {
    const caveat =
      independent === 0
        ? "**This does not mean the gate is robust.** It means this exercise proved nothing beyond internal agreement between the rules and a fixture corpus written by the same person, in the same sitting. A clean sweep against a threat model you wrote yourself is not evidence against a threat model you have not tried."
        : `**This does not mean the gate is robust**, but it is not merely self-agreement either. ${selfAuthored} of these attacks were written by whoever wrote the rules, and a clean sweep over those proves only that the two agree. ${independent} came from a source whose context held the tool contracts, the published policy and the catalog, and never the gate implementation — so those ${independent} are a real result. It remains a declared threat model: an attack neither author imagined is still unmeasured.`;
    return [
      "## Escapes",
      "",
      `No adversarial transcript escaped detection in the ${split} split of this run.`,
      "",
      caveat,
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
  // Interrupted-intent is its own stratum (see transcriptGroup in
  // transcript.ts) but does not belong in a table titled "coverage over a
  // declared threat model" — it isn't an attack, it isn't benign, and it
  // has its own dedicated section below the cost section instead.
  const rows = summarizeBySplit(verdicts).filter(
    (r) => r.split === split && r.group !== "interrupted_intent"
  );

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
  // Interrupted-intent sessions are excluded here — see the module doc on
  // computeInterruptedIntent. This section is scoped to true benign
  // sessions only, the population a WRONGLY blocked step would come from.
  const benign = results.filter(
    (r) =>
      r.transcript.attack_class === null &&
      r.transcript.expected_step_decisions === undefined
  );
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

/**
 * A percentage is only printed once the denominator "reaches the dozens" —
 * the same rule the per-class coverage table follows (never a percentage
 * under a small-n denominator), applied here at a literal read of "dozens":
 * at least two dozen. Below that, only the raw "N of M" count is shown.
 */
const INTERRUPTED_RECOVERY_PCT_FLOOR = 24;

function renderInterruptedIntentSection(
  summary: InterruptedIntentSummary,
  netPaise: number | null
): string {
  const recoveryLine =
    summary.interruptedCount === 0
      ? "No interrupted-intent session was replayed in this split."
      : summary.interruptedCount >= INTERRUPTED_RECOVERY_PCT_FLOOR
        ? `${summary.recoveredCount} of ${summary.interruptedCount} interrupted sessions completed a substitute purchase (${((summary.recoveredCount / summary.interruptedCount) * 100).toFixed(1)}%).`
        : `${summary.recoveredCount} of ${summary.interruptedCount} interrupted sessions completed a substitute purchase.`;

  const netLine =
    netPaise === null
      ? "NOT COMPUTABLE — no interrupted-intent session was replayed in this split."
      : formatRupees(netPaise);

  const lines = [
    "## Interrupted legitimate intent",
    "",
    "Distinct from the cost section above, on purpose. A session here is a legitimate shopper whose first non-allow step was a CORRECT policy decision — a real category exclusion, a real stock shortfall, a real over-threshold order — not a gate mistake. **The gate was right in every one of these.** This is the cost of the policy's strictness, not of the gate being wrong, and it must never be added to the false-positive figure above.",
    "",
    `1. **${summary.interruptedCount} interrupted session(s)**, stopping ${formatRupees(summary.stoppedValuePaise)} of asserted checkout value at the point of interruption \u2014 median ${formatRupees(summary.medianStoppedValuePaise)}. The total is concentrated, not typical: the single largest session is ${(summary.largestShare * 100).toFixed(0)}% of it. Read the median as the representative figure and the total as an upper bound.`,
    `2. **Recovery:** ${recoveryLine}`,
    `3. **Net:** ${netLine} \u2014 the stopped value of the sessions that did NOT recover, summed directly. Deliberately not the total scaled by the recovery rate: recovered and unrecovered sessions here differ in average value by roughly seven times, so a rate-scaled figure would have overstated this by several hundred percent.`,
  ];

  if (summary.mismatches.length > 0) {
    lines.push(
      "",
      `**${summary.mismatches.length} interrupted-intent transcript(s) did not replay as their fixture expects** — a genuine finding, not a dropped row:`,
      ...summary.mismatches.map(
        (m) =>
          `- **${m.transcriptId}** (${m.merchant}): stopped=${m.stopped}, decision=${m.stoppedDecision ?? "n/a"}`
      )
    );
  }

  return lines.join("\n");
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

function renderScopeSection(
  split: Split,
  transcriptCount: number,
  adversarialByOrigin: ReadonlyMap<Origin, number>
): string {
  const independent = adversarialByOrigin.get("llm") ?? 0;
  const selfAuthored = adversarialByOrigin.get("hand") ?? 0;
  return [
    "## Scope",
    "",
    `**${REQUIRED_SCOPE_SENTENCE}**`,
    "",
    `This report scored the **${split}** split (${transcriptCount} transcripts) of the frozen dataset. The held-out split is scored exactly once, at DUK-20 (Day 10) — see \`FREEZE_NOTE\` in \`src/eval/dataset.ts\`.`,
    "",
    independent === 0
      ? "Every adversarial transcript replayed above was hand-authored by whoever wrote the gate's rules (see Origin, under Rule coverage). That is a circularity limitation on everything in this report, not just the escapes section."
      : `Of the adversarial transcripts replayed above, ${selfAuthored} were hand-authored by whoever wrote the gate's rules and ${independent} came from an independent source that never saw the gate implementation (see Origin, under Rule coverage). The circularity limitation applies in full to the first group and not to the second. Note it applies to the BENIGN transcripts on the same terms: a hand-written definition of what counts as legitimate shopping is as self-authored as a hand-written attack.`,
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
  const interruptedIntentRows = computeInterruptedIntent(results);
  const interruptedIntentSummary = summarizeInterruptedIntent(
    interruptedIntentRows
  );
  const interruptedNetPaise = computeInterruptedNetPaise(interruptedIntentRows);

  // How many adversarial transcripts came from each author. The escapes
  // section's caveat depends on this: a clean sweep means something different
  // when some of the attacks came from a source that never saw the gate.
  const adversarialByOrigin = new Map<Origin, number>();
  for (const r of results) {
    if (r.transcript.attack_class === null) continue;
    const o = r.transcript.origin;
    adversarialByOrigin.set(o, (adversarialByOrigin.get(o) ?? 0) + 1);
  }

  const sections: string[] = [];
  if (split === "holdout") {
    sections.push(
      "> **WARNING: HOLDOUT SPLIT SCORED.** The held-out split is scored exactly once, at DUK-20 (Day 10) — see `FREEZE_NOTE` in `src/eval/dataset.ts`. If this run is not that authorized Day-10 scoring, stop and re-run with `--split=train` (the default)."
    );
  }
  sections.push(`# Dukaan gate eval report — ${split} split`);
  sections.push(renderEscapesSection(escapes, split, adversarialByOrigin));
  sections.push(renderCoverageSection(transcripts, results, split));
  sections.push(renderEscalationSection(outcomes));
  sections.push(renderCostSection(falsePositives, recovery, netPaise, results));
  sections.push(
    renderInterruptedIntentSection(
      interruptedIntentSummary,
      interruptedNetPaise
    )
  );
  sections.push(
    renderPriceDistributionSection(transcripts, skuPriceDistribution)
  );
  sections.push(
    renderScopeSection(split, transcripts.length, adversarialByOrigin)
  );

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
