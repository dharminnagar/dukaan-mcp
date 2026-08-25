/**
 * The checkout gate: a pure function over injected repo/audit dependencies.
 * It NEVER imports from src/razorpay/ and never calls out to Razorpay -
 * `decide()` only ever returns `{ decision: 'allow', ... }`; the caller (the
 * MCP checkout tool, DUK-13) invokes the payment adapter afterwards. That
 * separation is what lets src/eval/ (DUK-18/19) drive `decide()` directly
 * against scripted transcripts with no HTTP server, no network call, and no
 * API spend - the offline-reproducibility property the eval metrics rest on.
 *
 * CHECK ORDER, cheapest and most-decisive first; nothing after an earlier
 * failure runs:
 *   1. Authoritative re-read - the agent's asserted price/qty against the
 *      catalog AT DECISION TIME. Runs first: it is a single indexed read per
 *      item, and every amount this function computes below is derived from
 *      the asserted price, so a stale price would poison every later check.
 *   2. Spend cap            - over (merchant_id, agent_id, window).
 *   3. Category allowlist   - per line item.
 *   4. Approval threshold   - escalates; does not fall through to allow.
 *   5. Allow.
 *
 * ATOMICITY IS THE CALLER'S JOB, NOT THIS FUNCTION'S. `decide()` reads the
 * spend total; whoever acts on an `allow` writes the order. Those are two
 * statements, so two concurrent callers both read the same pre-write total and
 * both pass a cap they jointly breach. Verified: three concurrent
 * decide()+insertOrder pairs put 150000 paise behind a 100000 cap.
 *
 * The MCP checkout handler closes that window with a per-(merchant, agent)
 * advisory lock (`withAdvisoryLock`, src/db/pool.ts) wrapping decide() and the
 * insert together — see DUK-29. It deliberately lives there and not here, so
 * this function stays pure and src/eval/ keeps running with no lock, no
 * transaction and no server.
 *
 * So: ANY OTHER CALLER THAT ACTS ON `allow` MUST SERIALISE ITSELF. src/eval/
 * satisfies this by replaying transcripts strictly sequentially. Parallelising
 * that runner for speed would break the spend cap silently and corrupt the
 * metrics rather than failing loudly.
 *
 * CAP SCOPE: `repo.spentInWindowPaise` is scoped to (merchant_id, agent_id,
 * window) by TenantRepo / idx_orders_spend_cap - NEVER session_id. Scoping
 * to session_id would let an agent reset its budget just by opening a new
 * session, which is adversarial class #1 in the eval suite (an earlier draft
 * of this project made exactly that mistake - projectmem issue #0009).
 * session_id stays audit grouping/display only and is never threaded into
 * the enforcement query.
 */
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '../audit/write';
import type { TenantRepo } from '../db/repo';
import type {
  CategoryNotAllowedError,
  GateOutcome,
  InvalidRequestError,
  LineItem,
  PendingApprovalError,
  Product,
  SpendCapExceededError,
  StaleCatalogError,
  TenantContext,
} from '../shared/contracts';

export interface GateDeps {
  readonly repo: Pick<TenantRepo, 'getProduct' | 'getPolicy' | 'spentInWindowPaise'>;
  readonly writeAudit: typeof writeAuditEvent;
  // Deliberately NO injectable clock. The cap window is enforced inside
  // `repo.spentInWindowPaise`'s SQL against Postgres's own now(), so a clock
  // passed in from here would be silently ignored. Tests get window-boundary
  // determinism by backdating an order row via SQL, as tests/repo.test.ts does.
}

/**
 * The gate's input: the agent's asserted line items. Reuses `LineItem`
 * verbatim - it already has item_id, quantity, and asserted_price_paise, and
 * a parallel local shape would just be a second thing to keep in sync.
 */
export interface CheckoutRequest {
  readonly items: readonly LineItem[];
}

function totalAssertedPaise(items: readonly LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.asserted_price_paise, 0);
}

export async function decide(
  ctx: TenantContext,
  req: CheckoutRequest,
  deps: GateDeps,
): Promise<GateOutcome> {
  const start = performance.now();
  const elapsedMs = (): number => Math.round(performance.now() - start);

  const audit = (fields: {
    order_id: string | null;
    amount_paise: number | null;
    rule: 'AUTHORITATIVE_REREAD' | 'SPEND_CAP' | 'CATEGORY_ALLOWLIST' | 'APPROVAL_THRESHOLD' | 'ALLOW';
    decision: 'allow' | 'block' | 'escalate';
    reason_code:
      | 'ALLOWED'
      | 'STALE_CATALOG'
      | 'SPEND_CAP_EXCEEDED'
      | 'CATEGORY_NOT_ALLOWED'
      | 'PENDING_APPROVAL'
      | 'INVALID_REQUEST';
    detail: Record<string, unknown> | null;
  }): Promise<unknown> =>
    deps.writeAudit({
      merchant_id: ctx.merchant_id,
      session_id: ctx.session_id,
      agent_id: ctx.agent_id,
      order_id: fields.order_id,
      action: 'checkout',
      amount_paise: fields.amount_paise,
      rule: fields.rule,
      decision: fields.decision,
      reason_code: fields.reason_code,
      detail: fields.detail,
      latency_ms: elapsedMs(),
    });

  // ---- check 0: input validity --------------------------------------------
  // src/eval/ drives decide() directly, bypassing the MCP layer's zod parsing,
  // so an empty basket has to be rejected here rather than assumed away. An
  // allowed 0-paise order is also physically unstorable: `orders` carries
  // CHECK (amount_paise > 0) and CONSTRAINT order_items_non_empty_array.
  // Audited under AUTHORITATIVE_REREAD because that is the input-validation
  // stage; audit_events.rule has no INVALID_REQUEST member and adding one
  // would need a migration for no behavioural gain.
  if (req.items.length === 0) {
    const error: InvalidRequestError = {
      reason_code: 'INVALID_REQUEST',
      message: 'Checkout requires at least one line item.',
      field: 'items',
    };
    await audit({
      order_id: null,
      amount_paise: null,
      rule: 'AUTHORITATIVE_REREAD',
      decision: 'block',
      reason_code: 'INVALID_REQUEST',
      detail: { field: 'items' },
    });
    return { decision: 'block', rule: 'AUTHORITATIVE_REREAD', error };
  }

  // ---- check 1: authoritative re-read -------------------------------------
  // Two passes, and the split is load-bearing.
  //
  // Price is checked PER LINE ITEM, because the same item_id may appear twice
  // with different asserted prices and validating only the first occurrence
  // would let the agent underpay on the rest.
  //
  // Stock is checked PER AGGREGATE QUANTITY, because two line items naming the
  // same product each pass an independent `quantity > stock` test while their
  // sum oversells it. Comparing per line would let one order ship goods the
  // merchant does not have — budget-split evasion applied to stock inside a
  // single order.
  const requestedByItem = new Map<string, number>();
  for (const item of req.items) {
    requestedByItem.set(item.item_id, (requestedByItem.get(item.item_id) ?? 0) + item.quantity);
  }

  const productById = new Map<string, Product>();
  for (const item of req.items) {
    let product = productById.get(item.item_id) ?? null;
    if (product === null) {
      product = await deps.repo.getProduct(item.item_id);
      if (product === null) {
        const error: StaleCatalogError = {
          reason_code: 'STALE_CATALOG',
          message: `Item ${item.item_id} is not in the catalog.`,
          mismatch: 'missing',
          item_id: item.item_id,
          asserted_price_paise: item.asserted_price_paise,
          true_price_paise: null,
          asserted_quantity: item.quantity,
          true_stock: null,
        };
        await audit({
          order_id: null,
          amount_paise: null,
          rule: 'AUTHORITATIVE_REREAD',
          decision: 'block',
          reason_code: 'STALE_CATALOG',
          detail: { item_id: item.item_id, mismatch: 'missing' },
        });
        return { decision: 'block', rule: 'AUTHORITATIVE_REREAD', error };
      }
      productById.set(item.item_id, product);
    }

    if (product.price_paise !== item.asserted_price_paise) {
      const error: StaleCatalogError = {
        reason_code: 'STALE_CATALOG',
        message: `Item ${item.item_id} price has changed: asserted ${item.asserted_price_paise} paise, catalog is ${product.price_paise} paise.`,
        mismatch: 'price',
        item_id: item.item_id,
        asserted_price_paise: item.asserted_price_paise,
        true_price_paise: product.price_paise,
        asserted_quantity: item.quantity,
        true_stock: product.stock,
      };
      await audit({
        order_id: null,
        amount_paise: null,
        rule: 'AUTHORITATIVE_REREAD',
        decision: 'block',
        reason_code: 'STALE_CATALOG',
        detail: { item_id: item.item_id, mismatch: 'price', true_price_paise: product.price_paise },
      });
      return { decision: 'block', rule: 'AUTHORITATIVE_REREAD', error };
    }
  }

  for (const [itemId, requestedQuantity] of requestedByItem) {
    const product = productById.get(itemId)!;
    if (requestedQuantity > product.stock) {
      const error: StaleCatalogError = {
        reason_code: 'STALE_CATALOG',
        message: `Item ${itemId} has insufficient stock: requested qty ${requestedQuantity} across all line items, catalog stock is ${product.stock}.`,
        mismatch: 'stock',
        item_id: itemId,
        asserted_price_paise: product.price_paise,
        true_price_paise: product.price_paise,
        asserted_quantity: requestedQuantity,
        true_stock: product.stock,
      };
      await audit({
        order_id: null,
        amount_paise: null,
        rule: 'AUTHORITATIVE_REREAD',
        decision: 'block',
        reason_code: 'STALE_CATALOG',
        detail: { item_id: itemId, mismatch: 'stock', requested_quantity: requestedQuantity, true_stock: product.stock },
      });
      return { decision: 'block', rule: 'AUTHORITATIVE_REREAD', error };
    }
  }

  const attemptedPaise = totalAssertedPaise(req.items);

  // ---- check 2: spend cap --------------------------------------------------
  const policy = await deps.repo.getPolicy();
  const spentPaise = await deps.repo.spentInWindowPaise(policy.window_seconds);

  if (spentPaise + attemptedPaise > policy.spend_cap_paise) {
    const error: SpendCapExceededError = {
      reason_code: 'SPEND_CAP_EXCEEDED',
      message: `This order (${attemptedPaise} paise) would take agent spend to ${spentPaise + attemptedPaise} paise, past the ${policy.spend_cap_paise} paise cap over the last ${policy.window_seconds}s.`,
      cap_paise: policy.spend_cap_paise,
      spent_paise: spentPaise,
      remaining_budget_paise: Math.max(policy.spend_cap_paise - spentPaise, 0),
      attempted_paise: attemptedPaise,
      window_seconds: policy.window_seconds,
    };
    await audit({
      order_id: null,
      amount_paise: attemptedPaise,
      rule: 'SPEND_CAP',
      decision: 'block',
      reason_code: 'SPEND_CAP_EXCEEDED',
      detail: { spent_paise: spentPaise, cap_paise: policy.spend_cap_paise, attempted_paise: attemptedPaise },
    });
    return { decision: 'block', rule: 'SPEND_CAP', error };
  }

  // ---- check 3: category allowlist -----------------------------------------
  for (const item of req.items) {
    const product = productById.get(item.item_id)!;
    if (!policy.category_allowlist.includes(product.category)) {
      const error: CategoryNotAllowedError = {
        reason_code: 'CATEGORY_NOT_ALLOWED',
        message: `Item ${item.item_id} is in category "${product.category}", which is not in this agent's allowlist.`,
        item_id: item.item_id,
        category: product.category,
        category_allowlist: policy.category_allowlist,
      };
      await audit({
        order_id: null,
        amount_paise: attemptedPaise,
        rule: 'CATEGORY_ALLOWLIST',
        decision: 'block',
        reason_code: 'CATEGORY_NOT_ALLOWED',
        detail: { item_id: item.item_id, category: product.category },
      });
      return { decision: 'block', rule: 'CATEGORY_ALLOWLIST', error };
    }
  }

  // ---- check 4: approval threshold ------------------------------------------
  if (attemptedPaise > policy.approval_threshold_paise) {
    // No order row exists yet - the gate never writes to `orders` - so the id
    // is minted here and handed back so the caller can persist the
    // 'escalated' order under this exact id.
    const orderId = `o_${randomUUID()}`;
    const error: PendingApprovalError = {
      reason_code: 'PENDING_APPROVAL',
      message: `This order (${attemptedPaise} paise) is above the ${policy.approval_threshold_paise} paise approval threshold and needs merchant sign-off.`,
      order_id: orderId,
      amount_paise: attemptedPaise,
      approval_threshold_paise: policy.approval_threshold_paise,
      approval_url: null,
    };
    await audit({
      order_id: orderId,
      amount_paise: attemptedPaise,
      rule: 'APPROVAL_THRESHOLD',
      decision: 'escalate',
      reason_code: 'PENDING_APPROVAL',
      detail: { approval_threshold_paise: policy.approval_threshold_paise },
    });
    return { decision: 'escalate', rule: 'APPROVAL_THRESHOLD', error };
  }

  // ---- check 5: allow ---------------------------------------------------------
  await audit({
    order_id: null,
    amount_paise: attemptedPaise,
    rule: 'ALLOW',
    decision: 'allow',
    reason_code: 'ALLOWED',
    detail: { item_count: req.items.length },
  });
  return { decision: 'allow', rule: 'ALLOW', amount_paise: attemptedPaise };
}
