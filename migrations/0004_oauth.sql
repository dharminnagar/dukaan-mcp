-- 0004_oauth.sql
--
-- OAuth 2.1 discoverable front door onto the existing agent-token machinery
-- (DUK-35). No new credential format: the access token this issues IS the
-- `dk_...` token `provisionAgentForBuyer` already mints (src/buyer/provision.ts),
-- so `src/auth/resolve.ts` validates it completely unchanged. What was missing
-- was (a) somewhere to record a dynamically-registered MCP client, since these
-- clients cannot pre-register by hand, and (b) somewhere to hold a short-lived
-- authorization code between `/authorize` and `/token` without ever storing it
-- (or the PKCE verifier) in the clear.
--
-- WHY NO client_secret. Every MCP client here is a "public client" in RFC 6749
-- terms — a CLI/desktop agent with no secure place to hold a secret — so this
-- is OAuth 2.1's confidential-client story minus the part that does not apply.
-- PKCE (RFC 7636, S256 only) is what stands in for a client secret: possession
-- of `code_verifier` is the proof of continuity between `/authorize` and
-- `/token`, not a shared secret baked into the client at registration time.
--
-- WHY code_challenge_method IS A CHECK, NOT AN APP-LAYER `if`. OAuth 2.1
-- deprecates the `plain` PKCE method precisely because it offers no
-- protection (challenge == verifier, so an intercepted authorization request
-- alone is enough to redeem the code). Rather than trust every call site to
-- reject `plain` forever, the column only has one legal value. A row that
-- would represent an accepted `plain` challenge cannot exist in this table.
--
-- WHY THE CODE IS STORED HASHED. Mirrors `agents.token_hash` and
-- `buyer_sessions.token_hash`: the raw authorization code exists only in the
-- redirect URL and the client's exchange request, never at rest. A database
-- read (backup, replica, careless log) is not enough to redeem someone else's
-- code.
--
-- WHY consumed_at IS A NULLABLE TIMESTAMP, NOT A BOOLEAN. `/token` marks it in
-- the same statement that checks it is still NULL (`UPDATE ... WHERE
-- consumed_at IS NULL RETURNING *`), so the check-and-mark is one atomic
-- write and two concurrent redemption attempts cannot both see "unconsumed".
-- The timestamp is also an audit fact (when was this redeemed) that a
-- boolean would throw away for free.

CREATE TABLE oauth_clients (
    id            TEXT        PRIMARY KEY CHECK (id ~ '^oc_[a-z0-9]{1,64}$'),
    -- RFC 7591 dynamic registration: whatever redirect URIs the client
    -- declared at registration time. `/authorize` and `/token` both check
    -- the caller's redirect_uri against this array with exact string
    -- equality — never a prefix or wildcard match, so a registered
    -- "https://client.example/cb" does not also authorise
    -- "https://client.example/cb/evil".
    redirect_uris TEXT[]      NOT NULL CHECK (cardinality(redirect_uris) > 0
                                               AND NOT ('' = ANY (redirect_uris))),
    client_name   TEXT        NOT NULL CHECK (length(btrim(client_name)) > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_auth_codes (
    -- SHA-256 of the raw authorization code, same shape as agents.token_hash.
    code_hash             CHAR(64)    PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    client_id             TEXT        NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
    buyer_id              TEXT        NOT NULL REFERENCES buyers(id)       ON DELETE CASCADE,
    merchant_id           TEXT        NOT NULL REFERENCES merchants(id)    ON DELETE CASCADE,
    -- The exact redirect_uri presented to /authorize for THIS code, so /token
    -- can require the exchange to repeat it (RFC 6749 4.1.3) rather than
    -- trusting the registration row a second time.
    redirect_uri          TEXT        NOT NULL CHECK (length(btrim(redirect_uri)) > 0),
    -- Base64url(SHA-256(code_verifier)) per RFC 7636 — 43 chars with no
    -- padding for a real S256 challenge; the range leaves headroom without
    -- accepting garbage.
    code_challenge        TEXT        NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43,128}$'),
    -- The one legal value. See module comment: this is what makes "plain"
    -- unrepresentable rather than merely rejected in application code.
    code_challenge_method TEXT        NOT NULL CHECK (code_challenge_method = 'S256'),
    -- RFC 8707 resource indicator this code (and the token minted from it)
    -- is bound to. Required, not optional: a code with no resource could be
    -- redeemed against any downstream resource server that trusts this AS.
    resource              TEXT        NOT NULL CHECK (length(btrim(resource)) > 0),
    -- The buyer's chosen spend cap for the agent /token will mint, carried
    -- from the /authorize consent screen through to the exchange. NULL means
    -- no buyer-set cap, exactly like agents.buyer_cap_paise (migration 0002)
    -- — this column is NOT that column, it is where the same choice waits
    -- until the code is redeemed.
    buyer_cap_paise       BIGINT      NULL CHECK (buyer_cap_paise > 0),
    expires_at            TIMESTAMPTZ NOT NULL,
    -- NULL = unconsumed. See module comment for why this is a timestamp, not
    -- a boolean, and why /token's UPDATE is what makes single-use atomic.
    consumed_at           TIMESTAMPTZ NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT oauth_code_expires_after_creation
        CHECK (expires_at > created_at),
    CONSTRAINT oauth_code_consumed_after_creation
        CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

-- /token's redemption query is an equality lookup on code_hash (the primary
-- key) alone, so no extra index is needed there. This one supports the one
-- other access pattern: cleaning up or auditing a client's issued codes.
CREATE INDEX idx_oauth_auth_codes_client ON oauth_auth_codes (client_id, created_at DESC);
