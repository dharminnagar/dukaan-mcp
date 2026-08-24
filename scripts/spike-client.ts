import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const BEARER = 'Bearer test-token-abc';
const URL_ = new URL(process.env.MCP_URL ?? 'http://127.0.0.1:8787/mcp');

const transport = new StreamableHTTPClientTransport(URL_, {
  requestInit: { headers: { Authorization: BEARER } },
});

const client = new Client({ name: 'dukaan-spike-client', version: '0.1.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

const res = await client.callTool({ name: 'whoami', arguments: {} });
const first = res.content?.[0];
const text = first !== undefined && first.type === 'text' ? first.text : '';
console.log('whoami ->', JSON.stringify(text));

await client.close();

if (text !== BEARER) {
  console.error(`FAIL: expected ${JSON.stringify(BEARER)}`);
  process.exit(1);
}
console.log('PASS: per-request auth context is wired');
