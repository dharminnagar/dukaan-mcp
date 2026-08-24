import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { resolveTenant } from '../auth/resolve';
import { writeAuditEvent } from '../audit/write';
import { TenantRepo } from '../db/repo';
import type { UnauthenticatedError } from '../shared/contracts';

const PORT = Number.parseInt(process.env.PORT ?? '8787', 10);

/**
 * DUK-12: the real multi-tenant MCP server. Streamable HTTP, per-request
 * bearer auth, two catalog read tools.
 *
 * The factory runs ONCE PER REQUEST with { era, authInfo, requestInfo }.
 *
 * ctx.authInfo is strictly pass-through — createMcpHandler never populates it
 * from headers and performs no token verification (verified against the
 * SDK's own .d.cts by the DUK-24 spike). So multi-tenancy reads the
 * Authorization header off ctx.requestInfo here, which is the point of the
 * per-request factory. NEVER read ctx.authInfo for tenancy.
 *
 * Auth is resolved TWICE per request by design: once in `fetchMcp` below
 * (so a missing/bad token gets a real HTTP 401 before the MCP protocol ever
 * starts — the factory has no way to return a Response), and again here
 * inside the factory (because this is the only place the per-request
 * `TenantRepo` can be constructed with a scope the tool handlers close over).
 * The second call is a deliberate, cheap redundancy in exchange for never
 * needing to smuggle resolved state across the fetchMcp -> createMcpHandler
 * boundary via mutable shared state, which would not be safe under
 * concurrent requests.
 */
export const mcpHandler = createMcpHandler(
  async ({ requestInfo }) => {
    const authorization = requestInfo?.headers.get('authorization') ?? null;
    const sessionHint = requestInfo?.headers.get('mcp-session-id') ?? null;

    const resolved = await resolveTenant(authorization, sessionHint);
    if (!resolved.ok) {
      // fetchMcp() already rejects a bad token with 401 before this factory
      // ever runs, so getting here means the token was revoked in the gap
      // between that check and now. Fail loudly rather than silently
      // building a server with no tenant scope.
      throw new Error(`resolveTenant failed inside MCP factory: ${resolved.error.message}`);
    }
    const ctx = resolved.ctx;
    const repo = new TenantRepo(ctx);

    // audit_events.session_id has a real FK to sessions, so the row must
    // exist before any tool call below writes an AuditEvent. ensureSession()
    // is idempotent, and doing it once per request (not once per tool call)
    // is why this lives here rather than inside each handler.
    await repo.ensureSession();

    const server = new McpServer({ name: 'dukaan-mcp', version: '0.1.0' });

    server.registerTool(
      'list_products',
      {
        title: 'List Products',
        description:
          "List every product in your catalog: id, name, price_paise, stock, and category. " +
          "Call this first to see what you can buy and at what price. Prices and stock " +
          "change over time, so re-call this (or get_product) right before checkout rather " +
          "than reusing a price you saw earlier — checkout rejects a stale asserted price " +
          "with a STALE_CATALOG error. Always scoped to your own merchant's catalog; there " +
          "is no way to list another merchant's products.",
        inputSchema: z.object({}),
      },
      async () => {
        const start = performance.now();
        const products = await repo.listProducts();
        await writeAuditEvent({
          merchant_id: ctx.merchant_id,
          session_id: ctx.session_id,
          agent_id: ctx.agent_id,
          order_id: null,
          action: 'list_products',
          amount_paise: null,
          rule: 'ALLOW',
          decision: 'allow',
          reason_code: 'ALLOWED',
          detail: { count: products.length },
          latency_ms: Math.round(performance.now() - start),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ products }) }],
        };
      },
    );

    server.registerTool(
      'get_product',
      {
        title: 'Get Product',
        description:
          "Fetch one product by id from your catalog, with its CURRENT price_paise and " +
          "stock. Always call this (or list_products) immediately before checkout so the " +
          "price you act on is fresh, not one you cached earlier — checkout rejects a stale " +
          "asserted price with a STALE_CATALOG error. Returns { product: null } if the id " +
          "is not in your catalog. That includes an id that belongs to a different " +
          "merchant: this tool never reveals whether such an id exists elsewhere, it just " +
          "isn't yours.",
        inputSchema: z.object({
          id: z.string().min(1).describe(
            'The product id (sku), exactly as returned by list_products.',
          ),
        }),
      },
      async ({ id }) => {
        const start = performance.now();
        const product = await repo.getProduct(id);
        await writeAuditEvent({
          merchant_id: ctx.merchant_id,
          session_id: ctx.session_id,
          agent_id: ctx.agent_id,
          order_id: null,
          action: 'get_product',
          amount_paise: null,
          rule: 'ALLOW',
          decision: 'allow',
          reason_code: 'ALLOWED',
          detail: { item_id: id, found: product !== null },
          latency_ms: Math.round(performance.now() - start),
        });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ product }) }],
        };
      },
    );

    return server;
  },
  { onerror: (err) => console.error('[mcp]', err.message) },
);

function unauthorizedResponse(error: UnauthenticatedError): Response {
  return new Response(JSON.stringify(error), {
    status: 401,
    headers: {
      'content-type': 'application/json',
      'www-authenticate': error.www_authenticate,
    },
  });
}

/**
 * The Bun.serve fetch handler. Exported (rather than only wired inline below)
 * so tests can drive it directly, and so a real HTTP server can be started
 * against it from more than one entry point without duplicating the auth
 * gate.
 */
export async function fetchMcp(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === '/health') return new Response('ok\n');
  if (url.pathname !== '/mcp') return new Response('not found\n', { status: 404 });

  const resolved = await resolveTenant(
    req.headers.get('authorization'),
    req.headers.get('mcp-session-id'),
  );
  if (!resolved.ok) {
    return unauthorizedResponse(resolved.error);
  }

  return mcpHandler.fetch(req);
}

if (import.meta.main) {
  Bun.serve({ port: PORT, fetch: fetchMcp });
  console.log(`mcp listening on http://127.0.0.1:${PORT}/mcp`);
}
