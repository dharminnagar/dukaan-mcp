/**
 * `bun run eval:generate` — writes the frozen eval dataset to
 * fixtures/eval/transcripts.json and fixtures/eval/manifest.json.
 *
 * Pure and offline: no Postgres, no network, no `Math.random()`/`Date.now()`.
 * Running this twice must produce byte-identical files — that is the whole
 * point of freezing the split before any result exists. tests/eval.test.ts
 * asserts this by calling `buildFrozenDataset()` twice in-process and
 * diffing the JSON; this script exists for a human to inspect the
 * committed fixture and to regenerate it if hand-attacks.ts/benign.ts ever
 * change (which would then require re-freezing, deliberately, not silently).
 */
import { writeFileSync } from 'node:fs';
import { ATTACK_CLASSES } from './transcript';
import type { SplitTranscript } from './transcript';
import { buildFrozenDataset, DATASET_SEED, FREEZE_NOTE, FROZEN_AT } from './dataset';

const FIXTURES_DIR = `${import.meta.dir}/../../fixtures/eval`;
const TRANSCRIPTS_PATH = `${FIXTURES_DIR}/transcripts.json`;
const MANIFEST_PATH = `${FIXTURES_DIR}/manifest.json`;

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

function buildManifest(dataset: readonly SplitTranscript[]) {
  const byClass = countBy(dataset, (t) => t.attack_class ?? 'benign');
  const bySplit = countBy(dataset, (t) => t.split);
  const byClassAndSplit: Record<string, Record<string, number>> = {};
  for (const cls of ['benign', ...ATTACK_CLASSES]) {
    byClassAndSplit[cls] = countBy(
      dataset.filter((t) => (t.attack_class ?? 'benign') === cls),
      (t) => t.split,
    );
  }

  return {
    frozen_at: FROZEN_AT,
    note: FREEZE_NOTE,
    seed: DATASET_SEED,
    total: dataset.length,
    by_origin: countBy(dataset, (t) => t.origin),
    by_split: bySplit,
    by_class: byClass,
    by_class_and_split: byClassAndSplit,
  };
}

function main(): void {
  const dataset = buildFrozenDataset();
  writeFileSync(TRANSCRIPTS_PATH, `${JSON.stringify(dataset, null, 2)}\n`);

  const manifest = buildManifest(dataset);
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`wrote ${dataset.length} transcripts to ${TRANSCRIPTS_PATH}`);
  console.log(`wrote manifest to ${MANIFEST_PATH}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
