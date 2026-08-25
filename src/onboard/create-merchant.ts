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
import { withTransaction } from "../db/pool";
import { Agent, Merchant } from "../shared/contracts";
import type { Policy } from "../shared/contracts";
import { parseCatalogCsv } from "../catalog/csv";
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

export async function createMerchant(args: {
  merchantId: string;
  name: string;
  csv: string;
  policyJson: unknown;
  agentLabel: string;
}): Promise<{
  merchant: Merchant;
  policy: Policy;
  agent: Agent;
  productCount: number;
  token: string;
}> {
  const { merchantId, name, csv, policyJson, agentLabel } = args;

  // Validate everything BEFORE opening a transaction, so a bad catalog or
  // policy never touches the database.
  const { products } = parseCatalogCsv(csv, merchantId);
  const policy = parsePolicy(policyJson, merchantId);
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
      `INSERT INTO agents (id, merchant_id, label, token_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, merchant_id, label, created_at`,
      [agentId, merchantId, agentLabel, tokenHash]
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
  };
}
