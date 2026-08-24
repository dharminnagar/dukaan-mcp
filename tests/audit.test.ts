import { afterAll, describe, expect, test } from 'bun:test';
import { writeAuditEvent } from '../src/audit/write';
import { closePool, pool, query } from '../src/db/pool';
import type { AuditEventInput } from '../src/shared/contracts';

const baseInput: AuditEventInput = {
  merchant_id: 'm_audit_test',
  session_id: 's_audit_test',
  agent_id: 'ag_audit_test',
  order_id: null,
  action: 'list_products',
  amount_paise: null,
  rule: 'ALLOW',
  decision: 'allow',
  reason_code: 'ALLOWED',
  detail: null,
  latency_ms: 5,
};

afterAll(async () => {
  await closePool();
});

describe('writeAuditEvent', () => {
  test('returns a row with a generated id and ts, and a follow-up SELECT finds exactly one', async () => {
    const event = await writeAuditEvent(baseInput);

    expect(event.id.startsWith('ae_')).toBe(true);
    expect(event.ts).toBeInstanceOf(Date);
    expect(event.decision).toBe('allow');
    expect(event.reason_code).toBe('ALLOWED');

    const rows = await query('SELECT id FROM audit_events WHERE id = $1', [event.id]);
    expect(rows.length).toBe(1);
  });

  test('writes on the allow branch too (reason_code ALLOWED, non-null amount)', async () => {
    const event = await writeAuditEvent({
      ...baseInput,
      action: 'checkout',
      amount_paise: 5000,
      rule: 'ALLOW',
      decision: 'allow',
      reason_code: 'ALLOWED',
    });

    expect(event.decision).toBe('allow');
    expect(event.amount_paise).toBe(5000);
  });

  test('rejects the allow/reason_code mismatch at the zod layer before it ever reaches the DB', async () => {
    const before = await query<{ count: string }>('SELECT count(*)::text FROM audit_events');

    await expect(
      writeAuditEvent({
        ...baseInput,
        decision: 'allow',
        reason_code: 'SPEND_CAP_EXCEEDED',
      }),
    ).rejects.toThrow();

    const after = await query<{ count: string }>('SELECT count(*)::text FROM audit_events');
    expect(after[0]?.count).toBe(before[0]?.count);
  });

  test('the DB CHECK constraint independently rejects the same mismatch, bypassing zod', async () => {
    // Write a legitimately valid row through the one true write path, then try
    // to corrupt it in place with a raw UPDATE. This proves the CHECK
    // constraint (audit_allow_implies_allowed) is a second, independent guard
    // -- without ever inserting through a second write path.
    const event = await writeAuditEvent({
      ...baseInput,
      decision: 'block',
      reason_code: 'SPEND_CAP_EXCEEDED',
    });

    await expect(
      pool.query(`UPDATE audit_events SET decision = 'allow' WHERE id = $1`, [event.id]),
    ).rejects.toMatchObject({ code: '23514' }); // check_violation
  });
});
