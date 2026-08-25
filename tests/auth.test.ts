import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  hashToken,
  hashesEqual,
  mintAgentToken,
  parseBearer,
} from "../src/auth/token";
import { resolveTenant } from "../src/auth/resolve";
import { pool, query } from "../src/db/pool";

const MERCHANT_ID = "m_u4_auth";
const AGENT_1_ID = "ag_u4_auth1";
const AGENT_2_ID = "ag_u4_auth2";

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

test("pool is reachable", async () => {
  const { rows } = await pool.query("SELECT 1 AS ok");
  expect(rows[0]?.ok).toBe(1);
});
