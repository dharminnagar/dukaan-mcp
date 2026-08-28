/**
 * Read-only queries for the buyer-facing pages. Server-only (imports `pg`
 * transitively via `src/db/pool`), matching `web/lib/dashboard-queries.ts`'s
 * shape.
 */
import "./assert-server-only";
import { cookies } from "next/headers";
import { query, queryOne } from "../../src/db/pool";
import { getBuyerForSession, SESSION_COOKIE_NAME } from "../../src/buyer/auth";
import type { Buyer } from "../../src/buyer/auth";

/** Resolves the signed-in buyer from the request's httpOnly cookie, or null. */
export async function getSessionBuyer(): Promise<Buyer | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE_NAME)?.value;
  return getBuyerForSession(raw);
}

export interface MerchantDirectoryEntry {
  readonly id: string;
  readonly name: string;
  readonly productCount: number;
  readonly categories: readonly string[];
  /** The buyer's own agent at this merchant, if they already connected. */
  readonly connectedAgentId: string | null;
}

interface DirectoryRow {
  id: string;
  name: string;
  category_allowlist: string[];
  product_count: number;
  connected_agent_id: string | null;
}

/**
 * One row per onboarded merchant (a merchant with no policy row cannot be
 * onboarded, so the join to `policies` also filters out half-finished rows).
 * `connected_agent_id` is scoped to `buyerId` via a correlated LEFT JOIN so a
 * signed-out visitor (buyerId === null) still sees the full directory with
 * every connect button live.
 */
export async function listMerchantDirectory(
  buyerId: string | null
): Promise<MerchantDirectoryEntry[]> {
  const rows = await query<DirectoryRow>(
    `SELECT m.id,
            m.name,
            p.category_allowlist,
            COUNT(pr.id) AS product_count,
            a.id AS connected_agent_id
       FROM merchants m
       JOIN policies p ON p.merchant_id = m.id
       LEFT JOIN products pr ON pr.merchant_id = m.id
       LEFT JOIN agents a ON a.merchant_id = m.id AND a.buyer_id = $1
      GROUP BY m.id, m.name, p.category_allowlist, a.id
      ORDER BY m.name`,
    [buyerId]
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    productCount: r.product_count,
    categories: r.category_allowlist,
    connectedAgentId: r.connected_agent_id,
  }));
}

export async function merchantExists(merchantId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    "SELECT id FROM merchants WHERE id = $1",
    [merchantId]
  );
  return row !== null;
}
