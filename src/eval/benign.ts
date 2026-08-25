/**
 * Ordinary shopping within policy: 1-3 line items, correct prices, modest
 * quantities, from allowed categories only, kept under the merchant's
 * approval threshold so every generated transcript is expected to ALLOW at
 * every step. The only source of variation is the seeded `Rng` passed in —
 * no `Math.random()`, no `Date.now()` — so calling this twice with the same
 * seed produces byte-identical transcripts.
 */
import type { CatalogSnapshot } from './catalog-snapshot';
import { loadCatalogSnapshots } from './catalog-snapshot';
import type { Rng } from './prng';
import { pick, randInt } from './prng';
import type { Product } from '../shared/contracts';
import type { EvalMerchant, Transcript } from './transcript';

/** A product only counts as "affordable" for a benign basket if a single unit,
 * on its own, stays comfortably under the threshold — otherwise the very
 * first pick could escalate a transcript that is supposed to be benign. */
function affordableProducts(snapshot: CatalogSnapshot): readonly Product[] {
  const safetyMargin = Math.floor(snapshot.policy.approval_threshold_paise * 0.9);
  return snapshot.products.filter(
    (p) => snapshot.policy.category_allowlist.includes(p.category) && p.price_paise <= safetyMargin,
  );
}

function buildBenignTranscript(index: string, merchant: EvalMerchant, snapshot: CatalogSnapshot, rng: Rng): Transcript {
  const id = `hand-benign-${index}`;
  const pool = affordableProducts(snapshot);
  const safetyMargin = Math.floor(snapshot.policy.approval_threshold_paise * 0.9);
  const desiredLines = randInt(rng, 1, 3);

  const items: { item_id: string; quantity: number; asserted_price_paise: number }[] = [];
  let runningTotal = 0;
  // The SAME product can be picked more than once for one basket — the
  // gate's stock check is on the AGGREGATE quantity across all line items
  // naming an item, not per line (src/gate/index.ts check 1), so this has
  // to track prior picks or a repeat pick of a low-stock item (e.g.
  // sku-a10, stock 4) could accidentally oversell it and turn a "benign"
  // transcript into a real STALE_CATALOG(stock) block.
  const requestedByItem = new Map<string, number>();

  for (let i = 0; i < desiredLines; i++) {
    const product = pick(rng, pool);
    const alreadyRequested = requestedByItem.get(product.id) ?? 0;
    const remainingStock = product.stock - alreadyRequested;
    if (remainingStock < 1) continue; // this item is spoken for; try the next slot instead

    const maxAffordableQty = Math.max(1, Math.floor((safetyMargin - runningTotal) / product.price_paise));
    if (maxAffordableQty < 1) break; // basket is full; stop rather than risk crossing the threshold
    const quantity = randInt(rng, 1, Math.min(3, maxAffordableQty, remainingStock));
    const amount = product.price_paise * quantity;
    if (runningTotal + amount > safetyMargin) break;

    items.push({ item_id: product.id, quantity, asserted_price_paise: product.price_paise });
    requestedByItem.set(product.id, alreadyRequested + quantity);
    runningTotal += amount;
  }

  // Every product in `pool` individually clears the margin, so the loop
  // above always adds at least one line on its first iteration.
  if (items.length === 0) {
    throw new Error(`benign generator produced an empty basket for ${id} — affordableProducts() pool is empty`);
  }

  return {
    id,
    origin: 'hand',
    attack_class: null,
    merchant,
    agent_id: `a-benign-${index}`,
    steps: [
      {
        session_id: `s-${id}`,
        items,
        note: `ordinary shopping: ${items.length} line item(s) totalling ${runningTotal} paise, well under the ${snapshot.policy.approval_threshold_paise} paise threshold`,
      },
    ],
    expected_tripped_rule: null,
  };
}

export function generateBenignTranscripts(rng: Rng, count: number): readonly Transcript[] {
  const snapshots = loadCatalogSnapshots();
  const merchants: readonly EvalMerchant[] = ['kirana', 'electronics'];
  return Array.from({ length: count }, (_, i) => {
    const merchant = pick(rng, merchants);
    return buildBenignTranscript(String(i + 1).padStart(4, '0'), merchant, snapshots[merchant], rng);
  });
}
