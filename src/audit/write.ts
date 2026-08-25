import { randomUUID } from 'node:crypto';
import { query } from '../db/pool';
import { AuditEvent, AuditEventInput } from '../shared/contracts';
import type {
  AuditEvent as AuditEventType,
  AuditEventInput as AuditEventInputType,
} from '../shared/contracts';

/**
 * The ONLY module permitted to `INSERT INTO audit_events`. Every gate branch —
 * including the allow branch — calls this, so the append-only ledger is the
 * single source of truth an eval reporter or auditor can reconstruct decisions
 * from. A second insert path anywhere else defeats that guarantee.
 */
export async function writeAuditEvent(input: AuditEventInputType): Promise<AuditEventType> {
  const parsed = AuditEventInput.parse(input);
  const id = `ae_${randomUUID()}`;

  const rows = await query<{
    id: string;
    merchant_id: string;
    session_id: string;
    agent_id: string;
    order_id: string | null;
    action: string;
    amount_paise: number | null;
    rule: string;
    decision: string;
    reason_code: string;
    detail: Record<string, unknown> | null;
    latency_ms: number;
    ts: Date;
  }>(
    `INSERT INTO audit_events
       (id, merchant_id, session_id, agent_id, order_id, action,
        amount_paise, rule, decision, reason_code, detail, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, merchant_id, session_id, agent_id, order_id, action,
               amount_paise, rule, decision, reason_code, detail, latency_ms, ts`,
    [
      id,
      parsed.merchant_id,
      parsed.session_id,
      parsed.agent_id,
      parsed.order_id,
      parsed.action,
      parsed.amount_paise,
      parsed.rule,
      parsed.decision,
      parsed.reason_code,
      parsed.detail,
      parsed.latency_ms,
    ],
  );

  const row = rows[0];
  if (row === undefined) {
    throw new Error('writeAuditEvent: INSERT ... RETURNING produced no row');
  }

  return AuditEvent.parse(row);
}
