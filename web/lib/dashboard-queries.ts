/**
 * Read-only queries for the merchant dashboard (DUK-32). Nothing here writes
 * to the database — this module is a second reader over data the gate and
 * the onboarding flow already settled, matching `web/app/actions.ts`'s
 * "use server" + Node-runtime shape so it can import `src/db/pool` directly.
 *
 * DUK-31 added `agents.buyer_cap_paise` and `env.PLATFORM_SPEND_CEILING_PAISE`
 * — both read below. `loadAgentSpend` selects `buyer_cap_paise` and falls
 * back to a query without it (catching Postgres error 42703, undefined_column)
 * for environments where that migration predates this file; `loadTopAgentSpend`
 * (DUK-32b, buyer self-service) selects it unconditionally, since by the time
 * agents can be buyer-provisioned the column is guaranteed to exist.
 *
 * DUK-31's migration (0003) also added `agents.buyer_id` and
 * `policies.merchant_total_cap_paise`, read by `loadAgentCounts` and
 * `loadMerchantExposure` respectively — see those functions' doc comments.
 */
import "../lib/assert-server-only";
import { query, queryOne } from "../../src/db/pool";
import { env } from "../../src/config";
import { effectiveCap } from "../../src/gate/limits";
import type { EffectiveCap } from "../../src/gate/limits";

export interface RevenueSummary {
  readonly window_seconds: number;
  readonly revenue_paise: number;
  readonly order_count: number;
}

export interface AgentCounts {
  readonly buyer_registered: number;
  readonly merchant_minted: number;
}

export interface TopAgentSpend {
  readonly agent_id: string;
  readonly agent_label: string;
  readonly buyer_registered: boolean;
  readonly spent_paise: number;
  readonly effective_cap: EffectiveCap;
}

/**
 * `agents` returned capped at `TOP_AGENTS_LIMIT`, plus how many more agents
 * had qualifying spend in the window but did not make the cut — so the page
 * can say "and 340 more" instead of either rendering a thousand rows or
 * silently dropping them with no trace.
 */
export interface TopAgentsResult {
  readonly agents: readonly TopAgentSpend[];
  readonly total_with_spend: number;
}

export interface MerchantExposure {
  readonly window_seconds: number;
  /**
   * Merchant-wide spend across EVERY agent in the window — numerically the
   * same aggregate as `RevenueSummary.revenue_paise` (same table, same
   * window, same `status IN ('created','authorized')` filter, no
   * `agent_id` predicate on either). Kept as its own field rather than
   * reusing `revenue_paise` by name because the two answer different
   * questions on screen ("how much did I sell" vs "how close am I to my
   * exposure limit"), even though today they are the identical number by
   * construction — see `sumOrdersInWindow` below, which both call.
   */
  readonly spent_paise: number;
  /** `null` means the merchant has set no aggregate cap — a real, currently-normal state. */
  readonly cap_paise: number | null;
}

export interface AgentSpend {
  readonly agent_id: string;
  readonly agent_label: string;
  readonly spent_paise: number;
  readonly effective_cap: EffectiveCap;
}

export type ReasonCode =
  | "ALLOWED"
  | "STALE_CATALOG"
  | "SPEND_CAP_EXCEEDED"
  | "CATEGORY_NOT_ALLOWED"
  | "PENDING_APPROVAL"
  | "RAZORPAY_ERROR"
  | "UNAUTHENTICATED"
  | "INVALID_REQUEST";

export type Decision = "allow" | "block" | "escalate";

export interface RecentDecision {
  readonly id: string;
  readonly ts: string;
  readonly decision: Decision;
  readonly reason_code: ReasonCode;
  readonly amount_paise: number | null;
  /**
   * Best-effort human line under the reason code — never a replacement for
   * it. See the module doc on `describeDecision` for exactly what data each
   * reason code can and cannot support.
   */
  readonly description: string;
}

interface PolicyRow {
  readonly spend_cap_paise: number;
  readonly window_seconds: number;
  readonly merchant_total_cap_paise: number | null;
}

async function loadPolicy(merchantId: string): Promise<PolicyRow | null> {
  return queryOne<PolicyRow>(
    "SELECT spend_cap_paise, window_seconds, merchant_total_cap_paise FROM policies WHERE merchant_id = $1",
    [merchantId]
  );
}

/**
 * The one aggregate used by both revenue and merchant-exposure: every order
 * for this merchant, across every agent, in the window, restricted to
 * `status IN ('created', 'authorized')` — mirroring `SPEND_CAP_SQL`
 * (src/db/repo.ts) verbatim except for the `agent_id` predicate it has and
 * this deliberately omits. Factored out so "revenue" and "merchant spend
 * against its aggregate cap" cannot drift into two subtly different SQL
 * strings that happen to agree today.
 */
async function sumOrdersInWindow(
  merchantId: string,
  windowSeconds: number
): Promise<{ amount_paise: number; order_count: number }> {
  const row = await queryOne<{ amount_paise: number; order_count: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::BIGINT AS amount_paise,
            COUNT(*)::BIGINT AS order_count
       FROM orders
      WHERE merchant_id = $1
        AND status IN ('created', 'authorized')
        AND created_at >= now() - make_interval(secs => $2::int)`,
    [merchantId, windowSeconds]
  );
  return row ?? { amount_paise: 0, order_count: 0 };
}

/**
 * Revenue and order count over the policy's own `window_seconds` — the same
 * window the gate enforces the spend cap against, so the number on screen is
 * the number the gate is actually reasoning about, not an arbitrary "last
 * 24h" a dashboard would default to on its own.
 */
export async function loadRevenueSummary(
  merchantId: string
): Promise<RevenueSummary | null> {
  const policy = await loadPolicy(merchantId);
  if (policy === null) return null;

  const sum = await sumOrdersInWindow(merchantId, policy.window_seconds);

  return {
    window_seconds: policy.window_seconds,
    revenue_paise: sum.amount_paise,
    order_count: sum.order_count,
  };
}

/**
 * How many agents this merchant has, split by provenance: `buyer_id IS NOT
 * NULL` means a buyer self-provisioned it post-DUK-31, `NULL` means the
 * merchant onboarding flow minted it (every pre-buyer-era row, and still a
 * legitimate shape — a merchant testing their own store). This split, not
 * the raw total, is the self-service adoption signal the dashboard needs
 * once a merchant can have thousands of agents.
 */
export async function loadAgentCounts(
  merchantId: string
): Promise<AgentCounts> {
  const row = await queryOne<{
    buyer_registered: number;
    merchant_minted: number;
  }>(
    `SELECT COUNT(*) FILTER (WHERE buyer_id IS NOT NULL)::BIGINT AS buyer_registered,
            COUNT(*) FILTER (WHERE buyer_id IS NULL)::BIGINT     AS merchant_minted
       FROM agents
      WHERE merchant_id = $1`,
    [merchantId]
  );
  return row ?? { buyer_registered: 0, merchant_minted: 0 };
}

const TOP_AGENTS_LIMIT = 10;

/**
 * Top agents by spend in the policy window, capped at `TOP_AGENTS_LIMIT` —
 * at thousands of agents, rendering every row is both useless to a merchant
 * and a way to make the page itself slow. `total_with_spend` lets the page
 * say "and N more" rather than truncating silently.
 *
 * Joins `agents` to `orders` constraining `merchant_id` on BOTH sides
 * (`a.merchant_id = o.merchant_id`, in addition to the `WHERE` on `o`) so a
 * mismatched id can never attribute one merchant's order to another
 * merchant's agent row.
 */
export async function loadTopAgentSpend(
  merchantId: string,
  windowSeconds: number
): Promise<TopAgentsResult> {
  const [rows, totalRow, policy] = await Promise.all([
    query<{
      agent_id: string;
      agent_label: string;
      buyer_registered: boolean;
      spent_paise: number;
      buyer_cap_paise: number | null;
    }>(
      `SELECT o.agent_id                  AS agent_id,
              a.label                     AS agent_label,
              (a.buyer_id IS NOT NULL)    AS buyer_registered,
              SUM(o.amount_paise)::BIGINT AS spent_paise,
              a.buyer_cap_paise           AS buyer_cap_paise
         FROM orders o
         JOIN agents a ON a.id = o.agent_id AND a.merchant_id = o.merchant_id
        WHERE o.merchant_id = $1
          AND o.status IN ('created', 'authorized')
          AND o.created_at >= now() - make_interval(secs => $2::int)
        GROUP BY o.agent_id, a.label, a.buyer_id, a.buyer_cap_paise
        ORDER BY spent_paise DESC
        LIMIT $3`,
      [merchantId, windowSeconds, TOP_AGENTS_LIMIT]
    ),
    queryOne<{ count: number }>(
      `SELECT COUNT(DISTINCT agent_id)::BIGINT AS count
         FROM orders
        WHERE merchant_id = $1
          AND status IN ('created', 'authorized')
          AND created_at >= now() - make_interval(secs => $2::int)`,
      [merchantId, windowSeconds]
    ),
    loadPolicy(merchantId),
  ]);
  const policyCapPaise = policy?.spend_cap_paise ?? null;

  return {
    agents: rows.map((row) => ({
      agent_id: row.agent_id,
      agent_label: row.agent_label,
      buyer_registered: row.buyer_registered,
      spent_paise: row.spent_paise,
      effective_cap: effectiveCap(
        row.buyer_cap_paise,
        // `policyCapPaise` is only null when the merchant row itself is
        // missing, which cannot happen here (an order implies an onboarded
        // merchant) — the `?? 0` is unreachable, not a real fallback value.
        policyCapPaise ?? 0,
        env.PLATFORM_SPEND_CEILING_PAISE
      ),
    })),
    total_with_spend: totalRow?.count ?? 0,
  };
}

/**
 * Merchant-wide spend against `policies.merchant_total_cap_paise`. `null`
 * cap means the merchant has set no aggregate limit — a real, currently-
 * normal state (every merchant before DUK-31 is in it), not an empty or
 * broken one, so the page must say so rather than render an empty bar.
 */
export async function loadMerchantExposure(
  merchantId: string
): Promise<MerchantExposure | null> {
  const policy = await loadPolicy(merchantId);
  if (policy === null) return null;

  const sum = await sumOrdersInWindow(merchantId, policy.window_seconds);

  return {
    window_seconds: policy.window_seconds,
    spent_paise: sum.amount_paise,
    cap_paise: policy.merchant_total_cap_paise,
  };
}

const UNDEFINED_COLUMN = "42703";

interface AgentRow {
  readonly id: string;
  readonly label: string;
  readonly buyer_cap_paise: number | null;
}

/**
 * Selects `buyer_cap_paise`, and on a bare Postgres "column does not exist"
 * (42703 — DUK-31's migration hasn't run yet in this environment) retries
 * without it, treating every agent as having no buyer cap. This is the
 * tolerate-absence path named in DUK-32: it means this file does not need
 * editing again the moment that migration lands.
 */
async function loadPrimaryAgent(merchantId: string): Promise<AgentRow | null> {
  try {
    return await queryOne<AgentRow>(
      `SELECT id, label, buyer_cap_paise
         FROM agents
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [merchantId]
    );
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== UNDEFINED_COLUMN) throw err;
    const row = await queryOne<{ id: string; label: string }>(
      `SELECT id, label
         FROM agents
        WHERE merchant_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [merchantId]
    );
    return row === null ? null : { ...row, buyer_cap_paise: null };
  }
}

/**
 * Spend against the effective cap, naming the binding party via
 * `effectiveCap` (src/gate/limits.ts) — never a re-implemented min(). Scoped
 * to (merchant_id, agent_id, window_seconds), matching `SPEND_CAP_SQL`
 * exactly, over the merchant's most recently created agent.
 *
 * A merchant can have more than one agent (src/db/repo.ts's cap query is
 * itself per-agent), but the onboarding flow this dashboard sits behind
 * mints exactly one, so showing "the" agent's spend is the common case, not
 * an average or a sum across agents that would mix separate caps together.
 */
export async function loadAgentSpend(
  merchantId: string
): Promise<AgentSpend | null> {
  const [policy, agent] = await Promise.all([
    loadPolicy(merchantId),
    loadPrimaryAgent(merchantId),
  ]);
  if (policy === null || agent === null) return null;

  const spent = await queryOne<{ spent_paise: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::BIGINT AS spent_paise
       FROM orders
      WHERE merchant_id = $1
        AND agent_id    = $2
        AND created_at >= now() - make_interval(secs => $3::int)
        AND status IN ('created', 'authorized')`,
    [merchantId, agent.id, policy.window_seconds]
  );

  return {
    agent_id: agent.id,
    agent_label: agent.label,
    spent_paise: spent?.spent_paise ?? 0,
    effective_cap: effectiveCap(
      agent.buyer_cap_paise,
      policy.spend_cap_paise,
      env.PLATFORM_SPEND_CEILING_PAISE
    ),
  };
}

interface RawDecisionRow {
  readonly id: string;
  // node-postgres parses `timestamptz` into a JS `Date`, not a string —
  // unlike the INT8 columns, `src/db/pool.ts` installs no override for it.
  readonly ts: Date;
  readonly decision: Decision;
  readonly reason_code: ReasonCode;
  readonly amount_paise: number | null;
  readonly detail: Record<string, unknown> | null;
  readonly order_items: { item_id: string; quantity: number }[] | null;
  readonly detail_product_name: string | null;
}

/**
 * What can honestly be shown beside each reason code, given what
 * `audit_events` actually stores (see src/gate/index.ts's `audit()` calls):
 *
 * - STALE_CATALOG / CATEGORY_NOT_ALLOWED: `detail->>'item_id'` is always
 *   present, so the SQL below left-joins `products` on it for a name. Stock
 *   mismatches additionally carry `requested_quantity`/`true_stock` in
 *   `detail`.
 * - PENDING_APPROVAL / RAZORPAY_ERROR: these are the only block/escalate
 *   reason codes that carry an `order_id`, so the SQL left-joins `orders`
 *   and reads its `items` JSONB for the real line items.
 * - ALLOWED: `decide()` writes `order_id: null` on the allow path (the order
 *   row is inserted by the MCP checkout handler afterwards, under a
 *   different id, and never linked back) and `detail` is just
 *   `{ item_count }` — no item identity survives in `audit_events` for an
 *   allowed checkout. This function shows "{n} item(s)" and the total
 *   amount rather than inventing a product name.
 * - UNAUTHENTICATED / INVALID_REQUEST: no product is implicated; falls back
 *   to the reason code's own message context in `detail`.
 */
function describeDecision(row: RawDecisionRow): string {
  const rupees = (paise: number): string => formatRupees(paise);

  const firstItem = row.order_items?.[0];
  if (firstItem !== undefined) {
    const extraCount = row.order_items!.length - 1;
    const label =
      extraCount === 0
        ? `${firstItem.item_id} x${firstItem.quantity}`
        : `${firstItem.item_id} x${firstItem.quantity} +${extraCount} more`;
    return row.amount_paise !== null
      ? `${label}  ${rupees(row.amount_paise)}`
      : label;
  }

  if (row.reason_code === "STALE_CATALOG") {
    const name =
      row.detail_product_name ?? String(row.detail?.["item_id"] ?? "item");
    const trueStock = row.detail?.["true_stock"];
    const requestedQty = row.detail?.["requested_quantity"];
    if (typeof trueStock === "number") {
      const qty = typeof requestedQty === "number" ? requestedQty : trueStock;
      return `${name} x${qty}  stock ${trueStock}`;
    }
    return name;
  }

  if (row.reason_code === "CATEGORY_NOT_ALLOWED") {
    const name =
      row.detail_product_name ?? String(row.detail?.["item_id"] ?? "item");
    const category = row.detail?.["category"];
    return typeof category === "string" ? `${name}  ${category}` : name;
  }

  if (row.reason_code === "ALLOWED") {
    const itemCount = row.detail?.["item_count"];
    const label =
      typeof itemCount === "number" ? `${itemCount} item(s)` : "order";
    return row.amount_paise !== null
      ? `${label}  ${rupees(row.amount_paise)}`
      : label;
  }

  if (row.reason_code === "SPEND_CAP_EXCEEDED" && row.amount_paise !== null) {
    return `attempted ${rupees(row.amount_paise)}`;
  }

  return row.amount_paise !== null ? rupees(row.amount_paise) : "";
}

/** Never do float arithmetic on money. Format for display only, at the edge. */
export function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

const RECENT_DECISIONS_LIMIT = 20;

export async function loadRecentDecisions(
  merchantId: string
): Promise<RecentDecision[]> {
  const rows = await query<RawDecisionRow>(
    `SELECT ae.id,
            ae.ts,
            ae.decision,
            ae.reason_code,
            ae.amount_paise,
            ae.detail,
            o.items AS order_items,
            p.name  AS detail_product_name
       FROM audit_events ae
       LEFT JOIN orders o
              ON o.id = ae.order_id AND o.merchant_id = ae.merchant_id
       LEFT JOIN products p
              ON p.merchant_id = ae.merchant_id
             AND p.id = (ae.detail ->> 'item_id')
      WHERE ae.merchant_id = $1
        AND ae.action = 'checkout'
      ORDER BY ae.ts DESC
      LIMIT $2`,
    [merchantId, RECENT_DECISIONS_LIMIT]
  );

  return rows.map((row) => ({
    id: row.id,
    ts: row.ts.toISOString(),
    decision: row.decision,
    reason_code: row.reason_code,
    amount_paise: row.amount_paise,
    description: describeDecision(row),
  }));
}
