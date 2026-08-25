/**
 * Replays a transcript straight against `decide()` — no HTTP server, no
 * MCP, no network, no Razorpay call — collecting the AuditEvent every gate
 * branch writes. This is what makes the eval's metrics claim hold: every
 * decision here is the SAME code path DUK-13's checkout tool calls, driven
 * with the same TenantContext/GateDeps shape tests/gate.test.ts already
 * uses.
 *
 * ORDER PERSISTENCE, the subtle part: `decide()` never writes to `orders`
 * (see src/gate/index.ts's module doc — it deliberately returns before any
 * payment call so it stays a pure decision function). In production,
 * src/mcp/http.ts's checkout handler is the one that calls
 * `repo.insertOrder(...)` after an allow (once Razorpay confirms) or an
 * escalate (immediately, status 'escalated'). Since this runner bypasses
 * that handler entirely, IT has to do that insert itself, or every
 * multi-step transcript's spend-cap arithmetic would be checking against
 * zero prior spend no matter how many "allowed" orders came before it —
 * which would make budget-split evasion untestable. So: on 'allow', this
 * runner inserts an order with status 'created' (skipping the Razorpay
 * call the real handler makes, which is exactly the eval's no-network
 * constraint); on 'escalate', it inserts one with status 'escalated' under
 * the id the gate already minted, mirroring src/mcp/http.ts's own escalate
 * branch exactly. On 'block', nothing is written to `orders` — same as
 * production, since a blocked order never happened.
 */
import { randomUUID } from 'node:crypto';
import { writeAuditEvent } from '../audit/write';
import { TenantRepo } from '../db/repo';
import { decide } from '../gate';
import type { AuditEvent, GateOutcome, TenantContext } from '../shared/contracts';
import { ensureEvalAgent, ensureEvalSession, evalAgentId, evalSessionId } from './provision';
import type { EvalMerchantIds } from './provision';
import type { Transcript } from './transcript';

export interface ReplayStepResult {
  readonly stepIndex: number;
  readonly sessionId: string;
  readonly outcome: GateOutcome;
  readonly audit: AuditEvent;
}

export interface ReplayResult<T extends Transcript = Transcript> {
  readonly transcript: T;
  readonly steps: readonly ReplayStepResult[];
}

async function persistOrderIfNeeded(repo: TenantRepo, ctx: TenantContext, items: Transcript['steps'][number]['items'], outcome: GateOutcome): Promise<void> {
  if (outcome.decision === 'allow') {
    await repo.insertOrder({
      id: `o_${randomUUID()}`,
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [...items],
      amount_paise: outcome.amount_paise,
      status: 'created',
      razorpay_order_id: null,
    });
    return;
  }
  if (outcome.decision === 'escalate') {
    await repo.insertOrder({
      id: outcome.error.order_id,
      merchant_id: ctx.merchant_id,
      agent_id: ctx.agent_id,
      session_id: ctx.session_id,
      items: [...items],
      amount_paise: outcome.error.amount_paise,
      status: 'escalated',
      razorpay_order_id: null,
    });
  }
  // 'block': no order row, same as production (src/mcp/http.ts never inserts on block).
}

/**
 * Replays one transcript's steps IN ORDER against a single agent, under the
 * given namespace and merchant mapping. Callers MUST have already called
 * `resetEvalMerchants(namespace)` (see provision.ts) so `merchantIds`
 * points at a freshly-provisioned, empty-of-orders merchant.
 */
export async function replayTranscript<T extends Transcript>(
  namespace: string,
  merchantIds: EvalMerchantIds,
  transcript: T,
): Promise<ReplayResult<T>> {
  const merchantId = merchantIds[transcript.merchant];
  const agentId = evalAgentId(namespace, transcript.agent_id);
  await ensureEvalAgent(merchantId, agentId, transcript.id);

  const steps: ReplayStepResult[] = [];

  for (let i = 0; i < transcript.steps.length; i++) {
    const step = transcript.steps[i];
    if (step === undefined) continue; // unreachable given the loop bound; satisfies noUncheckedIndexedAccess
    // `step.session_id` is only unique WITHIN a transcript (e.g. every attack
    // class's first fixture names its session "s-01") — `sessions.id` is a
    // global PK, so it has to be qualified by the transcript id too.
    const sessionId = evalSessionId(namespace, `${transcript.id}-${step.session_id}`);
    const ctx: TenantContext = { merchant_id: merchantId, agent_id: agentId, session_id: sessionId };
    await ensureEvalSession(ctx);

    const repo = new TenantRepo(ctx);
    const collected: AuditEvent[] = [];
    const captureAudit: typeof writeAuditEvent = async (input) => {
      const event = await writeAuditEvent(input);
      collected.push(event);
      return event;
    };

    const outcome = await decide(ctx, { items: step.items }, { repo, writeAudit: captureAudit });
    await persistOrderIfNeeded(repo, ctx, step.items, outcome);

    const audit = collected[0];
    if (audit === undefined) {
      throw new Error(`replayTranscript: decide() wrote no AuditEvent for ${transcript.id} step ${i}`);
    }
    steps.push({ stepIndex: i, sessionId, outcome, audit });
  }

  return { transcript, steps };
}

/**
 * Replays a whole batch in order. Does NOT reset merchant state between
 * transcripts — each transcript already carries its own distinct
 * `agent_id`, and the spend cap is scoped to (merchant_id, agent_id), so
 * cross-transcript interference cannot happen even within one shared
 * merchant. Reset once (via `resetEvalMerchants`) before calling this.
 */
export async function replayBatch<T extends Transcript>(
  namespace: string,
  merchantIds: EvalMerchantIds,
  transcripts: readonly T[],
): Promise<readonly ReplayResult<T>[]> {
  const results: ReplayResult<T>[] = [];
  for (const transcript of transcripts) {
    results.push(await replayTranscript(namespace, merchantIds, transcript));
  }
  return results;
}
