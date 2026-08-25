import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { query } from '../src/db/pool';
import { buildFrozenDataset, TRAIN_FRACTION } from '../src/eval/dataset';
import type { EvalMerchantIds } from '../src/eval/provision';
import { resetEvalMerchants } from '../src/eval/provision';
import { replayBatch, replayTranscript } from '../src/eval/runner';
import type { ReplayStepResult } from '../src/eval/runner';
import { scoreReplay, summarizeBySplit } from '../src/eval/metrics';
import { ATTACK_CLASSES } from '../src/eval/transcript';
import type { SplitTranscript } from '../src/eval/transcript';

/**
 * m_evaltest_* / ag_evaltest_* namespace — distinct from both `m_demo_*`
 * (DUK-11's real demo data) and from the "eval" namespace `bun run eval`
 * uses for a real replay report, so this test file, a manual `bun run
 * eval`, and every other test file's fixtures can never collide. See
 * src/eval/provision.ts's module doc for the full isolation rationale.
 */
const NAMESPACE = 'evaltest';
const EVAL_TEST_MERCHANT_IDS = ['m_evaltest_kirana', 'm_evaltest_electronics'];

async function wipeEvalTestData(): Promise<void> {
  await query('DELETE FROM audit_events WHERE merchant_id = ANY($1::text[])', [EVAL_TEST_MERCHANT_IDS]);
  await query('DELETE FROM merchants WHERE id = ANY($1::text[])', [EVAL_TEST_MERCHANT_IDS]);
}

beforeAll(wipeEvalTestData);
afterAll(wipeEvalTestData);

/** Strips ids/timestamps/latency so two replays of the same transcript can be compared for decision equality. */
function normalizeStep(step: ReplayStepResult) {
  return {
    decision: step.outcome.decision,
    rule: step.outcome.rule,
    reason_code: step.audit.reason_code,
    amount_paise: step.audit.amount_paise,
  };
}

describe('dataset generation (pure, offline, no Postgres)', () => {
  test('bun run eval:generate is byte-identical across two runs', () => {
    const first = JSON.stringify(buildFrozenDataset());
    const second = JSON.stringify(buildFrozenDataset());
    expect(first).toBe(second);
  });

  test('every transcript is labelled origin "hand"', () => {
    const dataset = buildFrozenDataset();
    expect(dataset.length).toBeGreaterThan(0);
    expect(dataset.every((t) => t.origin === 'hand')).toBe(true);
  });

  test('~200 sessions, 70/30 benign to adversarial, 60/40 train to held-out', () => {
    const dataset = buildFrozenDataset();
    expect(dataset.length).toBe(200);

    const benign = dataset.filter((t) => t.attack_class === null).length;
    const adversarial = dataset.length - benign;
    expect(benign).toBe(140);
    expect(adversarial).toBe(60);

    const train = dataset.filter((t) => t.split === 'train').length;
    const holdout = dataset.filter((t) => t.split === 'holdout').length;
    expect(train + holdout).toBe(dataset.length);
    // Not an exact 120/80: the split is stratified per class, so each stratum
    // rounds independently (84 benign + 7 x 5 classes = 119). The ratio is the
    // requirement; the exact integer was always incidental. One transcript of
    // slack per stratum is the most rounding can cost.
    const target = Math.round(dataset.length * TRAIN_FRACTION);
    expect(Math.abs(train - target)).toBeLessThanOrEqual(ATTACK_CLASSES.length + 1);
  });

  test('the split is STRATIFIED: every attack class gets the same holdout share', () => {
    // Regression for the first frozen dataset, which pooled all 200 transcripts
    // into one shuffle and left category_laundering with 1 holdout instance and
    // stale_price with 2. A per-rule line reading "1 of 1 caught" cannot support
    // the reporting plan, which deliberately quotes raw integers precisely
    // because the per-class denominators are small.
    const dataset = buildFrozenDataset();
    const holdoutCounts = ATTACK_CLASSES.map(
      (c) => dataset.filter((t) => t.attack_class === c && t.split === 'holdout').length,
    );
    // Every class within one of every other class — no class may be starved.
    expect(Math.max(...holdoutCounts) - Math.min(...holdoutCounts)).toBeLessThanOrEqual(1);
    // And each must be large enough to report at all.
    for (const n of holdoutCounts) expect(n).toBeGreaterThanOrEqual(4);
  });

  test('each of the five adversarial classes has sessions in BOTH splits', () => {
    const dataset = buildFrozenDataset();
    for (const attackClass of ATTACK_CLASSES) {
      const inClass = dataset.filter((t) => t.attack_class === attackClass);
      expect(inClass.length).toBeGreaterThan(0);
      expect(inClass.some((t) => t.split === 'train')).toBe(true);
      expect(inClass.some((t) => t.split === 'holdout')).toBe(true);
    }
  });

  test('every transcript id is unique', () => {
    const dataset = buildFrozenDataset();
    expect(new Set(dataset.map((t) => t.id)).size).toBe(dataset.length);
  });
});

describe('replay against the real gate (Postgres, eval-namespaced, no network)', () => {
  let merchantIds: EvalMerchantIds;
  const dataset = buildFrozenDataset();

  beforeAll(async () => {
    merchantIds = await resetEvalMerchants(NAMESPACE);
  });

  test('replaying one transcript twice yields identical decisions', async () => {
    const transcript = dataset.find((t) => t.id === 'hand-budget_split-01');
    if (transcript === undefined) throw new Error('fixture hand-budget_split-01 not found');

    const first = await replayTranscript(NAMESPACE, merchantIds, transcript);
    const firstDecisions = first.steps.map(normalizeStep);

    // Reset between replays: the SAME agent_id is reused (transcripts are
    // deterministic on their own id), so without wiping, the second
    // replay's spend cap would see the first replay's own orders as prior
    // spend and diverge — that would be testing leftover state, not
    // decide()'s determinism.
    merchantIds = await resetEvalMerchants(NAMESPACE);
    const second = await replayTranscript(NAMESPACE, merchantIds, transcript);
    const secondDecisions = second.steps.map(normalizeStep);

    expect(secondDecisions).toEqual(firstDecisions);
    expect(firstDecisions[firstDecisions.length - 1]?.rule).toBe('SPEND_CAP');
  });

  test('one representative transcript per adversarial class trips its expected rule', async () => {
    merchantIds = await resetEvalMerchants(NAMESPACE);
    for (const attackClass of ATTACK_CLASSES) {
      const transcript = dataset.find((t) => t.attack_class === attackClass);
      if (transcript === undefined) throw new Error(`no fixture for class ${attackClass}`);
      const expectedRule = transcript.expected_tripped_rule;
      if (expectedRule === null) throw new Error(`${transcript.id} has no expected_tripped_rule`);

      const result = await replayTranscript(NAMESPACE, merchantIds, transcript);
      const lastStep = result.steps[result.steps.length - 1];
      if (lastStep === undefined) throw new Error(`${transcript.id} replayed with zero steps`);

      expect(lastStep.outcome.decision).not.toBe('allow');
      expect(lastStep.outcome.rule).toBe(expectedRule);
    }
  });

  test('a sample of benign transcripts always ALLOW', async () => {
    merchantIds = await resetEvalMerchants(NAMESPACE);
    const benignSample = dataset.filter((t) => t.attack_class === null).slice(0, 8);
    for (const transcript of benignSample) {
      const result = await replayTranscript(NAMESPACE, merchantIds, transcript);
      expect(result.steps.every((s) => s.outcome.decision === 'allow')).toBe(true);
    }
  });

  test('the full frozen dataset replays with a 100% catch/allow rate', async () => {
    merchantIds = await resetEvalMerchants(NAMESPACE);
    const results = await replayBatch<SplitTranscript>(NAMESPACE, merchantIds, dataset);
    const verdicts = results.map((r) => scoreReplay(r));
    const missed = verdicts.filter((v) => !v.caught);

    expect(missed.map((v) => v.transcript.id)).toEqual([]);

    const rows = summarizeBySplit(verdicts);
    for (const row of rows) {
      expect(row.rate).toBe(1);
    }
  }, 30_000);
});
