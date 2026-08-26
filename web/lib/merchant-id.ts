/**
 * Pure, dependency-free helpers for deriving and validating a merchant id.
 * Deliberately its own module (no `csv-parse` import anywhere in this file)
 * so the client page can import it directly for the live "m_..." preview
 * next to the name field without pulling a server-only CSV parser into the
 * browser bundle.
 */

/** "Sunny's Kirana Store" -> "m_sunnys_kirana_store", matching `^m_[a-z0-9_]{1,48}$`. */
export function slugifyMerchantId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 46); // leaves room for the "m_" prefix within the 48-char body limit
  return `m_${slug.length > 0 ? slug : "merchant"}`;
}

export function isValidMerchantId(id: string): boolean {
  return /^m_[a-z0-9_]{1,48}$/.test(id);
}
