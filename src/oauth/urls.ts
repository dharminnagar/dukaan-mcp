/**
 * Deliberately dependency-free (no `src/config.ts`, no `pg`): this module is
 * imported from BOTH the MCP server (src/mcp/http.ts, src/auth/resolve.ts)
 * and the Next app (web/app/.well-known/**, web/app/oauth/**,
 * web/app/api/oauth/**). Importing src/config.ts from a Next route throws at
 * module load if DATABASE_URL is unset in that process's env — see the
 * "Gotchas" in this ticket's brief — and this module's only job is naming
 * URLs, which needs no database.
 *
 * Every value here has a `127.0.0.1`-based default so a fresh clone's
 * `bun run db:migrate` / `bun test` / `bun run eval` never depend on any of
 * these env vars being set.
 */

function readEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

/** Strips a trailing slash so callers can safely template `${base}/path`. */
function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * The resource server's own base URL (the MCP server, port 8787 by default).
 * `MCP_PUBLIC_URL`, when set, is the full `/mcp` endpoint URL (matching
 * `web/lib/buyer-actions.ts`'s existing use of that var) — strip the
 * trailing `/mcp` to get the base other well-known paths hang off of.
 */
export function mcpBaseUrl(): string {
  const publicUrl = process.env["MCP_PUBLIC_URL"];
  if (publicUrl !== undefined && publicUrl.trim() !== "") {
    const trimmed = stripTrailingSlash(publicUrl.trim());
    return trimmed.endsWith("/mcp")
      ? trimmed.slice(0, -"/mcp".length)
      : trimmed;
  }
  const host = readEnv("MCP_HOST", "127.0.0.1");
  const port = readEnv("MCP_PORT", "8787");
  return `http://${host}:${port}`;
}

export function mcpResourceUrl(): string {
  return `${mcpBaseUrl()}/mcp`;
}

export function mcpProtectedResourceMetadataUrl(): string {
  return `${mcpBaseUrl()}/.well-known/oauth-protected-resource`;
}

/** The authorization server's base URL — the Next app, port 3000 by default. */
export function authServerBaseUrl(): string {
  return stripTrailingSlash(
    readEnv("OAUTH_AUTHORIZATION_SERVER_URL", "http://127.0.0.1:3000")
  );
}

export function authServerMetadataUrl(): string {
  return `${authServerBaseUrl()}/.well-known/oauth-authorization-server`;
}

export function authorizationEndpoint(): string {
  return `${authServerBaseUrl()}/oauth/authorize`;
}

export function tokenEndpoint(): string {
  return `${authServerBaseUrl()}/api/oauth/token`;
}

export function registrationEndpoint(): string {
  return `${authServerBaseUrl()}/api/oauth/register`;
}
