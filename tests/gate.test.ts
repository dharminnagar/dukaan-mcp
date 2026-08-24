import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { writeAuditEvent } from '../src/audit/write';
import { hashToken } from '../src/auth/token';
import { pool, query, queryOne } from '../src/db/pool';
import { TenantRepo } from '../src/db/repo';
import { decide } from '../src/gate';
import type { CheckoutRequest, GateDeps } from '../src/gate';
import type { TenantContext } from '../src/shared/contracts';

/**
 * m_gate_* / ag_gate_* namespace, so this file cannot collide with the
 * concurrent DUK-13/razorpay agent's own fixtures or with any other test
 * file's data.
 */
const MERCHANT = 'm_gate_test';

const PRODUCT_BASIC = { id: 'p_gate_basic', name: 'Basic Item', price_paise: 10_000, stock: 5, category: 'groceries' };
const PRODUCT_DISALLOWED_CATEGORY = { id: 'p_gate_electronics', name: 'Gadget', price_paise: 20_000, stock: 3, category: 'electronics' };
const PRODUCT_MULTISESSION = { id: 'p_gate_multisession', name: 'Multisession Item', price_paise: 50_000, stock: 10, category: 'groceries' };
const PRODUCT_APPROVAL = { id: 'p_gate_approval', name: 'Approval Item', price_paise: 60_000, stock: 10, category: 'groceries' };
const PRODUCT_WINDOW = { id: 'p_gate_window', name: 'Window Item', price_paise: 20_000, stock: 10, category: 'groceries' };

const SPEND_CAP_PAISE = 100_000;
const APPROVAL_THRESHOLD_PAISE = 50_000;

async function makeAgentCtx(agentSuffix: string, sessionSuffix = agentSuffix): Promise<TenantContext> {
  const agentId = `ag_gate_${agentSuffix}`;
  await query('INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)', [
    agentId,
    MERCHANT,
    `gate test agent ${agentSuffix}`,
    // Not a real credential - decide() is driven directly with a TenantContext,
    // bypassing auth/resolve.ts entirely, so only a valid unique digest shape matters.
    hashToken(agentId),
  ]);
  const ctx: TenantContext = {
    merchant_id: MERCHANT,
    agent_id: agentId,
    session_id: `s_gate_${sessionSuffix}`,
  };
  await new TenantRepo(ctx).ensureSession();
  return ctx;
}

function makeDeps(ctx: TenantContext): GateDeps {
  return { repo: new TenantRepo(ctx), writeAudit: writeAuditEvent };
}

async function countCheckoutAudits(agentId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `SELECT count(*)::text AS count FROM audit_events WHERE merchant_id = $1 AND agent_id = $2 AND action = 'checkout'`,
    [MERCHANT, agentId],
  );
  return Number.parseInt(row?.count ?? '0', 10);
}

beforeAll(async () => {
  await query('DELETE FROM audit_events WHERE merchant_id = $1', [MERCHANT]);
  await query('DELETE FROM merchants WHERE id = $1', [MERCHANT]);
  await query('INSERT INTO merchants (id, name) VALUES ($1, $2)', [MERCHANT, 'Gate Test Kirana']);
  await query(
    `INSERT INTO policies (merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds)
     VALUES ($1, $2, $3, $4, $5)`,
    [MERCHANT, SPEND_CAP_PAISE, APPROVAL_THRESHOLD_PAISE, ['groceries', 'dairy'], 3600],
  );
  for (const p of [PRODUCT_BASIC, PRODUCT_DISALLOWED_CATEGORY, PRODUCT_MULTISESSION, PRODUCT_APPROVAL, PRODUCT_WINDOW]) {
    await query(
      'INSERT INTO products (merchant_id, id, name, price_paise, stock, category) VALUES ($1, $2, $3, $4, $5, $6)',
      [MERCHANT, p.id, p.name, p.price_paise, p.stock, p.category],
    );
  }
});

afterAll(async () => {
  await query('DELETE FROM audit_events WHERE merchant_id = $1', [MERCHANT]);
  await query('DELETE FROM merchants WHERE id = $1', [MERCHANT]);
  // src/db/pool.ts exports ONE process-wide Pool singleton shared across
  // every test file in the same `bun test` process. Closing it here would
  // break whichever file runs next (projectmem #0013); bun exits fine
  // without it, so it is deliberately left open.
});

describe('check 1: authoritative re-read', () => {
  test('asserted price below catalog price -> STALE_CATALOG with mismatch "price" and the true price', async () => {
    const ctx = await makeAgentCtx('stale_price');
    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: 9_000 }] };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.rule).toBe('AUTHORITATIVE_REREAD');
    expect(outcome.error.reason_code).toBe('STALE_CATALOG');
    if (outcome.error.reason_code !== 'STALE_CATALOG') throw new Error('unreachable');
    expect(outcome.error.mismatch).toBe('price');
    expect(outcome.error.true_price_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(outcome.error.item_id).toBe(PRODUCT_BASIC.id);
  });

  test('asserted qty above stock -> STALE_CATALOG with mismatch "stock"', async () => {
    const ctx = await makeAgentCtx('stale_stock');
    const req: CheckoutRequest = {
      items: [{ item_id: PRODUCT_BASIC.id, quantity: PRODUCT_BASIC.stock + 1, asserted_price_paise: PRODUCT_BASIC.price_paise }],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.error.reason_code).toBe('STALE_CATALOG');
    if (outcome.error.reason_code !== 'STALE_CATALOG') throw new Error('unreachable');
    expect(outcome.error.mismatch).toBe('stock');
    expect(outcome.error.true_stock).toBe(PRODUCT_BASIC.stock);
  });

  test('unknown item id -> STALE_CATALOG with mismatch "missing"', async () => {
    const ctx = await makeAgentCtx('stale_missing');
    const req: CheckoutRequest = { items: [{ item_id: 'p_gate_does_not_exist', quantity: 1, asserted_price_paise: 5_000 }] };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.error.reason_code).toBe('STALE_CATALOG');
    if (outcome.error.reason_code !== 'STALE_CATALOG') throw new Error('unreachable');
    expect(outcome.error.mismatch).toBe('missing');
    expect(outcome.error.true_price_paise).toBeNull();
    expect(outcome.error.true_stock).toBeNull();
  });

  test('an authoritative-re-read block writes exactly one AuditEvent', async () => {
    const ctx = await makeAgentCtx('stale_audit_count');
    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: 1 }] };

    await decide(ctx, req, makeDeps(ctx));

    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

describe('check 2: spend cap', () => {
  test('an order taking the agent past spend_cap_paise within window -> SPEND_CAP_EXCEEDED', async () => {
    const ctx = await makeAgentCtx('cap');
    // Prior spend of 95_000, leaving only 5_000 of headroom under the 100_000 cap.
    await new TenantRepo(ctx).insertOrder({
      id: 'o_gate_cap_prior',
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [{ item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: 95_000 }],
      amount_paise: 95_000,
      status: 'created',
      razorpay_order_id: null,
    });

    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: PRODUCT_BASIC.price_paise }] };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.rule).toBe('SPEND_CAP');
    expect(outcome.error.reason_code).toBe('SPEND_CAP_EXCEEDED');
    if (outcome.error.reason_code !== 'SPEND_CAP_EXCEEDED') throw new Error('unreachable');
    expect(outcome.error.spent_paise).toBe(95_000);
    expect(outcome.error.attempted_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(outcome.error.cap_paise).toBe(SPEND_CAP_PAISE);
    expect(outcome.error.remaining_budget_paise).toBe(5_000);
  });

  test('THE regression that matters most: NEW SESSION, SAME AGENT, cumulative total past cap -> STILL BLOCKED', async () => {
    const agentId = `ag_gate_multisession`;
    await query('INSERT INTO agents (id, merchant_id, label, token_hash) VALUES ($1, $2, $3, $4)', [
      agentId,
      MERCHANT,
      'gate test multisession agent',
      hashToken(agentId),
    ]);

    const ctxSession1: TenantContext = { merchant_id: MERCHANT, agent_id: agentId, session_id: 's_gate_multisession_1' };
    const ctxSession2: TenantContext = { merchant_id: MERCHANT, agent_id: agentId, session_id: 's_gate_multisession_2' };
    await new TenantRepo(ctxSession1).ensureSession();
    await new TenantRepo(ctxSession2).ensureSession();

    // Session 1 spends 60_000 and then the agent starts a BRAND NEW session.
    await new TenantRepo(ctxSession1).insertOrder({
      id: 'o_gate_multisession_1',
      merchant_id: ctxSession1.merchant_id,
      agent_id: ctxSession1.agent_id,
      session_id: ctxSession1.session_id,
      items: [{ item_id: PRODUCT_MULTISESSION.id, quantity: 1, asserted_price_paise: PRODUCT_MULTISESSION.price_paise }],
      amount_paise: 60_000,
      status: 'created',
      razorpay_order_id: null,
    });

    // Session 2 (different session_id, SAME merchant_id + agent_id) tries to
    // spend another 50_000. 60_000 + 50_000 = 110_000 > the 100_000 cap.
    // If the cap were (wrongly) scoped to session_id, this would see 0 prior
    // spend and be allowed - exactly the bug projectmem issue #0009 flags.
    const req: CheckoutRequest = {
      items: [{ item_id: PRODUCT_MULTISESSION.id, quantity: 1, asserted_price_paise: PRODUCT_MULTISESSION.price_paise }],
    };
    const outcome = await decide(ctxSession2, req, makeDeps(ctxSession2));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.error.reason_code).toBe('SPEND_CAP_EXCEEDED');
    if (outcome.error.reason_code !== 'SPEND_CAP_EXCEEDED') throw new Error('unreachable');
    expect(outcome.error.spent_paise).toBe(60_000);
  });

  test('window boundary: an order just OUTSIDE window_seconds does not count toward the cap', async () => {
    const ctx = await makeAgentCtx('window');
    await new TenantRepo(ctx).ensureSession();

    // Backdated directly via SQL (the same technique tests/repo.test.ts
    // uses) rather than sleeping or mocking a clock: the enforcement query
    // (repo.spentInWindowPaise) filters on Postgres's own `now()`, so the
    // deterministic way to place an order "outside the window" is to give
    // it a created_at that is provably outside it relative to that same
    // now(), computed in the same SQL statement.
    await query(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, now() - interval '2 hours')`,
      [
        'o_gate_window_outside',
        ctx.merchant_id,
        ctx.agent_id,
        ctx.session_id,
        JSON.stringify([{ item_id: PRODUCT_WINDOW.id, quantity: 1, asserted_price_paise: 90_000 }]),
        90_000,
        'created',
      ],
    );

    // Policy window is 3600s (1 hour). If the 90_000 order above counted,
    // 90_000 + 20_000 = 110_000 would exceed the 100_000 cap and this would
    // block. Because it is 2 hours old, it must not count, and this must allow.
    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_WINDOW.id, quantity: 1, asserted_price_paise: PRODUCT_WINDOW.price_paise }] };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('allow');
  });
});

describe('check 3: category allowlist', () => {
  test('a line item outside the allowlist -> CATEGORY_NOT_ALLOWED', async () => {
    const ctx = await makeAgentCtx('category');
    const req: CheckoutRequest = {
      items: [{ item_id: PRODUCT_DISALLOWED_CATEGORY.id, quantity: 1, asserted_price_paise: PRODUCT_DISALLOWED_CATEGORY.price_paise }],
    };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.rule).toBe('CATEGORY_ALLOWLIST');
    expect(outcome.error.reason_code).toBe('CATEGORY_NOT_ALLOWED');
    if (outcome.error.reason_code !== 'CATEGORY_NOT_ALLOWED') throw new Error('unreachable');
    expect(outcome.error.category).toBe('electronics');
    expect(outcome.error.category_allowlist).toEqual(['groceries', 'dairy']);
  });
});

describe('check 4: approval threshold', () => {
  test('amount above approval_threshold_paise -> PENDING_APPROVAL, and does not fall through to allow', async () => {
    const ctx = await makeAgentCtx('approval');
    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_APPROVAL.id, quantity: 1, asserted_price_paise: PRODUCT_APPROVAL.price_paise }] };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('escalate');
    if (outcome.decision !== 'escalate') throw new Error('unreachable');
    expect(outcome.rule).toBe('APPROVAL_THRESHOLD');
    expect(outcome.error.reason_code).toBe('PENDING_APPROVAL');
    expect(outcome.error.amount_paise).toBe(PRODUCT_APPROVAL.price_paise);
    expect(outcome.error.approval_threshold_paise).toBe(APPROVAL_THRESHOLD_PAISE);
    expect(outcome.error.order_id).toMatch(/^o_[a-zA-Z0-9_-]+$/);

    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

describe('check 5: allow', () => {
  test('a clean order allows, with amount_paise, and writes exactly one allow AuditEvent', async () => {
    const ctx = await makeAgentCtx('allow');
    const req: CheckoutRequest = { items: [{ item_id: PRODUCT_BASIC.id, quantity: 2, asserted_price_paise: PRODUCT_BASIC.price_paise }] };

    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('allow');
    if (outcome.decision !== 'allow') throw new Error('unreachable');
    expect(outcome.rule).toBe('ALLOW');
    expect(outcome.amount_paise).toBe(PRODUCT_BASIC.price_paise * 2);

    const events = await query<{ decision: string; reason_code: string; latency_ms: number }>(
      `SELECT decision, reason_code, latency_ms FROM audit_events WHERE merchant_id = $1 AND agent_id = $2 AND action = 'checkout'`,
      [MERCHANT, ctx.agent_id],
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.decision).toBe('allow');
    expect(events[0]?.reason_code).toBe('ALLOWED');
    expect(events[0]?.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

/**
 * Regressions for projectmem issue #0016 — three holes in check 1 found by
 * adversarial probes after DUK-14 landed, none covered by the original suite.
 * All three are shapes an adversary reaches for, so they stay tested.
 */
describe('check 1 regressions: per-line vs per-aggregate validation', () => {
  test('duplicate line items may not oversell stock (3 + 3 against stock 5)', async () => {
    const ctx = await makeAgentCtx('dupstock');
    // Each line passes an independent `quantity > stock` test (3 <= 5), but the
    // aggregate is 6 against 5. Validating per line would ship goods that do
    // not exist.
    const req: CheckoutRequest = {
      items: [
        { item_id: PRODUCT_BASIC.id, quantity: 3, asserted_price_paise: PRODUCT_BASIC.price_paise },
        { item_id: PRODUCT_BASIC.id, quantity: 3, asserted_price_paise: PRODUCT_BASIC.price_paise },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.rule).toBe('AUTHORITATIVE_REREAD');
    expect(outcome.error.reason_code).toBe('STALE_CATALOG');
    if (outcome.error.reason_code !== 'STALE_CATALOG') throw new Error('unreachable');
    expect(outcome.error.mismatch).toBe('stock');
    // The reported quantity is the aggregate, not one line's share.
    expect(outcome.error.asserted_quantity).toBe(6);
    expect(outcome.error.true_stock).toBe(PRODUCT_BASIC.stock);
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });

  test('the same item twice at different asserted prices is caught on the second line', async () => {
    const ctx = await makeAgentCtx('dupprice');
    // Deduping the catalog read must not dedupe the PRICE check: if only the
    // first occurrence were validated, the agent would underpay on the rest.
    const req: CheckoutRequest = {
      items: [
        { item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: PRODUCT_BASIC.price_paise },
        { item_id: PRODUCT_BASIC.id, quantity: 1, asserted_price_paise: PRODUCT_BASIC.price_paise - 5_000 },
      ],
    };
    const outcome = await decide(ctx, req, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.error.reason_code).toBe('STALE_CATALOG');
    if (outcome.error.reason_code !== 'STALE_CATALOG') throw new Error('unreachable');
    expect(outcome.error.mismatch).toBe('price');
    expect(outcome.error.true_price_paise).toBe(PRODUCT_BASIC.price_paise);
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });

  test('an empty basket is INVALID_REQUEST, never a 0-paise allow', async () => {
    const ctx = await makeAgentCtx('emptyitems');
    // src/eval/ calls decide() directly with no zod layer in front of it, and
    // `orders` could not store a 0-paise, 0-item row anyway.
    const outcome = await decide(ctx, { items: [] }, makeDeps(ctx));

    expect(outcome.decision).toBe('block');
    if (outcome.decision !== 'block') throw new Error('unreachable');
    expect(outcome.rule).toBe('AUTHORITATIVE_REREAD');
    expect(outcome.error.reason_code).toBe('INVALID_REQUEST');
    if (outcome.error.reason_code !== 'INVALID_REQUEST') throw new Error('unreachable');
    expect(outcome.error.field).toBe('items');
    expect(await countCheckoutAudits(ctx.agent_id)).toBe(1);
  });
});

afterAll(async () => {
  // Belt-and-braces: prove no test in this file ever opened a second
  // connection pool or otherwise left the shared pool in a bad state.
  expect(pool.ended).toBe(false);
});
