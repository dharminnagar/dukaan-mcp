import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { buildFrozenDataset } from "../src/eval/dataset";
import { callOpenRouterChat } from "../src/eval/llm-generate";
import { buildLlmGenerationPrompt } from "../src/eval/llm-prompt";
import {
  llmFixtureExists,
  validateModelResponse,
} from "../src/eval/llm-source";

/**
 * Entirely offline: every case here either calls pure functions or injects
 * a stub `fetch`. Nothing in this file hits OPENROUTER_API_KEY or the live
 * API — that only ever happens inside `bun run eval:generate:llm`
 * (src/eval/llm-generate.ts), a separate, human-run command this test
 * suite never invokes.
 */

const TARGETS = { benign: 42, adversarial: 18 };

describe("validateModelResponse (offline, no network)", () => {
  test('a well-formed model response validates and lands with origin "llm"', () => {
    const raw = JSON.stringify({
      benign: [
        {
          merchant: "kirana",
          steps: [
            {
              items: [
                {
                  item_id: "sku-a01",
                  quantity: 2,
                  asserted_price_paise: 14500,
                },
              ],
              note: "buys some dal",
            },
          ],
        },
      ],
      adversarial: [],
    });

    const { transcripts, summary } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(1);
    expect(transcripts[0]?.origin).toBe("llm");
    expect(transcripts[0]?.attack_class).toBeNull();
    expect(transcripts[0]?.expected_tripped_rule).toBeNull();
    expect(summary.returned.benign).toBe(1);
    expect(summary.validated.benign).toBe(1);
    expect(summary.rejections.length).toBe(0);
  });

  test("a malformed session is rejected, not repaired, and the rejection is counted", () => {
    const raw = JSON.stringify({
      benign: [
        {
          merchant: "kirana",
          // quantity is negative — fails the LineItem shape outright.
          steps: [
            {
              items: [
                {
                  item_id: "sku-a01",
                  quantity: -3,
                  asserted_price_paise: 14500,
                },
              ],
            },
          ],
        },
      ],
      adversarial: [],
    });

    const { transcripts, summary } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(0);
    expect(summary.returned.benign).toBe(1);
    expect(summary.validated.benign).toBe(0);
    expect(summary.rejections.length).toBe(1);
    expect(summary.rejections[0]?.role).toBe("benign");
    expect(summary.rejections[0]?.reason).toContain("schema");
  });

  test("a transcript referencing a SKU that does not exist is rejected", () => {
    const raw = JSON.stringify({
      benign: [
        {
          merchant: "kirana",
          steps: [
            {
              items: [
                {
                  item_id: "sku-does-not-exist",
                  quantity: 1,
                  asserted_price_paise: 100,
                },
              ],
            },
          ],
        },
      ],
      adversarial: [],
    });

    const { transcripts, summary } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(0);
    expect(summary.rejections.length).toBe(1);
    expect(summary.rejections[0]?.reason).toContain("sku-does-not-exist");
  });

  test('origin is forced to "llm" even if the model returns something else', () => {
    const raw = JSON.stringify({
      benign: [
        {
          merchant: "kirana",
          origin: "hand", // hallucinated extra field — must be ignored, never trusted
          steps: [
            {
              items: [
                {
                  item_id: "sku-a01",
                  quantity: 1,
                  asserted_price_paise: 14500,
                },
              ],
            },
          ],
        },
      ],
      adversarial: [],
    });

    const { transcripts } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(1);
    expect(transcripts[0]?.origin).toBe("llm");
  });

  test("an adversarial session whose last step trips a price mismatch classifies as stale_price/AUTHORITATIVE_REREAD", () => {
    const raw = JSON.stringify({
      benign: [],
      adversarial: [
        {
          merchant: "kirana",
          intent: "claims a lower cached price than the current catalog price",
          steps: [
            {
              items: [
                {
                  item_id: "sku-a01",
                  quantity: 2,
                  asserted_price_paise: 10000,
                },
              ],
            },
          ],
        },
      ],
    });

    const { transcripts, summary } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(1);
    expect(transcripts[0]?.attack_class).toBe("stale_price");
    expect(transcripts[0]?.expected_tripped_rule).toBe("AUTHORITATIVE_REREAD");
    expect(transcripts[0]?.origin).toBe("llm");
    expect(summary.attackClassCounts.stale_price).toBe(1);
  });

  test("an adversarial session that never actually violates the published policy is rejected, not force-classified", () => {
    const raw = JSON.stringify({
      benign: [],
      adversarial: [
        {
          merchant: "kirana",
          intent: "tries to buy dal at the correct price, within every limit",
          steps: [
            {
              items: [
                {
                  item_id: "sku-a01",
                  quantity: 1,
                  asserted_price_paise: 14500,
                },
              ],
            },
          ],
        },
      ],
    });

    const { transcripts, summary } = validateModelResponse(raw, TARGETS);
    expect(transcripts.length).toBe(0);
    expect(summary.rejections.length).toBe(1);
    expect(summary.rejections[0]?.reason).toContain("never violates");
  });

  test("top-level JSON that fails to parse yields zero transcripts and one reported rejection, not a thrown error", () => {
    const { transcripts, summary } = validateModelResponse(
      "not json at all {{{",
      TARGETS
    );
    expect(transcripts.length).toBe(0);
    expect(summary.rejections.length).toBe(1);
  });
});

describe("callOpenRouterChat (offline — fetch is always stubbed)", () => {
  test("returns the message content on a successful stubbed response", async () => {
    const stubFetch = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hello" } }] }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const result = await callOpenRouterChat("prompt text", {
      fetch: stubFetch,
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      model: "test/model",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("hello");
  });

  test("an API-level failure (non-2xx) is returned as data, never thrown", async () => {
    const stubFetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;

    const result = await callOpenRouterChat("prompt text", {
      fetch: stubFetch,
      apiKey: "test-key",
      baseUrl: "https://example.invalid",
      model: "test/model",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("429");
  });
});

describe("determinism (pure, offline, no Postgres)", () => {
  test("bun run eval:generate stays byte-identical across two in-process calls with the committed LLM fixture present", () => {
    const first = JSON.stringify(buildFrozenDataset());
    const second = JSON.stringify(buildFrozenDataset());
    expect(first).toBe(second);
  });

  test("llmSource never throws when its fixture is simply absent", () => {
    // Not asserting presence either way here — just that buildFrozenDataset()
    // never depends on network/API access to run at all.
    expect(() => buildFrozenDataset()).not.toThrow();
  });
});

describe("independence guard: the committed prompt must never contain gate logic", () => {
  const FORBIDDEN_SUBSTRINGS = [
    "SPEND_CAP",
    "spentInWindowPaise",
    "AUTHORITATIVE_REREAD",
    "decide(",
    "CATEGORY_ALLOWLIST",
    "approval_threshold_paise",
  ];

  test("buildLlmGenerationPrompt() output contains none of the forbidden substrings", () => {
    const prompt = buildLlmGenerationPrompt(42, 18);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(prompt).not.toContain(forbidden);
    }
    // Sanity check the guard itself is not vacuous.
    expect(prompt.length).toBeGreaterThan(500);
    expect(prompt).toContain("checkout");
    expect(prompt).toContain("spend_cap_rupees");
  });

  test("the committed prompt file, once generated, matches buildLlmGenerationPrompt() exactly and is equally clean", () => {
    const path = `${import.meta.dir}/../fixtures/eval/llm-generation-prompt.md`;
    if (!existsSync(path)) {
      // `bun run eval:generate:llm` has not been run in this checkout yet.
      // The pure-function test above already enforces the guard; this one
      // additionally checks the committed artefact once it exists.
      return;
    }
    const committed = readFileSync(path, "utf8").trim();
    const rebuilt = buildLlmGenerationPrompt(42, 18).trim();
    expect(committed).toBe(rebuilt);
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      expect(committed).not.toContain(forbidden);
    }
  });
});

describe("llmFixtureExists (offline)", () => {
  test("reports a boolean without throwing regardless of whether the fixture exists", () => {
    expect(typeof llmFixtureExists()).toBe("boolean");
  });
});
