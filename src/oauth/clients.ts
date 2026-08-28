/**
 * Dynamic Client Registration (RFC 7591) for MCP clients.
 *
 * MCP clients cannot pre-register by hand — a buyer's agent discovers this
 * server, discovers the authorization server, and registers itself on the
 * spot. Every registered client is a public client (no `client_secret`):
 * see the module comment in migrations/0004_oauth.sql for why PKCE, not a
 * shared secret, is this design's proof of continuity between /authorize
 * and /token.
 */
import { queryOne } from "../db/pool";

export interface OAuthClient {
  readonly id: string;
  readonly redirectUris: readonly string[];
  readonly clientName: string;
  readonly createdAt: Date;
}

interface OAuthClientRow {
  id: string;
  redirect_uris: string[];
  client_name: string;
  created_at: Date;
}

function toClient(row: OAuthClientRow): OAuthClient {
  return {
    id: row.id,
    redirectUris: row.redirect_uris,
    clientName: row.client_name,
    createdAt: row.created_at,
  };
}

function newClientId(): string {
  return `oc_${crypto.randomUUID().replace(/-/g, "")}`;
}

export class InvalidRedirectUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRedirectUriError";
  }
}

/**
 * A redirect_uri must be an absolute, non-fragment URI. Full loopback-IP and
 * HTTPS-only rules from RFC 8252 are intentionally NOT enforced here — this
 * is a demo authorization server, and refusing plain `http://` would also
 * refuse the exact local CLI clients this project's own README walks a
 * buyer through registering.
 */
function isPlausibleRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  return (
    (parsed.protocol === "http:" || parsed.protocol === "https:") &&
    parsed.hash === ""
  );
}

export async function registerClient(args: {
  redirectUris: readonly string[];
  clientName: string;
}): Promise<OAuthClient> {
  const redirectUris = args.redirectUris.map((u) => u.trim());
  if (redirectUris.length === 0) {
    throw new InvalidRedirectUriError(
      "redirect_uris must contain at least one URI."
    );
  }
  for (const uri of redirectUris) {
    if (!isPlausibleRedirectUri(uri)) {
      throw new InvalidRedirectUriError(`Invalid redirect_uri: ${uri}`);
    }
  }

  const clientName = args.clientName.trim();
  if (clientName.length === 0) {
    throw new Error("client_name must not be blank.");
  }

  const id = newClientId();
  const row = await queryOne<OAuthClientRow>(
    `INSERT INTO oauth_clients (id, redirect_uris, client_name)
     VALUES ($1, $2, $3)
     RETURNING id, redirect_uris, client_name, created_at`,
    [id, redirectUris, clientName]
  );
  if (row === null) {
    throw new Error(`insert into oauth_clients returned no row for ${id}`);
  }
  return toClient(row);
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
  const row = await queryOne<OAuthClientRow>(
    "SELECT id, redirect_uris, client_name, created_at FROM oauth_clients WHERE id = $1",
    [clientId]
  );
  return row === null ? null : toClient(row);
}

/**
 * Exact string equality against the registered set — no prefix, no
 * wildcard, no path-normalisation. A registered
 * "https://client.example/cb" does not authorise
 * "https://client.example/cb/evil" or "https://client.example/CB".
 */
export function isRegisteredRedirectUri(
  client: OAuthClient,
  redirectUri: string
): boolean {
  return client.redirectUris.includes(redirectUri);
}
