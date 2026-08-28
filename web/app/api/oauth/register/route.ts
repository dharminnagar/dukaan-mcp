/**
 * RFC 7591 Dynamic Client Registration. The reason this exists at all: MCP
 * clients cannot be pre-registered by a human before first use, so this
 * endpoint is the only "signup" a client ever does, and it does it itself,
 * unauthenticated, the first time it talks to this authorization server.
 *
 * Every client registered here is public (no `client_secret` issued) — see
 * migrations/0004_oauth.sql's module comment for why PKCE stands in for a
 * client secret in this design.
 */
import "../../../../lib/assert-server-only";
import {
  InvalidRedirectUriError,
  registerClient,
} from "../../../../../src/oauth/clients";

interface RegisterRequestBody {
  readonly redirect_uris?: unknown;
  readonly client_name?: unknown;
}

function badRequest(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400 }
  );
}

export async function POST(req: Request): Promise<Response> {
  let body: RegisterRequestBody;
  try {
    body = (await req.json()) as RegisterRequestBody;
  } catch {
    return badRequest("invalid_request", "Request body must be JSON.");
  }

  const redirectUris = body.redirect_uris;
  if (
    !Array.isArray(redirectUris) ||
    redirectUris.length === 0 ||
    !redirectUris.every((u): u is string => typeof u === "string")
  ) {
    return badRequest(
      "invalid_redirect_uri",
      "redirect_uris must be a non-empty array of strings."
    );
  }

  const clientName =
    typeof body.client_name === "string" && body.client_name.trim() !== ""
      ? body.client_name
      : "Unnamed MCP client";

  try {
    const client = await registerClient({ redirectUris, clientName });
    return Response.json(
      {
        client_id: client.id,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code"],
        response_types: ["code"],
        client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof InvalidRedirectUriError) {
      return badRequest("invalid_redirect_uri", err.message);
    }
    throw err;
  }
}
