/**
 * `bun run eval` — replays the frozen dataset (fixtures/eval/transcripts.json)
 * against the real gate over a real (but eval-namespaced) Postgres schema,
 * and prints a catch-rate table by attack class and split.
 *
 * Standalone CLI process, same shape as scripts/seed-demo.ts: closes the
 * pool on exit. NEVER do this inside tests/eval.test.ts — bun test shares
 * one process (and one Pool) across every test file, and closing it there
 * would break tests/gate.test.ts and tests/mcp.test.ts running alongside it
 * (projectmem #0013).
 */
import { readFileSync } from 'node:fs';
import { closePool } from '../db/pool';
import { scoreReplay, summarizeBySplit } from './metrics';
import { resetEvalMerchants } from './provision';
import { replayBatch } from './runner';
import type { SplitTranscript } from './transcript';

const NAMESPACE = 'eval';
const TRANSCRIPTS_PATH = `${import.meta.dir}/../../fixtures/eval/transcripts.json`;

async function main(): Promise<void> {
  const raw = readFileSync(TRANSCRIPTS_PATH, 'utf8');
  const dataset = JSON.parse(raw) as SplitTranscript[];

  console.log(`loaded ${dataset.length} transcripts from ${TRANSCRIPTS_PATH}`);
  console.log(
    `provisioning eval merchants under namespace "${NAMESPACE}" (wipes any previous eval run's spend history)...`,
  );

  const merchantIds = await resetEvalMerchants(NAMESPACE);
  const results = await replayBatch(NAMESPACE, merchantIds, dataset);
  const verdicts = results.map((r) => scoreReplay(r));
  const rows = summarizeBySplit(verdicts);

  console.log(`\nreplayed ${dataset.length} transcripts. catch/allow rate by class and split:\n`);
  console.table(rows.map((r) => ({ ...r, rate: `${(r.rate * 100).toFixed(1)}%` })));

  const missed = verdicts.filter((v) => !v.caught);
  if (missed.length > 0) {
    console.log(`\n${missed.length} transcript(s) did not match their expectation:`);
    for (const v of missed) {
      console.log(
        `  ${v.transcript.id} (${v.transcript.attack_class ?? 'benign'}, ${v.transcript.split})`,
      );
    }
  }
}

try {
  await main();
} finally {
  await closePool();
}
