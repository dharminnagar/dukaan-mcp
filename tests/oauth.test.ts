/**
 * DUK-35's OAuth 2.1 front door: dynamic client registration, PKCE
 * verification (S256-only), single-use/expiring authorization codes, exact
 * redirect_uri matching, and the /token exchange end to end against a real
 * agent token. Namespaced `oauth_test_*` / `oauth.test@` so this file never
 * collides with another test file's fixtures.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { pool, query } from "../src/db/pool";
import {
  InvalidRedirectUriError,
  getClient,
  isRegisteredRedirectUri,
  registerClient,
} from "../src/oauth/clients";
import {
  createAuthCode,
  consumeAuthCode,
  deriveS256Challenge,
  verifyPkce,
} from "../src/oauth/codes";
import { parseAuthorizeParams } from "../web/app/oauth/authorize/params";
import { mcpResourceUrl } from "../src/oauth/urls";
import { POST as registerRoute } from "../web/app/api/oauth/register/route";
import { POST as tokenRoute } from "../web/app/api/oauth/token/route";
import { registerBuyer } from "../src/buyer/auth";
import { createMerchant } from "../src/onboard/create-merchant";

const FIXTURE_CSV = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.csv`
).text();
const FIXTURE_POLICY: unknown = await Bun.file(
  `${import.meta.dir}/../fixtures/merchant-a.policy.json`
).json();

const TEST_MERCHANT_ID = "m_oauth_test";
const TEST_BUYER_EMAILS = [
  "oauth.buyer@oauth-test.example",
  "oauth.buyer2@oauth-test.example",
];

async function cleanupMerchant(merchantId: string): Promise<void> {
  await query("DELETE FROM audit_events WHERE merchant_id = $1", [merchantId]);
  await query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

async function cleanupBuyers(): Promise<void> {
  await query("DELETE FROM buyers WHERE email = ANY($1::text[])", [
    TEST_BUYER_EMAILS,
  ]);
}

async function cleanupClients(): Promise<void> {
  await query(
    "DELETE FROM oauth_clients WHERE client_name LIKE 'oauth-test-%'"
  );
}

afterAll(async () => {
  await cleanupClients();
  await cleanupBuyers();
  await cleanupMerchant(TEST_MERCHANT_ID);
});

/** A real 43-char S256 code_verifier/challenge pair, matching RFC 7636. */
function pkcePair(seed: string): { verifier: string; challenge: string } {
  const verifier = `${seed}-${"a".repeat(50)}`.slice(0, 64);
  return { verifier, challenge: deriveS256Challenge(verifier) };
}

describe("registerClient / getClient / isRegisteredRedirectUri", () => {
  test("registers a client and round-trips it", async () => {
    const client = await registerClient({
      redirectUris: ["https://client.example/cb"],
      clientName: "oauth-test-basic",
    });
    expect(client.id).toMatch(/^oc_/);

    const fetched = await getClient(client.id);
    expect(fetched?.redirectUris).toEqual(["https://client.example/cb"]);
  });

  test("rejects an empty redirect_uris array", async () => {
    await expect(
      registerClient({ redirectUris: [], clientName: "oauth-test-empty" })
    ).rejects.toThrow(InvalidRedirectUriError);
  });

  test("rejects a malformed redirect_uri", async () => {
    await expect(
      registerClient({
        redirectUris: ["not-a-url"],
        clientName: "oauth-test-malformed",
      })
    ).rejects.toThrow(InvalidRedirectUriError);
  });

  test("exact match only — no prefix, no wildcard, no case-insensitivity", async () => {
    const client = await registerClient({
      redirectUris: ["https://client.example/cb"],
      clientName: "oauth-test-exact",
    });
    expect(isRegisteredRedirectUri(client, "https://client.example/cb")).toBe(
      true
    );
    expect(
      isRegisteredRedirectUri(client, "https://client.example/cb/evil")
    ).toBe(false);
    expect(isRegisteredRedirectUri(client, "https://client.example/CB")).toBe(
      false
    );
    expect(isRegisteredRedirectUri(client, "https://evil.example/cb")).toBe(
      false
    );
  });
});

describe("PKCE (S256)", () => {
  test("verifyPkce accepts the matching verifier and rejects a wrong one", () => {
    const { verifier, challenge } = pkcePair("right");
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("wrong-verifier-wrong-verifier-wrong", challenge)).toBe(
      false
    );
  });

  test("deriveS256Challenge matches a manual SHA-256/base64url computation", () => {
    const verifier = "abc123-abc123-abc123-abc123-abc123-abc123";
    const expected = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64url");
    expect(deriveS256Challenge(verifier)).toBe(expected);
  });
});

describe("parseAuthorizeParams", () => {
  const base = {
    response_type: "code",
    client_id: "oc_abc",
    redirect_uri: "https://client.example/cb",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
  };

  test("accepts a well-formed request, defaulting resource to this server", () => {
    const result = parseAuthorizeParams(base);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.resource).toBe(mcpResourceUrl());
    }
  });

  test("rejects code_challenge_method=plain", () => {
    const result = parseAuthorizeParams({
      ...base,
      code_challenge_method: "plain",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a missing code_challenge_method", () => {
    const { code_challenge_method, ...rest } = base;
    void code_challenge_method;
    const result = parseAuthorizeParams(rest);
    expect(result.ok).toBe(false);
  });

  test("rejects a missing code_challenge", () => {
    const { code_challenge, ...rest } = base;
    void code_challenge;
    const result = parseAuthorizeParams(rest);
    expect(result.ok).toBe(false);
  });

  test("rejects an unknown resource", () => {
    const result = parseAuthorizeParams({
      ...base,
      resource: "https://someone-elses-server.example/mcp",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a non-code response_type (no implicit grant)", () => {
    const result = parseAuthorizeParams({ ...base, response_type: "token" });
    expect(result.ok).toBe(false);
  });
});

describe("authorization codes: single-use and expiry", () => {
  test("consumeAuthCode succeeds once, then fails on replay", async () => {
    const client = await registerClient({
      redirectUris: ["https://client.example/cb"],
      clientName: "oauth-test-singleuse",
    });
    await cleanupMerchant(TEST_MERCHANT_ID);
    await createMerchant({
      merchantId: TEST_MERCHANT_ID,
      name: "OAuth Test Kirana",
      csv: FIXTURE_CSV,
      policyJson: FIXTURE_POLICY,
      agentLabel: "merchant-minted-agent",
    });
    const { buyer } = await registerBuyer(
      "oauth.buyer@oauth-test.example",
      "correct-horse-oauth-1"
    );

    const { challenge } = pkcePair("singleuse");
    const minted = await createAuthCode({
      clientId: client.id,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
      redirectUri: "https://client.example/cb",
      codeChallenge: challenge,
      resource: mcpResourceUrl(),
      buyerCapPaise: null,
    });

    const first = await consumeAuthCode(minted.raw);
    expect(first?.buyerId).toBe(buyer.id);
    expect(first?.merchantId).toBe(TEST_MERCHANT_ID);

    const replay = await consumeAuthCode(minted.raw);
    expect(replay).toBeNull();
  });

  test("consumeAuthCode fails for an expired code", async () => {
    const client = await registerClient({
      redirectUris: ["https://client.example/cb"],
      clientName: "oauth-test-expiry",
    });
    const { buyer } = await registerBuyer(
      "oauth.buyer2@oauth-test.example",
      "correct-horse-oauth-2"
    );
    const { challenge } = pkcePair("expiry");
    const minted = await createAuthCode({
      clientId: client.id,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
      redirectUri: "https://client.example/cb",
      codeChallenge: challenge,
      resource: mcpResourceUrl(),
      buyerCapPaise: null,
    });

    await query(
      "UPDATE oauth_auth_codes SET created_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute' WHERE code_hash = $1",
      [createHash("sha256").update(minted.raw, "utf8").digest("hex")]
    );

    const result = await consumeAuthCode(minted.raw);
    expect(result).toBeNull();
  });

  test("consumeAuthCode fails for a code that never existed", async () => {
    const result = await consumeAuthCode("oac_totally-made-up");
    expect(result).toBeNull();
  });
});

describe("DCR route (POST /api/oauth/register)", () => {
  test("returns a client_id for a valid registration", async () => {
    const req = new Request("http://127.0.0.1:3000/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/cb"],
        client_name: "oauth-test-dcr-route",
      }),
    });
    const res = await registerRoute(req);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string };
    expect(body.client_id).toMatch(/^oc_/);
  });

  test("rejects a request with no redirect_uris", async () => {
    const req = new Request("http://127.0.0.1:3000/api/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "oauth-test-dcr-bad" }),
    });
    const res = await registerRoute(req);
    expect(res.status).toBe(400);
  });
});

describe("token route (POST /api/oauth/token)", () => {
  async function issueCode(args: {
    redirectUri: string;
    challenge: string;
    buyerId: string;
    merchantId: string;
  }) {
    const client = await registerClient({
      redirectUris: [args.redirectUri],
      clientName: "oauth-test-token-route",
    });
    const minted = await createAuthCode({
      clientId: client.id,
      buyerId: args.buyerId,
      merchantId: args.merchantId,
      redirectUri: args.redirectUri,
      codeChallenge: args.challenge,
      resource: mcpResourceUrl(),
      buyerCapPaise: null,
    });
    return { client, code: minted.raw };
  }

  function tokenRequest(params: Record<string, string>): Request {
    return new Request("http://127.0.0.1:3000/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    });
  }

  test("issues a real dk_ token for the correct code_verifier, and it authenticates against the gate", async () => {
    const { buyer } = await registerBuyer(
      "oauth.token1@oauth-test.example",
      "correct-horse-oauth-3"
    );
    TEST_BUYER_EMAILS.push("oauth.token1@oauth-test.example");
    const { verifier, challenge } = pkcePair("token-success");
    const { client, code } = await issueCode({
      redirectUri: "https://client.example/cb",
      challenge,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
    });

    const res = await tokenRoute(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://client.example/cb",
        client_id: client.id,
        code_verifier: verifier,
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string };
    expect(body.access_token).toMatch(/^dk_/);

    const { resolveTenant } = await import("../src/auth/resolve");
    const resolved = await resolveTenant(`Bearer ${body.access_token}`, null);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.ctx.merchant_id).toBe(TEST_MERCHANT_ID);
    }
  });

  test("wrong code_verifier fails", async () => {
    const { buyer } = await registerBuyer(
      "oauth.token2@oauth-test.example",
      "correct-horse-oauth-4"
    );
    TEST_BUYER_EMAILS.push("oauth.token2@oauth-test.example");
    const { challenge } = pkcePair("token-wrong-verifier");
    const { client, code } = await issueCode({
      redirectUri: "https://client.example/cb",
      challenge,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
    });

    const res = await tokenRoute(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://client.example/cb",
        client_id: client.id,
        code_verifier: "totally-the-wrong-verifier-0000000000000000",
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("replaying a consumed code fails, even with the right verifier", async () => {
    const { buyer } = await registerBuyer(
      "oauth.token3@oauth-test.example",
      "correct-horse-oauth-5"
    );
    TEST_BUYER_EMAILS.push("oauth.token3@oauth-test.example");
    const { verifier, challenge } = pkcePair("token-replay");
    const { client, code } = await issueCode({
      redirectUri: "https://client.example/cb",
      challenge,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
    });

    const params = {
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://client.example/cb",
      client_id: client.id,
      code_verifier: verifier,
    };
    const first = await tokenRoute(tokenRequest(params));
    expect(first.status).toBe(200);

    const second = await tokenRoute(tokenRequest(params));
    expect(second.status).toBe(400);
    const body = (await second.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("a redirect_uri not exactly matching the registration is rejected", async () => {
    const { buyer } = await registerBuyer(
      "oauth.token4@oauth-test.example",
      "correct-horse-oauth-6"
    );
    TEST_BUYER_EMAILS.push("oauth.token4@oauth-test.example");
    const { verifier, challenge } = pkcePair("token-bad-redirect");
    const { client, code } = await issueCode({
      redirectUri: "https://client.example/cb",
      challenge,
      buyerId: buyer.id,
      merchantId: TEST_MERCHANT_ID,
    });

    const res = await tokenRoute(
      tokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://client.example/cb/evil",
        client_id: client.id,
        code_verifier: verifier,
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_grant");
  });

  test("rejects an unsupported grant_type", async () => {
    const res = await tokenRoute(
      tokenRequest({
        grant_type: "client_credentials",
        code: "irrelevant",
        redirect_uri: "https://client.example/cb",
        client_id: "oc_irrelevant",
        code_verifier: "irrelevant",
      })
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unsupported_grant_type");
  });
});

// pool is never closed here — src/db/pool.ts is a process-wide singleton
// shared by every test file in this run.
void pool;
