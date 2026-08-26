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
 * comes from the merchant's own dropdown selection.
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
