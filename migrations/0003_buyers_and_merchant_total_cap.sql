-- 0003_buyers_and_merchant_total_cap.sql
--
-- Makes provisioning self-service, and closes the exposure hole that going
-- multi-buyer would otherwise open.
--
-- WHY THIS EXISTS. Until now a merchant minted exactly one agent during
-- onboarding and handed that token to one buyer out of band. That is O(buyers)
-- manual work for the merchant and does not survive contact with a merchant who
-- has more than a handful of them, let alone millions. Buyers now register on
-- the platform, browse merchants and mint their own agent per merchant, so the
-- merchant never touches an individual buyer.
--
-- The per-agent machinery this leans on already existed: spend accrues over
-- (merchant_id, agent_id, window), buyer caps live on the agent row, and orders
-- and audit events are already agent-scoped. `agents.merchant_id` never had a
-- unique constraint, so many agents per merchant needs no structural change.
-- What was missing was a buyer to own them and a bound on the total.

CREATE TABLE buyers (
    id            TEXT        PRIMARY KEY CHECK (id ~ '^b_[a-z0-9_]{1,48}$'),
    email         TEXT        NOT NULL UNIQUE
                              CHECK (position('@' IN email) > 1
                                     AND length(btrim(email)) = length(email)),
    -- An argon2id string from Bun.password.hash, never a plaintext password and
    -- never a bare digest. Length is not constrained because the encoded form
    -- carries its own parameters and those change with the runtime's defaults.
    password_hash TEXT        NOT NULL CHECK (length(password_hash) > 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Session tokens are stored as a SHA-256 only, exactly like `agents.token_hash`:
-- the plaintext exists in the buyer's cookie and nowhere else, so a database
-- read cannot impersonate anyone.
CREATE TABLE buyer_sessions (
    token_hash CHAR(64)    PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    buyer_id   TEXT        NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    CONSTRAINT buyer_session_expires_after_creation
        CHECK (expires_at > created_at)
);
CREATE INDEX idx_buyer_sessions_buyer ON buyer_sessions (buyer_id, expires_at DESC);

-- Which buyer owns an agent. NULL means "minted by the merchant during
-- onboarding", which is every row that predates this migration and remains a
-- legitimate shape: a merchant testing their own store still wants a token.
-- Deliberately no NOT NULL and no default, so nothing existing changes meaning.
ALTER TABLE agents
    ADD COLUMN buyer_id TEXT NULL REFERENCES buyers(id) ON DELETE CASCADE;

-- One agent per buyer per merchant. Partial, so the many merchant-minted rows
-- with a NULL buyer_id are unaffected. This makes "connect" naturally
-- idempotent: a buyer who clicks twice cannot end up with two budgets at one
-- store, which would quietly double their own cap.
CREATE UNIQUE INDEX idx_agents_buyer_merchant
    ON agents (buyer_id, merchant_id)
    WHERE buyer_id IS NOT NULL;

-- The merchant's exposure across EVERY agent, which the per-agent cap cannot
-- bound. `policies.spend_cap_paise` is applied to each agent separately, so with
-- N buyers a merchant's real exposure was N x cap — at any interesting number of
-- buyers that is not an exposure limit at all, and self-service issuance would
-- have turned it into a faucet.
--
-- NULL means no aggregate constraint, which is the pre-existing behaviour, so
-- every already-scored transcript decides exactly as before. That matters: the
-- eval's holdout split is frozen and gets exactly one scored run, and a
-- non-null default here would have moved published numbers.
ALTER TABLE policies
    ADD COLUMN merchant_total_cap_paise BIGINT NULL
        CHECK (merchant_total_cap_paise > 0);

-- Supports the aggregate sum: all of one merchant's orders in a window,
-- regardless of agent. The existing idx_orders_spend_cap is (merchant_id,
-- agent_id, ...) so it cannot serve a query that deliberately ignores agent_id.
CREATE INDEX idx_orders_merchant_window
    ON orders (merchant_id, created_at DESC)
    WHERE status IN ('created', 'authorized');
