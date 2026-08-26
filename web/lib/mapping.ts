/**
 * Pure, offline-testable core of DUK-27's column-mapping step. Nothing in
 * this file touches the network or the database — it only knows how to:
 *
 *   1. build the prompt sent to the model (header + sample rows only),
 *   2. validate/parse whatever comes back,
 *   3. deterministically rewrite an arbitrary CSV into the canonical
 *      `sku,name,price,stock,category` shape `src/catalog/csv.ts` expects.
 *
 * THE RULE THIS FILE ENFORCES: the model may rename columns, never author a
 * value a gate rule reads. `parseModelMappingResponse` only ever accepts a
 * *column name already present in the uploaded header* (or `null`) for each
 * canonical field — it cannot return a literal value, so it cannot invent a
 * price or a category. Category is the one field that resolves to a fixed
 * per-upload literal, and that literal always comes from the merchant's own
 * UI selection (see `ColumnMapping`'s `{ kind: "fixed" }` branch), never
 * from `parseModelMappingResponse`'s output.
 *
 * This module imports `csv-parse` and is only ever imported from
 * app/actions.ts (a server-only file) or from tests. The client page
 * imports lib/mapping-types.ts and lib/merchant-id.ts directly instead, so
 * `csv-parse` never reaches the browser bundle.
 */
import { parse } from "csv-parse/sync";
import { CANONICAL_FIELDS } from "./mapping-types";
import type {
  CanonicalField,
  ColumnMapping,
  MappingProposal,
} from "./mapping-types";

export {
  CANONICAL_FIELDS,
  LOW_CONFIDENCE_THRESHOLD,
  isLowConfidence,
  lowConfidenceFields,
} from "./mapping-types";
export type {
  CanonicalField,
  ColumnMapping,
  MappingProposal,
  ProposedConfidence,
  ProposedMapping,
} from "./mapping-types";
export { isValidMerchantId, slugifyMerchantId } from "./merchant-id";

/* ------------------------------------------------------------- CSV reads */

export interface CsvSample {
  readonly header: readonly string[];
  readonly sampleRows: readonly (readonly string[])[];
}

/**
 * The ONLY function that decides what leaves the server on its way to the
 * model. Reads the whole CSV, but returns just the header plus the first
 * `sampleCount` data rows — nothing else is ever placed in a prompt.
 */
export function readHeaderAndSamples(
  csvText: string,
  sampleCount = 3
): CsvSample {
  const records: string[][] = parse(csvText, {
    columns: false,
    skip_empty_lines: true,
    trim: true,
  });
  if (records.length === 0) {
    throw new Error("CSV has no rows");
  }
  const [header, ...dataRows] = records as [string[], ...string[][]];
  return { header, sampleRows: dataRows.slice(0, sampleCount) };
}

/* --------------------------------------------------------- prompt build */

/**
 * Builds the exact prompt sent to the model. Takes header + sample rows as
 * arguments rather than a CSV string on purpose — a caller physically
 * cannot pass more than what it already extracted via
 * `readHeaderAndSamples`.
 */
export function buildMappingPrompt(
  header: readonly string[],
  sampleRows: readonly (readonly string[])[]
): string {
  const sampleTable = sampleRows.map((row) => JSON.stringify(row)).join("\n");

  return `# Task: map spreadsheet columns to a fixed product schema

You will see a CSV file's header row and up to three sample data rows —
nothing else. Map each of the five canonical fields below to the column
name in the header that holds that data, or to \`null\` if no column holds
it.

## Canonical fields
- "sku": a unique product identifier/code
- "name": the product's display name/title
- "price": the selling price (any currency, any format)
- "stock": quantity available / inventory count
- "category": a product category or type label

## Header
${JSON.stringify(header)}

## Sample rows (up to 3, same order as the header)
${sampleTable}

## Output format
Return ONLY a single JSON object, no markdown fences, no commentary, of
exactly this shape:

{
  "mapping": {
    "sku": "<a header value from the array above, or null>",
    "name": "<a header value from the array above, or null>",
    "price": "<a header value from the array above, or null>",
    "stock": "<a header value from the array above, or null>",
    "category": "<a header value from the array above, or null>"
  },
  "confidence": {
    "sku": <number 0 to 1>,
    "name": <number 0 to 1>,
    "price": <number 0 to 1>,
    "stock": <number 0 to 1>,
    "category": <number 0 to 1>
  }
}

Every "mapping" value must be either \`null\` or copied EXACTLY (character
for character) from the header array above. Never invent a column name that
is not in the header. Never return a product value (a price, a sku, a
name) — only column names.`;
}

/* -------------------------------------------------------- response parse */

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}

/**
 * Validates the model's raw response text against the real header. Returns
 * `null` — never throws — on anything malformed or unparseable, which is
 * the caller's cue to fall back to the exact-header path. This is the sole
 * gate that keeps a hallucinated column name (one not actually in the
 * header) from ever becoming part of a `ColumnMapping`.
 */
export function parseModelMappingResponse(
  raw: string,
  header: readonly string[]
): MappingProposal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonText(raw));
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const rawMapping = obj["mapping"];
  const rawConfidence = obj["confidence"];
  if (typeof rawMapping !== "object" || rawMapping === null) return null;
  if (typeof rawConfidence !== "object" || rawConfidence === null) return null;

  const mappingObj = rawMapping as Record<string, unknown>;
  const confidenceObj = rawConfidence as Record<string, unknown>;

  const mapping = {} as Record<CanonicalField, string | null>;
  const confidence = {} as Record<CanonicalField, number>;

  for (const field of CANONICAL_FIELDS) {
    const value = mappingObj[field];
    if (value === null) {
      mapping[field] = null;
    } else if (typeof value === "string" && header.includes(value)) {
      mapping[field] = value;
    } else {
      // Not null and not an exact header match: either a hallucinated
      // column name or a produced value — reject the whole response.
      return null;
    }

    const conf = confidenceObj[field];
    if (
      typeof conf !== "number" ||
      Number.isNaN(conf) ||
      conf < 0 ||
      conf > 1
    ) {
      return null;
    }
    confidence[field] = conf;
  }

  return { mapping, confidence };
}

/* --------------------------------------------------------- deterministic */

/**
 * The offline fallback: no API key, a failed call, or an unparseable
 * response. Maps each canonical field to itself only if the header already
 * contains that exact name — the same contract `src/catalog/csv.ts` has
 * always enforced. No fuzzy matching here on purpose; the whole point of
 * the fallback is to be exactly the old, well-understood behaviour.
 */
export function exactHeaderFallback(
  header: readonly string[]
): MappingProposal {
  const mapping = {} as Record<CanonicalField, string | null>;
  const confidence = {} as Record<CanonicalField, number>;
  for (const field of CANONICAL_FIELDS) {
    const present = header.includes(field);
    mapping[field] = present ? field : null;
    // Deterministic exact-match is either right (1) or absent (0) — nothing
    // in between to be "unsure" about, so no field from this path is ever
    // flagged low-confidence.
    confidence[field] = present ? 1 : 0;
  }
  return { mapping, confidence };
}

function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Rewrites an arbitrary CSV into the canonical `sku,name,price,stock,category`
 * shape `parseCatalogCsv` (src/catalog/csv.ts) expects, using a resolved
 * `ColumnMapping`. Deterministic string manipulation only — no model
 * involved at this stage, by construction: `ColumnMapping` cannot express
 * "read a value from row N", only "read this named column" or "use this
 * one fixed literal for every row".
 */
export function renameToCanonicalCsv(
  csvText: string,
  mapping: ColumnMapping
): string {
  const rows: Record<string, string | undefined>[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const lines = ["sku,name,price,stock,category"];
  for (const row of rows) {
    const sku = row[mapping.sku] ?? "";
    const name = row[mapping.name] ?? "";
    const price = row[mapping.price] ?? "";
    const stock = row[mapping.stock] ?? "";
    const category =
      mapping.category.kind === "fixed"
        ? mapping.category.value
        : (row[mapping.category.column] ?? "");
    lines.push([sku, name, price, stock, category].map(csvField).join(","));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Parses the CSV into plain row objects keyed by header name, capped at
 * `limit` rows. Used server-side to hand the client a small, already-mapped
 * JSON-serialisable preview slice so the browser never needs a CSV parser
 * of its own — `csv-parse` stays a server-only dependency.
 */
export function parseCsvRowObjects(
  csvText: string,
  limit = 20
): { header: readonly string[]; rows: readonly Record<string, string>[] } {
  const { header } = readHeaderAndSamples(csvText, 0);
  const rows: Record<string, string | undefined>[] = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    to: limit,
  });
  return {
    header,
    rows: rows.map((row) =>
      Object.fromEntries(header.map((h) => [h, row[h] ?? ""]))
    ),
  };
}
