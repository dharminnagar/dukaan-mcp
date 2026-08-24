import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { fetchMcp } from '../src/mcp/http';
import { createMerchant } from '../src/onboard/create-merchant';
import { pool, query } from '../src/db/pool';

/**
 * Seeds its own two merchants rather than depending on `bun run seed:demo` or
 * `fixtures/**` — another agent is actively rewriting those in parallel, and
 * this file would race it. Merchant ids are namespaced to this test file so
 * they cannot collide with that agent's data.
 */
const MERCHANT_A = 'm_mcp_test_a';
const MERCHANT_B = 'm_mcp_test_b';

const CSV_A = `sku,name,price,stock,category
sku-a1,Widget A,199.00,10,widgets
sku-a2,Gadget A,499.00,5,gadgets
`;

const CSV_B = `sku,name,price,stock,category
sku-b1,Widget B,299.00,20,widgets
`;

const POLICY = {
  spend_cap_rupees: '5000.00',
  approval_threshold_rupees: '1000.00',
  category_allowlist: ['widgets', 'gadgets'],
  window: '24h',
};

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

beforeAll(async () => {
  await cleanupMerchant(MERCHANT_A);
  await cleanupMerchant(MERCHANT_B);

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
  tokenA = a.token;
  tokenB = b.token;

  server = Bun.serve({ port: 0, fetch: fetchMcp });
  baseUrl = `http://127.0.0.1:${server.port}/mcp`;
});

afterAll(async () => {
  server.stop();
  await cleanupMerchant(MERCHANT_A);
  await cleanupMerchant(MERCHANT_B);
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

    expect(toolsA.map((t) => t.name).sort()).toEqual(['get_product', 'list_products']);
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
