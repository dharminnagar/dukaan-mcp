/**
 * OAuth Authorization Server Metadata (RFC 8414). The one thing an MCP
 * client needs after reading `/.well-known/oauth-protected-resource` off the
 * resource server (src/mcp/http.ts): where to register, authorize, and
 * redeem a token. Public discovery data — no auth, matches the resource
 * server's own well-known route.
 */
import {
  authServerBaseUrl,
  authorizationEndpoint,
  registrationEndpoint,
  tokenEndpoint,
} from "../../../../src/oauth/urls";

export function GET(): Response {
  return Response.json({
    issuer: authServerBaseUrl(),
    authorization_endpoint: authorizationEndpoint(),
    token_endpoint: tokenEndpoint(),
    registration_endpoint: registrationEndpoint(),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  });
}
