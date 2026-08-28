/**
 * Mints an agent for a (buyer, merchant) pair — the self-service replacement
 * for the one agent a merchant used to hand-mint during onboarding.
 *
 * Follows the exact insert shape `src/onboard/create-merchant.ts` (lines
 * ~150-165) uses for a merchant-minted agent, plus `buyer_id`. The unique
 * partial index `idx_agents_buyer_merchant` (migration 0003) makes a second
 * connect to the same merchant a SQLSTATE 23505 rather than a second budget;
 * callers should catch `AlreadyConnectedError` and show it as a normal
 * outcome, not a database error — see `web/lib/buyer-actions.ts`.
 */
import { mintAgentToken } from "../auth/token";
import { queryOne } from "../db/pool";
import { isUniqueViolation } from "./auth";

export class AlreadyConnectedError extends Error {
  constructor(merchantId: string) {
    super(`Already connected to merchant ${merchantId}.`);
    this.name = "AlreadyConnectedError";
  }
}

interface AgentRow {
  id: string;
  merchant_id: string;
  label: string;
  created_at: Date;
}

function newAgentId(): string {
  return `ag_${crypto.randomUUID().replace(/-/g, "")}`;
}

export interface ProvisionResult {
  readonly agentId: string;
  readonly merchantId: string;
  readonly token: string;
  readonly buyerCapPaise: number | null;
}

/**
 * `buyerCapPaise` must already be converted to paise (see
 * `src/catalog/csv.ts`'s `rupeesToPaise`) — this module does no unit
 * conversion, matching `createMerchant`'s split between rupee-string inputs
 * and integer-paise storage.
 */
export async function provisionAgentForBuyer(args: {
  buyerId: string;
  merchantId: string;
  label: string;
  buyerCapPaise: number | null;
}): Promise<ProvisionResult> {
  const label = args.label.trim();
  if (label.length === 0) {
    throw new Error("Agent label must not be blank.");
  }

  // Validate buyerId strictly: the partial unique index idx_agents_buyer_merchant
  // only covers non-NULL buyer_ids, so a NULL value bypasses the "one agent per
  // buyer per merchant" constraint entirely. A single caller mistake then yields
  // unlimited orphan agents at a merchant, each with its own spend budget, each
  // indistinguishable from a legitimately merchant-minted agent (NULL marks those
  // by design). This field is therefore validated harder than the others.
  const buyerId = args.buyerId?.trim() ?? "";
  if (buyerId.length === 0) {
    throw new Error("Buyer ID must not be blank.");
  }

  const agentId = newAgentId();
  const { raw: token, hash: tokenHash } = mintAgentToken();

  try {
    const row = await queryOne<AgentRow>(
      `INSERT INTO agents (id, merchant_id, buyer_id, label, token_hash, buyer_cap_paise)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, merchant_id, label, created_at`,
      [agentId, args.merchantId, buyerId, label, tokenHash, args.buyerCapPaise]
    );
    if (row === null) {
      throw new Error(`insert into agents returned no row for ${agentId}`);
    }
    return {
      agentId: row.id,
      merchantId: row.merchant_id,
      token,
      buyerCapPaise: args.buyerCapPaise,
    };
  } catch (err) {
    if (isUniqueViolation(err))
      throw new AlreadyConnectedError(args.merchantId);
    throw err;
  }
}
