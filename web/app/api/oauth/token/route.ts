/**
 * OAuth 2.1 token endpoint. Authorization code + PKCE only — no refresh
 * grant, no client secret (this AS registers only public clients; see
 * migrations/0004_oauth.sql). The whole point of this design: on success it
 * returns the exact `dk_...` agent token `provisionAgentForBuyer`
 * (src/buyer/provision.ts) mints, so src/auth/resolve.ts needs no new
 * validation path — it already accepts this token.
 */
import "../../../../lib/assert-server-only";
import {
  getClient,
  isRegisteredRedirectUri,
} from "../../../../../src/oauth/clients";
import { consumeAuthCode, verifyPkce } from "../../../../../src/oauth/codes";
import { mcpResourceUrl } from "../../../../../src/oauth/urls";
import {
  AlreadyConnectedError,
  provisionAgentForBuyer,
} from "../../../../../src/buyer/provision";

function oauthError(
  error: string,
  description: string,
  status = 400
): Response {
  return Response.json({ error, error_description: description }, { status });
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const body = (await req.json()) as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === "string") params.set(key, value);
    }
    return params;
  }
  // RFC 6749 4.1.3 mandates application/x-www-form-urlencoded; this is the
  // primary path every real OAuth client uses.
  return new URLSearchParams(await req.text());
}

export async function POST(req: Request): Promise<Response> {
  const params = await readParams(req);

  const grantType = params.get("grant_type");
  if (grantType !== "authorization_code") {
    return oauthError(
      "unsupported_grant_type",
      'Only "authorization_code" is supported — no refresh token, no client credentials, no password grant.'
    );
  }

  const code = params.get("code");
  const redirectUri = params.get("redirect_uri");
  const clientId = params.get("client_id");
  const codeVerifier = params.get("code_verifier");
  if (
    code === null ||
    redirectUri === null ||
    clientId === null ||
    codeVerifier === null
  ) {
    return oauthError(
      "invalid_request",
      "code, redirect_uri, client_id, and code_verifier are all required."
    );
  }

  // Single atomic check-and-consume. A replay of an already-exchanged code,
  // or a code that never existed, or one past its 60-second TTL, all land
  // here indistinguishably as "invalid_grant" — never revealing which.
  const consumed = await consumeAuthCode(code);
  if (consumed === null) {
    return oauthError(
      "invalid_grant",
      "This authorization code is invalid, expired, or has already been used."
    );
  }

  const client = await getClient(clientId);
  if (
    client === null ||
    client.id !== consumed.clientId ||
    !isRegisteredRedirectUri(client, redirectUri) ||
    redirectUri !== consumed.redirectUri
  ) {
    return oauthError(
      "invalid_grant",
      "client_id or redirect_uri does not match the authorization request this code was issued for."
    );
  }

  const requestedResource = params.get("resource") ?? mcpResourceUrl();
  if (requestedResource !== consumed.resource) {
    return oauthError(
      "invalid_target",
      "resource does not match the one this code was bound to."
    );
  }

  if (!verifyPkce(codeVerifier, consumed.codeChallenge)) {
    return oauthError(
      "invalid_grant",
      "code_verifier does not match the code_challenge presented at /authorize."
    );
  }

  try {
    const result = await provisionAgentForBuyer({
      buyerId: consumed.buyerId,
      merchantId: consumed.merchantId,
      label: `oauth-${client.id}`,
      buyerCapPaise: consumed.buyerCapPaise,
    });
    return Response.json({
      access_token: result.token,
      token_type: "Bearer",
      resource: mcpResourceUrl(),
    });
  } catch (err) {
    if (err instanceof AlreadyConnectedError) {
      // The buyer connected to this merchant through some other path
      // (the paste-a-token flow, or a second OAuth client) between consent
      // and this exchange. There is no existing raw token to hand back —
      // only its hash is ever stored, by design (see src/auth/token.ts) —
      // so the honest answer is failure, not a stale or fabricated token.
      return oauthError(
        "invalid_grant",
        "Already connected to this merchant through another agent."
      );
    }
    throw err;
  }
}
