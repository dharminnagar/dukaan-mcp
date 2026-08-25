import { describe, expect, test } from 'bun:test';
import { AuditEvent, AuditEventInput, StaleCatalogError } from '../src/shared/contracts';

const validAuditEventInput = {
  merchant_id: 'm_test',
  session_id: 's_test',
  agent_id: 'ag_test',
  order_id: null,
  action: 'list_products',
  amount_paise: null,
  rule: 'ALLOW',
  decision: 'allow',
  reason_code: 'ALLOWED',
  detail: null,
  latency_ms: 12,
} as const;

describe('AuditEvent', () => {
  test('zod rejects an AuditEvent missing decision', () => {
    const { decision: _decision, ...withoutDecision } = {
      ...validAuditEventInput,
      id: 'ae_x',
      ts: new Date(),
    };
    expect(() => AuditEvent.parse(withoutDecision)).toThrow();
  });

  test('zod rejects reason_code: "NOPE"', () => {
    expect(() => AuditEventInput.parse({ ...validAuditEventInput, reason_code: 'NOPE' })).toThrow();
  });

  test('decision "allow" + reason_code "SPEND_CAP_EXCEEDED" is rejected by the refine', () => {
    expect(() =>
      AuditEventInput.parse({
        ...validAuditEventInput,
        decision: 'allow',
        reason_code: 'SPEND_CAP_EXCEEDED',
      }),
    ).toThrow();

    expect(() =>
      AuditEvent.parse({
        ...validAuditEventInput,
        id: 'ae_x',
        ts: new Date(),
        decision: 'allow',
        reason_code: 'SPEND_CAP_EXCEEDED',
      }),
    ).toThrow();
  });

  test('the inverse mismatch is also rejected: reason_code "ALLOWED" with decision "block"', () => {
    expect(() =>
      AuditEventInput.parse({
        ...validAuditEventInput,
        decision: 'block',
        reason_code: 'ALLOWED',
      }),
    ).toThrow();
  });
});

describe('StaleCatalogError', () => {
  test('round-trips through JSON.parse(JSON.stringify(x)) and still parses, mismatch preserved', () => {
    const original = StaleCatalogError.parse({
      reason_code: 'STALE_CATALOG',
      message: 'price mismatch',
      mismatch: 'price',
      item_id: 'p_1',
      asserted_price_paise: 1000,
      true_price_paise: 1200,
      asserted_quantity: 2,
      true_stock: null,
    });

    const roundTripped = JSON.parse(JSON.stringify(original));
    const reparsed = StaleCatalogError.parse(roundTripped);

    expect(reparsed.mismatch).toBe('price');
    expect(reparsed).toEqual(original);
  });
});
