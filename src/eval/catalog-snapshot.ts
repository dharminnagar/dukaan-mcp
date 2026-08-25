/**
 * Reads the REAL DUK-11 demo catalogs and policies straight off disk — no
 * Postgres, no network — so the hand-scripted attacks and the benign
 * generator are built against actual seed data (prices, stock, categories,
 * thresholds) instead of a hand-copied approximation that could drift from
 * fixtures/demo-merchant-{a,b}.csv the day someone edits them. This module
 * only reads files already owned by DUK-11; it never writes to them.
 */
import { readFileSync } from 'node:fs';
import { parseCatalogCsv } from '../catalog/csv';
import { parsePolicy } from '../catalog/policy';
import type { Policy, Product } from '../shared/contracts';
import type { EvalMerchant } from './transcript';

const FIXTURES_DIR = `${import.meta.dir}/../../fixtures`;

const DEMO_SOURCE: Record<EvalMerchant, { csvPath: string; policyPath: string; sourceMerchantId: string }> = {
  kirana: {
    csvPath: `${FIXTURES_DIR}/demo-merchant-a.csv`,
    policyPath: `${FIXTURES_DIR}/demo-merchant-a.policy.json`,
    sourceMerchantId: 'm_demo_kirana',
  },
  electronics: {
    csvPath: `${FIXTURES_DIR}/demo-merchant-b.csv`,
    policyPath: `${FIXTURES_DIR}/demo-merchant-b.policy.json`,
    sourceMerchantId: 'm_demo_electronics',
  },
};

export interface CatalogSnapshot {
  readonly merchant: EvalMerchant;
  readonly products: readonly Product[];
  readonly productsById: ReadonlyMap<string, Product>;
  readonly policy: Policy;
}

let cache: Record<EvalMerchant, CatalogSnapshot> | null = null;

function loadOne(merchant: EvalMerchant): CatalogSnapshot {
  const source = DEMO_SOURCE[merchant];
  const csv = readFileSync(source.csvPath, 'utf8');
  const policyJson: unknown = JSON.parse(readFileSync(source.policyPath, 'utf8'));

  const { products: rawProducts } = parseCatalogCsv(csv, source.sourceMerchantId);
  const products: Product[] = rawProducts.map((p) => ({ ...p, updated_at: new Date(0) }));
  const policy = parsePolicy(policyJson, source.sourceMerchantId);

  return {
    merchant,
    products,
    productsById: new Map(products.map((p) => [p.id, p])),
    policy,
  };
}

/** Loaded once per process; the underlying files never change mid-run. */
export function loadCatalogSnapshots(): Record<EvalMerchant, CatalogSnapshot> {
  if (cache === null) {
    cache = { kirana: loadOne('kirana'), electronics: loadOne('electronics') };
  }
  return cache;
}

export function getProduct(snapshot: CatalogSnapshot, itemId: string): Product {
  const product = snapshot.productsById.get(itemId);
  if (product === undefined) {
    throw new Error(`catalog-snapshot: "${itemId}" is not in the ${snapshot.merchant} demo catalog`);
  }
  return product;
}
