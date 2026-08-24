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
    await client.query('ROLLBACK').catch(() => { /* connection already dead */ });
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
