/**
 * Provisions the two eval merchants a replay run needs, and the
 * per-transcript agent/session rows underneath them.
 *
 * ISOLATION STRATEGY: every id this module writes is namespaced under a
 * caller-supplied prefix (`m_<namespace>_kirana`, `ag_<namespace>_...`,
 * `s_<namespace>_...`). `bun run eval` uses the "eval" namespace;
 * tests/eval.test.ts uses a separate "evaltest" namespace, so a test run
 * and a real `bun run eval` invocation can never step on each other, and
 * neither can ever touch `m_demo_*` (DUK-11's demo data) or any other
 * agent's `m_gate_test` / `m_test` fixtures. `resetEvalMerchants` deletes
 * and recreates its own two merchants before every run — `ON DELETE
 * CASCADE` on merchants takes policies/products/agents/sessions/orders
 * with it (see migrations/0001_init.sql), so every replay starts from a
 * clean spend history. `audit_events` has no FK and is deliberately never
 * touched here: it is an append-only ledger by design, and eval rows in it
 * stay forever scoped to the eval merchant ids, so they cannot pollute any
 * other merchant's audit trail or another test file's assertions.
 *
 * The one thing this module does NOT do is call the real catalog/policy
 * fixtures under fixtures/eval/ — there are none. It reads the ACTUAL
 * DUK-11 demo fixtures via catalog-snapshot.ts, so the merchants replay
 * runs against have byte-identical catalogs/policies to the real demo
 * merchants, just under different ids.
 */
import { createMerchant } from "../onboard/create-merchant";
import { pool, query } from "../db/pool";
import { hashToken } from "../auth/token";
import { TenantRepo } from "../db/repo";
import type { TenantContext } from "../shared/contracts";
import { loadCatalogSnapshots } from "./catalog-snapshot";
import type { EvalMerchant } from "./transcript";

export interface EvalMerchantIds {
  readonly kirana: string;
  readonly electronics: string;
}

function merchantId(namespace: string, merchant: EvalMerchant): string {
  return `m_${namespace}_${merchant}`;
}

/** Lowercases and replaces every non `[a-z0-9_]` run with a single `_`, matching agents/sessions CHECK constraints. */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

export function evalAgentId(namespace: string, logicalAgentId: string): string {
  const id = `ag_${slug(namespace)}_${slug(logicalAgentId)}`;
  if (id.length > 51 || !/^ag_[a-z0-9_]{1,48}$/.test(id)) {
    throw new Error(
      `evalAgentId: "${id}" does not fit the agents.id CHECK constraint`
    );
  }
  return id;
}

/**
 * Small stable hash, so a long logical id can be shortened without two
 * different ids ever colliding into one session.
 */
function shortHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Composes a session id that ALWAYS satisfies the sessions.id CHECK, whatever
 * the transcript called its sessions.
 *
 * The earlier version simply concatenated and threw if the result was too
 * long, which was fine while every transcript was hand-written to fit. It
 * stopped being fine the moment a model started naming its own sessions:
 * `s_report_llm_category_laundering_0003_s_llm_category_laundering_0003_step1`
 * is 73 characters and crashed the whole replay batch. A transcript source is
 * untrusted input, so this function guarantees a valid id rather than asking
 * every future source to be careful.
 *
 * A truncated logical id keeps a readable prefix and appends a hash of the
 * FULL id, so two long ids sharing a prefix still get distinct sessions —
 * silently merging them would corrupt the audit grouping the report depends on.
 */
export function evalSessionId(
  namespace: string,
  logicalSessionId: string
): string {
  const prefix = `s_${slug(namespace)}_`;
  const logical = slug(logicalSessionId);
  const budget = 66 - prefix.length;

  const tail =
    logical.length <= budget
      ? logical
      : `${logical.slice(0, Math.max(1, budget - 9))}_${shortHash(logical)}`;

  const id = `${prefix}${tail}`;
  if (id.length > 66 || !/^s_[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    throw new Error(
      `evalSessionId: "${id}" does not fit the sessions.id CHECK constraint`
    );
  }
  return id;
}

/**
 * Wipes and recreates `m_<namespace>_kirana` / `m_<namespace>_electronics`
 * from the real demo catalogs/policies. Call this ONCE at the start of a
 * replay batch, before provisioning any agent — never mid-batch, or
 * in-flight spend history gets erased out from under a still-running
 * transcript.
 */
export async function resetEvalMerchants(
  namespace: string
): Promise<EvalMerchantIds> {
  const ids: EvalMerchantIds = {
    kirana: merchantId(namespace, "kirana"),
    electronics: merchantId(namespace, "electronics"),
  };

  await query("DELETE FROM merchants WHERE id = ANY($1::text[])", [
    Object.values(ids),
  ]);

  const snapshots = loadCatalogSnapshots();
  for (const merchant of Object.keys(ids) as (keyof EvalMerchantIds)[]) {
    const snapshot = snapshots[merchant];
    const csv = [
      "sku,name,price,stock,category",
      ...snapshot.products.map(csvRow),
    ].join("\n");
    await createMerchant({
      merchantId: ids[merchant],
      name: `Eval merchant (${namespace}/${merchant})`,
      csv,
      policyJson: policyToRawJson(snapshot.policy),
      agentLabel: `${namespace}-${merchant}-seed-agent`,
    });
  }

  return ids;
}

function csvRow(p: {
  id: string;
  name: string;
  price_paise: number;
  stock: number;
  category: string;
}): string {
  const rupees = (p.price_paise / 100).toFixed(2);
  return `${p.id},${p.name},${rupees},${p.stock},${p.category}`;
}

function policyToRawJson(policy: {
  spend_cap_paise: number;
  approval_threshold_paise: number;
  category_allowlist: readonly string[];
  window_seconds: number;
}): unknown {
  return {
    spend_cap_rupees: (policy.spend_cap_paise / 100).toFixed(2),
    approval_threshold_rupees: (policy.approval_threshold_paise / 100).toFixed(
      2
    ),
    category_allowlist: policy.category_allowlist,
    window: `${policy.window_seconds}s`,
  };
}

/**
 * Idempotent: inserts the agent row if it does not already exist. The
 * token hash is a placeholder — decide() is driven directly with a
 * TenantContext, bypassing auth/resolve.ts entirely, exactly as
 * tests/gate.test.ts does, so only a unique digest SHAPE matters here, not
 * a real credential.
 */
export async function ensureEvalAgent(
  merchantId: string,
  agentId: string,
  label: string
): Promise<void> {
  await query(
    `INSERT INTO agents (id, merchant_id, label, token_hash)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [agentId, merchantId, label, hashToken(agentId)]
  );
}

export async function ensureEvalSession(ctx: TenantContext): Promise<void> {
  await new TenantRepo(ctx).ensureSession();
}

/** Exposed only so a CLI entrypoint (run.ts) can close the pool on exit. Tests must never call this — see the pool singleton warning in pool.ts. */
export { pool as evalPool };
