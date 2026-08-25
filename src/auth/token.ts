/**
 * Bearer-token minting and verification for agent credentials.
 *
 * Why this design needs no timing-safe *string comparison* to be secure:
 * the raw token is 32 bytes of CSPRNG output (256 bits of entropy), we never
 * store or compare it directly, and lookup of the SHA-256 digest happens as
 * one indexed equality predicate inside Postgres (`WHERE token_hash = $1`).
 * There is no branch in application code whose timing depends on how many
 * leading bytes of a guess matched the secret, because the "comparison" is a
 * B-tree/hash index lookup on a value an attacker cannot feasibly enumerate
 * (guessing the digest requires guessing the 256-bit raw token first). That
 * is the actual defence. `hashesEqual` below exists as a belt-and-braces
 * post-fetch assertion, not as the thing making this safe.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface MintedToken {
  readonly raw: string;
  readonly hash: string;
}

const TOKEN_PREFIX = "dk_";
const TOKEN_ENTROPY_BYTES = 32;
const HEX_DIGEST_RE = /^[0-9a-f]{64}$/;

/** raw = `dk_<43 chars base64url>` — 32 random bytes, base64url has no padding. */
export function mintAgentToken(): MintedToken {
  const raw = `${TOKEN_PREFIX}${randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url")}`;
  return { raw, hash: hashToken(raw) };
}

/** sha256 hex digest, always 64 lowercase hex chars. */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

/**
 * Post-fetch sanity check that two hex digests match, using a constant-time
 * byte comparison so this function itself never becomes a timing channel.
 * See the module comment: the real safety property comes from indexed
 * lookup on high-entropy input, not from this function.
 */
export function hashesEqual(a: string, b: string): boolean {
  if (!HEX_DIGEST_RE.test(a) || !HEX_DIGEST_RE.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Extracts the token from `Authorization: Bearer <token>`, else null. */
export function parseBearer(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const match = /^Bearer\s+(.+)$/.exec(header.trim());
  if (match === null) return null;
  const token = match[1];
  if (token === undefined) return null;
  const trimmed = token.trim();
  return trimmed === "" ? null : trimmed;
}
