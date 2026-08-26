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
import { writeFileSync } from "node:fs";
import { ATTACK_CLASSES, transcriptGroup } from "./transcript";
import type { SplitTranscript } from "./transcript";
import {
  buildFrozenDataset,
  DATASET_SEED,
  FREEZE_NOTE,
  FROZEN_AT,
} from "./dataset";

const FIXTURES_DIR = `${import.meta.dir}/../../fixtures/eval`;
const TRANSCRIPTS_PATH = `${FIXTURES_DIR}/transcripts.json`;
const MANIFEST_PATH = `${FIXTURES_DIR}/manifest.json`;

function countBy<T>(
  items: readonly T[],
  key: (item: T) => string
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

// "benign" and "interrupted_intent" both carry attack_class: null;
// transcriptGroup() is the single source of truth for telling them apart
// (see transcript.ts) so this manifest can never quietly re-merge the two.
const REPORTED_GROUPS = ["benign", "interrupted_intent", ...ATTACK_CLASSES];

function buildManifest(dataset: readonly SplitTranscript[]) {
  const byClass = countBy(dataset, transcriptGroup);
  const bySplit = countBy(dataset, (t) => t.split);
  const byClassAndSplit: Record<string, Record<string, number>> = {};
  for (const cls of REPORTED_GROUPS) {
    byClassAndSplit[cls] = countBy(
      dataset.filter((t) => transcriptGroup(t) === cls),
      (t) => t.split
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
