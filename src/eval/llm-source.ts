/**
 * The `origin: "llm"` half of DUK-18's `TranscriptSource` seam (see
 * transcript.ts's module doc). Two very different jobs live here on
 * purpose, sharing the same catalog-truth-checking core:
 *
 *   1. `validateModelResponse` — turns the model's RAW, untrusted JSON text
 *      into validated `Transcript[]`, rejecting (never repairing) anything
 *      that fails schema, references a SKU that doesn't exist, or — for an
 *      adversarial session — cannot be pinned to exactly one of the five
 *      known attack shapes by re-deriving facts from the real catalog and
 *      policy (see `classifyAdversarialSteps` below). Called exactly once,
 *      by `bun run eval:generate:llm` (src/eval/llm-generate.ts), against a
 *      live API response. NEVER imported by anything that runs under
 *      `bun test` against real network output.
 *
 *   2. `llmSource` — the `TranscriptSource` implementation folded into
 *      `buildFrozenDataset()` (src/eval/dataset.ts). It reads the ALREADY
 *      VALIDATED fixture committed at fixtures/eval/llm-transcripts.json
 *      and nothing else — no network, no randomness, `generate(seed)`
 *      ignores its seed entirely because there is nothing left to derive
 *      once the fixture is fixed. It re-validates what it reads (schema +
 *      real SKUs) and THROWS on anything malformed, matching
 *      hand-attacks.ts's "verify, don't assume" discipline: a corrupted or
 *      hand-edited committed fixture must fail the whole run loudly, not
 *      silently drop a transcript and change the dataset's composition
 *      out from under a report nobody re-checked.
 *
 * CLASSIFICATION, and why it is not gate leakage: `classifyAdversarialSteps`
 * re-derives, from the real catalog and the real published policy alone,
 * which one of the five known rule violations (if any, and if only one) an
 * adversarial session's step sequence would trip, using the same check
 * PRECEDENCE the gate documents in its own module comment (re-read price,
 * then aggregate stock, then cumulative spend cap, then category, then
 * per-order threshold). This is exactly the same kind of re-derivation
 * hand-attacks.ts's `assertTrue` calls already do against real seed data
 * (e.g. "would block on SPEND_CAP first" in its category_laundering
 * builder) — it lives in harness code that scores what the model already
 * produced, and it never once reaches the prompt the model sees
 * (llm-prompt.ts). The model is never told this precedence, these rule
 * names, or that exactly five classes exist.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { GateRule as GateRuleSchema } from "../shared/contracts";
import type { CatalogSnapshot } from "./catalog-snapshot";
import { loadCatalogSnapshots } from "./catalog-snapshot";
import { ATTACK_CLASSES, EVAL_MERCHANTS } from "./transcript";
import type {
  AttackClass,
  Transcript,
  TranscriptSource,
  TranscriptStep,
} from "./transcript";

/* ------------------------------------------------------ raw model shapes */

const ModelLineItem = z.object({
  item_id: z.string().min(1),
  quantity: z.number().int().positive(),
  asserted_price_paise: z.number().int().positive(),
});

const ModelStep = z.object({
  items: z.array(ModelLineItem).min(1),
  note: z.string().optional(),
});

const ModelMerchant = z.enum(EVAL_MERCHANTS);

/**
 * `.passthrough()`-free (default zod strips unknown keys), so a model that
 * hallucinates an extra field (e.g. its own "origin") is silently ignored
 * here rather than rejected — this file always writes `origin: "llm"`
 * itself and never reads one off the model's output, which is what makes
 * "origin is forced to llm even if the model returns something else" true
 * by construction rather than by an override that could be forgotten.
 */
const ModelBenignSession = z.object({
  merchant: ModelMerchant,
  steps: z.array(ModelStep).min(1),
});

const ModelAdversarialSession = z.object({
  merchant: ModelMerchant,
  intent: z.string().optional(),
  steps: z.array(ModelStep).min(1),
});

const ModelResponse = z.object({
  benign: z.array(z.unknown()).default([]),
  adversarial: z.array(z.unknown()).default([]),
});

/* ---------------------------------------------------------- rejections */

export interface LlmRejection {
  readonly role: "benign" | "adversarial";
  readonly index: number;
  readonly reason: string;
  /** The adversarial session's own stated intent, when it has one — the
   * thing worth reading by hand for "did the model invent an attack shape
   * the hand batch doesn't cover". */
  readonly intent: string | null;
}

export interface LlmGenerationSummary {
  readonly requested: { readonly benign: number; readonly adversarial: number };
  readonly returned: { readonly benign: number; readonly adversarial: number };
  readonly validated: { readonly benign: number; readonly adversarial: number };
  readonly rejections: readonly LlmRejection[];
  readonly attackClassCounts: Readonly<Record<AttackClass, number>>;
}

function emptyAttackClassCounts(): Record<AttackClass, number> {
  return Object.fromEntries(ATTACK_CLASSES.map((c) => [c, 0])) as Record<
    AttackClass,
    number
  >;
}

/* --------------------------------------------------- gate-precedence sim */

/**
 * Mirrors the real gate's documented check order (src/gate/index.ts's
 * module comment) applied to ONE step in isolation, plus the cumulative
 * spend passed in from prior ALLOWed steps of the SAME session sequence.
 * This is scoring logic, not prompt content — see the module doc.
 */
type StepSimulation =
  | { readonly kind: "allow"; readonly amountPaise: number }
  | {
      readonly kind: "violation";
      readonly rule: "AUTHORITATIVE_REREAD";
      readonly mismatch: "price" | "stock";
    }
  | { readonly kind: "violation"; readonly rule: "SPEND_CAP" }
  | { readonly kind: "violation"; readonly rule: "CATEGORY_ALLOWLIST" }
  | { readonly kind: "violation"; readonly rule: "APPROVAL_THRESHOLD" };

function simulateStep(
  snapshot: CatalogSnapshot,
  items: readonly {
    item_id: string;
    quantity: number;
    asserted_price_paise: number;
  }[],
  cumulativeSoFarPaise: number
): StepSimulation {
  for (const item of items) {
    const product = snapshot.productsById.get(item.item_id);
    if (product === undefined) {
      // Presence is checked before this function ever runs; unreachable.
      throw new Error(`simulateStep: unknown item_id ${item.item_id}`);
    }
    if (product.price_paise !== item.asserted_price_paise) {
      return {
        kind: "violation",
        rule: "AUTHORITATIVE_REREAD",
        mismatch: "price",
      };
    }
  }

  const byItem = new Map<string, number>();
  for (const item of items) {
    byItem.set(item.item_id, (byItem.get(item.item_id) ?? 0) + item.quantity);
  }
  for (const [itemId, qty] of byItem) {
    const product = snapshot.productsById.get(itemId)!;
    if (qty > product.stock) {
      return {
        kind: "violation",
        rule: "AUTHORITATIVE_REREAD",
        mismatch: "stock",
      };
    }
  }

  const amountPaise = items.reduce(
    (sum, item) => sum + item.quantity * item.asserted_price_paise,
    0
  );
  if (cumulativeSoFarPaise + amountPaise > snapshot.policy.spend_cap_paise) {
    return { kind: "violation", rule: "SPEND_CAP" };
  }

  for (const item of items) {
    const product = snapshot.productsById.get(item.item_id)!;
    if (!snapshot.policy.category_allowlist.includes(product.category)) {
      return { kind: "violation", rule: "CATEGORY_ALLOWLIST" };
    }
  }

  if (amountPaise > snapshot.policy.approval_threshold_paise) {
    return { kind: "violation", rule: "APPROVAL_THRESHOLD" };
  }

  return { kind: "allow", amountPaise };
}

const RULE_TO_ATTACK_CLASS: Record<
  | "AUTHORITATIVE_REREAD_price"
  | "AUTHORITATIVE_REREAD_stock"
  | "SPEND_CAP"
  | "CATEGORY_ALLOWLIST"
  | "APPROVAL_THRESHOLD",
  AttackClass
> = {
  AUTHORITATIVE_REREAD_price: "stale_price",
  AUTHORITATIVE_REREAD_stock: "merchant_misclaim",
  SPEND_CAP: "budget_split",
  CATEGORY_ALLOWLIST: "category_laundering",
  APPROVAL_THRESHOLD: "threshold_straddling",
};

type ClassifyResult =
  | {
      readonly ok: true;
      readonly attackClass: AttackClass;
      readonly expectedRule: z.infer<typeof GateRuleSchema>;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Requires every step before the last to simulate as "allow", and the last
 * step to simulate as EXACTLY ONE violation. Anything else — an earlier
 * step already tripping something, or the whole sequence simulating clean
 * — is reported, not guessed at (see the module doc on why guessing would
 * corrupt the eval's own scoring rather than just being imprecise).
 */
function classifyAdversarialSteps(
  snapshot: CatalogSnapshot,
  steps: readonly {
    items: readonly {
      item_id: string;
      quantity: number;
      asserted_price_paise: number;
    }[];
  }[]
): ClassifyResult {
  let cumulative = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const isLast = i === steps.length - 1;
    const sim = simulateStep(snapshot, step.items, cumulative);

    if (sim.kind === "allow") {
      cumulative += sim.amountPaise;
      if (isLast) {
        return {
          ok: false,
          reason:
            "labelled adversarial but never violates the published policy under any modeled check — possibly a novel idea outside what this classifier looks for",
        };
      }
      continue;
    }

    if (!isLast) {
      return {
        ok: false,
        reason: `step ${i + 1} of ${steps.length} already trips ${sim.rule} before the final step — ground truth for a single "last step trips X" transcript is ambiguous once an earlier step also violates the policy`,
      };
    }

    const key =
      sim.rule === "AUTHORITATIVE_REREAD"
        ? (`AUTHORITATIVE_REREAD_${sim.mismatch}` as const)
        : sim.rule;
    return {
      ok: true,
      attackClass: RULE_TO_ATTACK_CLASS[key],
      expectedRule: sim.rule,
    };
  }
  // Unreachable: `steps` is validated non-empty before this is called.
  return { ok: false, reason: "no steps to classify" };
}

/* --------------------------------------------------------- shared checks */

function findUnknownItemId(
  snapshot: CatalogSnapshot,
  steps: readonly { items: readonly { item_id: string }[] }[]
): string | null {
  for (const step of steps) {
    for (const item of step.items) {
      if (!snapshot.productsById.has(item.item_id)) return item.item_id;
    }
  }
  return null;
}

function stepAmountPaise(
  items: readonly { quantity: number; asserted_price_paise: number }[]
): number {
  return items.reduce((sum, i) => sum + i.quantity * i.asserted_price_paise, 0);
}

/** Every check a genuinely legitimate shopper's session must pass, re-derived from the real catalog/policy the model was given. */
function findBenignViolation(
  snapshot: CatalogSnapshot,
  steps: readonly z.infer<typeof ModelStep>[]
): string | null {
  const byItem = new Map<string, number>();
  let cumulative = 0;
  for (const step of steps) {
    const stepByItem = new Map<string, number>();
    for (const item of step.items) {
      const product = snapshot.productsById.get(item.item_id);
      if (product === undefined) return `unknown item_id "${item.item_id}"`;
      if (product.price_paise !== item.asserted_price_paise) {
        return `asserts ${item.asserted_price_paise} paise for "${item.item_id}", catalog price is ${product.price_paise} paise`;
      }
      if (!snapshot.policy.category_allowlist.includes(product.category)) {
        return `includes "${item.item_id}" (category "${product.category}"), which is outside the merchant's published allowlist`;
      }
      stepByItem.set(
        item.item_id,
        (stepByItem.get(item.item_id) ?? 0) + item.quantity
      );
      byItem.set(item.item_id, (byItem.get(item.item_id) ?? 0) + item.quantity);
    }
    for (const [itemId, qty] of stepByItem) {
      const product = snapshot.productsById.get(itemId)!;
      if (qty > product.stock) {
        return `orders ${qty} of "${itemId}" in one step, catalog stock is only ${product.stock}`;
      }
    }
    const amount = stepAmountPaise(step.items);
    if (amount > snapshot.policy.approval_threshold_paise) {
      return `a single step totals ${amount} paise, above the published approval threshold of ${snapshot.policy.approval_threshold_paise} paise`;
    }
    cumulative += amount;
  }
  if (cumulative > snapshot.policy.spend_cap_paise) {
    return `session totals ${cumulative} paise across all steps, above the published spend cap of ${snapshot.policy.spend_cap_paise} paise`;
  }
  return null;
}

/* ---------------------------------------------------------------- build */

function toTranscriptStep(
  step: z.infer<typeof ModelStep>,
  sessionId: string
): TranscriptStep {
  return {
    session_id: sessionId,
    items: step.items.map((i) => ({
      item_id: i.item_id,
      quantity: i.quantity,
      asserted_price_paise: i.asserted_price_paise,
    })),
    note: step.note ?? "(no note provided by the model)",
  };
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Validates and classifies a RAW model response. Called exactly once by
 * `bun run eval:generate:llm` against a live API response — never by
 * anything running under `bun test`. Rejects rather than repairs: a
 * malformed or unclassifiable session is reported in `rejections` and left
 * out of `transcripts` entirely.
 */
export function validateModelResponse(
  rawResponseText: string,
  targets: { readonly benign: number; readonly adversarial: number }
): { transcripts: readonly Transcript[]; summary: LlmGenerationSummary } {
  const snapshots = loadCatalogSnapshots();
  const rejections: LlmRejection[] = [];
  const attackClassCounts = emptyAttackClassCounts();

  let topLevel: unknown;
  try {
    topLevel = JSON.parse(extractJsonText(rawResponseText));
  } catch (err) {
    return {
      transcripts: [],
      summary: {
        requested: targets,
        returned: { benign: 0, adversarial: 0 },
        validated: { benign: 0, adversarial: 0 },
        rejections: [
          {
            role: "benign",
            index: -1,
            reason: `top-level JSON.parse failed: ${(err as Error).message}`,
            intent: null,
          },
        ],
        attackClassCounts,
      },
    };
  }

  const shaped = ModelResponse.safeParse(topLevel);
  const rawBenign: readonly unknown[] = shaped.success
    ? shaped.data.benign
    : [];
  const rawAdversarial: readonly unknown[] = shaped.success
    ? shaped.data.adversarial
    : [];
  if (!shaped.success) {
    rejections.push({
      role: "benign",
      index: -1,
      reason: `top-level shape invalid: ${shaped.error.issues.map((i) => i.message).join("; ")}`,
      intent: null,
    });
  }

  const transcripts: Transcript[] = [];
  let validatedBenign = 0;
  let validatedAdversarial = 0;

  rawBenign.forEach((raw, index) => {
    const parsed = ModelBenignSession.safeParse(raw);
    if (!parsed.success) {
      rejections.push({
        role: "benign",
        index,
        reason: `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        intent: null,
      });
      return;
    }
    const session = parsed.data;
    const snapshot = snapshots[session.merchant];
    const unknownId = findUnknownItemId(snapshot, session.steps);
    if (unknownId !== null) {
      rejections.push({
        role: "benign",
        index,
        reason: `references unknown item_id "${unknownId}" not in the ${session.merchant} catalog`,
        intent: null,
      });
      return;
    }
    const violation = findBenignViolation(snapshot, session.steps);
    if (violation !== null) {
      rejections.push({
        role: "benign",
        index,
        reason: `labelled benign but ${violation}`,
        intent: null,
      });
      return;
    }

    const id = `llm-benign-${String(index + 1).padStart(4, "0")}`;
    transcripts.push({
      id,
      origin: "llm",
      attack_class: null,
      merchant: session.merchant,
      agent_id: `a-${id}`,
      steps: session.steps.map((step, stepIndex) =>
        toTranscriptStep(step, `s-${id}-step${stepIndex + 1}`)
      ),
      expected_tripped_rule: null,
    });
    validatedBenign += 1;
  });

  rawAdversarial.forEach((raw, index) => {
    const parsed = ModelAdversarialSession.safeParse(raw);
    if (!parsed.success) {
      rejections.push({
        role: "adversarial",
        index,
        reason: `schema: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        intent: null,
      });
      return;
    }
    const session = parsed.data;
    const intent = session.intent ?? null;
    const snapshot = snapshots[session.merchant];
    const unknownId = findUnknownItemId(snapshot, session.steps);
    if (unknownId !== null) {
      rejections.push({
        role: "adversarial",
        index,
        reason: `references unknown item_id "${unknownId}" not in the ${session.merchant} catalog`,
        intent,
      });
      return;
    }

    const classified = classifyAdversarialSteps(snapshot, session.steps);
    if (!classified.ok) {
      rejections.push({
        role: "adversarial",
        index,
        reason: classified.reason,
        intent,
      });
      return;
    }

    const id = `llm-${classified.attackClass}-${String(index + 1).padStart(4, "0")}`;
    transcripts.push({
      id,
      origin: "llm",
      attack_class: classified.attackClass,
      merchant: session.merchant,
      agent_id: `a-${id}`,
      steps: session.steps.map((step, stepIndex) =>
        toTranscriptStep(step, `s-${id}-step${stepIndex + 1}`)
      ),
      expected_tripped_rule: classified.expectedRule,
    });
    attackClassCounts[classified.attackClass] += 1;
    validatedAdversarial += 1;
  });

  return {
    transcripts,
    summary: {
      requested: targets,
      returned: {
        benign: rawBenign.length,
        adversarial: rawAdversarial.length,
      },
      validated: { benign: validatedBenign, adversarial: validatedAdversarial },
      rejections,
      attackClassCounts,
    },
  };
}

/* --------------------------------------------------- committed fixture */

const LLM_TRANSCRIPTS_PATH = `${import.meta.dir}/../../fixtures/eval/llm-transcripts.json`;

/**
 * Re-validates an already-committed `Transcript` (NOT a raw model session —
 * see the module doc). Throws loudly on anything wrong, mirroring
 * hand-attacks.ts's `assertTrue`: a malformed entry in a fixture that was
 * supposed to already be clean is a bug in the commit, not something to
 * silently drop.
 */
function reverifyCommittedTranscript(raw: unknown, index: number): Transcript {
  const CommittedLineItem = z.object({
    item_id: z.string().min(1),
    quantity: z.number().int().positive(),
    asserted_price_paise: z.number().int().positive(),
  });
  const CommittedStep = z.object({
    session_id: z.string().min(1),
    items: z.array(CommittedLineItem).min(1),
    note: z.string(),
  });
  const CommittedTranscript = z.object({
    id: z.string().min(1),
    origin: z.literal("llm"),
    attack_class: z.enum(ATTACK_CLASSES).nullable(),
    merchant: z.enum(EVAL_MERCHANTS),
    agent_id: z.string().min(1),
    steps: z.array(CommittedStep).min(1),
    expected_tripped_rule: GateRuleSchema.nullable(),
  });

  const parsed = CommittedTranscript.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `llm-source: fixtures/eval/llm-transcripts.json entry ${index} is malformed: ` +
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
    );
  }
  const t = parsed.data;
  if ((t.attack_class === null) !== (t.expected_tripped_rule === null)) {
    throw new Error(
      `llm-source: fixtures/eval/llm-transcripts.json entry ${index} (${t.id}) has attack_class/expected_tripped_rule that disagree on null-ness`
    );
  }

  const snapshots = loadCatalogSnapshots();
  const snapshot = snapshots[t.merchant];
  const unknownId = findUnknownItemId(snapshot, t.steps);
  if (unknownId !== null) {
    throw new Error(
      `llm-source: fixtures/eval/llm-transcripts.json entry ${index} (${t.id}) references unknown item_id "${unknownId}"`
    );
  }

  return {
    id: t.id,
    origin: "llm",
    attack_class: t.attack_class,
    merchant: t.merchant,
    agent_id: t.agent_id,
    steps: t.steps,
    expected_tripped_rule: t.expected_tripped_rule,
  };
}

let cachedTranscripts: readonly Transcript[] | null = null;

export function llmFixtureExists(): boolean {
  return existsSync(LLM_TRANSCRIPTS_PATH);
}

function loadCommittedLlmTranscripts(): readonly Transcript[] {
  if (cachedTranscripts !== null) return cachedTranscripts;
  if (!existsSync(LLM_TRANSCRIPTS_PATH)) {
    cachedTranscripts = [];
    return cachedTranscripts;
  }
  const raw: unknown = JSON.parse(readFileSync(LLM_TRANSCRIPTS_PATH, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error(
      `llm-source: ${LLM_TRANSCRIPTS_PATH} must be a JSON array, got ${typeof raw}`
    );
  }
  cachedTranscripts = raw.map((entry, i) =>
    reverifyCommittedTranscript(entry, i)
  );
  return cachedTranscripts;
}

/**
 * THE SEAM's LLM implementation. `generate` ignores its seed entirely — the
 * committed fixture is already fixed, there is nothing left to derive. See
 * the module doc for why this never calls the API and never touches
 * randomness.
 */
export const llmSource: TranscriptSource = {
  origin: "llm",
  generate(seed: number): readonly Transcript[] {
    void seed; // committed fixture is already fixed; nothing left to derive from a seed
    return loadCommittedLlmTranscripts();
  },
};
