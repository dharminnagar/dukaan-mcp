import pg from 'pg';
import type { PoolClient, QueryResultRow } from 'pg';
import { env } from '../config';

const { Pool, types } = pg;

/**
 * BIGINT (int8, oid 20) arrives from node-postgres as a *string* by default,
 * because int8 can exceed IEEE-754 safe range. Every BIGINT column here is
 * paise, and Number.MAX_SAFE_INTEGER paise is about Rs 90,071,992,547.40 —
 * not reachable in this system. Parse once, globally, rather than remembering
 * Number() at forty call sites.
 *
 * NOTE: mutates pg's global type-parser registry. Any other process importing
 * pg directly (a future web/ route) must do the same or it will see strings.
 */
types.setTypeParser(types.builtins.INT8, (v: string) => Number(v));

/** One Pool. Exported once. Reused everywhere. A pool per module exhausts connections. */
export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'dukaan-mcp',
});

pool.on('error', (err: Error) => {
  console.error('[pg] idle client error:', err.message);
});

export async function query<R extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  const res = await pool.query<R>(text, params as unknown[]);
  return res.rows;
}

export async function queryOne<R extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<R | null> {
  const rows = await query<R>(text, params);
  return rows[0] ?? null;
}

export async function withTransaction<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection already dead */
    });
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Serialises `fn` across every caller using the same `key`, via a Postgres
 * advisory lock scoped to a transaction (`pg_advisory_xact_lock`, DUK-29).
 * Transaction-scoped rather than session-scoped (`pg_advisory_lock`) on
 * purpose: a session lock needs an explicit `pg_advisory_unlock` and leaks
 * for the rest of that connection's life if the process dies mid-`fn()`,
 * whereas Postgres releases an xact lock the moment the transaction ends —
 * COMMIT, ROLLBACK, or the connection dropping — with nothing for us to
 * remember to clean up.
 *
 * The lock is held on this dedicated client while `fn()` does its work
 * through the shared pool, not through this client. That's intentional:
 * mutual exclusion comes from every caller contending on `hashtext(key)`,
 * not from `fn()`'s queries running inside this transaction.
 */
export async function withAdvisoryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    const out = await fn();
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      /* connection already dead */
    });
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
