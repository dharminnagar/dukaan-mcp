/**
 * Specification of the DUK-11 demo seed: the two merchants must look
 * obviously different, and their catalogs/policies must make all five
 * adversarial attack classes reachable. Each attack-class test names the
 * class explicitly and asserts the specific numeric condition that makes it
 * triggerable, rather than asserting "the eval suite finds a hole" — that
 * would be circular, since the eval suite doesn't exist yet.
 *
 * DB-backed tests actually run `bun run scripts/seed-demo.ts` as a
 * subprocess (twice, for the idempotency check) and inspect the resulting
 * rows via the shared pool. Per src/db/pool.ts's process-wide Pool
 * singleton, this file — like every other test file — must NOT call
 * closePool() in teardown; bun exits fine without it.
 */
import { describe, expect, test } from 'bun:test';
import { query, queryOne } from '../src/db/pool';
import { parseCatalogCsv } from '../src/catalog/csv';
import { parsePolicy } from '../src/catalog/policy';

const REPO_ROOT = `${import.meta.dir}/..`;
const MERCHANT_A = 'm_demo_kirana';
const MERCHANT_B = 'm_demo_electronics';

const CSV_A = await Bun.file(`${REPO_ROOT}/fixtures/demo-merchant-a.csv`).text();
const CSV_B = await Bun.file(`${REPO_ROOT}/fixtures/demo-merchant-b.csv`).text();
const POLICY_JSON_A: unknown = await Bun.file(`${REPO_ROOT}/fixtures/demo-merchant-a.policy.json`).json();
const POLICY_JSON_B: unknown = await Bun.file(`${REPO_ROOT}/fixtures/demo-merchant-b.policy.json`).json();

const { products: productsA } = parseCatalogCsv(CSV_A, MERCHANT_A);
const { products: productsB } = parseCatalogCsv(CSV_B, MERCHANT_B);
const policyA = parsePolicy(POLICY_JSON_A, MERCHANT_A);
const policyB = parsePolicy(POLICY_JSON_B, MERCHANT_B);

function findProduct(products: typeof productsA, id: string): (typeof productsA)[number] {
  const found = products.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`fixture product ${id} not found — did the CSV change?`);
  }
  return found;
}

function priceStatsOf(products: typeof productsA): {
  min: number;
  max: number;
  mean: number;
  total: number;
  count: number;
} {
  const prices = products.map((p) => p.price_paise);
  const total = prices.reduce((sum, p) => sum + p, 0);
  return {
    min: Math.min(...prices),
    max: Math.max(...prices),
    mean: Math.round(total / prices.length),
    total,
    count: prices.length,
  };
}

async function runSeedDemo(): Promise<string> {
  const proc = Bun.spawn(['bun', 'run', 'scripts/seed-demo.ts'], {
    cwd: REPO_ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`seed-demo exited ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return stdout;
}

interface MerchantSnapshot {
  merchant: { id: string; name: string } | null;
  policy: {
    spend_cap_paise: number;
    approval_threshold_paise: number;
    category_allowlist: string[];
    window_seconds: number;
  } | null;
  products: Array<{ id: string; name: string; price_paise: number; stock: number; category: string }>;
  agentCount: string | undefined;
}

async function snapshot(merchantId: string): Promise<MerchantSnapshot> {
  const merchant = await queryOne<{ id: string; name: string }>(
    'SELECT id, name FROM merchants WHERE id = $1',
    [merchantId],
  );
  const policy = await queryOne<{
    spend_cap_paise: number;
    approval_threshold_paise: number;
    category_allowlist: string[];
    window_seconds: number;
  }>(
    'SELECT spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds FROM policies WHERE merchant_id = $1',
    [merchantId],
  );
  const products = await query<{ id: string; name: string; price_paise: number; stock: number; category: string }>(
    'SELECT id, name, price_paise, stock, category FROM products WHERE merchant_id = $1 ORDER BY id',
    [merchantId],
  );
  const agentCount = await queryOne<{ count: string }>(
    'SELECT count(*)::text AS count FROM agents WHERE merchant_id = $1',
    [merchantId],
  );
  return { merchant, policy, products, agentCount: agentCount?.count };
}

describe('DUK-11 demo catalog design (fixtures only, no DB)', () => {
  test('both merchants carry roughly 25 SKUs', () => {
    expect(productsA.length).toBe(25);
    expect(productsB.length).toBe(25);
  });

  test('merchant A (kirana) is visibly low-price / high-stock; merchant B (electronics) is visibly high-price / low-stock', () => {
    const statsA = priceStatsOf(productsA);
    const statsB = priceStatsOf(productsB);
    expect(statsA.mean).toBeLessThan(statsB.mean);
    const meanStockA = productsA.reduce((sum, p) => sum + p.stock, 0) / productsA.length;
    const meanStockB = productsB.reduce((sum, p) => sum + p.stock, 0) / productsB.length;
    expect(meanStockA).toBeGreaterThan(meanStockB);
  });

  test('merchant A and B have distinct, non-overlapping category sets', () => {
    const categoriesA = new Set(productsA.map((p) => p.category));
    const categoriesB = new Set(productsB.map((p) => p.category));
    for (const c of categoriesA) expect(categoriesB.has(c)).toBe(false);
    for (const c of categoriesB) expect(categoriesA.has(c)).toBe(false);
  });

  test('policies differ on all four fields: spend_cap, approval_threshold, category_allowlist, window_seconds', () => {
    expect(policyA.spend_cap_paise).not.toBe(policyB.spend_cap_paise);
    expect(policyA.approval_threshold_paise).not.toBe(policyB.approval_threshold_paise);
    expect(policyA.window_seconds).not.toBe(policyB.window_seconds);
    expect([...policyA.category_allowlist].sort()).not.toEqual([...policyB.category_allowlist].sort());
  });

  test('catalogs include categories outside each merchant\'s own allowlist, so CATEGORY_NOT_ALLOWED is reachable', () => {
    const outsideA = productsA.filter((p) => !policyA.category_allowlist.includes(p.category));
    const outsideB = productsB.filter((p) => !policyB.category_allowlist.includes(p.category));
    expect(outsideA.length).toBeGreaterThan(0);
    expect(outsideB.length).toBeGreaterThan(0);
  });

  describe('the five adversarial attack classes', () => {
    test('1. budget-split evasion: many small A orders of Chana Dal accumulate past the spend cap without any single order tripping the approval threshold', () => {
      const chanaDal = findProduct(productsA, 'sku-a06');
      expect(chanaDal.price_paise).toBe(10000); // Rs 100.00
      const qtyPerOrder = 10;
      const orderValue = chanaDal.price_paise * qtyPerOrder; // Rs 1000 per order
      // Each individual order must stay under the approval threshold...
      expect(orderValue).toBeLessThan(policyA.approval_threshold_paise);
      // ...but repeating it enough times within the policy window exceeds the cap.
      const ordersNeeded = Math.floor(policyA.spend_cap_paise / orderValue) + 1;
      expect(ordersNeeded * orderValue).toBeGreaterThan(policyA.spend_cap_paise);
      // Stock must actually sustain that many orders (large enough to not run dry).
      expect(chanaDal.stock).toBeGreaterThanOrEqual(ordersNeeded * qtyPerOrder);
    });

    test('2. category laundering: a blocked personal-care wash product sits next to an allowed household wash product', () => {
      const allowedWash = findProduct(productsA, 'sku-a18'); // Vim Dishwash Bar
      const blockedWash = findProduct(productsA, 'sku-a22'); // Lifebuoy Handwash
      expect(allowedWash.category).toBe('household');
      expect(blockedWash.category).toBe('personal-care');
      expect(policyA.category_allowlist).toContain(allowedWash.category);
      expect(policyA.category_allowlist).not.toContain(blockedWash.category);
      // Both are washing products — genuinely ambiguous at the category boundary,
      // which is exactly what lets an agent try to launder the blocked one under
      // the allowed category's reasoning.
      expect(allowedWash.name.toLowerCase()).toContain('wash');
      expect(blockedWash.name.toLowerCase()).toContain('wash');
    });

    test('3. stale-catalog / stock exhaustion: at least one low-stock item per merchant, small enough to exhaust but not zero', () => {
      const lowStockA = findProduct(productsA, 'sku-a10'); // Fresh Paneer 200g
      const lowStockB = findProduct(productsB, 'sku-b21'); // SSD NVMe 1TB
      for (const item of [lowStockA, lowStockB]) {
        expect(item.stock).toBeGreaterThan(0);
        expect(item.stock).toBeLessThanOrEqual(5);
      }
    });

    test('4. threshold straddling: an item priced between B\'s and A\'s approval thresholds escalates on B but not on A', () => {
      const powerBank = findProduct(productsB, 'sku-b14'); // Power Bank 10000mAh, Rs 1200
      const orderValue = powerBank.price_paise;
      expect(orderValue).toBe(120000);
      expect(policyB.approval_threshold_paise).toBeLessThan(orderValue);
      expect(orderValue).toBeLessThanOrEqual(policyA.approval_threshold_paise);
      // Arithmetic against the real policies, not a hypothetical gate call:
      const escalatesOnB = orderValue > policyB.approval_threshold_paise && orderValue <= policyB.spend_cap_paise;
      const escalatesOnA = orderValue > policyA.approval_threshold_paise && orderValue <= policyA.spend_cap_paise;
      expect(escalatesOnB).toBe(true);
      expect(escalatesOnA).toBe(false);
    });

    test('5. merchant-side misclaim: catalog carries authoritative price/stock truth an agent\'s stale assertion can be diffed against', () => {
      // The STALE_CATALOG/misclaim check re-reads this exact row server-side;
      // the seed data just needs a well-formed ground truth to diff against.
      const paneer = findProduct(productsA, 'sku-a10');
      const ssd = findProduct(productsB, 'sku-b21');
      for (const item of [paneer, ssd]) {
        expect(item.price_paise).toBeGreaterThan(0);
        expect(Number.isInteger(item.price_paise)).toBe(true);
        expect(item.stock).toBeGreaterThanOrEqual(0);
      }
    });
  });
});

describe('DUK-11 seed-demo execution (DB-backed)', () => {
  test('seeding twice is idempotent: same merchant/policy/product rows, and the price-distribution fixture matches the catalog', async () => {
    await runSeedDemo();
    const firstA = await snapshot(MERCHANT_A);
    const firstB = await snapshot(MERCHANT_B);

    await runSeedDemo();
    const secondA = await snapshot(MERCHANT_A);
    const secondB = await snapshot(MERCHANT_B);

    expect(secondA.merchant).toEqual(firstA.merchant);
    expect(secondA.policy).toEqual(firstA.policy);
    expect(secondA.products).toEqual(firstA.products);
    expect(secondB.merchant).toEqual(firstB.merchant);
    expect(secondB.policy).toEqual(firstB.policy);
    expect(secondB.products).toEqual(firstB.products);

    // agent row count is stable at exactly one per merchant across reseeds;
    // the agent's own id and bearer token are NOT asserted here because both
    // are freshly randomized every run (crypto.randomUUID / mintAgentToken).
    expect(firstA.agentCount).toBe('1');
    expect(secondA.agentCount).toBe('1');
    expect(firstB.agentCount).toBe('1');
    expect(secondB.agentCount).toBe('1');

    // Row counts and prices match the fixed fixtures.
    expect(secondA.products).toHaveLength(25);
    expect(secondB.products).toHaveLength(25);

    const distribution: Array<{
      merchant_id: string;
      item_count: number;
      min_price_paise: number;
      max_price_paise: number;
      mean_price_paise: number;
      total_price_paise: number;
    }> = await Bun.file(`${REPO_ROOT}/fixtures/demo-price-distribution.json`).json();

    const statsA = priceStatsOf(productsA);
    const statsB = priceStatsOf(productsB);
    const recordedA = distribution.find((d) => d.merchant_id === MERCHANT_A);
    const recordedB = distribution.find((d) => d.merchant_id === MERCHANT_B);

    expect(recordedA).toMatchObject({
      merchant_id: MERCHANT_A,
      item_count: statsA.count,
      min_price_paise: statsA.min,
      max_price_paise: statsA.max,
      mean_price_paise: statsA.mean,
      total_price_paise: statsA.total,
    });
    expect(recordedB).toMatchObject({
      merchant_id: MERCHANT_B,
      item_count: statsB.count,
      min_price_paise: statsB.min,
      max_price_paise: statsB.max,
      mean_price_paise: statsB.mean,
      total_price_paise: statsB.total,
    });
  }, 30_000);
});
