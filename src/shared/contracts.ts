/**
 * The two shapes everything downstream consumes:
 *   1. the structured tool-error envelope the buyer agent re-plans against
 *   2. the AuditEvent the gate writes, the audit view renders, and the eval
 *      reporter aggregates
 *
 * Two rules that shaped it:
 *   - No optional properties. Absence is `T | null`, always present. Keeps the
 *     shapes JSON-round-trippable and sidesteps exactOptionalPropertyTypes.
 *   - Money is BIGINT paise, always suffixed `_paise`, never a float.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ money */

export const Paise = z.int().nonnegative();
export const PositivePaise = z.int().positive();

/* ------------------------------------------------------- reason code union */

/**
 * CLOSED union. An unknown string fails typecheck and fails the CHECK
 * constraint on audit_events.reason_code.
 *
 * ALLOWED is here because the allow branch writes an AuditEvent and
 * reason_code is NOT NULL; without it every eval aggregation writes COALESCE.
 * UNAUTHENTICATED so DUK-9's 401 is the same envelope as everything else.
 * INVALID_REQUEST is the catch-all so no code path invents a string.
 */
export const REASON_CODES = [
  "ALLOWED",
  "STALE_CATALOG",
  "SPEND_CAP_EXCEEDED",
  "CATEGORY_NOT_ALLOWED",
  "PENDING_APPROVAL",
  "RAZORPAY_ERROR",
  "UNAUTHENTICATED",
  "INVALID_REQUEST",
] as const;

export const ReasonCode = z.enum(REASON_CODES);
export type ReasonCode = z.infer<typeof ReasonCode>;

export const Decision = z.enum(["allow", "block", "escalate"]);
export type Decision = z.infer<typeof Decision>;

export const GateRule = z.enum([
  "AUTHORITATIVE_REREAD",
  "SPEND_CAP",
  "CATEGORY_ALLOWLIST",
  "APPROVAL_THRESHOLD",
  "ALLOW",
  "AUTH",
]);
export type GateRule = z.infer<typeof GateRule>;

export const ToolAction = z.enum([
  "list_products",
  "get_product",
  "checkout",
  "get_order_status",
]);
export type ToolAction = z.infer<typeof ToolAction>;

/* ------------------------------------------------- the tool-error envelope */

/**
 * STALE_CATALOG carries a `mismatch` discriminator, not just true_stock.
 * The merchant-side-misclaim attack is a PRICE mismatch, and the agent's
 * re-plan differs by kind: price means retry at the true price, stock means
 * substitute, missing means drop the line. Without the discriminator the agent
 * infers the kind by comparing numbers, which is fragile.
 */
export const StaleCatalogError = z.object({
  reason_code: z.literal("STALE_CATALOG"),
  message: z.string().min(1),
  mismatch: z.enum(["price", "stock", "missing"]),
  item_id: z.string().min(1),
  asserted_price_paise: Paise.nullable(),
  true_price_paise: Paise.nullable(),
  asserted_quantity: z.int().nonnegative().nullable(),
  true_stock: z.int().nonnegative().nullable(),
});

/**
 * Which of the three parties' caps actually bound. The member list is spelled
 * out here because src/gate/limits.ts exports `BindingParty` as a type only;
 * the gate assigning `bound_by: effectiveCap(...).bound_by` into this shape is
 * what makes a divergence between the two a typecheck failure rather than a
 * production parse error.
 */
export const BindingPartyCode = z.enum([
  "buyer",
  "merchant",
  "platform",
  // Not a fourth cap in the same comparison — it bounds the sum across every
  // agent of a merchant, so it is measured against a different total.
  "merchant_total",
]);
export type BindingPartyCode = z.infer<typeof BindingPartyCode>;

/**
 * `cap_paise` and `remaining_budget_paise` are the EFFECTIVE cap — the tightest
 * of the three — because that is the number the agent has to re-plan against;
 * an agent told the merchant's figure while a tighter buyer limit is what
 * actually blocked it would retry forever.
 *
 * All three inputs are reported alongside `bound_by` so a reader of the block
 * (or of the audit row's `detail`) can see WHY that one bound, without going
 * back to the policy row and the deployment config to reconstruct it.
 *
 * FOOT-GUN, and `bound_by` is the thing that disarms it: the triple
 * (`cap_paise`, `spent_paise`, `remaining_budget_paise`) always describes THE
 * BOUND THAT ACTUALLY FIRED, and the aggregate bound is measured against a
 * different total than the other three. So when `bound_by` is "merchant_total"
 * that triple is merchant-wide — every agent's spend summed — and when it is
 * any of "buyer" / "merchant" / "platform" it is this ONE agent's. Do not read
 * `spent_paise` as per-agent without checking `bound_by` first.
 *
 * It is arranged this way round on purpose. The triple has to stay internally
 * consistent (`remaining == max(cap - spent, 0)`) or an agent re-planning
 * against it computes a budget that does not exist, which is the one thing
 * this payload is for. Mixing an aggregate cap with a per-agent spend would
 * have broken that arithmetic on exactly the new path.
 */
export const SpendCapExceededError = z.object({
  reason_code: z.literal("SPEND_CAP_EXCEEDED"),
  message: z.string().min(1),
  cap_paise: PositivePaise,
  bound_by: BindingPartyCode,
  buyer_cap_paise: PositivePaise.nullable(),
  merchant_cap_paise: PositivePaise,
  platform_ceiling_paise: PositivePaise.nullable(),
  spent_paise: Paise,
  remaining_budget_paise: Paise,
  attempted_paise: PositivePaise,
  window_seconds: z.int().positive(),
  /**
   * The merchant's AGGREGATE cap across every one of its agents, and the spend
   * already accrued against it in this window. `null` — both together — means
   * the merchant set no aggregate cap, so the gate never measured that total.
   *
   * INVARIANT, and the gate is the only writer that has to hold it up: these
   * two are non-null together or null together. The gate reads the merchant
   * total only when the cap is set, so "cap set but spend unmeasured" is not a
   * state it can emit.
   *
   * These sit ALONGSIDE `cap_paise`/`spent_paise` rather than replacing them
   * because the aggregate is measured against a different total than the other
   * three caps — see `BindingPartyCode`.
   */
  merchant_total_cap_paise: PositivePaise.nullable(),
  merchant_total_spent_paise: Paise.nullable(),
});

export const CategoryNotAllowedError = z.object({
  reason_code: z.literal("CATEGORY_NOT_ALLOWED"),
  message: z.string().min(1),
  item_id: z.string().min(1),
  category: z.string().min(1),
  category_allowlist: z.array(z.string().min(1)).min(1),
});

export const PendingApprovalError = z.object({
  reason_code: z.literal("PENDING_APPROVAL"),
  message: z.string().min(1),
  order_id: z.string().min(1),
  amount_paise: PositivePaise,
  approval_threshold_paise: PositivePaise,
  approval_url: z.url().nullable(),
});

export const RazorpayError = z.object({
  reason_code: z.literal("RAZORPAY_ERROR"),
  message: z.string().min(1),
  http_status: z.int().nullable(),
  razorpay_code: z.string().nullable(),
  retryable: z.boolean(),
});

export const UnauthenticatedError = z.object({
  reason_code: z.literal("UNAUTHENTICATED"),
  message: z.string().min(1),
  www_authenticate: z.string().min(1),
});

export const InvalidRequestError = z.object({
  reason_code: z.literal("INVALID_REQUEST"),
  message: z.string().min(1),
  field: z.string().nullable(),
});

/**
 * Discriminated on reason_code so the buyer agent gets an exhaustive switch.
 * ALLOWED deliberately absent: it is an AuditEvent reason code, never an error.
 */
export const ToolError = z.discriminatedUnion("reason_code", [
  StaleCatalogError,
  SpendCapExceededError,
  CategoryNotAllowedError,
  PendingApprovalError,
  RazorpayError,
  UnauthenticatedError,
  InvalidRequestError,
]);
export type ToolError = z.infer<typeof ToolError>;

export type StaleCatalogError = z.infer<typeof StaleCatalogError>;
export type SpendCapExceededError = z.infer<typeof SpendCapExceededError>;
export type CategoryNotAllowedError = z.infer<typeof CategoryNotAllowedError>;
export type PendingApprovalError = z.infer<typeof PendingApprovalError>;
export type RazorpayError = z.infer<typeof RazorpayError>;
export type UnauthenticatedError = z.infer<typeof UnauthenticatedError>;
export type InvalidRequestError = z.infer<typeof InvalidRequestError>;

/* ---------------------------------------------------- MCP result shaping */

/**
 * NEVER a thrown exception: a throw terminates the tool call and the agent
 * sees a transport failure instead of a re-plannable result.
 *
 * The payload is JSON in content[0].text and mirrored in _meta. NOT in
 * `structuredContent`, because a tool declaring an outputSchema for its
 * success shape would then fail SDK validation on the error path.
 */
export const ERROR_META_KEY = "dukaan.error" as const;

export interface ToolErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly _meta: { readonly [ERROR_META_KEY]: ToolError };
}

export function toolError(err: ToolError): ToolErrorResult {
  const parsed = ToolError.parse(err); // fail loudly here, not at the agent
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(parsed) }],
    _meta: { [ERROR_META_KEY]: parsed },
  };
}

export function parseToolError(text: string): ToolError {
  return ToolError.parse(JSON.parse(text));
}

/* --------------------------------------------------------- the AuditEvent */

/**
 * One row of the append-only ledger. Written on EVERY branch, including allow,
 * and including list_products / get_product — the stale-price attack class
 * needs those reads in the log to prove the agent replayed a price it saw at
 * time T.
 */
export const AuditEvent = z
  .object({
    id: z.string().min(1),
    merchant_id: z.string().min(1),
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    order_id: z.string().min(1).nullable(),
    action: ToolAction,
    amount_paise: Paise.nullable(),
    rule: GateRule,
    decision: Decision,
    reason_code: ReasonCode,
    detail: z.record(z.string(), z.unknown()).nullable(),
    latency_ms: z.int().nonnegative(),
    ts: z.date(),
  })
  .refine((e) => (e.decision === "allow") === (e.reason_code === "ALLOWED"), {
    message: 'decision "allow" requires reason_code "ALLOWED", and vice versa',
  });
export type AuditEvent = z.infer<typeof AuditEvent>;

export const AuditEventInput = z
  .object({
    merchant_id: z.string().min(1),
    session_id: z.string().min(1),
    agent_id: z.string().min(1),
    order_id: z.string().min(1).nullable(),
    action: ToolAction,
    amount_paise: Paise.nullable(),
    rule: GateRule,
    decision: Decision,
    reason_code: ReasonCode,
    detail: z.record(z.string(), z.unknown()).nullable(),
    latency_ms: z.int().nonnegative(),
  })
  .refine((e) => (e.decision === "allow") === (e.reason_code === "ALLOWED"), {
    message: 'decision "allow" requires reason_code "ALLOWED", and vice versa',
  });
export type AuditEventInput = z.infer<typeof AuditEventInput>;

/* ------------------------------------------------------------ domain rows */

export const Merchant = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  created_at: z.date(),
});
export type Merchant = z.infer<typeof Merchant>;

export const Policy = z
  .object({
    merchant_id: z.string().min(1),
    spend_cap_paise: PositivePaise,
    approval_threshold_paise: PositivePaise,
    category_allowlist: z.array(z.string().min(1)).min(1),
    window_seconds: z.int().positive(),
    /**
     * The merchant's cap on the sum across EVERY one of its agents, or `null`
     * for no aggregate constraint.
     *
     * `spend_cap_paise` above is applied to each agent SEPARATELY, so with N
     * agents a merchant's real exposure is N x that figure. This is the bound
     * that survives going multi-buyer; see src/gate/limits.ts.
     *
     * Deliberately no default and deliberately nullable: `null` is the
     * pre-existing behaviour, so a policy row written before this column
     * existed decides exactly as it always did.
     *
     * NOT refined against `spend_cap_paise`. An aggregate cap TIGHTER than one
     * agent's per-agent cap is legal and meaningful — it says "any single agent
     * may spend up to X, but all of them together may not exceed Y" — so a
     * `>= spend_cap_paise` rule here would reject a sensible policy.
     */
    merchant_total_cap_paise: PositivePaise.nullable(),
  })
  .refine((p) => p.approval_threshold_paise <= p.spend_cap_paise, {
    message:
      "approval_threshold must be <= spend_cap, or the escalate branch is unreachable",
    path: ["approval_threshold_paise"],
  });
export type Policy = z.infer<typeof Policy>;

export const Product = z.object({
  merchant_id: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  price_paise: PositivePaise,
  stock: z.int().nonnegative(),
  category: z.string().min(1),
  updated_at: z.date(),
});
export type Product = z.infer<typeof Product>;

export const Agent = z.object({
  id: z.string().min(1),
  merchant_id: z.string().min(1),
  label: z.string().min(1),
  created_at: z.date(),
});
export type Agent = z.infer<typeof Agent>;

export const Session = z.object({
  id: z.string().min(1),
  merchant_id: z.string().min(1),
  agent_id: z.string().min(1),
  started_at: z.date(),
});
export type Session = z.infer<typeof Session>;

export const OrderStatus = z.enum([
  "created",
  "authorized",
  "escalated",
  "failed",
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const LineItem = z.object({
  item_id: z.string().min(1),
  quantity: z.int().positive(),
  /** What the AGENT asserts. Never trusted; check 1 re-reads the truth. */
  asserted_price_paise: PositivePaise,
});
export type LineItem = z.infer<typeof LineItem>;

export const Order = z.object({
  id: z.string().min(1),
  merchant_id: z.string().min(1),
  agent_id: z.string().min(1),
  session_id: z.string().min(1),
  items: z.array(LineItem).min(1),
  amount_paise: PositivePaise,
  status: OrderStatus,
  razorpay_order_id: z.string().min(1).nullable(),
  created_at: z.date(),
});
export type Order = z.infer<typeof Order>;

/* ------------------------------------------------------- resolved tenancy */

/**
 * Derived from the bearer token, never from a tool argument. If it came from
 * the request body, an agent would rename itself past the spend cap.
 */
export interface TenantContext {
  readonly merchant_id: string;
  readonly agent_id: string;
  readonly session_id: string;
}

/* ------------------------------------------------------------ gate result */

export type GateOutcome =
  | {
      readonly decision: "allow";
      readonly rule: "ALLOW";
      readonly amount_paise: number;
      /**
       * Minted by the gate, exactly as the escalate branch does, so the ALLOW
       * audit row and the `orders` row it authorises share one id. The caller
       * must persist under THIS id rather than generating its own, or the audit
       * log stops being self-contained on the one path where money moves.
       */
      readonly order_id: string;
    }
  | {
      readonly decision: "block";
      readonly rule: GateRule;
      readonly error: ToolError;
    }
  | {
      readonly decision: "escalate";
      readonly rule: "APPROVAL_THRESHOLD";
      readonly error: PendingApprovalError;
    };
