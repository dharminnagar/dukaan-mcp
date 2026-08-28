"use server";

/**
 * The two server actions DUK-20/DUK-27's onboarding page calls. Both are
 * server-only (enforced twice: the "use server" directive above, and the
 * `import "../lib/assert-server-only"` below, which throws if this module
 * is ever evaluated in a browser) and run on the Node runtime — the app
 * router's default for a "use server" file, and required here since
 * `createMerchant` imports `pg` transitively via `src/db/pool`. A "use
 * server" file may only export async functions, so that runtime choice
 * can't be declared with the usual `export const runtime = "nodejs"` route
 * segment config here; `next.config.ts`'s `serverExternalPackages: ["pg"]`
 * is the belt-and-suspenders equivalent for this file.
 *
 * `createMerchant` (src/onboard/create-merchant.ts) is imported directly —
 * no internal HTTP route — so this page and `bun run seed:demo` share one
 * validated path instead of the UI re-implementing catalog/policy
 * validation over a wire.
 */
import "../lib/assert-server-only";
import { createMerchant } from "../../src/onboard/create-merchant";
import {
  buildMappingPrompt,
  exactHeaderFallback,
  isValidMerchantId,
  parseModelMappingResponse,
  readCsvColumns,
  readHeaderAndSamples,
  renameToCanonicalCsv,
  slugifyMerchantId,
} from "../lib/mapping";
import type {
  ColumnMapping,
  ColumnValueSummary,
  MappingProposal,
  ProposedConfidence,
  ProposedMapping,
} from "../lib/mapping";
import { callOpenRouterChat, readOpenRouterEnv } from "../lib/openrouter";

/**
 * The MCP server is a SEPARATE process on its own port, so this must never read
 * bare `PORT`: inside Next that resolves to Next's own port (3000) and the
 * success screen then hands the merchant a dead endpoint — a 404 on the one
 * value the whole onboarding exists to produce.
 *
 * MCP_PUBLIC_URL wins outright when set, which is what a deployment behind a
 * real hostname needs; the host/port pair is only the local-dev default.
 */
const MCP_HOST = process.env["MCP_HOST"] ?? "127.0.0.1";
const MCP_PORT = process.env["MCP_PORT"] ?? "8787";
const MCP_ENDPOINT =
  process.env["MCP_PUBLIC_URL"] ?? `http://${MCP_HOST}:${MCP_PORT}/mcp`;

/** Mirrors the shape `parsePolicy` (src/catalog/policy.ts) expects: rupee strings, not paise. */
export interface PolicyFormInput {
  readonly spend_cap_rupees: string;
  readonly approval_threshold_rupees: string;
  readonly category_allowlist: readonly string[];
  readonly window: string;
  /**
   * The merchant's cap on the sum across every one of its agents. Blank means
   * no aggregate cap, exactly as absent does. Sent as the string the merchant
   * typed and converted server-side by `rupeesToPaise` — never parsed to a
   * number in the browser, where `0.29 * 100` is 28.999999999999996.
   */
  readonly merchant_total_cap_rupees?: string;
}

/**
 * Proposes a column mapping. Called with ONLY a header array and up to
 * three sample rows — see lib/mapping.ts's `readHeaderAndSamples`, which is
 * the sole place that decides what leaves the browser's uploaded CSV on its
 * way here. This function has no way to see the rest of the file: it never
 * receives it as an argument.
 *
 * Returns `null` — never throws — for: no OPENROUTER_API_KEY set, a failed
 * API call, or a response that fails validation (including a response that
 * names a column not actually in the header, or supplies a raw value
 * instead of a column name). The caller falls back to the exact-header
 * path (`exactHeaderFallback` in lib/mapping.ts) in every `null` case.
 */
export async function proposeMapping(
  header: string[],
  sampleRows: string[][]
): Promise<{
  mapping: ProposedMapping;
  confidence: ProposedConfidence;
} | null> {
  const { apiKey, model, baseUrl } = readOpenRouterEnv();
  if (apiKey === null) return null;

  const prompt = buildMappingPrompt(header, sampleRows);
  const result = await callOpenRouterChat(prompt, { apiKey, model, baseUrl });
  if (!result.ok) return null;

  return parseModelMappingResponse(result.text, header);
}

/**
 * Orchestration for the step-1-to-step-2 transition: parses the uploaded
 * CSV server-side (so `csv-parse` never has to reach the client bundle),
 * calls `proposeMapping` with ONLY the header + 3 sample rows it just
 * extracted, and falls back to `exactHeaderFallback` on a `null` result —
 * no API key, a failed call, or an unparseable response. Also returns a
 * small preview slice of parsed rows (plain objects, JSON-serialisable) so
 * the client can render the confirm-mapping preview table locally as the
 * merchant adjusts dropdowns, without another round trip per keystroke —
 * and, via `readCsvColumns`, the distinct values of EVERY column computed
 * over the WHOLE file, which is what lets the page build category
 * checkboxes without dropping any category that first appears past a
 * short preview window.
 */
export async function startMapping(csvText: string): Promise<{
  header: string[];
  rowCount: number;
  previewRows: Record<string, string>[];
  columnValues: Record<string, ColumnValueSummary>;
  proposal: MappingProposal;
  usedFallback: boolean;
}> {
  const { header, sampleRows } = readHeaderAndSamples(csvText, 3);
  const { rowCount, previewRows, columnValues } = readCsvColumns(csvText);

  const proposal = await proposeMapping(
    [...header],
    sampleRows.map((r) => [...r])
  );
  const resolvedProposal = proposal ?? exactHeaderFallback(header);
  return {
    header: [...header],
    rowCount,
    previewRows: [...previewRows],
    columnValues: { ...columnValues },
    proposal: resolvedProposal,
    usedFallback: proposal === null,
  };
}

/**
 * Renames columns deterministically (`renameToCanonicalCsv`, pure string
 * manipulation — no model call happens here), then calls `createMerchant`,
 * which validates the catalog and the policy — and only then opens a
 * transaction. Nothing is written to `products` before this runs, and
 * `createMerchant` never partially commits: validation happens first.
 */
export async function onboard(
  csvText: string,
  mapping: ColumnMapping,
  name: string,
  policy: PolicyFormInput,
  /**
   * The BUYER's cap on the agent this call mints, in rupees. Optional, and
   * blank is the same as absent: it stores NULL, meaning the buyer imposes no
   * constraint. Converted server-side by `createMerchant` through the one
   * integer-string rupee converter — never parsed to a float in the browser.
   */
  buyerCapRupees?: string
): Promise<{
  token: string;
  endpoint: string;
  productCount: number;
  merchantId: string;
  buyerCapPaise: number | null;
}> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new Error("Merchant name is required.");
  }

  const merchantId = slugifyMerchantId(trimmedName);
  if (!isValidMerchantId(merchantId)) {
    throw new Error(
      `Could not derive a valid merchant id from "${trimmedName}" — use a name with at least one letter or digit.`
    );
  }

  const canonicalCsv = renameToCanonicalCsv(csvText, mapping);

  let result: Awaited<ReturnType<typeof createMerchant>>;
  try {
    result = await createMerchant({
      merchantId,
      name: trimmedName,
      csv: canonicalCsv,
      policyJson: policy,
      agentLabel: "web-onboarding-agent",
      buyerCapRupees,
    });
  } catch (err) {
    // A repeated merchant name is the ONE failure a human will hit by accident
    // — re-recording a demo, or onboarding the same shop twice — and Postgres
    // reports it as `duplicate key value violates unique constraint`, which is
    // both alarming and unactionable on screen. Every other error keeps its own
    // message; this one gets translated because the fix is obvious once said
    // out loud.
    //
    // Matched on SQLSTATE 23505, not on message text, so it survives a Postgres
    // locale or version that words the message differently.
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "23505"
    ) {
      // `cause` keeps the driver's own error reachable: the merchant reads the
      // sentence, a developer reading a log still gets the SQLSTATE and the
      // constraint name.
      throw new Error(
        `A merchant named "${trimmedName}" already exists (id ${merchantId}). ` +
          `Pick a different name, or open its dashboard at /dashboard/${merchantId}.`,
        { cause: err }
      );
    }
    throw err;
  }

  return {
    token: result.token,
    endpoint: MCP_ENDPOINT,
    productCount: result.productCount,
    // Returned rather than re-derived on the client: this is the id actually
    // written, and it is what the dashboard link on the success screen needs.
    merchantId: result.merchant.id,
    buyerCapPaise: result.buyerCapPaise,
  };
}
