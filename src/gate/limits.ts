/**
 * Who owns the spend limit.
 *
 * The gate's cap check used to read one number, `policies.spend_cap_paise`,
 * set by the merchant. That number is a real thing a merchant wants (an
 * exposure limit) but it is not a buyer protection, and the merchant is the
 * party that profits when it is loose. "The agent cannot overspend" then rests
 * on the goodwill of whoever it constrains.
 *
 * So three parties each get a number, and the tightest one binds:
 *
 *   buyer     whoever funds the agent. Set when the token is minted, never
 *             updated after, so it cannot be raised mid-session by the party
 *             it limits.
 *   merchant  the existing policy row. Unchanged.
 *   platform  deployment config, not tenant data. A ceiling on what any
 *             merchant may set for themselves.
 *
 * `null` means that party imposes no constraint. The merchant's number is not
 * nullable because the policy row requires it.
 *
 * This module is deliberately pure, with no config or database imports, so
 * `src/eval/` can drive it and the dashboard can call it without dragging a
 * connection pool into a page render.
 */

/** Which party's number actually bound, for the block payload and the dashboard. */
export type BindingParty = "buyer" | "merchant" | "platform";

export interface EffectiveCap {
  readonly cap_paise: number;
  readonly bound_by: BindingParty;
}

/**
 * The tightest of the three caps.
 *
 * Ties resolve to the earliest party in buyer, merchant, platform order, which
 * makes `bound_by` deterministic rather than dependent on argument order at the
 * call site. The order is chosen so that when a buyer and a merchant name the
 * same figure, the block reads as the buyer's limit — attributing a shared
 * number to the party being protected rather than to the one being restrained.
 *
 * With no buyer cap and no platform ceiling this returns the merchant's number
 * and `bound_by: "merchant"`, which is exactly the pre-existing behaviour. That
 * is what keeps the frozen eval corpus valid: every transcript scored before
 * this module existed scores identically after it.
 */
export function effectiveCap(
  buyer_cap_paise: number | null,
  merchant_cap_paise: number,
  platform_ceiling_paise: number | null
): EffectiveCap {
  let cap_paise = merchant_cap_paise;
  let bound_by: BindingParty = "merchant";

  // Buyer first, and `<=` rather than `<`: on a tie the buyer's figure wins
  // the attribution, which is the ordering rule above. A strict `<` here would
  // report a tie as the merchant's limit and defeat the point.
  if (buyer_cap_paise !== null && buyer_cap_paise <= cap_paise) {
    cap_paise = buyer_cap_paise;
    bound_by = "buyer";
  }

  if (platform_ceiling_paise !== null && platform_ceiling_paise < cap_paise) {
    cap_paise = platform_ceiling_paise;
    bound_by = "platform";
  }

  return { cap_paise, bound_by };
}
