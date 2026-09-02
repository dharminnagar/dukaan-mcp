/**
 * Video demo client for DUK-22. Drives a real MCP client
 * (`@modelcontextprotocol/client`, the same package `spike-client.ts` and
 * `verify-mcp.ts` use) against a live `bun run mcp:dev` process, on camera.
 *
 * Flow: list the catalog, attempt checkout on the personal-care item the
 * merchant's policy excludes, print the gate's block, then re-plan and
 * checkout an allowed item instead.
 *
 * Usage:
 *   DEMO_TOKEN=<token from the onboarding UI> bun run scripts/demo-client.ts
 *
 * MCP_URL defaults to http://127.0.0.1:8787/mcp. Requires a live
 * `bun run mcp:dev` process and RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET set,
 * so the allowed checkout creates a real Razorpay test-mode order.
 */
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { parseToolError } from "../src/shared/contracts";

const TOKEN = process.env.DEMO_TOKEN;
if (TOKEN === undefined || TOKEN === "") {
  console.error("FAIL: set DEMO_TOKEN to the token from the onboarding UI");
  process.exit(1);
}

const MCP_URL = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8787/mcp");

const BLOCKED_ITEM = {
  item_id: "sku-a22",
  quantity: 1,
  asserted_price_paise: 8900,
}; // Lifebuoy Handwash 500ml, personal-care
const ALLOWED_ITEM = {
  item_id: "sku-a17",
  quantity: 1,
  asserted_price_paise: 9000,
}; // Cadbury Dairy Milk 100g, snacks

function textOf(res: {
  content?: readonly { type: string; text?: string }[];
}): string {
  const first = res.content?.[0];
  return first !== undefined &&
    first.type === "text" &&
    first.text !== undefined
    ? first.text
    : "";
}

const transport = new StreamableHTTPClientTransport(MCP_URL, {
  requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
});
const client = new Client({ name: "dukaan-demo-client", version: "0.1.0" });
await client.connect(transport);

console.log(`connected: ${MCP_URL}`);
console.log("");

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("");

console.log("-> list_products");
const products = await client.callTool({
  name: "list_products",
  arguments: {},
});
console.log(textOf(products));
console.log("");

console.log("-> checkout: Lifebuoy Handwash 500ml (personal-care)");
const blocked = await client.callTool({
  name: "checkout",
  arguments: { items: [BLOCKED_ITEM] },
});
if (blocked.isError !== true) {
  console.error("FAIL: expected this checkout to be blocked, it was not");
  await client.close();
  process.exit(1);
}
const blockedError = parseToolError(textOf(blocked));
console.log(`BLOCKED: ${blockedError.reason_code}`);
console.log("");

console.log("re-planning: picking an allowed item instead");
console.log("");

console.log("-> checkout: Cadbury Dairy Milk 100g (snacks)");
const allowed = await client.callTool({
  name: "checkout",
  arguments: { items: [ALLOWED_ITEM] },
});
if (allowed.isError === true) {
  console.error("FAIL: expected this checkout to succeed");
  console.error(textOf(allowed));
  await client.close();
  process.exit(1);
}
const { order } = JSON.parse(textOf(allowed)) as {
  order: { id: string; razorpay_order_id: string | null; status: string };
};
console.log(`ALLOWED: order ${order.id}`);
console.log(`Razorpay order id: ${order.razorpay_order_id}`);
console.log(`status: ${order.status}`);

await client.close();
