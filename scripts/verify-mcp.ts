/**
 * Manual DUK-12 verification harness: seeds two throwaway merchants, then
 * drives a real MCP client (`@modelcontextprotocol/client`, the same package
 * scripts/spike-client.ts uses) against a live `bun run mcp:dev` /
 * `bun src/mcp/http.ts` process over Streamable HTTP with two different
 * bearer tokens.
 *
 * This is NOT part of the `bun test` suite — tests/mcp.test.ts already drives
 * a real client against an in-process server. This script exists to satisfy
 * the DUK-12 requirement to also verify against an actually-listening
 * process, the same way a judge or a future buyer agent would connect.
 *
 * Usage: start the server first (`bun run mcp:dev` or `bun src/mcp/http.ts`),
 * then `bun run src/mcp/verify-live.ts`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMerchant } from '../src/onboard/create-merchant';
import { pool } from '../src/db/pool';

const MCP_URL = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8787/mcp');

const MERCHANT_A = 'm_mcp_verify_a';
const MERCHANT_B = 'm_mcp_verify_b';

const CSV_A = `sku,name,price,stock,category
verify-a1,Verify Widget A,150.00,8,widgets
`;
const CSV_B = `sku,name,price,stock,category
verify-b1,Verify Widget B,275.00,3,widgets
`;
const POLICY = {
  spend_cap_rupees: '5000.00',
  approval_threshold_rupees: '1000.00',
  category_allowlist: ['widgets'],
  window: '24h',
};

async function cleanup(merchantId: string): Promise<void> {
  await pool.query('DELETE FROM audit_events WHERE merchant_id = $1', [merchantId]);
  await pool.query('DELETE FROM merchants WHERE id = $1', [merchantId]);
}

async function connect(label: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: `dukaan-verify-${label}`, version: '0.1.0' });
  await client.connect(transport);
  return client;
}

async function main(): Promise<void> {
  await cleanup(MERCHANT_A);
  await cleanup(MERCHANT_B);

  const a = await createMerchant({
    merchantId: MERCHANT_A,
    name: 'Verify Kirana A',
    csv: CSV_A,
    policyJson: POLICY,
    agentLabel: 'verify-agent-a',
  });
  const b = await createMerchant({
    merchantId: MERCHANT_B,
    name: 'Verify Kirana B',
    csv: CSV_B,
    policyJson: POLICY,
    agentLabel: 'verify-agent-b',
  });

  console.log(`merchant A = ${MERCHANT_A}, token = ${a.token.slice(0, 10)}...`);
  console.log(`merchant B = ${MERCHANT_B}, token = ${b.token.slice(0, 10)}...`);

  const clientA = await connect('a', a.token);
  const clientB = await connect('b', b.token);

  const { tools: toolsA } = await clientA.listTools();
  console.log('tools (as A):', toolsA.map((t) => t.name).join(', '));

  const listA = await clientA.callTool({ name: 'list_products', arguments: {} });
  console.log(
    'list_products (as A) ->',
    listA.content?.[0]?.type === 'text' ? listA.content[0].text : listA,
  );

  const listB = await clientB.callTool({ name: 'list_products', arguments: {} });
  console.log(
    'list_products (as B) ->',
    listB.content?.[0]?.type === 'text' ? listB.content[0].text : listB,
  );

  const ownProduct = await clientA.callTool({
    name: 'get_product',
    arguments: { id: 'verify-a1' },
  });
  console.log(
    "get_product (A, A's own sku verify-a1) ->",
    ownProduct.content?.[0]?.type === 'text' ? ownProduct.content[0].text : ownProduct,
  );

  const crossTenant = await clientA.callTool({
    name: 'get_product',
    arguments: { id: 'verify-b1' },
  });
  console.log(
    "get_product (A, asking for B's sku verify-b1) ->",
    crossTenant.content?.[0]?.type === 'text' ? crossTenant.content[0].text : crossTenant,
  );

  await clientA.close();
  await clientB.close();

  await cleanup(MERCHANT_A);
  await cleanup(MERCHANT_B);
  await pool.end();

  console.log('PASS: real MCP client round-tripped both tools under two different merchant tokens');
}

await main();
