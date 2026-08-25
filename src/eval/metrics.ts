/**
 * Scores replayed transcripts against their own declared ground truth
 * (`Transcript.expected_tripped_rule`) and aggregates by attack class and
 * split. Consumes only `ReplayResult`/`Transcript` — nothing here knows or
 * cares whether the transcript's `origin` is 'hand' or 'llm', which is the
 * other half of the seam described in transcript.ts.
 */
import type { ReplayResult } from './runner';
import type { Split, SplitTranscript, Transcript } from './transcript';

export interface TranscriptVerdict<T extends Transcript = Transcript> {
  readonly transcript: T;
  /**
   * Benign: true iff every step ALLOWed (no false block/escalate).
   * Adversarial: true iff some step's outcome has decision != 'allow' and
   * rule === transcript.expected_tripped_rule — i.e. the attack was caught
   * by the rule it was designed to exercise, not merely blocked by
   * something incidental.
   */
  readonly caught: boolean;
}

export function scoreReplay<T extends Transcript>(result: ReplayResult<T>): TranscriptVerdict<T> {
  const { transcript, steps } = result;

  if (transcript.expected_tripped_rule === null) {
    const caught = steps.every((s) => s.outcome.decision === 'allow');
    return { transcript, caught };
  }

  const caught = steps.some(
    (s) => s.outcome.decision !== 'allow' && s.outcome.rule === transcript.expected_tripped_rule,
  );
  return { transcript, caught };
}

export interface MetricsRow {
  readonly group: string; // attack class, or 'benign'
  readonly split: Split;
  readonly total: number;
  readonly caught: number;
  readonly rate: number; // caught / total, in [0, 1]
}

function groupKey(t: Transcript): string {
  return t.attack_class ?? 'benign';
}

export function summarizeBySplit(
  verdicts: readonly TranscriptVerdict<SplitTranscript>[],
): readonly MetricsRow[] {
  const buckets = new Map<string, { total: number; caught: number }>();

  for (const v of verdicts) {
    const key = `${groupKey(v.transcript)}::${v.transcript.split}`;
    const bucket = buckets.get(key) ?? { total: 0, caught: 0 };
    bucket.total += 1;
    if (v.caught) bucket.caught += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .map(([key, { total, caught }]) => {
      const [group, split] = key.split('::') as [string, Split];
      return { group, split, total, caught, rate: caught / total };
    })
    .sort((a, b) => a.group.localeCompare(b.group) || a.split.localeCompare(b.split));
}
