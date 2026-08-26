/**
 * Onboards a merchant end to end: validates a CSV catalog and a policy
 * document, mints the merchant's first agent credential, and writes all of
 * it in one transaction.
 *
 * Runs BEFORE any tenant context exists, so this writes through the shared
 * pool with raw SQL inside withTransaction rather than through TenantRepo
 * (which requires an already-resolved TenantContext).
 */
import { mintAgentToken } from "../auth/token";
import { env } from "../config";
import { withTransaction } from "../db/pool";
import { Agent, Merchant } from "../shared/contracts";
import type { Policy } from "../shared/contracts";
import { parseCatalogCsv, rupeesToPaise } from "../catalog/csv";
import { parsePolicy } from "../catalog/policy";

interface MerchantRow {
  id: string;
  name: string;
  created_at: Date;
}

interface AgentRow {
  id: string;
  merchant_id: string;
  label: string;
  created_at: Date;
}

/**
 * Rejects a merchant policy that sets itself a cap above the platform's
 * ceiling. This CANNOT be a SQL CHECK — Postgres cannot see the environment —
 * and it does not belong inside `parsePolicy` (src/catalog/policy.ts) either:
 * that function is a pure rupees-to-paise parser that src/eval/ and the tests
 * rely on being independent of deployment config. So the rule sits on the write
 * path instead, and takes the ceiling as an argument rather than reading
 * `env` itself so every branch is testable without mutating the environment.
 *
 * FOOT-GUN, unremovable here: this is the only policy write path today. A
 * future policy-EDIT path must call this too, or a merchant raises its own cap
 * past the ceiling by editing rather than by onboarding. The gate's own ceiling
 * check (src/gate/index.ts check 2) is the backstop that makes that a
 * mis-stated policy row rather than an actually-spendable one.
 */
export function assertWithinPlatformCeiling(
  spendCapPaise: number,
  ceilingPaise: number | null
): void {
  if (ceilingPaise !== null && spendCapPaise > ceilingPaise) {
    throw new Error(
      `spend_cap of ${spendCapPaise} paise exceeds the platform ceiling of ` +
        `${ceilingPaise} paise (PLATFORM_SPEND_CEILING_PAISE). ` +
        `Lower the merchant's spend cap, or raise the platform ceiling.`
    );
  }
}

/**
 * Converts an optional buyer cap written in rupees. Blank or absent means the
 * buyer imposes no constraint, which is `null` — the column is nullable for
 * exactly that reason. Delegates to `rupeesToPaise`, the codebase's one
 * integer-string rupee converter, because `0.29 * 100` is 28.999999999999996
 * and a second converter would eventually get that wrong.
 */
function buyerCapToPaise(buyerCapRupees: string | undefined): number | null {
  if (buyerCapRupees === undefined || buyerCapRupees.trim() === "") return null;
  const paise = rupeesToPaise(buyerCapRupees);
  if (paise <= 0) {
    throw new Error(
      `Invalid buyer cap ${JSON.stringify(buyerCapRupees)}: must be greater than zero. ` +
        `Leave it blank for no buyer cap.`
    );
  }
  return paise;
}

export async function createMerchant(args: {
  merchantId: string;
  name: string;
  csv: string;
  policyJson: unknown;
  agentLabel: string;
  /**
   * The BUYER's cap on the agent being minted, in rupees ("2500", "2500.50").
   * Optional: absent or blank stores NULL, meaning the buyer imposes no
   * constraint and the merchant's policy figure binds on its own — the exact
   * behaviour that predates this argument.
   */
  buyerCapRupees?: string;
}): Promise<{
  merchant: Merchant;
  policy: Policy;
  agent: Agent;
  productCount: number;
  token: string;
  /** What was stored on the agent row: null when the buyer set no cap. */
  buyerCapPaise: number | null;
}> {
  const { merchantId, name, csv, policyJson, agentLabel, buyerCapRupees } =
    args;

  // Validate everything BEFORE opening a transaction, so a bad catalog or
  // policy never touches the database.
  const { products } = parseCatalogCsv(csv, merchantId);
  const policy = parsePolicy(policyJson, merchantId);
  assertWithinPlatformCeiling(
    policy.spend_cap_paise,
    env.PLATFORM_SPEND_CEILING_PAISE
  );
  const buyerCapPaise = buyerCapToPaise(buyerCapRupees);
  const { raw: token, hash: tokenHash } = mintAgentToken();
  const agentId = `ag_${crypto.randomUUID().replace(/-/g, "")}`;

  const { merchantRow, agentRow } = await withTransaction(async (client) => {
    const merchantResult = await client.query<MerchantRow>(
      `INSERT INTO merchants (id, name) VALUES ($1, $2)
       RETURNING id, name, created_at`,
      [merchantId, name]
    );
    const insertedMerchant = merchantResult.rows[0];
    if (insertedMerchant === undefined) {
      throw new Error(
        `insert into merchants returned no row for ${merchantId}`
      );
    }

    await client.query(
      `INSERT INTO policies
         (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        merchantId,
        policy.spend_cap_paise,
        policy.approval_threshold_paise,
        policy.category_allowlist,
        policy.window_seconds,
      ]
    );

    for (const product of products) {
      await client.query(
        `INSERT INTO products (merchant_id, id, name, price_paise, stock, category)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          product.merchant_id,
          product.id,
          product.name,
          product.price_paise,
          product.stock,
          product.category,
        ]
      );
    }

    const agentResult = await client.query<AgentRow>(
      `INSERT INTO agents (id, merchant_id, label, token_hash, buyer_cap_paise)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, merchant_id, label, created_at`,
      [agentId, merchantId, agentLabel, tokenHash, buyerCapPaise]
    );
    const insertedAgent = agentResult.rows[0];
    if (insertedAgent === undefined) {
      throw new Error(`insert into agents returned no row for ${agentId}`);
    }

    return { merchantRow: insertedMerchant, agentRow: insertedAgent };
  });

  return {
    merchant: Merchant.parse(merchantRow),
    policy,
    agent: Agent.parse(agentRow),
    productCount: products.length,
    token,
    buyerCapPaise,
  };
}
