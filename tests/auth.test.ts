import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  hashToken,
  hashesEqual,
  mintAgentToken,
  parseBearer,
} from "../src/auth/token";
import { resolveTenant } from "../src/auth/resolve";
import { TenantRepo } from "../src/db/repo";
import { pool, query } from "../src/db/pool";

const MERCHANT_ID = "m_u4_auth";
const AGENT_1_ID = "ag_u4_auth1";
const AGENT_2_ID = "ag_u4_auth2";

const SESSION_ID_RE = /^s_[a-zA-Z0-9_-]{1,64}$/;

const REUSE_MERCHANT_ID = "m_auth28_reuse";
const REUSE_AGENT_1_ID = "ag_auth28_1";
const REUSE_AGENT_2_ID = "ag_auth28_2";

interface AgentRow {
  id: string;
  merchant_id: string;
  label: string;
  token_hash: string;
  created_at: Date;
}

let token1: ReturnType<typeof mintAgentToken>;
let token2: ReturnType<typeof mintAgentToken>;

beforeAll(async () => {
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT_ID]);
  await query("INSERT INTO merchants (id, name) VALUES ($1, $2)", [
    MERCHANT_ID,
    "Auth Test Merchant",
  ]);

  token1 = mintAgentToken();
  token2 = mintAgentToken();

  await query(
    "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
    [AGENT_1_ID, MERCHANT_ID, "Auth Agent 1", token1.hash]
  );
  await query(
    "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
    [AGENT_2_ID, MERCHANT_ID, "Auth Agent 2", token2.hash]
  );
});

afterAll(async () => {
  await query("DELETE FROM merchants WHERE id = $1", [MERCHANT_ID]);
  // src/db/pool.ts exports one process-wide Pool singleton, shared with
  // tests/repo.test.ts whenever both run in the same `bun test` process.
  // Ending it here would break whichever file's hooks still need to query
  // it, so leave the pool open — `bun test` exits the process on its own
  // once every file's tests are done.
});

describe("token.ts", () => {
  test("mintAgentToken produces a dk_ prefixed 43-char base64url raw token and a 64-char hex hash", () => {
    const minted = mintAgentToken();
    expect(minted.raw.startsWith("dk_")).toBe(true);
    expect(minted.raw.slice(3)).toHaveLength(43);
    expect(minted.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(minted.hash).toBe(hashToken(minted.raw));
  });

  test("mintAgentToken().raw appears in no column after the agent row is persisted", async () => {
    const minted = mintAgentToken();
    const id = "ag_u4_auth_probe";
    await query("DELETE FROM agents WHERE id = $1", [id]);
    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
      [id, MERCHANT_ID, "Probe Agent", minted.hash]
    );
    const rows = await query<AgentRow>("SELECT * FROM agents WHERE id = $1", [
      id,
    ]);
    const row = rows[0];
    expect(row).toBeDefined();
    if (row === undefined) throw new Error("unreachable");
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    for (const value of Object.values(row)) {
      expect(value).not.toBe(minted.raw);
    }
    await query("DELETE FROM agents WHERE id = $1", [id]);
  });

  test("hashesEqual is true for identical digests and false for different or malformed ones", () => {
    const minted = mintAgentToken();
    expect(hashesEqual(minted.hash, hashToken(minted.raw))).toBe(true);
    expect(hashesEqual(minted.hash, hashToken("some-other-token"))).toBe(false);
    expect(hashesEqual("not-hex", minted.hash)).toBe(false);
    expect(hashesEqual(minted.hash, "short")).toBe(false);
  });

  test("parseBearer extracts the token, rejecting missing/malformed headers", () => {
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("Basic abc123")).toBeNull();
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer   ")).toBeNull();
    expect(parseBearer("Bearer abc123")).toBe("abc123");
    expect(parseBearer("Bearer  abc123  ")).toBe("abc123");
  });
});

describe("resolve.ts", () => {
  test("resolveTenant(null, ...) is unauthenticated with a non-empty WWW-Authenticate hint", async () => {
    const result = await resolveTenant(null, null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason_code).toBe("UNAUTHENTICATED");
    expect(result.error.www_authenticate.length).toBeGreaterThan(0);
  });

  test('resolveTenant("Bearer garbage", ...) is unauthenticated', async () => {
    const result = await resolveTenant("Bearer garbage", null);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.reason_code).toBe("UNAUTHENTICATED");
    expect(result.error.www_authenticate.length).toBeGreaterThan(0);
  });

  test("two agents under one merchant resolve to different agent_id, same merchant_id", async () => {
    const result1 = await resolveTenant(`Bearer ${token1.raw}`, "s_u4_auth_1");
    const result2 = await resolveTenant(`Bearer ${token2.raw}`, "s_u4_auth_2");

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (!result1.ok || !result2.ok) throw new Error("unreachable");

    expect(result1.ctx.merchant_id).toBe(MERCHANT_ID);
    expect(result2.ctx.merchant_id).toBe(MERCHANT_ID);
    expect(result1.ctx.agent_id).toBe(AGENT_1_ID);
    expect(result2.ctx.agent_id).toBe(AGENT_2_ID);
    expect(result1.ctx.agent_id).not.toBe(result2.ctx.agent_id);
  });

  test("resolveTenant mints a fresh session_id when none is supplied", async () => {
    const result = await resolveTenant(`Bearer ${token1.raw}`, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.session_id.length).toBeGreaterThan(0);
  });
});

describe("resolveTenant session_id derivation (DUK-28)", () => {
  let reuseToken1: ReturnType<typeof mintAgentToken>;
  let reuseToken2: ReturnType<typeof mintAgentToken>;

  beforeAll(async () => {
    await query("DELETE FROM merchants WHERE id = $1", [REUSE_MERCHANT_ID]);
    await query("INSERT INTO merchants (id, name) VALUES ($1, $2)", [
      REUSE_MERCHANT_ID,
      "DUK-28 Reuse Test Merchant",
    ]);

    reuseToken1 = mintAgentToken();
    reuseToken2 = mintAgentToken();

    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
      [REUSE_AGENT_1_ID, REUSE_MERCHANT_ID, "Reuse Agent 1", reuseToken1.hash]
    );
    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
      [REUSE_AGENT_2_ID, REUSE_MERCHANT_ID, "Reuse Agent 2", reuseToken2.hash]
    );
  });

  afterAll(async () => {
    // Same pool-lifetime rule as the top-level afterAll: never closePool()
    // here, tests/repo.test.ts and tests/gate.test.ts may still need it.
    await query("DELETE FROM merchants WHERE id = $1", [REUSE_MERCHANT_ID]);
  });

  test("a supplied mcp-session-id header is honoured verbatim", async () => {
    const supplied = "s_auth28_explicit_header";
    const result = await resolveTenant(`Bearer ${reuseToken1.raw}`, supplied);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.session_id).toBe(supplied);
  });

  test("two resolutions for the same agent with no header return the same session_id inside the reuse window", async () => {
    const first = await resolveTenant(`Bearer ${reuseToken1.raw}`, null);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("unreachable");

    // Mirrors the real call chain in src/mcp/http.ts: resolveTenant() only
    // decides which id to use, ensureSession() is what persists the row
    // that a later resolveTenant() call can find.
    await new TenantRepo(first.ctx).ensureSession();

    const second = await resolveTenant(`Bearer ${reuseToken1.raw}`, null);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");

    expect(second.ctx.session_id).toBe(first.ctx.session_id);
  });

  test("two resolutions for different agents under the same merchant with no header never merge", async () => {
    const agent1 = await resolveTenant(`Bearer ${reuseToken1.raw}`, null);
    const agent2 = await resolveTenant(`Bearer ${reuseToken2.raw}`, null);
    expect(agent1.ok).toBe(true);
    expect(agent2.ok).toBe(true);
    if (!agent1.ok || !agent2.ok) throw new Error("unreachable");

    await new TenantRepo(agent1.ctx).ensureSession();
    await new TenantRepo(agent2.ctx).ensureSession();

    const agent1Again = await resolveTenant(`Bearer ${reuseToken1.raw}`, null);
    const agent2Again = await resolveTenant(`Bearer ${reuseToken2.raw}`, null);
    expect(agent1Again.ok).toBe(true);
    expect(agent2Again.ok).toBe(true);
    if (!agent1Again.ok || !agent2Again.ok) throw new Error("unreachable");

    expect(agent1Again.ctx.session_id).not.toBe(agent2Again.ctx.session_id);
  });

  test("a resolution after the reuse window has elapsed returns a new session_id", async () => {
    const agentId = "ag_auth28_expiry";
    const token = mintAgentToken();
    await query("DELETE FROM agents WHERE id = $1", [agentId]);
    await query(
      "INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)",
      [agentId, REUSE_MERCHANT_ID, "Expiry Agent", token.hash]
    );

    const staleSessionId = "s_auth28_stale_session";
    // Backdated directly via SQL (the same technique tests/repo.test.ts and
    // tests/gate.test.ts use for the spend-cap window) rather than sleeping
    // or mocking a clock: the reuse lookup filters on Postgres's own now(),
    // so the deterministic way to place a session "outside the window" is
    // to give it a started_at that is provably outside it relative to that
    // same now(), computed in the same SQL statement.
    await query(
      `INSERT INTO sessions (id, merchant_id, agent_id, started_at)
       VALUES ($1, $2, $3, now() - interval '2 hours')`,
      [staleSessionId, REUSE_MERCHANT_ID, agentId]
    );

    const result = await resolveTenant(`Bearer ${token.raw}`, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.session_id).not.toBe(staleSessionId);

    await query("DELETE FROM agents WHERE id = $1", [agentId]);
  });

  test("every derived session_id satisfies the sessions.id CHECK and can actually be inserted", async () => {
    const result = await resolveTenant(`Bearer ${reuseToken1.raw}`, null);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.ctx.session_id).toMatch(SESSION_ID_RE);

    const inserted = await new TenantRepo(result.ctx).ensureSession();
    expect(inserted.id).toBe(result.ctx.session_id);
  });

  test("a revoked or unknown token still returns UNAUTHENTICATED and never a session_id", async () => {
    const revoked = await resolveTenant("Bearer dk_not_a_real_token", null);
    expect(revoked.ok).toBe(false);
    if (revoked.ok) throw new Error("unreachable");
    expect(revoked.error.reason_code).toBe("UNAUTHENTICATED");

    await query("UPDATE agents SET token_hash = $1 WHERE id = $2", [
      hashToken("some-other-value-now-unmatched"),
      REUSE_AGENT_2_ID,
    ]);
    const afterRevoke = await resolveTenant(`Bearer ${reuseToken2.raw}`, null);
    expect(afterRevoke.ok).toBe(false);
    if (afterRevoke.ok) throw new Error("unreachable");
    expect(afterRevoke.error.reason_code).toBe("UNAUTHENTICATED");
  });
});

test("pool is reachable", async () => {
  const { rows } = await pool.query("SELECT 1 AS ok");
  expect(rows[0]?.ok).toBe(1);
});
