/**
 * Every query in this file is scoped by the merchant_id (and, where the
 * table has one, the agent_id) carried on the `TenantContext` passed to the
 * constructor. No method here accepts a merchant_id argument — that is the
 * structural defence against a cross-tenant leak: a query missing the scope
 * clause is not just a bug to catch in review, it is a shape the type
 * signatures make awkward to even write, because the id has to come from
 * `this.ctx`, not from a caller-supplied parameter.
 */
import type { TenantContext } from '../shared/contracts';
import { Order, Policy, Product, Session } from '../shared/contracts';
import { query, queryOne } from './pool';

/**
 * The spend-cap query, verbatim per DUK-9. Scope is (merchant_id, agent_id,
 * window) — NEVER session_id. A session-scoped cap resets every time an
 * agent opens a new session, which defeats the cap entirely. This exact
 * text is what `idx_orders_spend_cap` (merchant_id, agent_id, created_at)
 * INCLUDE (amount_paise, status) is shaped for; do not reformat the
 * predicate order or it risks losing the Index Only Scan.
 */
const SPEND_CAP_SQL = `SELECT COALESCE(SUM(amount_paise), 0)::BIGINT AS spent_paise
  FROM orders
 WHERE merchant_id = $1
   AND agent_id    = $2
   AND created_at >= now() - make_interval(secs => $3::int)
   AND status IN ('created', 'authorized')`;

interface SpendCapRow {
  spent_paise: number;
}

export class TenantRepo {
  private readonly ctx: TenantContext;

  constructor(ctx: TenantContext) {
    this.ctx = ctx;
  }

  async listProducts(): Promise<Product[]> {
    const rows = await query<Product>(
      'SELECT merchant_id, id, name, price_paise, stock, category, updated_at FROM products WHERE merchant_id = $1 ORDER BY id',
      [this.ctx.merchant_id],
    );
    return rows.map((row) => Product.parse(row));
  }

  async getProduct(id: string): Promise<Product | null> {
    const row = await queryOne<Product>(
      'SELECT merchant_id, id, name, price_paise, stock, category, updated_at FROM products WHERE merchant_id = $1 AND id = $2',
      [this.ctx.merchant_id, id],
    );
    return row === null ? null : Product.parse(row);
  }

  async getPolicy(): Promise<Policy> {
    const row = await queryOne<Policy>(
      'SELECT merchant_id, spend_cap_paise, approval_threshold_paise, category_allowlist, window_seconds FROM policies WHERE merchant_id = $1',
      [this.ctx.merchant_id],
    );
    if (row === null) {
      throw new Error(`No policy configured for merchant ${this.ctx.merchant_id}`);
    }
    return Policy.parse(row);
  }

  async spentInWindowPaise(windowSeconds: number): Promise<number> {
    const row = await queryOne<SpendCapRow>(SPEND_CAP_SQL, [
      this.ctx.merchant_id,
      this.ctx.agent_id,
      windowSeconds,
    ]);
    if (row === null) {
      throw new Error('spentInWindowPaise: aggregate query returned no row');
    }
    return row.spent_paise;
  }

  async ensureSession(): Promise<Session> {
    const existing = await queryOne<Session>(
      'SELECT id, merchant_id, agent_id, started_at FROM sessions WHERE merchant_id = $1 AND agent_id = $2 AND id = $3',
      [this.ctx.merchant_id, this.ctx.agent_id, this.ctx.session_id],
    );
    if (existing !== null) return Session.parse(existing);

    const inserted = await queryOne<Session>(
      `INSERT INTO sessions (id, merchant_id, agent_id)
       VALUES ($1, $2, $3)
       RETURNING id, merchant_id, agent_id, started_at`,
      [this.ctx.session_id, this.ctx.merchant_id, this.ctx.agent_id],
    );
    if (inserted === null) {
      throw new Error('ensureSession: insert returned no row');
    }
    return Session.parse(inserted);
  }

  /**
   * merchant_id, agent_id, and session_id on `o` are accepted only to match
   * the frozen `Omit<Order, 'created_at'>` shape; the actual INSERT always
   * uses `this.ctx`, never the caller-supplied values, so a caller cannot
   * write an order into a tenant it was not resolved into.
   */
  async insertOrder(o: Omit<Order, 'created_at'>): Promise<Order> {
    const row = await queryOne<Order>(
      `INSERT INTO orders (id, merchant_id, agent_id, session_id, items, amount_paise, status, razorpay_order_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       RETURNING id, merchant_id, agent_id, session_id, items, amount_paise, status, razorpay_order_id, created_at`,
      [
        o.id,
        this.ctx.merchant_id,
        this.ctx.agent_id,
        this.ctx.session_id,
        JSON.stringify(o.items),
        o.amount_paise,
        o.status,
        o.razorpay_order_id,
      ],
    );
    if (row === null) {
      throw new Error('insertOrder: insert returned no row');
    }
    return Order.parse(row);
  }

  async getOrder(id: string): Promise<Order | null> {
    const row = await queryOne<Order>(
      'SELECT id, merchant_id, agent_id, session_id, items, amount_paise, status, razorpay_order_id, created_at FROM orders WHERE merchant_id = $1 AND agent_id = $2 AND id = $3',
      [this.ctx.merchant_id, this.ctx.agent_id, id],
    );
    return row === null ? null : Order.parse(row);
  }
}
