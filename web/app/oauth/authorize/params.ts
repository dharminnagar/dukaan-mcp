/**
 * Pure parsing/validation of an /authorize request's query string. Split out
 * from page.tsx so it can be exercised directly in `bun:test` without
 * rendering React — matches how `web/lib/mapping.ts` separates pure logic
 * from `web/app/actions.ts`.
 */
import { mcpResourceUrl } from "../../../../src/oauth/urls";

export interface AuthorizeRequest {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly state: string | null;
}

export type ParseAuthorizeResult =
  | { readonly ok: true; readonly request: AuthorizeRequest }
  | { readonly ok: false; readonly error: string };

type RawSearchParams = Record<string, string | string[] | undefined>;

function single(v: string | string[] | undefined): string | null {
  if (v === undefined) return null;
  const value = Array.isArray(v) ? v[0] : v;
  return value !== undefined && value.trim() !== "" ? value.trim() : null;
}

/**
 * Authorization code flow only (OAuth 2.1 drops implicit and password
 * grants) — `response_type` must be exactly `code`. PKCE is mandatory and
 * S256-only: a missing `code_challenge`, a missing
 * `code_challenge_method`, or `code_challenge_method=plain` all fail here,
 * before any code is ever minted.
 */
export function parseAuthorizeParams(
  searchParams: RawSearchParams
): ParseAuthorizeResult {
  const responseType = single(searchParams["response_type"]);
  if (responseType !== "code") {
    return {
      ok: false,
      error: `Unsupported response_type ${JSON.stringify(responseType)}. Only "code" (authorization code flow) is supported.`,
    };
  }

  const clientId = single(searchParams["client_id"]);
  if (clientId === null) {
    return { ok: false, error: "Missing client_id." };
  }

  const redirectUri = single(searchParams["redirect_uri"]);
  if (redirectUri === null) {
    return { ok: false, error: "Missing redirect_uri." };
  }

  const codeChallengeMethod = single(searchParams["code_challenge_method"]);
  if (codeChallengeMethod !== "S256") {
    return {
      ok: false,
      error:
        codeChallengeMethod === null
          ? "Missing code_challenge_method. PKCE is mandatory: pass code_challenge_method=S256."
          : `Unsupported code_challenge_method ${JSON.stringify(codeChallengeMethod)}. Only "S256" is supported — "plain" offers no protection and is rejected.`,
    };
  }

  const codeChallenge = single(searchParams["code_challenge"]);
  if (
    codeChallenge === null ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(codeChallenge)
  ) {
    return {
      ok: false,
      error:
        "Missing or malformed code_challenge (expected 43-128 base64url characters).",
    };
  }

  // RFC 8707 resource indicator. This authorization server serves exactly
  // one resource server, so an explicit `resource` must name it exactly;
  // omitting it defaults to that same resource server rather than issuing
  // an unscoped token.
  const resource = single(searchParams["resource"]) ?? mcpResourceUrl();
  if (resource !== mcpResourceUrl()) {
    return {
      ok: false,
      error: `Unknown resource ${JSON.stringify(resource)}. This authorization server only issues tokens for ${mcpResourceUrl()}.`,
    };
  }

  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      codeChallenge,
      resource,
      state: single(searchParams["state"]),
    },
  };
}
