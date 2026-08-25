/**
 * Turns a raw Authorization header into a `TenantContext`, the only place
 * merchant_id/agent_id enter the system downstream of the transport layer.
 * Never derived from a tool argument — see the TenantContext doc comment in
 * contracts.ts for why.
 */
import { randomBytes } from "node:crypto";
import type { TenantContext, UnauthenticatedError } from "@/shared/contracts";
import { query } from "../db/pool";
import { hashToken, hashesEqual, parseBearer } from "./token";

export type ResolveResult =
  | { readonly ok: true; readonly ctx: TenantContext }
  | { readonly ok: false; readonly error: UnauthenticatedError };

interface AgentTokenRow {
  id: string;
  merchant_id: string;
  token_hash: string;
}

const WWW_AUTHENTICATE = 'Bearer realm="dukaan-mcp"';

function unauthenticated(message: string): ResolveResult {
  return {
    ok: false,
    error: {
      reason_code: "UNAUTHENTICATED",
      message,
      www_authenticate: WWW_AUTHENTICATE,
    },
  };
}

/**
 * MCP transport session ids are not this unit's concern. When the caller
 * has not already established one, mint a fresh opaque id matching the
 * sessions.id shape so `TenantRepo.ensureSession()` can create the row.
 */
function freshSessionId(): string {
  return `s_${randomBytes(16).toString("base64url")}`;
}

export async function resolveTenant(
  authorizationHeader: string | null | undefined,
  sessionId: string | null
): Promise<ResolveResult> {
  const raw = parseBearer(authorizationHeader);
  if (raw === null) {
    return unauthenticated(
      'Missing or malformed Authorization header. Expected "Bearer <token>".'
    );
  }

  const digest = hashToken(raw);
  const rows = await query<AgentTokenRow>(
    "SELECT id, merchant_id, token_hash FROM agents WHERE token_hash = $1",
    [digest]
  );
  const agent = rows[0];
  if (agent === undefined) {
    return unauthenticated("Token not recognized.");
  }

  // Belt-and-braces re-check — see token.ts for why this is not what makes
  // the lookup above safe.
  if (!hashesEqual(agent.token_hash, digest)) {
    return unauthenticated("Token not recognized.");
  }

  return {
    ok: true,
    ctx: {
      merchant_id: agent.merchant_id,
      agent_id: agent.id,
      session_id: sessionId ?? freshSessionId(),
    },
  };
}
