import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import { resolveTenant } from "../auth/resolve";
import { writeAuditEvent } from "../audit/write";
import { env, requireRazorpay } from "../config";
import { TenantRepo } from "../db/repo";
import { withAdvisoryLock } from "../db/pool";
import { decide } from "../gate/index";
import { RazorpayHttpAdapter } from "../razorpay/index";
import type { RazorpayAdapter } from "../razorpay/index";
import { LineItem, toolError } from "../shared/contracts";
import type { ToolError, UnauthenticatedError } from "../shared/contracts";

const PORT = Number.parseInt(process.env.PORT ?? "8787", 10);

/**
 * `toolError()` (src/shared/contracts.ts) returns a `ToolErrorResult` whose
 * fields are `readonly` — deliberately, since that shape is also consumed by
 * src/eval/'s offline harness and has no business being mutable there. The
 * SDK's `CallToolResult` is the same runtime shape without those modifiers,
 * and TypeScript will not widen `readonly T[]` to `T[]`.
 *
 * Copying rather than casting is the point: `[...result.content]` produces a
 * genuinely mutable array, so the SDK's type is satisfied by construction
 * instead of by assertion. A cast here would silence the compiler on every
 * future change to either shape, which is exactly when you would want to hear
 * from it.
 */
function errorResult(err: ToolError): CallToolResult {
  const result = toolError(err);
  return { ...result, content: [...result.content] };
}

/**
 * Constructed lazily on first checkout, not at module load: importing this
 * module (which every test file does transitively via fetchMcp) must not
 * throw just because RAZORPAY_KEY_ID/SECRET are unset, matching the
 * `requireRazorpay()` contract in src/config.ts. `setRazorpayAdapter` is the
 * whole seam — tests call it with a `FakeRazorpayAdapter` before making any
 * checkout call; there is no framework/DI container here on purpose.
 */
let razorpayAdapter: RazorpayAdapter | null = null;

function getRazorpayAdapter(): RazorpayAdapter {
  if (razorpayAdapter === null) {
    const { keyId, keySecret } = requireRazorpay();
    razorpayAdapter = new RazorpayHttpAdapter(keyId, keySecret);
  }
  return razorpayAdapter;
}

export function setRazorpayAdapter(adapter: RazorpayAdapter): void {
  razorpayAdapter = adapter;
}

/**
 * DUK-12/DUK-13: the real multi-tenant MCP server. Streamable HTTP,
 * per-request bearer auth, two catalog read tools (list_products,
 * get_product), and the two order tools (checkout, get_order_status).
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
    const authorization = requestInfo?.headers.get("authorization") ?? null;
    const sessionHint = requestInfo?.headers.get("mcp-session-id") ?? null;

    const resolved = await resolveTenant(authorization, sessionHint);
    if (!resolved.ok) {
      // fetchMcp() already rejects a bad token with 401 before this factory
      // ever runs, so getting here means the token was revoked in the gap
      // between that check and now. Fail loudly rather than silently
      // building a server with no tenant scope.
      throw new Error(
        `resolveTenant failed inside MCP factory: ${resolved.error.message}`
      );
    }
    const ctx = resolved.ctx;
    const repo = new TenantRepo(ctx);

    // audit_events.session_id has a real FK to sessions, so the row must
    // exist before any tool call below writes an AuditEvent. ensureSession()
    // is idempotent, and doing it once per request (not once per tool call)
    // is why this lives here rather than inside each handler.
    await repo.ensureSession();

    const server = new McpServer({ name: "dukaan-mcp", version: "0.1.0" });

    server.registerTool(
      "list_products",
      {
        title: "List Products",
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
          action: "list_products",
          amount_paise: null,
          rule: "ALLOW",
          decision: "allow",
          reason_code: "ALLOWED",
          detail: { count: products.length },
          latency_ms: Math.round(performance.now() - start),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ products }) },
          ],
        };
      }
    );

    server.registerTool(
      "get_product",
      {
        title: "Get Product",
        description:
          "Fetch one product by id from your catalog, with its CURRENT price_paise and " +
          "stock. Always call this (or list_products) immediately before checkout so the " +
          "price you act on is fresh, not one you cached earlier — checkout rejects a stale " +
          "asserted price with a STALE_CATALOG error. Returns { product: null } if the id " +
          "is not in your catalog. That includes an id that belongs to a different " +
          "merchant: this tool never reveals whether such an id exists elsewhere, it just " +
          "isn't yours.",
        inputSchema: z.object({
          id: z
            .string()
            .min(1)
            .describe(
              "The product id (sku), exactly as returned by list_products."
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
          action: "get_product",
          amount_paise: null,
          rule: "ALLOW",
          decision: "allow",
          reason_code: "ALLOWED",
          detail: { item_id: id, found: product !== null },
          latency_ms: Math.round(performance.now() - start),
        });
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ product }) },
          ],
        };
      }
    );

    server.registerTool(
      "checkout",
      {
        title: "Checkout",
        description:
          "Place an order for one or more line items, asserting the item_id, quantity, and " +
          "price_paise you believe is current for each — get these from list_products or " +
          "get_product IMMEDIATELY beforehand, not from earlier in the conversation. Your " +
          "asserted price is NOT trusted: checkout re-reads the live catalog and rejects a " +
          "stale price with a STALE_CATALOG error (isError: true) instead of charging you. " +
          "A spend-cap or category-allowlist violation also returns a structured block error " +
          "with isError: true and never reaches Razorpay. An order above the merchant's " +
          "approval threshold is recorded as an 'escalated' order and returned as a " +
          "PENDING_APPROVAL error — also isError: true, also never reaching Razorpay — so a " +
          "PENDING_APPROVAL response means the order needs merchant sign-off, not that it " +
          "failed. On success this actually creates a Razorpay order and returns the order " +
          "row (id, status: 'created', razorpay_order_id, amount_paise). Every outcome, " +
          "including a Razorpay-side failure, is written to the audit log.",
        inputSchema: z.object({
          items: z
            .array(LineItem)
            .min(1)
            .describe(
              "The line items to buy. Each item's price_paise MUST be the CURRENT catalog " +
                "price for that item_id, not one you saw earlier — checkout re-checks it and " +
                "returns STALE_CATALOG if it has changed."
            ),
        }),
      },
      async ({ items }) => {
        const start = performance.now();

        // DUK-29: `decide()`'s spend-cap check and the insertOrder that
        // persists its outcome must be atomic with respect to this SAME
        // agent's other in-flight checkouts, or N parallel checkouts each
        // read the same pre-write spend total and all get allowed past a
        // cap none of them individually exceeds. The lock has to enclose
        // decide() itself — its outcome is what tells us which insertOrder
        // (if any) follows, so we cannot decide what to lock until after
        // we've already needed the lock. Scoped per (merchant_id, agent_id):
        // unrelated agents and merchants never contend.
        //
        // The Razorpay call on the allow path stays inside the lock too,
        // even though it is slow network I/O. Carving it out — release the
        // lock after decide(), re-acquire for insertOrder — would let a
        // second racing checkout's decide() run in that gap and read the
        // exact same stale spend total this lock exists to prevent; the cap
        // would still be beatable, just with a smaller window. The cost is
        // that one agent's own checkouts serialise behind Razorpay's
        // latency; other agents and merchants are untouched, since each
        // contends on its own key.
        return withAdvisoryLock(
          `${ctx.merchant_id}:${ctx.agent_id}`,
          async () => {
            // This process is the only place the platform ceiling enters the
            // gate: `decide()` deliberately cannot read src/config.ts itself.
            // Null when PLATFORM_SPEND_CEILING_PAISE is unset, which is the
            // pre-existing two-party behaviour.
            const outcome = await decide(
              ctx,
              { items },
              {
                repo,
                writeAudit: writeAuditEvent,
                platformCeilingPaise: env.PLATFORM_SPEND_CEILING_PAISE,
              }
            );

            if (outcome.decision === "block") {
              // The gate already wrote this decision's AuditEvent. No order row:
              // `orders` is written on allow and escalate only, never on block.
              return errorResult(outcome.error);
            }

            if (outcome.decision === "escalate") {
              // Escalated orders never count toward the spend cap —
              // SPEND_CAP_SQL filters status IN ('created','authorized') — so
              // this insert doesn't need the lock for cap correctness. It runs
              // under it anyway because decide() already had to; splitting the
              // lock scope by outcome would only add complexity for no gain.
              //
              // The gate minted this id (there is no order yet for it to
              // attach to) and already wrote its own AuditEvent under it.
              // Reuse that exact id so the audit row and the order row agree,
              // and stop here — zero Razorpay calls on this path.
              await repo.insertOrder({
                id: outcome.error.order_id,
                merchant_id: ctx.merchant_id,
                agent_id: ctx.agent_id,
                session_id: ctx.session_id,
                items,
                amount_paise: outcome.error.amount_paise,
                status: "escalated",
                razorpay_order_id: null,
              });
              return errorResult(outcome.error);
            }

            // decision === 'allow'. The gate already wrote the ALLOW/ALLOWED
            // AuditEvent; only a Razorpay-side failure below needs a second one.
            const receipt = outcome.order_id;
            const razorpayResult = await getRazorpayAdapter().createOrder({
              amount_paise: outcome.amount_paise,
              merchant_id: ctx.merchant_id,
              session_id: ctx.session_id,
              receipt,
            });

            if (!razorpayResult.ok) {
              await repo.insertOrder({
                id: outcome.order_id,
                merchant_id: ctx.merchant_id,
                agent_id: ctx.agent_id,
                session_id: ctx.session_id,
                items,
                amount_paise: outcome.amount_paise,
                status: "failed",
                razorpay_order_id: null,
              });
              // audit_events.rule has no RAZORPAY member, and the
              // audit_allow_implies_allowed CHECK forces decision != 'allow'
              // whenever reason_code isn't ALLOWED — so rule: 'ALLOW' paired
              // with decision: 'block' is the only shape that fits the existing
              // schema without a migration. This mirrors the precedent the gate
              // already set for INVALID_REQUEST under AUTHORITATIVE_REREAD (see
              // src/gate/index.ts): audit a branch under the rule enum that was
              // closest to true, not the one purpose-built for it. It matters
              // here because a Razorpay failure is a money-path event, and the
              // project's claim that every money action is reconstructible from
              // the audit log alone would otherwise have a hole.
              await writeAuditEvent({
                merchant_id: ctx.merchant_id,
                session_id: ctx.session_id,
                agent_id: ctx.agent_id,
                order_id: outcome.order_id,
                action: "checkout",
                amount_paise: outcome.amount_paise,
                rule: "ALLOW",
                decision: "block",
                reason_code: "RAZORPAY_ERROR",
                detail: {
                  http_status: razorpayResult.error.http_status,
                  razorpay_code: razorpayResult.error.razorpay_code,
                  retryable: razorpayResult.error.retryable,
                },
                latency_ms: Math.round(performance.now() - start),
              });
              return errorResult(razorpayResult.error);
            }

            const order = await repo.insertOrder({
              id: outcome.order_id,
              merchant_id: ctx.merchant_id,
              agent_id: ctx.agent_id,
              session_id: ctx.session_id,
              items,
              amount_paise: outcome.amount_paise,
              status: "created",
              razorpay_order_id: razorpayResult.razorpay_order_id,
            });
            return {
              content: [
                { type: "text" as const, text: JSON.stringify({ order }) },
              ],
            };
          }
        );
      }
    );

    server.registerTool(
      "get_order_status",
      {
        title: "Get Order Status",
        description:
          "Fetch one of your own orders by id, with its current status (created, authorized, " +
          "escalated, or failed) and razorpay_order_id when one exists. Returns { order: null } " +
          "if the id is not one of your orders. That includes an id that belongs to a different " +
          "merchant: this tool never reveals whether such an order exists elsewhere, it just " +
          "isn't yours.",
        inputSchema: z.object({
          order_id: z
            .string()
            .min(1)
            .describe(
              "The order id, exactly as returned by checkout (in its success result or in a " +
                "PENDING_APPROVAL error)."
            ),
        }),
      },
      async ({ order_id }) => {
        const start = performance.now();
        const order = await repo.getOrder(order_id);
        await writeAuditEvent({
          merchant_id: ctx.merchant_id,
          session_id: ctx.session_id,
          agent_id: ctx.agent_id,
          order_id: order !== null ? order.id : null,
          action: "get_order_status",
          amount_paise: null,
          rule: "ALLOW",
          decision: "allow",
          reason_code: "ALLOWED",
          detail: { order_id, found: order !== null },
          latency_ms: Math.round(performance.now() - start),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ order }) }],
        };
      }
    );

    return server;
  },
  { onerror: (err) => console.error("[mcp]", err.message) }
);

function unauthorizedResponse(error: UnauthenticatedError): Response {
  return new Response(JSON.stringify(error), {
    status: 401,
    headers: {
      "content-type": "application/json",
      "www-authenticate": error.www_authenticate,
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
  if (url.pathname === "/health") return new Response("ok\n");
  if (url.pathname !== "/mcp")
    return new Response("not found\n", { status: 404 });

  const resolved = await resolveTenant(
    req.headers.get("authorization"),
    req.headers.get("mcp-session-id")
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
