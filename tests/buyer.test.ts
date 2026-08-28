import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pool, query, queryOne } from "../src/db/pool";
import {
  DuplicateEmailError,
  InvalidCredentialsError,
  getBuyerForSession,
  loginBuyer,
  logoutBuyer,
  normalizeEmail,
  registerBuyer,
} from "../src/buyer/auth";
import {
  AlreadyConnectedError,
  provisionAgentForBuyer,
} from "../src/buyer/provision";
import { createMerchant } from "../src/onboard/create-merchant";

const FIXTURE_CSV = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.csv`
).text();
const FIXTURE_POLICY: unknown = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.policy.json`
).json();

const TEST_BUYER_EMAILS = [
  "buyer.register@buyer-test.example",
  "buyer.dup@buyer-test.example",
  "buyer.login@buyer-test.example",
  "buyer.expiry@buyer-test.example",
  "buyer.hash@buyer-test.example",
  "buyer.connect@buyer-test.example",
  "buyer.reconnect@buyer-test.example",
];
const TEST_MERCHANT_ID = "m_buyer_test_provision";

async function cleanupBuyers(): Promise<void> {
  await query("DELETE FROM buyers WHERE email = ANY($1::text[])", [
    TEST_BUYER_EMAILS,
  ]);
}

async function cleanupMerchant(merchantId: string): Promise<void> {
  // audit_events has no FK to merchants — orphans survive a merchant delete
  // and double-count in later runs if not swept explicitly.
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [merchantId]);
  await query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

afterAll(async () => {
  await cleanupBuyers();
  await cleanupMerchant(TEST_MERCHANT_ID);
});

describe("registerBuyer", () => {
  test("creates a buyer with a normalised email and a usable session", async () => {
    const email = "  Buyer.Register@Buyer-Test.example  ";
    const { buyer, session } = await registerBuyer(email, "correct-horse-1");

    expect(buyer.email).toBe("buyer.register@buyer-test.example");
    expect(session.raw.length).toBeGreaterThan(10);

    const resolved = await getBuyerForSession(session.raw);
    expect(resolved?.id).toBe(buyer.id);
  });

  test("rejects a duplicate email with DuplicateEmailError", async () => {
    const email = "buyer.dup@buyer-test.example";
    await registerBuyer(email, "correct-horse-1");

    await expect(registerBuyer(email, "another-password")).rejects.toThrow(
      DuplicateEmailError
    );
  });

  test("rejects a short password", async () => {
    await expect(
      registerBuyer("buyer.short@buyer-test.example", "short")
    ).rejects.toThrow();
  });
});

describe("loginBuyer", () => {
  test("succeeds with the right password, normalising email on the way in", async () => {
    const email = "buyer.login@buyer-test.example";
    await registerBuyer(email, "correct-horse-2");

    const { buyer } = await loginBuyer(
      "  Buyer.Login@Buyer-Test.example ",
      "correct-horse-2"
    );
    expect(buyer.email).toBe(email);
  });

  test("fails with the wrong password", async () => {
    await expect(
      loginBuyer("buyer.login@buyer-test.example", "wrong-password")
    ).rejects.toThrow(InvalidCredentialsError);
  });

  test("fails for an email that was never registered", async () => {
    await expect(
      loginBuyer("nobody@buyer-test.example", "whatever12")
    ).rejects.toThrow(InvalidCredentialsError);
  });
});

describe("sessions", () => {
  test("only the SHA-256 of the session token is stored, never the raw token", async () => {
    const email = "buyer.hash@buyer-test.example";
    const { session } = await registerBuyer(email, "correct-horse-3");

    const row = await queryOne<{ token_hash: string }>(
      "SELECT token_hash FROM buyer_sessions WHERE token_hash = $1",
      [session.hash]
    );
    expect(row?.token_hash).toBe(
      createHash("sha256").update(session.raw, "utf8").digest("hex")
    );
    expect(row?.token_hash).not.toBe(session.raw);

    const rawStoredAnywhere = await queryOne<{ token_hash: string }>(
      "SELECT token_hash FROM buyer_sessions WHERE token_hash = $1",
      [session.raw]
    );
    expect(rawStoredAnywhere).toBeNull();
  });

  test("rejects an expired session on read", async () => {
    const email = "buyer.expiry@buyer-test.example";
    const { buyer, session } = await registerBuyer(email, "correct-horse-4");

    // Backdate expires_at into the past. created_at also moves back so the
    // buyer_session_expires_after_creation CHECK (expires_at > created_at)
    // still holds.
    await query(
      "UPDATE buyer_sessions SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE token_hash = $1",
      [session.hash]
    );

    const resolved = await getBuyerForSession(session.raw);
    expect(resolved).toBeNull();
    expect(buyer.id).not.toBe(""); // buyer row itself is untouched
  });

  test("logoutBuyer deletes the session so the token no longer resolves", async () => {
    const email = "buyer.register@buyer-test.example"; // already registered above; log in fresh
    const { session } = await loginBuyer(email, "correct-horse-1");
    expect(await getBuyerForSession(session.raw)).not.toBeNull();

    await logoutBuyer(session.raw);
    expect(await getBuyerForSession(session.raw)).toBeNull();
  });

  test("getBuyerForSession returns null for garbage input", async () => {
    expect(await getBuyerForSession(undefined)).toBeNull();
    expect(await getBuyerForSession(null)).toBeNull();
    expect(await getBuyerForSession("not-a-real-token")).toBeNull();
  });
});

describe("normalizeEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.Com ")).toBe("foo@bar.com");
  });
});

describe("provisionAgentForBuyer", () => {
  test("writes an agent row scoped to the buyer, merchant, and buyer cap", async () => {
    await cleanupMerchant(TEST_MERCHANT_ID);
    await createMerchant({
      merchantId: TEST_MERCHANT_ID,
      name: "Buyer Provision Test Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "merchant-minted-agent",
    });

    const { buyer } = await registerBuyer(
      "buyer.connect@buyer-test.example",
      "correct-horse-5"
    );

    const result = await provisionAgentForBuyer({
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
      label: "my-shopping-agent",
      buyerCapPaise: 50000,
    });

    expect(result.token).toMatch(/^dk_/);
    expect(result.buyerCapPaise).toBe(50000);

    const row = await queryOne<{
      buyer_id: string;
      merchant_id: string;
      buyer_cap_paise: number;
      token_hash: string;
    }>(
      "SELECT buyer_id, merchant_id, buyer_cap_paise, token_hash FROM agents WHERE id = $1",
      [result.agentId]
    );
    expect(row?.buyer_id).toBe(buyer.id);
    expect(row?.merchant_id).toBe(TEST_MERCHANT_ID);
    expect(row?.buyer_cap_paise).toBe(50000);
    expect(row?.token_hash).not.toBe(result.token);
  });

  test("a second connect to the same merchant throws AlreadyConnectedError", async () => {
    const { buyer } = await registerBuyer(
      "buyer.reconnect@buyer-test.example",
      "correct-horse-6"
    );

    await provisionAgentForBuyer({
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
      label: "first-connect",
      buyerCapPaise: null,
    });

    await expect(
      provisionAgentForBuyer({
        buyerId: buyer.id,
        merchantId: TEST_MERCHANT_ID,
        label: "second-connect",
        buyerCapPaise: null,
      })
    ).rejects.toThrow(AlreadyConnectedError);

    const count = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE buyer_id = $1 AND merchant_id = $2",
      [buyer.id, TEST_MERCHANT_ID]
    );
    expect(count?.count).toBe(1);
  });

  test("rejects a blank label", async () => {
    const { buyer } = await registerBuyer(
      "buyer.blanklabel@buyer-test.example",
      "correct-horse-7"
    );
    TEST_BUYER_EMAILS.push("buyer.blanklabel@buyer-test.example");

    await expect(
      provisionAgentForBuyer({
        buyerId: buyer.id,
        merchantId: TEST_MERCHANT_ID,
        label: "   ",
        buyerCapPaise: null,
      })
    ).rejects.toThrow();
  });

  test("rejects an empty buyerId and creates no agent row", async () => {
    await registerBuyer("buyer.emptyid@buyer-test.example", "correct-horse-8");
    TEST_BUYER_EMAILS.push("buyer.emptyid@buyer-test.example");

    const countBefore = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const beforeCount = countBefore?.count ?? 0;

    await expect(
      provisionAgentForBuyer({
        buyerId: "",
        merchantId: TEST_MERCHANT_ID,
        label: "test-agent",
        buyerCapPaise: null,
      })
    ).rejects.toThrow("Buyer ID must not be blank.");

    const countAfter = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const afterCount = countAfter?.count ?? 0;

    expect(afterCount).toBe(beforeCount);
  });

  test("rejects a whitespace-only buyerId and creates no agent row", async () => {
    await registerBuyer(
      "buyer.whitespaceid@buyer-test.example",
      "correct-horse-9"
    );
    TEST_BUYER_EMAILS.push("buyer.whitespaceid@buyer-test.example");

    const countBefore = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const beforeCount = countBefore?.count ?? 0;

    await expect(
      provisionAgentForBuyer({
        buyerId: "   ",
        merchantId: TEST_MERCHANT_ID,
        label: "test-agent",
        buyerCapPaise: null,
      })
    ).rejects.toThrow("Buyer ID must not be blank.");

    const countAfter = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const afterCount = countAfter?.count ?? 0;

    expect(afterCount).toBe(beforeCount);
  });

  test("rejects an undefined buyerId and creates no agent row", async () => {
    const countBefore = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const beforeCount = countBefore?.count ?? 0;

    await expect(
      provisionAgentForBuyer({
        buyerId: undefined as unknown as string,
        merchantId: TEST_MERCHANT_ID,
        label: "test-agent",
        buyerCapPaise: null,
      })
    ).rejects.toThrow("Buyer ID must not be blank.");

    const countAfter = await queryOne<{ count: number }>(
      "SELECT count(*) AS count FROM agents WHERE merchant_id = $1",
      [TEST_MERCHANT_ID]
    );
    const afterCount = countAfter?.count ?? 0;

    expect(afterCount).toBe(beforeCount);
  });

  test("valid buyerId still provisions and writes buyer_id and buyer_cap_paise", async () => {
    const { buyer } = await registerBuyer(
      "buyer.validid@buyer-test.example",
      "correct-horse-10"
    );
    TEST_BUYER_EMAILS.push("buyer.validid@buyer-test.example");

    const result = await provisionAgentForBuyer({
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
      label: "valid-buyer-agent",
      buyerCapPaise: 75000,
    });

    const row = await queryOne<{
      buyer_id: string;
      buyer_cap_paise: number;
    }>("SELECT buyer_id, buyer_cap_paise FROM agents WHERE id = $1", [
      result.agentId,
    ]);

    expect(row?.buyer_id).toBe(buyer.id);
    expect(row?.buyer_cap_paise).toBe(75000);
  });
});

// pool is never closed here — src/db/pool.ts is a process-wide singleton
// shared by every test file in this run.
void pool;
