import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pool, closePool } from './pool';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'migrations');
const LOCK_KEY = 6_884_705;

interface MigrationRow { id: string; checksum: string }

async function main(): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    locked = true;

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         TEXT        PRIMARY KEY,
        checksum   CHAR(64)    NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const { rows } = await client.query<MigrationRow>('SELECT id, checksum FROM _migrations');
    const applied = new Map(rows.map((r) => [r.id, r.checksum]));

    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    if (files.length === 0) throw new Error(`No .sql files found in ${MIGRATIONS_DIR}`);

    let pending = 0;
    for (const file of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const prior = applied.get(file);

      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(
            `Migration ${file} was already applied but its contents changed ` +
            `(${prior.slice(0, 12)}... -> ${checksum.slice(0, 12)}...). ` +
            `Never edit an applied migration. Write a new one.`,
          );
        }
        console.log(`  = ${file}`);
        continue;
      }

      console.log(`  + ${file}`);
      pending += 1;
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO _migrations (id, checksum) VALUES ($1, $2)',
          [file, checksum],
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
    }

    console.log(pending === 0 ? 'migrations: up to date' : `migrations: applied ${pending}`);
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
    client.release();
    await closePool();
  }
}

await main();
