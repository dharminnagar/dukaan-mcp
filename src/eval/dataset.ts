/**
 * Composes the hand-scripted `TranscriptSource` (benign generator + five
 * adversarial classes) into the ~200-session dataset and assigns the frozen
 * train/held-out split. Nothing in this file touches Postgres — generation
 * is pure and offline, which is what makes `bun run eval:generate` produce
 * byte-identical output on every run.
 *
 * FROZEN. The seed, the counts, and FROZEN_AT below were fixed before this
 * dataset was ever run against the gate — see fixtures/eval/manifest.json,
 * written by generate.ts, which carries this same note and timestamp. Do
 * not change these constants to chase a metric; that is exactly the
 * tuning-after-seeing-results the freeze exists to prevent.
 */
import { generateBenignTranscripts } from './benign';
import { generateHandScriptedAdversarial } from './hand-attacks';
import { mulberry32, shuffle } from './prng';
import type { SplitTranscript, Split, Transcript, TranscriptSource } from './transcript';

/** Fixed at authoring time. Never `Date.now()` — see the module comment. */
export const FROZEN_AT = '2026-08-25T00:00:00.000Z';
export const REFROZEN_AT = '2026-08-25T12:00:00.000Z';
export const FREEZE_NOTE =
  'Train/held-out assignment re-frozen 2026-08-25 to stratify per attack class. The first assignment pooled all transcripts and left category_laundering with 1 holdout instance and stale_price with 2, which cannot support a per-rule figure. No gate rule or threshold was changed at any point before or after either freeze: the only replays so far were construction checks confirming each class triggers its target rule. The held-out split is scored once, at DUK-20.';

export const DATASET_SEED = 0xd0417a51; // "d0 47a51" — arbitrary, fixed, never regenerated per-run.
export const BENIGN_COUNT = 140;
export const TRAIN_FRACTION = 0.6;

export const handScriptedSource: TranscriptSource = {
  origin: 'hand',
  generate(seed: number): readonly Transcript[] {
    const rng = mulberry32(seed);
    return [...generateBenignTranscripts(rng, BENIGN_COUNT), ...generateHandScriptedAdversarial()];
  },
};

/**
 * Deterministic, STRATIFIED train/held-out assignment.
 *
 * Stratification is not a nicety here, it is what makes the per-rule numbers
 * reportable. A single pooled shuffle over all 200 transcripts leaves the
 * per-class holdout counts to chance, and it did: the first frozen dataset
 * put 8 of 12 threshold_straddling transcripts in holdout but only 1 of 12
 * category_laundering. A published line reading "1 of 1 caught" says nothing
 * about the rule and reads as carelessness next to a report that makes a
 * point of refusing percentages on small denominators.
 *
 * So each class is shuffled and split on its own, giving every class the same
 * ~40% holdout share and roughly 5 holdout instances each — which is the
 * per-class denominator the reporting plan was written around.
 *
 * The seed is a derived, fixed sub-seed rather than the generation seed
 * reused verbatim, so a change to basket generation cannot accidentally
 * correlate with which half of the shuffle an id lands in.
 */
function assignSplit(transcripts: readonly Transcript[], seed: number): readonly SplitTranscript[] {
  const strata = new Map<string, Transcript[]>();
  for (const t of transcripts) {
    const key = t.attack_class ?? 'benign';
    const bucket = strata.get(key);
    if (bucket === undefined) strata.set(key, [t]);
    else bucket.push(t);
  }

  const trainIds = new Set<string>();
  // Iterate strata in sorted key order so the assignment does not depend on
  // the order classes happen to be generated in.
  for (const key of [...strata.keys()].sort()) {
    const bucket = strata.get(key)!;
    // Derive a per-stratum seed so one class's size cannot shift another's
    // assignment — otherwise adding a sixth attack class later would silently
    // re-roll the split for all five existing ones.
    const rng = mulberry32(seed + hashStratum(key));
    const order = shuffle(rng, bucket.map((t) => t.id));
    for (const id of order.slice(0, Math.round(order.length * TRAIN_FRACTION))) trainIds.add(id);
  }

  return transcripts.map((t) => ({ ...t, split: (trainIds.has(t.id) ? 'train' : 'holdout') as Split }));
}

/** Small stable string hash, so a stratum's seed depends on its name only. */
function hashStratum(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function buildFrozenDataset(): readonly SplitTranscript[] {
  const transcripts = handScriptedSource.generate(DATASET_SEED);
  // Fixed offset from DATASET_SEED, not a second magic constant to keep in
  // sync by hand — see assignSplit's doc comment for why this must differ
  // from the generation seed itself.
  return assignSplit(transcripts, DATASET_SEED ^ 0x5eed_0001);
}
