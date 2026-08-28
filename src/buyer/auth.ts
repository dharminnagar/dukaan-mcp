/**
 * Buyer registration, login, and session verification.
 *
 * Mirrors `src/auth/token.ts` deliberately: a session's plaintext token
 * lives ONLY in the buyer's cookie, and `buyer_sessions.token_hash` stores
 * its SHA-256 — a database read is not enough to impersonate a buyer,
 * exactly like `agents.token_hash`.
 *
 * Password hashing goes through `Bun.password.hash` / `Bun.password.verify`
 * (argon2id by default) — never a bare digest, never plaintext.
 */
import { createHash, randomBytes } from "node:crypto";
import { query, queryOne } from "../db/pool";

export interface Buyer {
  readonly id: string;
  readonly email: string;
  readonly created_at: Date;
}

export interface MintedSession {
  readonly raw: string;
  readonly hash: string;
  readonly expiresAt: Date;
}

/** Name of the httpOnly cookie carrying the raw session token. Shared with web/. */
export const SESSION_COOKIE_NAME = "buyer_session";

const SESSION_ENTROPY_BYTES = 32;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const SESSION_PREFIX = "bs_";

/**
 * True when `err` is a Postgres unique-violation (SQLSTATE 23505), matched on
 * the code rather than message text so it survives a locale/version change —
 * same reasoning as `web/app/actions.ts`'s duplicate-merchant-name handling.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

/** Lowercases and trims: the schema's CHECK rejects untrimmed email outright. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSessionToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function mintSessionToken(): { raw: string; hash: string } {
  const raw = `${SESSION_PREFIX}${randomBytes(SESSION_ENTROPY_BYTES).toString("base64url")}`;
  return { raw, hash: hashSessionToken(raw) };
}

function newBuyerId(): string {
  return `b_${crypto.randomUUID().replace(/-/g, "")}`;
}

export class DuplicateEmailError extends Error {
  constructor(email: string) {
    super(`An account with the email ${email} already exists.`);
    this.name = "DuplicateEmailError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid email or password.");
    this.name = "InvalidCredentialsError";
  }
}

/**
 * Registers a buyer and returns a freshly minted session for them — register
 * signs you in, matching how the merchant-onboarding flow hands back a
 * usable credential in the same call rather than a second round trip.
 */
export async function registerBuyer(
  emailInput: string,
  password: string
): Promise<{ buyer: Buyer; session: MintedSession }> {
  const email = normalizeEmail(emailInput);
  if (!email.includes("@") || email.length < 3) {
    throw new Error("Enter a valid email address.");
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.");
  }

  const passwordHash = await Bun.password.hash(password);
  const buyerId = newBuyerId();

  let buyer: Buyer;
  try {
    const row = await queryOne<Buyer>(
      `INSERT INTO buyers (id, email, password_hash) VALUES ($1, $2, $3)
       RETURNING id, email, created_at`,
      [buyerId, email, passwordHash]
    );
    if (row === null) {
      throw new Error(`insert into buyers returned no row for ${buyerId}`);
    }
    buyer = row;
  } catch (err) {
    if (isUniqueViolation(err)) throw new DuplicateEmailError(email);
    throw err;
  }

  const session = await createSession(buyer.id);
  return { buyer, session };
}

/** Verifies a password against the stored argon2id hash and mints a session. */
export async function loginBuyer(
  emailInput: string,
  password: string
): Promise<{ buyer: Buyer; session: MintedSession }> {
  const email = normalizeEmail(emailInput);
  const row = await queryOne<{
    id: string;
    email: string;
    password_hash: string;
    created_at: Date;
  }>(
    "SELECT id, email, password_hash, created_at FROM buyers WHERE email = $1",
    [email]
  );
  if (row === null) throw new InvalidCredentialsError();

  const valid = await Bun.password.verify(password, row.password_hash);
  if (!valid) throw new InvalidCredentialsError();

  const session = await createSession(row.id);
  return {
    buyer: { id: row.id, email: row.email, created_at: row.created_at },
    session,
  };
}

async function createSession(buyerId: string): Promise<MintedSession> {
  const { raw, hash } = mintSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    "INSERT INTO buyer_sessions (token_hash, buyer_id, expires_at) VALUES ($1, $2, $3)",
    [hash, buyerId, expiresAt]
  );
  return { raw, hash, expiresAt };
}

/** Deletes a session by its raw token. Never throws for an unknown token. */
export async function logoutBuyer(rawToken: string): Promise<void> {
  await query("DELETE FROM buyer_sessions WHERE token_hash = $1", [
    hashSessionToken(rawToken),
  ]);
}

/**
 * Resolves a raw session token to the buyer it belongs to, rejecting an
 * expired session at read time rather than relying on a cleanup job.
 */
export async function getBuyerForSession(
  rawToken: string | undefined | null
): Promise<Buyer | null> {
  if (rawToken === undefined || rawToken === null || rawToken.trim() === "") {
    return null;
  }
  const row = await queryOne<Buyer>(
    `SELECT b.id, b.email, b.created_at
       FROM buyer_sessions s
       JOIN buyers b ON b.id = s.buyer_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [hashSessionToken(rawToken)]
  );
  return row;
}
