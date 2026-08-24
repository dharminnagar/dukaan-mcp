-- 0001_init.sql
-- Seven domain tables. _migrations is created by the runner, not here.
-- Money is BIGINT paise everywhere, always with a _paise suffix.

CREATE TABLE merchants (
    id          TEXT        PRIMARY KEY CHECK (id ~ '^m_[a-z0-9_]{1,48}$'),
    name        TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE policies (
    merchant_id              TEXT        PRIMARY KEY
                                         REFERENCES merchants(id) ON DELETE CASCADE,
    spend_cap_paise          BIGINT      NOT NULL CHECK (spend_cap_paise > 0),
    approval_threshold_paise BIGINT      NOT NULL CHECK (approval_threshold_paise > 0),
    category_allowlist       TEXT[]      NOT NULL,
    window_seconds           INTEGER     NOT NULL CHECK (window_seconds > 0),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT policy_threshold_reachable
        CHECK (approval_threshold_paise <= spend_cap_paise),
    CONSTRAINT policy_allowlist_non_empty
        CHECK (cardinality(category_allowlist) > 0),
    CONSTRAINT policy_allowlist_no_blanks
        CHECK (NOT ('' = ANY (category_allowlist)))
);

CREATE TABLE products (
    merchant_id  TEXT        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    id           TEXT        NOT NULL CHECK (length(btrim(id)) > 0),
    name         TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
    price_paise  BIGINT      NOT NULL CHECK (price_paise > 0),
    stock        INTEGER     NOT NULL CHECK (stock >= 0),
    category     TEXT        NOT NULL CHECK (length(btrim(category)) > 0),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (merchant_id, id)
);

CREATE INDEX idx_products_merchant_category ON products (merchant_id, category);

CREATE TABLE agents (
    id          TEXT        PRIMARY KEY CHECK (id ~ '^ag_[a-z0-9_]{1,48}$'),
    merchant_id TEXT        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    label       TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
    token_hash  CHAR(64)    NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_agents_merchant ON agents (merchant_id);

-- session_id is for audit grouping and display ONLY. Never an enforcement key.
CREATE TABLE sessions (
    id          TEXT        PRIMARY KEY CHECK (id ~ '^s_[a-zA-Z0-9_-]{1,64}$'),
    merchant_id TEXT        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    agent_id    TEXT        NOT NULL REFERENCES agents(id)    ON DELETE CASCADE,
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_merchant_agent ON sessions (merchant_id, agent_id, started_at DESC);

-- Rows written on allow and escalate only, never on block.
CREATE TABLE orders (
    id                TEXT        PRIMARY KEY CHECK (id ~ '^o_[a-zA-Z0-9_-]{1,64}$'),
    merchant_id       TEXT        NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    agent_id          TEXT        NOT NULL REFERENCES agents(id)    ON DELETE CASCADE,
    session_id        TEXT        NOT NULL REFERENCES sessions(id)  ON DELETE CASCADE,
    items             JSONB       NOT NULL,
    amount_paise      BIGINT      NOT NULL CHECK (amount_paise > 0),
    status            TEXT        NOT NULL
                                  CHECK (status IN ('created','authorized','escalated','failed')),
    razorpay_order_id TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT order_items_non_empty_array
        CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) > 0),
    CONSTRAINT order_rzp_id_shape
        CHECK (razorpay_order_id IS NULL OR razorpay_order_id LIKE 'order\_%'),
    CONSTRAINT order_escalated_never_reached_razorpay
        CHECK (status <> 'escalated' OR razorpay_order_id IS NULL)
);

-- THE hot index. Equality cols first, then range, filter+aggregate as INCLUDE
-- payload so the spend-cap query is an Index Only Scan.
-- Scope is (merchant_id, agent_id) — NEVER session_id.
CREATE INDEX idx_orders_spend_cap
    ON orders (merchant_id, agent_id, created_at)
    INCLUDE (amount_paise, status);

CREATE INDEX idx_orders_session ON orders (session_id, created_at);

-- audit_events deliberately has NO FOREIGN KEYS. Append-only ledger that must
-- survive a merchant deletion; an FK cascade would delete evidence.
-- This is intentional. Do not "fix" it.
CREATE TABLE audit_events (
    id           TEXT        PRIMARY KEY,
    merchant_id  TEXT        NOT NULL,
    session_id   TEXT        NOT NULL,
    agent_id     TEXT        NOT NULL,
    order_id     TEXT,
    action       TEXT        NOT NULL
                             CHECK (action IN ('list_products','get_product',
                                               'checkout','get_order_status')),
    amount_paise BIGINT      CHECK (amount_paise IS NULL OR amount_paise >= 0),
    rule         TEXT        NOT NULL
                             CHECK (rule IN ('AUTHORITATIVE_REREAD','SPEND_CAP',
                                             'CATEGORY_ALLOWLIST','APPROVAL_THRESHOLD',
                                             'ALLOW','AUTH')),
    decision     TEXT        NOT NULL CHECK (decision IN ('allow','block','escalate')),
    reason_code  TEXT        NOT NULL
                             CHECK (reason_code IN ('ALLOWED','STALE_CATALOG',
                                                    'SPEND_CAP_EXCEEDED','CATEGORY_NOT_ALLOWED',
                                                    'PENDING_APPROVAL','RAZORPAY_ERROR',
                                                    'UNAUTHENTICATED','INVALID_REQUEST')),
    detail       JSONB,
    latency_ms   INTEGER     NOT NULL CHECK (latency_ms >= 0),
    ts           TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT audit_allow_implies_allowed
        CHECK ((decision = 'allow') = (reason_code = 'ALLOWED'))
);

CREATE INDEX idx_audit_session  ON audit_events (session_id, ts);
CREATE INDEX idx_audit_merchant ON audit_events (merchant_id, ts DESC);
CREATE INDEX idx_audit_agent    ON audit_events (merchant_id, agent_id, ts DESC);
CREATE INDEX idx_audit_reason   ON audit_events (reason_code, ts DESC);
