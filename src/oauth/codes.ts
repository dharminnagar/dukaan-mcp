/**
 * Authorization codes: short-lived, single-use, stored hashed. Mirrors
 * `src/auth/token.ts` and `src/buyer/auth.ts` deliberately — the raw code
 * lives only in the redirect URL and the client's /token request, and
 * `oauth_auth_codes.code_hash` stores its SHA-256, never the code itself.
 *
 * PKCE (RFC 7636) verification lives here too: `code_challenge_method` is
 * database-constrained to the literal 'S256' (migrations/0004_oauth.sql), so
 * this module never has to branch on a `plain` method — there is no row it
 * could ever read that has one.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { queryOne } from "../db/pool";

const CODE_ENTROPY_BYTES = 32;
const CODE_PREFIX = "oac_";
/** 60 seconds: long enough for a real browser round trip, short enough that
 * a leaked code (referrer header, browser history, a shared machine) is
 * worthless within a minute. */
const CODE_TTL_MS = 60_000;

export interface MintedAuthCode {
  readonly raw: string;
  readonly expiresAt: Date;
}

export interface CreateAuthCodeArgs {
  readonly clientId: string;
  readonly buyerId: string;
  readonly merchantId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly buyerCapPaise: number | null;
}

export interface ConsumedAuthCode {
  readonly clientId: string;
  readonly buyerId: string;
  readonly merchantId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly buyerCapPaise: number | null;
}

interface AuthCodeRow {
  client_id: string;
  buyer_id: string;
  merchant_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  buyer_cap_paise: number | null;
}

function hashCode(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** Base64url(SHA-256(verifier)) per RFC 7636 S256 — the only method this
 * schema allows a stored challenge to use. */
export function deriveS256Challenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

/**
 * Constant-time comparison of the derived challenge against the stored one.
 * Both are short (43-char) base64url strings, but there is no reason to make
 * this a data-dependent-time string compare when a fixed-size buffer compare
 * is just as cheap — same reasoning as `hashesEqual` in src/auth/token.ts.
 */
export function verifyPkce(
  codeVerifier: string,
  storedChallenge: string
): boolean {
  const derived = deriveS256Challenge(codeVerifier);
  const a = Buffer.from(derived, "utf8");
  const b = Buffer.from(storedChallenge, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function createAuthCode(
  args: CreateAuthCodeArgs
): Promise<MintedAuthCode> {
  const raw = `${CODE_PREFIX}${randomBytes(CODE_ENTROPY_BYTES).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + CODE_TTL_MS);

  await queryOne(
    `INSERT INTO oauth_auth_codes
       (code_hash, client_id, buyer_id, merchant_id, redirect_uri,
        code_challenge, code_challenge_method, resource, buyer_cap_paise, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'S256', $7, $8, $9)`,
    [
      hashCode(raw),
      args.clientId,
      args.buyerId,
      args.merchantId,
      args.redirectUri,
      args.codeChallenge,
      args.resource,
      args.buyerCapPaise,
      expiresAt,
    ]
  );

  return { raw, expiresAt };
}

/**
 * Atomically checks-and-marks a code consumed in one UPDATE, so two
 * concurrent redemption attempts (a replay racing the legitimate exchange)
 * cannot both observe `consumed_at IS NULL` — exactly one `RETURNING` row
 * is possible across every caller, ever, for a given code. Returns null for
 * an unknown code, an already-consumed code, or an expired one; the caller
 * cannot tell which, which is deliberate — same "don't reveal why" posture
 * `src/auth/resolve.ts` and `get_product`/`get_order_status` already take.
 */
export async function consumeAuthCode(
  raw: string
): Promise<ConsumedAuthCode | null> {
  const row = await queryOne<AuthCodeRow>(
    `UPDATE oauth_auth_codes
        SET consumed_at = now()
      WHERE code_hash = $1
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING client_id, buyer_id, merchant_id, redirect_uri, code_challenge,
                resource, buyer_cap_paise`,
    [hashCode(raw)]
  );
  if (row === null) return null;
  return {
    clientId: row.client_id,
    buyerId: row.buyer_id,
    merchantId: row.merchant_id,
    redirectUri: row.redirect_uri,
    codeChallenge: row.code_challenge,
    resource: row.resource,
    buyerCapPaise: row.buyer_cap_paise,
  };
}
