/**
 * `bun run audit --session=<id> | --merchant=<id> | --agent=<id> [--limit=<n>]`
 *
 * DUK-20 traded a browser audit view for this CLI printer: next to a
 * terminal agent trace, a coloured terminal table reads better on camera
 * than a browser tab switch. This is a video asset first, a debugging tool
 * second — the hero case is `--session=<id>` printing the three linked
 * events of a block-then-re-plan-then-succeed sequence in the order they
 * happened, legible with no SQL knowledge and no squinting.
 *
 * `audit_events` has NO foreign keys by design (see migrations/0001_init.sql)
 * so a session/agent id may outlive the agent or merchant it named — every
 * query here is a plain WHERE on audit_events itself, never a join, so those
 * rows keep showing up after the thing they reference is gone.
 */
import { closePool, query } from "../src/db/pool";
import type { ReasonCode } from "../src/shared/contracts";

interface AuditRow {
  readonly id: string;
  readonly merchant_id: string;
  readonly session_id: string;
  readonly agent_id: string;
  readonly order_id: string | null;
  readonly action: string;
  readonly amount_paise: number | null;
  readonly rule: string;
  readonly decision: string;
  readonly reason_code: string;
  readonly detail: Record<string, unknown> | null;
  readonly latency_ms: number;
  readonly ts: Date;
}

const DEFAULT_LIMIT = 50;

/* ------------------------------------------------------------------- CLI args */

export interface ParsedArgs {
  readonly session: string | null;
  readonly merchant: string | null;
  readonly agent: string | null;
  readonly limit: number;
}

function flagValue(argv: readonly string[], name: string): string | null {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found === undefined ? null : found.slice(prefix.length);
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const limitRaw = flagValue(argv, "limit");
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== null) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`--limit must be a positive integer, got "${limitRaw}"`);
    }
    limit = parsed;
  }
  return {
    session: flagValue(argv, "session"),
    merchant: flagValue(argv, "merchant"),
    agent: flagValue(argv, "agent"),
    limit,
  };
}

export const USAGE = `\
Usage: bun run audit [--session=<id>] [--merchant=<id>] [--agent=<id>] [--limit=<n>]

At least one of --session, --merchant, --agent is required.

  --session=<id>   Every event in one session, in the order it happened.
                    The hero case: a block followed by a re-plan that succeeds.
  --merchant=<id>  Every event for a merchant, most recent first.
  --agent=<id>     Every event for an agent, most recent first.
                    Combine with --merchant to hit the composite index.
  --limit=<n>      Max rows to print (default ${DEFAULT_LIMIT}).

Examples:
  bun run audit --session=s_q5o4uS1mrmtdWLcnVgdWWg
  bun run audit --merchant=m_demo_kirana --limit=20
`;

/* ------------------------------------------------------------------- fetch */

const SELECT_COLUMNS = `
  id, merchant_id, session_id, agent_id, order_id, action,
  amount_paise, rule, decision, reason_code, detail, latency_ms, ts
`;

/**
 * One query path per filter, each hitting the index migrations/0001_init.sql
 * declared for it. Deliberately no joins to agents/merchants/sessions: the
 * no-FK design on audit_events exists so evidence survives a deletion, and a
 * join here would silently drop exactly the rows that guarantee protects.
 */
export async function fetchAuditRows(
  args: ParsedArgs
): Promise<readonly AuditRow[]> {
  if (args.session !== null) {
    // idx_audit_session (session_id, ts) — ASC so the story reads in the
    // order it happened, not most-recent-first.
    return query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events WHERE session_id = $1 ORDER BY ts ASC LIMIT $2`,
      [args.session, args.limit]
    );
  }
  if (args.merchant !== null && args.agent !== null) {
    // idx_audit_agent (merchant_id, agent_id, ts DESC)
    return query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events
       WHERE merchant_id = $1 AND agent_id = $2 ORDER BY ts DESC LIMIT $3`,
      [args.merchant, args.agent, args.limit]
    );
  }
  if (args.merchant !== null) {
    // idx_audit_merchant (merchant_id, ts DESC)
    return query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events WHERE merchant_id = $1 ORDER BY ts DESC LIMIT $2`,
      [args.merchant, args.limit]
    );
  }
  if (args.agent !== null) {
    // No index has agent_id as a leading column on its own; pair with
    // --merchant when the caller has it, to hit idx_audit_agent instead.
    return query<AuditRow>(
      `SELECT ${SELECT_COLUMNS} FROM audit_events WHERE agent_id = $1 ORDER BY ts DESC LIMIT $2`,
      [args.agent, args.limit]
    );
  }
  return [];
}

/* -------------------------------------------------------------- rendering */

const COLOR = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
} as const;

function paint(
  text: string,
  codes: readonly string[],
  useColor: boolean
): string {
  if (!useColor) return text;
  return `${codes.join("")}${text}${COLOR.reset}`;
}

function padRight(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

function formatRupees(paise: number): string {
  const rupees = (paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `₹${rupees}`;
}

/** Human elapsed time since `ts`, short enough to read at video resolution. */
export function relativeTime(ts: Date, now: Date): string {
  const deltaMs = now.getTime() - ts.getTime();
  const past = deltaMs >= 0;
  const abs = Math.abs(deltaMs);
  const suffix = past ? "ago" : "away";

  if (abs < 1_000) return past ? "just now" : "in <1s";
  if (abs < 60_000) return `${Math.floor(abs / 1_000)}s ${suffix}`;
  if (abs < 3_600_000) return `${Math.floor(abs / 60_000)}m ${suffix}`;
  if (abs < 86_400_000) return `${Math.floor(abs / 3_600_000)}h ${suffix}`;
  return `${Math.floor(abs / 86_400_000)}d ${suffix}`;
}

/**
 * The whole point of the frame: block must never read like allow at a
 * glance. Word choice carries that when colour is stripped for a non-TTY
 * pipe; colour carries it again on top when a TTY is attached.
 */
function decisionCell(decision: string, useColor: boolean): string {
  const label = padRight(decision.toUpperCase(), "ESCALATE".length);
  if (decision === "allow") return paint(label, [COLOR.green], useColor);
  if (decision === "block")
    return paint(label, [COLOR.bold, COLOR.red], useColor);
  if (decision === "escalate")
    return paint(label, [COLOR.bold, COLOR.yellow], useColor);
  return label;
}

/**
 * Surfaces the handful of `detail` fields that make each reason code
 * explicable, per the actual shapes src/gate/index.ts and src/mcp/http.ts
 * write (not the full ToolError envelope, which carries more than the audit
 * row keeps). ALLOWED rows render as a dash: the story this tool tells is
 * about the block, not the routine reads around it.
 */
export function formatDetail(row: AuditRow): string {
  const reasonCode = row.reason_code as ReasonCode;
  const d = row.detail ?? {};
  const num = (key: string): number | null =>
    typeof d[key] === "number" ? (d[key] as number) : null;
  const str = (key: string): string | null =>
    typeof d[key] === "string" ? (d[key] as string) : null;

  switch (reasonCode) {
    case "ALLOWED":
      return "—";
    case "STALE_CATALOG": {
      const mismatch = str("mismatch");
      if (mismatch === "price") {
        const truePrice = num("true_price_paise");
        return `stale price — catalog is now ${truePrice === null ? "?" : formatRupees(truePrice)}`;
      }
      if (mismatch === "stock") {
        const requested = num("requested_quantity");
        const trueStock = num("true_stock");
        return `stale stock — asked for ${requested ?? "?"}, only ${trueStock ?? "?"} left`;
      }
      if (mismatch === "missing") return "item no longer in catalog";
      return "stale catalog";
    }
    case "SPEND_CAP_EXCEEDED": {
      const spent = num("spent_paise");
      const cap = num("cap_paise");
      // WHOSE cap bound is the point of a three-party limit, so name it. Absent
      // on rows written before DUK-31, hence the fallback to the bare figure
      // rather than printing "bound by ?" over historical audit data.
      const boundBy = str("bound_by");
      const suffix = boundBy === null ? " cap" : ` cap (${boundBy}'s)`;
      return `spent ${spent === null ? "?" : formatRupees(spent)} of ${cap === null ? "?" : formatRupees(cap)}${suffix}`;
    }
    case "CATEGORY_NOT_ALLOWED": {
      const category = str("category") ?? "?";
      return `category "${category}" not allowed`;
    }
    case "PENDING_APPROVAL": {
      const threshold = num("approval_threshold_paise");
      const amount = row.amount_paise;
      const amountStr = amount === null ? "?" : formatRupees(amount);
      const thresholdStr = threshold === null ? "?" : formatRupees(threshold);
      return `${amountStr} over ${thresholdStr} threshold — needs approval`;
    }
    case "RAZORPAY_ERROR": {
      const status = num("http_status");
      const code = str("razorpay_code");
      return `razorpay HTTP ${status ?? "?"}${code === null ? "" : ` (${code})`}`;
    }
    case "UNAUTHENTICATED":
      return "unauthenticated";
    case "INVALID_REQUEST": {
      const field = str("field");
      return field === null ? "invalid request" : `invalid field "${field}"`;
    }
    default: {
      // Exhaustiveness guard: a new reason code needs a case above.
      throw new Error(
        `audit-print: unhandled reason_code "${reasonCode as string}"`
      );
    }
  }
}

export interface RenderOptions {
  readonly useColor: boolean;
  readonly now: Date;
  readonly showSession: boolean;
}

const DETAIL_WIDTH = 46;

function renderTable(rows: readonly AuditRow[], opts: RenderOptions): string {
  if (rows.length === 0) return "(no matching audit events)";

  const cells = rows.map((row, i) => ({
    idx: String(i + 1),
    time: relativeTime(row.ts, opts.now),
    session: row.session_id,
    action: row.action,
    decision: decisionCell(row.decision, opts.useColor),
    detail: truncate(formatDetail(row), DETAIL_WIDTH),
    amount: row.amount_paise === null ? "—" : formatRupees(row.amount_paise),
    latency: `${row.latency_ms}ms`,
  }));

  const idxWidth = Math.max(1, ...cells.map((c) => c.idx.length));
  const timeWidth = Math.max(4, ...cells.map((c) => c.time.length));
  const sessionWidth = opts.showSession
    ? Math.max(7, ...cells.map((c) => c.session.length))
    : 0;
  const actionWidth = Math.max(6, ...cells.map((c) => c.action.length));
  const detailWidth = Math.max(4, ...cells.map((c) => c.detail.length));
  const amountWidth = Math.max(6, ...cells.map((c) => c.amount.length));
  const latencyWidth = Math.max(3, ...cells.map((c) => c.latency.length));

  const headerCells = [
    padLeft("#", idxWidth),
    padRight("TIME", timeWidth),
    ...(opts.showSession ? [padRight("SESSION", sessionWidth)] : []),
    padRight("ACTION", actionWidth),
    padRight("DECISION", "ESCALATE".length),
    padRight("DETAIL", detailWidth),
    padLeft("AMOUNT", amountWidth),
    padLeft("LAT", latencyWidth),
  ];
  const header = paint(headerCells.join("  "), [COLOR.dim], opts.useColor);

  const lines = cells.map((c) => {
    const rowCells = [
      padLeft(c.idx, idxWidth),
      padRight(c.time, timeWidth),
      ...(opts.showSession ? [padRight(c.session, sessionWidth)] : []),
      padRight(c.action, actionWidth),
      c.decision,
      padRight(c.detail, detailWidth),
      padLeft(c.amount, amountWidth),
      padLeft(c.latency, latencyWidth),
    ];
    return rowCells.join("  ");
  });

  return [header, ...lines].join("\n");
}

/**
 * "Whether any order resulted" is not a single column: the ALLOW checkout
 * audit row is written BEFORE the Razorpay call (src/gate/index.ts), so it
 * carries no order_id even on eventual success, and a Razorpay-side failure
 * or an approval escalation is a SEPARATE row written after. This reads the
 * rows honestly rather than guessing from decision counts alone.
 */
function orderOutcome(rows: readonly AuditRow[]): string {
  const failed = rows.find(
    (r) => r.reason_code === "RAZORPAY_ERROR" && r.order_id !== null
  );
  if (failed !== undefined) {
    return `checkout allowed, Razorpay failed (order ${failed.order_id})`;
  }
  const escalated = rows.find(
    (r) => r.decision === "escalate" && r.order_id !== null
  );
  if (escalated !== undefined) {
    return `order ${escalated.order_id} escalated for approval`;
  }
  const completed = rows.some(
    (r) => r.decision === "allow" && r.action === "checkout"
  );
  return completed ? "order completed" : "no order resulted";
}

function summaryLine(rows: readonly AuditRow[]): string {
  const allow = rows.filter((r) => r.decision === "allow").length;
  const block = rows.filter((r) => r.decision === "block").length;
  const escalate = rows.filter((r) => r.decision === "escalate").length;
  return `${rows.length} event(s) — ${allow} allow, ${block} block, ${escalate} escalate — ${orderOutcome(rows)}`;
}

function headerLine(args: ParsedArgs): string {
  if (args.session !== null) return `session ${args.session}`;
  if (args.merchant !== null && args.agent !== null)
    return `merchant ${args.merchant}, agent ${args.agent} (most recent first)`;
  if (args.merchant !== null)
    return `merchant ${args.merchant} (most recent first)`;
  return `agent ${args.agent} (most recent first)`;
}

export function render(
  args: ParsedArgs,
  rows: readonly AuditRow[],
  opts: Pick<RenderOptions, "useColor" | "now">
): string {
  if (args.session === null && args.merchant === null && args.agent === null) {
    return USAGE;
  }

  const showSession = args.session === null;
  const table = renderTable(rows, { ...opts, showSession });

  return [
    `audit trail — ${headerLine(args)}`,
    "",
    table,
    "",
    summaryLine(rows),
  ].join("\n");
}

/* ---------------------------------------------------------------------- CLI */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.session === null && args.merchant === null && args.agent === null) {
    console.log(USAGE);
    return;
  }

  const rows = await fetchAuditRows(args);
  const useColor = process.stdout.isTTY === true;
  console.log(render(args, rows, { useColor, now: new Date() }));
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await closePool();
  }
}

export type { AuditRow };
