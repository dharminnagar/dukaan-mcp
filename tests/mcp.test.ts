import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { fetchMcp, setRazorpayAdapter } from '../src/mcp/http';
import { createMerchant } from '../src/onboard/create-merchant';
import { resolveTenant } from '../src/auth/resolve';
import { TenantRepo } from '../src/db/repo';
import { FakeRazorpayAdapter } from '../src/razorpay/index';
import { pool, query } from '../src/db/pool';

/**
 * Seeds its own two merchants rather than depending on `bun run seed:demo` or
 * `fixtures/**` — another agent is actively rewriting those in parallel, and
 * this file would race it. Merchant ids are namespaced to this test file so
 * they cannot collide with that agent's data.
 */
const MERCHANT_A = 'm_mcp_test_a';
const MERCHANT_B = 'm_mcp_test_b';
// Own merchant, tiny spend cap, so the block-by-cap checkout test doesn't
// have to reason about how much A or B have already spent from earlier
// tests in this file.
const MERCHANT_C = 'm_mcp_test_c';
// DUK-29's regression: its own merchant so the concurrent-checkout race
// isn't sharing a spend cap with any other test in this file. Namespaced to
// this ticket rather than the file's mcp_test_* convention.
const MERCHANT_D = 'm_mcp29_concurrent';

const CSV_A = `sku,name,price,stock,category
sku-a1,Widget A,199.00,10,widgets
sku-a2,Gadget A,499.00,5,gadgets
`;

const CSV_B = `sku,name,price,stock,category
sku-b1,Widget B,299.00,20,widgets
`;

const CSV_C = `sku,name,price,stock,category
sku-c1,Costly Item,200.00,10,widgets
`;

const CSV_D = `sku,name,price,stock,category
sku-d1,Concurrency Widget,600.00,1000,widgets
`;

const POLICY = {
  spend_cap_rupees: '5000.00',
  approval_threshold_rupees: '1000.00',
  category_allowlist: ['widgets', 'gadgets'],
  window: '24h',
};

const POLICY_C = {
  spend_cap_rupees: '100.00',
  approval_threshold_rupees: '50.00',
  category_allowlist: ['widgets'],
  window: '24h',
};

// approval_threshold == spend_cap (the max the Policy schema's refine
// allows) so that a single 400.00-rupee line item never crosses the
// approval threshold and escalates — every checkout below must resolve to
// allow or SPEND_CAP_EXCEEDED, nothing else, or the arithmetic in the
// concurrency test stops being exact.
const POLICY_D = {
  spend_cap_rupees: '1000.00',
  approval_threshold_rupees: '1000.00',
  category_allowlist: ['widgets'],
  window: '24h',
};
const POLICY_D_CAP_PAISE = 100_000;

async function cleanupMerchant(merchantId: string): Promise<void> {
  // audit_events has no FK to merchants on purpose (append-only ledger that
  // must survive a merchant deletion), so it needs an explicit delete here;
  // everything else cascades off `merchants`.
  await pool.query('DELETE FROM audit_events WHERE merchant_id = $1', [merchantId]);
  await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
}

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let tokenA: string;
let tokenB: string;
let tokenC: string;
let tokenD: string;
let agentIdD: string;
let fake: FakeRazorpayAdapter;

beforeAll(async () => {
  await cleanupMerchant(MERCHANT_A);
  await cleanupMerchant(MERCHANT_B);
  await cleanupMerchant(MERCHANT_C);
  await cleanupMerchant(MERCHANT_D);

  const a = await createMerchant({
    merchantId: MERCHANT_A,
    name: 'MCP Test Kirana A',
    csv: CSV_A,
    policyJson: POLICY,
    agentLabel: 'mcp-test-agent-a',
  });
  const b = await createMerchant({
    merchantId: MERCHANT_B,
    name: 'MCP Test Kirana B',
    csv: CSV_B,
    policyJson: POLICY,
    agentLabel: 'mcp-test-agent-b',
  });
  const c = await createMerchant({
    merchantId: MERCHANT_C,
    name: 'MCP Test Kirana C',
    csv: CSV_C,
    policyJson: POLICY_C,
    agentLabel: 'mcp-test-agent-c',
  });
  const d = await createMerchant({
    merchantId: MERCHANT_D,
    name: 'MCP Test Kirana D',
    csv: CSV_D,
    policyJson: POLICY_D,
    agentLabel: 'mcp29-concurrent-agent',
  });
  tokenA = a.token;
  tokenB = b.token;
  tokenC = c.token;
  tokenD = d.token;
  agentIdD = d.agent.id;

  // Every checkout test in this file must hit the fake, never the real
  // Razorpay API. Installed once, before any client connects, via the
  // module-level seam in src/mcp/http.ts.
  fake = new FakeRazorpayAdapter();
  setRazorpayAdapter(fake);

  server = Bun.serve({ port: 0, fetch: fetchMcp });
  baseUrl = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(async () => {
  server.stop();
  await cleanupMerchant(MERCHANT_A);
  await cleanupMerchant(MERCHANT_B);
  await cleanupMerchant(MERCHANT_C);
  await cleanupMerchant(MERCHANT_D);
  // src/db/pool.ts exports ONE process-wide Pool singleton shared by every
  // test file in the same `bun test` process. Closing it here would break
  // whichever file runs next (see projectmem issue #0013), so it is
  // deliberately left open; bun exits regardless.
});

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'dukaan-mcp-test-client', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content?.[0];
  if (first === undefined || first.type !== 'text') {
    throw new Error('expected a text content block in the tool result');
  }
  return first.text;
}

type InputSchemaShape = { properties?: Record<string, unknown>; required?: string[] };

describe('MCP Streamable HTTP transport auth', () => {
  test('missing Authorization header returns 401 in the standard error envelope', async () => {
    const res = await fetchMcp(new Request(baseUrl, { method: 'POST' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    const body = (await res.json()) as { reason_code: string };
    expect(body.reason_code).toBe('UNAUTHENTICATED');
  });

  test('a well-formed but unrecognized token returns 401 in the standard error envelope', async () => {
    const res = await fetchMcp(
      new Request(baseUrl, {
        method: 'POST',
        headers: { authorization: 'Bearer dk_this-token-was-never-minted' },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason_code: string };
    expect(body.reason_code).toBe('UNAUTHENTICATED');
  });

  test('a malformed (non-Bearer) Authorization header returns 401', async () => {
    const res = await fetchMcp(
      new Request(baseUrl, {
        method: 'POST',
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      }),
    );
    expect(res.status).toBe(401);
    const body = (await res.json()) as { reason_code: string };
    expect(body.reason_code).toBe('UNAUTHENTICATED');
  });
});

describe('list_products / get_product tenancy', () => {
  test('tool names and schemas are byte-identical regardless of which merchant calls', async () => {
    const clientA = await connect(tokenA);
    const clientB = await connect(tokenB);

    const { tools: toolsA } = await clientA.listTools();
    const { tools: toolsB } = await clientB.listTools();

    expect(toolsA.map((t) => t.name).sort()).toEqual([
      'checkout',
      'get_order_status',
      'get_product',
      'list_products',
    ]);
    expect(JSON.stringify(toolsA)).toBe(JSON.stringify(toolsB));

    await clientA.close();
    await clientB.close();
  });

  test('no tool declares a merchant_id argument, on either tool, for either merchant', async () => {
    const client = await connect(tokenA);
    const { tools } = await client.listTools();

    for (const tool of tools) {
      const schema = tool.inputSchema as InputSchemaShape;
      expect(Object.keys(schema.properties ?? {})).not.toContain('merchant_id');
    }

    const listProducts = tools.find((t) => t.name === 'list_products');
    expect(Object.keys((listProducts?.inputSchema as InputSchemaShape).properties ?? {})).toEqual([]);

    const getProduct = tools.find((t) => t.name === 'get_product');
    expect(Object.keys((getProduct?.inputSchema as InputSchemaShape).properties ?? {})).toEqual(['id']);

    await client.close();
  });

  test("merchant A's token returns only A's catalog", async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({ name: 'list_products', arguments: {} });
    const { products } = JSON.parse(textOf(result)) as {
      products: { id: string; merchant_id: string }[];
    };
    expect(products.map((p) => p.id).sort()).toEqual(['sku-a1', 'sku-a2']);
    expect(products.every((p) => p.merchant_id === MERCHANT_A)).toBe(true);
    await client.close();
  });

  test("merchant B's token returns only B's catalog", async () => {
    const client = await connect(tokenB);
    const result = await client.callTool({ name: 'list_products', arguments: {} });
    const { products } = JSON.parse(textOf(result)) as {
      products: { id: string; merchant_id: string }[];
    };
    expect(products.map((p) => p.id)).toEqual(['sku-b1']);
    expect(products.every((p) => p.merchant_id === MERCHANT_B)).toBe(true);
    await client.close();
  });

  test('get_product returns the product when it belongs to the calling merchant', async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({ name: 'get_product', arguments: { id: 'sku-a1' } });
    const { product } = JSON.parse(textOf(result)) as {
      product: { id: string; price_paise: number; merchant_id: string } | null;
    };
    expect(product?.id).toBe('sku-a1');
    expect(product?.price_paise).toBe(19900);
    expect(product?.merchant_id).toBe(MERCHANT_A);
    await client.close();
  });

  test('get_product with a valid id belonging to ANOTHER merchant returns not-found, not the product', async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({ name: 'get_product', arguments: { id: 'sku-b1' } });
    expect(result.isError).not.toBe(true);
    const { product } = JSON.parse(textOf(result)) as { product: unknown };
    expect(product).toBeNull();
    await client.close();
  });

  test('get_product with an id that exists nowhere also returns not-found', async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({ name: 'get_product', arguments: { id: 'sku-does-not-exist' } });
    const { product } = JSON.parse(textOf(result)) as { product: unknown };
    expect(product).toBeNull();
    await client.close();
  });
});

describe('audit trail', () => {
  test('list_products and get_product both write an ALLOW/ALLOWED AuditEvent', async () => {
    const client = await connect(tokenA);
    await client.callTool({ name: 'list_products', arguments: {} });
    await client.callTool({ name: 'get_product', arguments: { id: 'sku-a1' } });
    await client.close();

    const rows = await query<{
      action: string;
      rule: string;
      decision: string;
      reason_code: string;
      amount_paise: number | null;
      merchant_id: string;
      latency_ms: number;
    }>(
      `SELECT action, rule, decision, reason_code, amount_paise, merchant_id, latency_ms
         FROM audit_events
        WHERE merchant_id = $1
        ORDER BY ts DESC
        LIMIT 2`,
      [MERCHANT_A],
    );

    expect(rows).toHaveLength(2);
    const actions = rows.map((r) => r.action).sort();
    expect(actions).toEqual(['get_product', 'list_products']);
    for (const row of rows) {
      expect(row.merchant_id).toBe(MERCHANT_A);
      expect(row.rule).toBe('ALLOW');
      expect(row.decision).toBe('allow');
      expect(row.reason_code).toBe('ALLOWED');
      expect(row.amount_paise).toBeNull();
      expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    }
  });
});

interface OrderPayload {
  id: string;
  status: string;
  razorpay_order_id: string | null;
  amount_paise: number;
}

interface AuditRow {
  order_id: string | null;
  action: string;
  rule: string;
  decision: string;
  reason_code: string;
  amount_paise: number | null;
  detail: Record<string, unknown> | null;
}

async function auditRows(merchantId: string, action: string, decision: string): Promise<AuditRow[]> {
  return query<AuditRow>(
    `SELECT order_id, action, rule, decision, reason_code, amount_paise, detail
       FROM audit_events
      WHERE merchant_id = $1 AND action = $2 AND decision = $3
      ORDER BY ts`,
    [merchantId, action, decision],
  );
}

describe('checkout', () => {
  test('a stale asserted price is rejected with STALE_CATALOG, isError true, and no order row', async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({
      name: 'checkout',
      arguments: { items: [{ item_id: 'sku-a1', quantity: 1, asserted_price_paise: 1 }] },
    });
    await client.close();

    expect(result.isError).toBe(true);
    const error = JSON.parse(textOf(result)) as {
      reason_code: string;
      mismatch: string;
      item_id: string;
      true_price_paise: number;
    };
    expect(error.reason_code).toBe('STALE_CATALOG');
    expect(error.mismatch).toBe('price');
    expect(error.item_id).toBe('sku-a1');
    expect(error.true_price_paise).toBe(19900);

    const orders = await query<{ id: string }>('SELECT id FROM orders WHERE merchant_id = $1', [MERCHANT_A]);
    expect(orders).toHaveLength(0);
  });

  test('a valid order is created, audited exactly once as allow, survives being read by a fresh repo, and stays invisible to another merchant', async () => {
    fake.enqueue({ ok: true, razorpay_order_id: 'order_test_success_1' });

    const client = await connect(tokenA);
    const result = await client.callTool({
      name: 'checkout',
      arguments: { items: [{ item_id: 'sku-a1', quantity: 1, asserted_price_paise: 19900 }] },
    });
    await client.close();

    expect(result.isError).not.toBe(true);
    const { order } = JSON.parse(textOf(result)) as { order: OrderPayload };
    expect(order.status).toBe('created');
    expect(order.razorpay_order_id).toBe('order_test_success_1');
    expect(order.amount_paise).toBe(19900);
    expect(fake.callCount).toBe(1);

    const allowRows = await auditRows(MERCHANT_A, 'checkout', 'allow');
    expect(allowRows).toHaveLength(1);
    expect(allowRows[0]?.rule).toBe('ALLOW');
    expect(allowRows[0]?.reason_code).toBe('ALLOWED');

    // "Restart survival": a brand new TenantRepo, built from scratch off the
    // bearer token (not the `repo`/`ctx` closed over by the request that just
    // ran), can still read the row. Nothing about this order lives in
    // process memory — only Postgres does.
    const resolvedA = await resolveTenant(`Bearer ${tokenA}`, null);
    if (!resolvedA.ok) throw new Error('resolveTenant unexpectedly failed for tokenA');
    const freshRepo = new TenantRepo(resolvedA.ctx);
    const reread = await freshRepo.getOrder(order.id);
    expect(reread?.status).toBe('created');
    expect(reread?.razorpay_order_id).toBe('order_test_success_1');

    // Another merchant's token must not be able to read A's order.
    const clientB = await connect(tokenB);
    const crossResult = await clientB.callTool({ name: 'get_order_status', arguments: { order_id: order.id } });
    await clientB.close();
    const { order: crossOrder } = JSON.parse(textOf(crossResult)) as { order: unknown };
    expect(crossOrder).toBeNull();
  });

  test('an order above the approval threshold is escalated, never reaches Razorpay, and carries the gate-minted order id', async () => {
    const callCountBefore = fake.callCount;

    const client = await connect(tokenA);
    const result = await client.callTool({
      name: 'checkout',
      // 3 * 49900 = 149700 paise: above POLICY's 100000 paise approval
      // threshold, comfortably under its 500000 paise spend cap.
      arguments: { items: [{ item_id: 'sku-a2', quantity: 3, asserted_price_paise: 49900 }] },
    });
    await client.close();

    expect(result.isError).toBe(true);
    const error = JSON.parse(textOf(result)) as { reason_code: string; order_id: string; amount_paise: number };
    expect(error.reason_code).toBe('PENDING_APPROVAL');
    expect(error.amount_paise).toBe(149700);
    expect(fake.callCount).toBe(callCountBefore);

    const rows = await query<{ status: string; razorpay_order_id: string | null; amount_paise: number }>(
      'SELECT status, razorpay_order_id, amount_paise FROM orders WHERE id = $1 AND merchant_id = $2',
      [error.order_id, MERCHANT_A],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('escalated');
    expect(rows[0]?.razorpay_order_id).toBeNull();
    expect(rows[0]?.amount_paise).toBe(149700);
  });

  test('an order blocked by the spend cap never reaches Razorpay and writes no order row', async () => {
    const callCountBefore = fake.callCount;

    const client = await connect(tokenC);
    const result = await client.callTool({
      name: 'checkout',
      // 200.00 rupees = 20000 paise, above merchant C's 10000 paise cap.
      arguments: { items: [{ item_id: 'sku-c1', quantity: 1, asserted_price_paise: 20000 }] },
    });
    await client.close();

    expect(result.isError).toBe(true);
    const error = JSON.parse(textOf(result)) as { reason_code: string };
    expect(error.reason_code).toBe('SPEND_CAP_EXCEEDED');
    expect(fake.callCount).toBe(callCountBefore);

    const orders = await query<{ id: string }>('SELECT id FROM orders WHERE merchant_id = $1', [MERCHANT_C]);
    expect(orders).toHaveLength(0);
  });

  test('a Razorpay-side failure on the allow path fails the order and audits RAZORPAY_ERROR, without throwing', async () => {
    fake.enqueue({
      ok: false,
      error: { reason_code: 'RAZORPAY_ERROR', message: 'simulated 500', http_status: 500, razorpay_code: null, retryable: true },
    });

    const client = await connect(tokenB);
    const result = await client.callTool({
      name: 'checkout',
      arguments: { items: [{ item_id: 'sku-b1', quantity: 1, asserted_price_paise: 29900 }] },
    });
    await client.close();

    expect(result.isError).toBe(true);
    const error = JSON.parse(textOf(result)) as { reason_code: string; retryable: boolean };
    expect(error.reason_code).toBe('RAZORPAY_ERROR');
    expect(error.retryable).toBe(true);

    const orders = await query<{ id: string; status: string; razorpay_order_id: string | null }>(
      "SELECT id, status, razorpay_order_id FROM orders WHERE merchant_id = $1 AND status = 'failed'",
      [MERCHANT_B],
    );
    expect(orders).toHaveLength(1);
    expect(orders[0]?.razorpay_order_id).toBeNull();

    const failureAudit = await auditRows(MERCHANT_B, 'checkout', 'block');
    const razorpayFailureRows = failureAudit.filter((r) => r.reason_code === 'RAZORPAY_ERROR');
    expect(razorpayFailureRows).toHaveLength(1);
    expect(razorpayFailureRows[0]?.rule).toBe('ALLOW');
    expect(razorpayFailureRows[0]?.order_id).toBe(orders[0]?.id);
  });
});

describe('checkout under concurrency (DUK-29)', () => {
  test('N parallel checkouts that each fit under the cap cannot collectively beat it', async () => {
    // sku-d1 is 60000 paise/unit against merchant D's 100000 paise cap, so
    // floor(100000 / 60000) = EXACTLY ONE of these can ever be legitimately
    // allowed. That is the point of picking an amount just over half the
    // cap: a floor of 2 (e.g. 40000-paise line items) lets an UNPROTECTED
    // pair of racers land on exactly the "correct" allowed count by sheer
    // luck, which is precisely how an earlier draft of this test passed
    // with the lock removed — a race that happens to serialize looks
    // identical to one that was actually serialized. With floor == 1, ANY
    // two requests that read the spend total concurrently and both get
    // allowed is already a cap violation, so this test cannot pass by
    // accident.
    //
    // Fired as one agent (one token) across N independent client
    // connections via Promise.all, reproducing the bug report verbatim:
    // "three checkouts fired concurrently by ONE agent" against a cap none
    // of them individually exceeds. Without the src/db/pool.ts advisory
    // lock, decide()'s spend-cap read and the order-row write race, and more
    // than one request can observe the same pre-write (zero) total and get
    // allowed — see the DUK-29 report for the red run with the lock removed.
    const AMOUNT_PAISE = 60000;
    const N = 8;
    const EXPECTED_ALLOWED = 1;
    const EXPECTED_BLOCKED = N - EXPECTED_ALLOWED;

    // A dedicated fake, swapped in for just this test, so a worst-case
    // unlocked run (where all N requests reach the allow branch and all N
    // call Razorpay) never starves the file's shared `fake` queue of
    // responses another test later in this file depends on.
    const concurrencyFake = new FakeRazorpayAdapter();
    for (let i = 0; i < N; i++) {
      concurrencyFake.enqueue({ ok: true, razorpay_order_id: `order_mcp29_${i}` });
    }
    setRazorpayAdapter(concurrencyFake);

    try {
      const clients = await Promise.all(Array.from({ length: N }, () => connect(tokenD)));
      const results = await Promise.all(
        clients.map((client) =>
          client.callTool({
            name: 'checkout',
            arguments: { items: [{ item_id: 'sku-d1', quantity: 1, asserted_price_paise: AMOUNT_PAISE }] },
          }),
        ),
      );
      await Promise.all(clients.map((client) => client.close()));

      const blocked = results.filter((r) => r.isError === true);
      const allowed = results.filter((r) => r.isError !== true);
      expect(blocked).toHaveLength(EXPECTED_BLOCKED);
      expect(allowed).toHaveLength(EXPECTED_ALLOWED);
      for (const result of blocked) {
        const error = JSON.parse(textOf(result)) as { reason_code: string };
        expect(error.reason_code).toBe('SPEND_CAP_EXCEEDED');
      }

      const [row] = await query<{ spent_paise: number }>(
        `SELECT COALESCE(SUM(amount_paise), 0)::BIGINT AS spent_paise
           FROM orders
          WHERE merchant_id = $1 AND agent_id = $2 AND status IN ('created', 'authorized')`,
        [MERCHANT_D, agentIdD],
      );
      expect(row?.spent_paise).toBeLessThanOrEqual(POLICY_D_CAP_PAISE);
      expect(row?.spent_paise).toBe(EXPECTED_ALLOWED * AMOUNT_PAISE);
    } finally {
      // Restore the shared fake for every test after this one in the file.
      setRazorpayAdapter(fake);
    }
  });
});

describe('get_order_status', () => {
  test('a nonexistent order id returns not-found', async () => {
    const client = await connect(tokenA);
    const result = await client.callTool({ name: 'get_order_status', arguments: { order_id: 'o_does-not-exist' } });
    await client.close();

    expect(result.isError).not.toBe(true);
    const { order } = JSON.parse(textOf(result)) as { order: unknown };
    expect(order).toBeNull();
  });
});

describe('all four tools are usable over HTTP under either token', () => {
  test('list_products, get_product, checkout, and get_order_status are all callable for both merchants', async () => {
    for (const token of [tokenA, tokenB]) {
      const client = await connect(token);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        'checkout',
        'get_order_status',
        'get_product',
        'list_products',
      ]);

      await expect(client.callTool({ name: 'list_products', arguments: {} })).resolves.toBeDefined();
      await expect(client.callTool({ name: 'get_product', arguments: { id: 'does-not-exist' } })).resolves.toBeDefined();
      // A nonexistent item_id is a deliberately side-effect-free way to
      // exercise checkout here: it always blocks with STALE_CATALOG, so this
      // loop never touches the fake adapter or writes an order row.
      await expect(
        client.callTool({
          name: 'checkout',
          arguments: { items: [{ item_id: 'does-not-exist', quantity: 1, asserted_price_paise: 100 }] },
        }),
      ).resolves.toBeDefined();
      await expect(
        client.callTool({ name: 'get_order_status', arguments: { order_id: 'o_does-not-exist' } }),
      ).resolves.toBeDefined();

      await client.close();
    }
  });
});
