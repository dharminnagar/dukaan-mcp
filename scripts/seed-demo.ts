/**
 * Seeds two demo merchants from scratch (DUK-11): a kirana/grocery store and
 * an electronics store, deliberately built so all five adversarial attack
 * classes (budget-split evasion, category laundering, stale-catalog /
 * stock exhaustion, threshold straddling, merchant-side misclaim) are
 * triggerable against the seeded catalogs and policies. See
 * fixtures/demo-merchant-{a,b}.csv and fixtures/demo-merchant-{a,b}.policy.json
 * for the actual data, and tests/seed-demo.test.ts for the specification of
 * which numbers make each attack class reachable.
 *
 * Idempotent: deletes the two demo merchants first (ON DELETE CASCADE takes
 * policies/products/agents/sessions/orders with them; audit_events has no
 * FK and deliberately survives), then recreates both from the fixed
 * fixtures below. Two runs in a row produce the same merchant/product/policy
 * rows.
 *
 * NOT idempotent: the agent id and its bearer token. `createMerchant` mints
 * a fresh `ag_<uuid>` id (crypto.randomUUID) and `mintAgentToken()` is
 * CSPRNG by design — both change on every reseed. The token is printed once
 * per run; there is no fixed-token mechanism here (see DUK-25).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { pool, closePool } from '../src/db/pool';
import { createMerchant } from '../src/onboard/create-merchant';
import { parseCatalogCsv } from '../src/catalog/csv';

const FIXTURES_DIR = `${import.meta.dir}/../fixtures`;
const DISTRIBUTION_PATH = `${FIXTURES_DIR}/demo-price-distribution.json`;

interface DemoMerchantConfig {
  readonly merchantId: string;
  readonly name: string;
  readonly csvPath: string;
  readonly policyPath: string;
  readonly agentLabel: string;
}

const DEMO_MERCHANTS: readonly DemoMerchantConfig[] = [
  {
    merchantId: 'm_demo_kirana',
    name: 'Demo Kirana Store',
    csvPath: `${FIXTURES_DIR}/demo-merchant-a.csv`,
    policyPath: `${FIXTURES_DIR}/demo-merchant-a.policy.json`,
    agentLabel: 'demo-kirana-agent',
  },
  {
    merchantId: 'm_demo_electronics',
    name: 'Demo Electronics Store',
    csvPath: `${FIXTURES_DIR}/demo-merchant-b.csv`,
    policyPath: `${FIXTURES_DIR}/demo-merchant-b.policy.json`,
    agentLabel: 'demo-electronics-agent',
  },
];

interface PriceStats {
  readonly merchant_id: string;
  readonly item_count: number;
  readonly min_price_paise: number;
  readonly max_price_paise: number;
  readonly mean_price_paise: number;
  readonly total_price_paise: number;
}

/**
 * "Order value" here assumes a single-item, quantity-1 order — the seed
 * catalog's baseline. A multi-item basket shifts mean order value upward
 * proportionally to basket size; this is the per-unit price distribution,
 * which is the number a reader rescales the blocked-GMV figure from.
 */
function computePriceStats(merchantId: string, csv: string): PriceStats {
  const { products } = parseCatalogCsv(csv, merchantId);
  const prices = products.map((p) => p.price_paise);
  const total = prices.reduce((sum, p) => sum + p, 0);
  return {
    merchant_id: merchantId,
    item_count: prices.length,
    min_price_paise: Math.min(...prices),
    max_price_paise: Math.max(...prices),
    mean_price_paise: Math.round(total / prices.length),
    total_price_paise: total,
  };
}

function formatRupees(paise: number): string {
  return `Rs${(paise / 100).toFixed(2)}`;
}

async function main(): Promise<void> {
  const merchantIds = DEMO_MERCHANTS.map((m) => m.merchantId);

  // Idempotent reseed: wipe both demo merchants first.
  await pool.query('DELETE FROM merchants WHERE id = ANY($1::text[])', [merchantIds]);

  const priceStats: PriceStats[] = [];

  for (const config of DEMO_MERCHANTS) {
    const csv = readFileSync(config.csvPath, 'utf8');
    const policyJson: unknown = JSON.parse(readFileSync(config.policyPath, 'utf8'));

    const result = await createMerchant({
      merchantId: config.merchantId,
      name: config.name,
      csv,
      policyJson,
      agentLabel: config.agentLabel,
    });

    const stats = computePriceStats(config.merchantId, csv);
    priceStats.push(stats);

    console.log(`merchant created: ${result.merchant.id} (${result.merchant.name})`);
    console.log(`  products loaded: ${result.productCount}`);
    console.log(
      `  policy: spend_cap=${formatRupees(result.policy.spend_cap_paise)} ` +
      `approval_threshold=${formatRupees(result.policy.approval_threshold_paise)} ` +
      `window=${result.policy.window_seconds}s ` +
      `allowlist=[${result.policy.category_allowlist.join(', ')}]`,
    );
    console.log(
      `  price distribution: mean=${formatRupees(stats.mean_price_paise)} ` +
      `range=[${formatRupees(stats.min_price_paise)}, ${formatRupees(stats.max_price_paise)}] ` +
      `over ${stats.item_count} SKUs`,
    );
    console.log(`  agent: ${result.agent.id} (${result.agent.label})`);
    console.log('  agent token (shown once — save it now, it will differ on the next reseed):');
    console.log(`  ${result.token}`);
  }

  writeFileSync(DISTRIBUTION_PATH, `${JSON.stringify(priceStats, null, 2)}\n`);
  console.log(`price distribution written to ${DISTRIBUTION_PATH}`);
}

try {
  await main();
} finally {
  await closePool();
}
