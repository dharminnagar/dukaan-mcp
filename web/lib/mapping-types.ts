/**
 * Types and tiny pure constants shared between the client page and the
 * server actions. Zero dependencies (no `csv-parse`) on purpose — the
 * client component imports this module directly so it never pulls a
 * server-only CSV parser into the browser bundle. See lib/mapping.ts for
 * the CSV-handling functions that build on these shapes.
 */

export const CANONICAL_FIELDS = [
  "sku",
  "name",
  "price",
  "stock",
  "category",
] as const;
export type CanonicalField = (typeof CANONICAL_FIELDS)[number];

/** Model's raw proposal: each canonical field maps to a header string it saw, or null (not found). */
export type ProposedMapping = Record<CanonicalField, string | null>;
export type ProposedConfidence = Record<CanonicalField, number>;

export interface MappingProposal {
  readonly mapping: ProposedMapping;
  readonly confidence: ProposedConfidence;
}

/** Below this, the UI must not pre-select the model's guess — the merchant chooses. */
export const LOW_CONFIDENCE_THRESHOLD = 0.6;

export function isLowConfidence(confidence: number): boolean {
  return confidence < LOW_CONFIDENCE_THRESHOLD;
}

export function lowConfidenceFields(
  confidence: ProposedConfidence
): readonly CanonicalField[] {
  return CANONICAL_FIELDS.filter((f) => isLowConfidence(confidence[f]));
}

/**
 * The mapping actually used to rewrite the CSV, resolved by the merchant in
 * the UI from a `MappingProposal`. `category` is the one field allowed to
 * resolve to a fixed literal instead of a source column — the model itself
 * may only ever propose a column name or null for category (see
 * lib/mapping.ts's `parseModelMappingResponse`); the fixed literal always
 * comes from the merchant typing one in.
 */
export interface ColumnMapping {
  readonly sku: string;
  readonly name: string;
  readonly price: string;
  readonly stock: string;
  readonly category:
    | { readonly kind: "column"; readonly column: string }
    | { readonly kind: "fixed"; readonly value: string };
}

/* ------------------------------------------------ CSV column value summaries */

/**
 * What one column of the uploaded CSV contains, computed over EVERY row.
 *
 * The row count matters more than it looks. `startMapping` hands the client only
 * a short preview slice, and deriving the category options from that slice would
 * silently drop any category that first appears further down the file — on
 * `fixtures/demo-merchant-a.csv` that is `personal-care` (row 22) and `beverages`
 * (row 24), which are exactly the two the demo policy excludes. So these summaries
 * are computed server-side over the whole file and shipped alongside the preview.
 */
export interface ColumnValueSummary {
  /**
   * Distinct values in first-appearance order, blanks excluded. EMPTY when
   * `truncated` — a column with thousands of distinct values is an identifier,
   * not a category, and shipping those values would be pure payload.
   */
  readonly values: readonly string[];
  /** The true distinct count, still accurate when `values` was dropped. */
  readonly distinctCount: number;
  /** Rows whose cell here was empty or whitespace-only. */
  readonly blankRows: number;
  readonly truncated: boolean;
}

export interface CsvColumns {
  readonly header: readonly string[];
  readonly rowCount: number;
  readonly previewRows: readonly Record<string, string>[];
  readonly columnValues: Readonly<Record<string, ColumnValueSummary>>;
}

/** Past this many distinct values a column is not a category and gets no picker. */
export const CATEGORY_DISTINCT_CAP = 200;

/** Past this many, the mapping step warns without blocking — 60 real categories is possible. */
export const CATEGORY_REVIEW_THRESHOLD = 40;

/**
 * Below this many rows the distinct-to-row ratio says nothing useful, so the
 * "looks like an identifier" heuristic is not applied at all.
 */
export const NEARLY_UNIQUE_MIN_ROWS = 20;

export type CategoryColumnVerdict = "ok" | "review" | "unusable";

/**
 * Whether a column can serve as the category source.
 *
 * `unusable` is a hard stop rather than a warning, for two reasons that are not
 * cosmetic. The gate serialises the entire allowlist into every
 * `CATEGORY_NOT_ALLOWED` response it sends an agent (src/gate/index.ts), so a
 * few-thousand-element allowlist is a payload problem on a hot path. And
 * offering "the first 200" would write a policy that silently omits the rest,
 * blocking those products at checkout with nothing to diagnose it by.
 */
export function categoryColumnVerdict(
  summary: ColumnValueSummary | undefined,
  rowCount: number
): CategoryColumnVerdict {
  if (summary === undefined) return "ok";
  // Both conditions are deliberate and neither is redundant, though with
  // `readCsvColumns`'s default cap they always agree. `truncated` says the
  // extractor gave up retaining values; `distinctCount > CATEGORY_DISTINCT_CAP`
  // enforces the UI's own limit independently, so a caller that raised the
  // extractor's cap still cannot make this function bless a 5,000-checkbox
  // picker.
  //
  // Consequence worth stating, because it is easy to get backwards: THIS
  // function is the authority on whether a column may be used, not
  // `availableCategoriesFor`, which reports what exists and deliberately does
  // no gating. A caller that checks only for a non-empty category list has not
  // checked anything — gate on this verdict.
  if (summary.truncated || summary.distinctCount > CATEGORY_DISTINCT_CAP) {
    return "unusable";
  }
  // Nearly one distinct value per row is an identifier column wearing a
  // category's name. Only meaningful once there are enough rows for the ratio
  // to mean anything: a 5-row catalog with 3 categories is perfectly ordinary
  // and trips a bare ratio test, which would have flagged
  // fixtures/shopify-export.csv — 5 rows, 3 categories — as suspicious.
  const nearlyUnique =
    rowCount >= NEARLY_UNIQUE_MIN_ROWS &&
    summary.distinctCount > rowCount * 0.5;
  if (summary.distinctCount > CATEGORY_REVIEW_THRESHOLD || nearlyUnique) {
    return "review";
  }
  return "ok";
}

/**
 * The categories on offer for the allowlist, given how the merchant resolved the
 * category field. `categoryColumn` is null when no source column was chosen, in
 * which case the single typed-in literal is the only option.
 */
export function availableCategoriesFor(
  categoryColumn: string | null,
  fixedCategory: string,
  columnValues: Readonly<Record<string, ColumnValueSummary>>
): readonly string[] {
  if (categoryColumn === null) {
    const trimmed = fixedCategory.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  return columnValues[categoryColumn]?.values ?? [];
}

/**
 * The allowlist to submit, as the available set minus what the merchant unticked.
 *
 * The EXCLUSION set is the stored state, never the selection — that is what makes
 * a stale category unrepresentable rather than something a transition has to
 * remember to clear. Remap the category column and the new column's values are
 * simply not in the exclusion set, so they arrive ticked; the old column's
 * entries linger in the set as unreachable strings and cost nothing. It also
 * means A -> B -> A restores the merchant's earlier unticks, which is what a
 * person expects.
 *
 * A corollary of the gate comparing categories with `===`: a catalog containing
 * both `Dairy` and `dairy` yields two separate entries here, and that is correct.
 * Do not case-fold or dedupe — neither src/catalog/policy.ts nor the gate does,
 * so folding in this one place would manufacture a category that matches nothing.
 */
export function selectedFrom(
  available: readonly string[],
  excluded: ReadonlySet<string>
): readonly string[] {
  return available.filter((c) => !excluded.has(c));
}
