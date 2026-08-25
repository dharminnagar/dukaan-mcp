/**
 * Turns a raw Authorization header into a `TenantContext`, the only place
 * merchant_id/agent_id enter the system downstream of the transport layer.
 * Never derived from a tool argument — see the TenantContext doc comment in
 * contracts.ts for why.
 *
 * SESSION ID RESOLUTION (DUK-28): `createMcpHandler` builds a fresh server
 * for every request and retains no state between requests, so there is no
 * protocol-level session for a client to have joined and nothing here ever
 * issues an `Mcp-Session-Id` for a client to echo back. A client that never
 * sends its own `mcp-session-id` header (the default for most clients) used
 * to get a fresh, unrelated session_id on every call, scattering one
 * shopping session's audit trail across N unlinked rows — the defect this
 * ticket exists to fix.
 *
 * We deliberately do NOT make the transport stateful to solve this. That
 * would mean replacing `createMcpHandler` with per-session
 * `NodeStreamableHTTPServerTransport` instances plus a session→transport
 * map, which would resolve the tenant ONCE at initialize and hold it for
 * the session's lifetime — a revoked token would keep working until the
 * session closed, instead of being re-checked on every request as it is
 * today. Trading away per-request re-auth for this is not worth it.
 *
 * Instead: when no `mcp-session-id` header is supplied, reuse the most
 * recent session row for this exact (merchant_id, agent_id) if it started
 * within SESSION_REUSE_WINDOW_SECONDS (a lookup, not a time-bucket hash —
 * see `findReusableSessionId`), else mint a fresh id.
 *
 * WHY THIS IS SAFE HERE, AND ONLY HERE: session_id is display and
 * audit-grouping only, NEVER an enforcement key. The spend cap is scoped to
 * (merchant_id, agent_id, window) — see `SPEND_CAP_SQL` in src/db/repo.ts,
 * which is shaped the way it is precisely because an earlier draft of this
 * project scoped the cap to session_id and let an agent reset its budget by
 * opening a new session (projectmem issue #0009). Because enforcement never
 * reads session_id, two genuinely separate shopping sessions merging into
 * one audit group changes nothing about what gets allowed, blocked, or
 * escalated — only how the trail displays. That is exactly why the same
 * trick would be unacceptable for the spend cap and is acceptable here.
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

interface RecentSessionRow {
  id: string;
}

const WWW_AUTHENTICATE = 'Bearer realm="dukaan-mcp"';

/**
 * How long a session with no explicit `mcp-session-id` stays "current" for
 * a given (merchant_id, agent_id) before the next call starts a new one.
 * 30 minutes comfortably covers one shopping session (browse, checkout,
 * confirm) while still splitting genuinely distinct visits apart. The
 * trade-off is entirely about audit-trail readability — see the module
 * comment for why session_id grouping has no enforcement consequence.
 */
const SESSION_REUSE_WINDOW_SECONDS = 30 * 60;

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

/**
 * Most-recent-session-within-window lookup, NOT a `floor(now / window)`
 * time bucket: a bucket boundary would split a session that straddles it
 * (a hero session starting at 10:29:50 would land its first call in one
 * bucket and its next call, seconds later, in the next) even though the
 * two calls belong to the same visit — precisely the failure this ticket
 * exists to fix. Ordering by started_at DESC and taking the top row has no
 * boundary artifact: any two calls less than SESSION_REUSE_WINDOW_SECONDS
 * apart always see the same "most recent" row.
 *
 * Equality on (merchant_id, agent_id) then ORDER BY started_at DESC LIMIT 1
 * is exactly what `idx_sessions_merchant_agent (merchant_id, agent_id,
 * started_at DESC)` (migrations/0001_init.sql) is shaped for.
 */
async function findReusableSessionId(
  merchantId: string,
  agentId: string
): Promise<string | null> {
  const rows = await query<RecentSessionRow>(
    `SELECT id FROM sessions
      WHERE merchant_id = $1
        AND agent_id = $2
        AND started_at >= now() - make_interval(secs => $3::int)
      ORDER BY started_at DESC
      LIMIT 1`,
    [merchantId, agentId, SESSION_REUSE_WINDOW_SECONDS]
  );
  return rows[0]?.id ?? null;
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

  const resolvedSessionId =
    sessionId ??
    (await findReusableSessionId(agent.merchant_id, agent.id)) ??
    freshSessionId();

  return {
    ok: true,
    ctx: {
      merchant_id: agent.merchant_id,
      agent_id: agent.id,
      session_id: resolvedSessionId,
    },
  };
}
