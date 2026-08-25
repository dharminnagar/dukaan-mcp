/**
 * Renders against real rows written through writeAuditEvent (the one true
 * insert path for audit_events), then asserts on the rendered string —
 * exactly what a viewer sees, not the SQL that produced it.
 *
 * Per src/db/pool.ts's process-wide Pool singleton, this file — like every
 * other test file — must NOT call closePool() in teardown; bun exits fine
 * without it. Test data is namespaced under `m_auditprint_*` /
 * `s_auditprint_*` / `ag_auditprint_*` so it never collides with fixtures
 * another suite depends on.
 */
import { describe, expect, test } from "bun:test";
import {
  fetchAuditRows,
  formatDetail,
  parseArgs,
  relativeTime,
  render,
  USAGE,
  type AuditRow,
} from "../scripts/audit-print";
import { writeAuditEvent } from "../src/audit/write";
import type { AuditEventInput } from "../src/shared/contracts";

const MERCHANT = "m_auditprint_hero";
const AGENT = "ag_auditprint_hero";

function uniqueSession(label: string): string {
  return `s_auditprint_${label}_${crypto.randomUUID().replace(/-/g, "")}`;
}

const baseInput: AuditEventInput = {
  merchant_id: MERCHANT,
  session_id: "s_auditprint_placeholder",
  agent_id: AGENT,
  order_id: null,
  action: "list_products",
  amount_paise: null,
  rule: "ALLOW",
  decision: "allow",
  reason_code: "ALLOWED",
  detail: null,
  latency_ms: 5,
};

/** Strips ANSI escapes so a colour-mode render can be asserted on by text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("audit-print", () => {
  test("the three-event hero sequence renders in ts order: list, block, then allow", async () => {
    const sessionId = uniqueSession("hero");

    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "list_products",
      detail: { count: 4 },
    });
    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "checkout",
      amount_paise: 11400,
      rule: "CATEGORY_ALLOWLIST",
      decision: "block",
      reason_code: "CATEGORY_NOT_ALLOWED",
      detail: { item_id: "sku-1", category: "electronics" },
    });
    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "checkout",
      amount_paise: 2500,
      rule: "ALLOW",
      decision: "allow",
      reason_code: "ALLOWED",
      detail: { item_count: 1 },
    });

    const args = parseArgs([`--session=${sessionId}`]);
    const rows = await fetchAuditRows(args);
    expect(rows.length).toBe(3);

    const actions = rows.map((r) => r.action);
    const decisions = rows.map((r) => r.decision);
    expect(actions).toEqual(["list_products", "checkout", "checkout"]);
    expect(decisions).toEqual(["allow", "block", "allow"]);
    // ts strictly non-decreasing in the order returned (ASC by ts).
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.ts.getTime()).toBeGreaterThanOrEqual(
        rows[i - 1]!.ts.getTime()
      );
    }

    const output = render(args, rows, { useColor: false, now: new Date() });
    const lines = output.split("\n").filter((l) => l.trim().length > 0);
    const bodyLines = lines.slice(
      lines.findIndex((l) => l.includes("ACTION")) + 1
    );

    expect(bodyLines.length).toBeGreaterThanOrEqual(3);
    // Each event appears, and in the right relative order top-to-bottom.
    const listIdx = bodyLines.findIndex((l) => l.includes("list_products"));
    const blockIdx = bodyLines.findIndex((l) => l.includes("BLOCK"));
    const allowCheckoutIdx = bodyLines.findIndex(
      (l, i) => l.includes("checkout") && i !== blockIdx
    );
    expect(listIdx).toBeGreaterThanOrEqual(0);
    expect(blockIdx).toBeGreaterThan(listIdx);
    expect(allowCheckoutIdx).toBeGreaterThan(blockIdx);

    expect(output).toContain("₹114.00");
    expect(output).toContain("₹25.00");
    expect(output).toContain('category "electronics" not allowed');
  });

  test("a NULL amount_paise renders as a dash, never ₹0.00", async () => {
    const sessionId = uniqueSession("null-amount");
    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "list_products",
      amount_paise: null,
      detail: { count: 2 },
    });

    const args = parseArgs([`--session=${sessionId}`]);
    const rows = await fetchAuditRows(args);
    const output = render(args, rows, { useColor: false, now: new Date() });

    expect(output).not.toContain("₹0.00");
    // The amount column for this row must be the dash placeholder, not blank
    // digits or a fabricated currency value.
    const bodyLine = output
      .split("\n")
      .find((l) => l.includes("list_products"));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).toMatch(/—\s+\d+ms\s*$/);
  });

  test("a row whose agent no longer exists still renders (audit_events has no FK)", async () => {
    const sessionId = uniqueSession("orphan-agent");
    const orphanAgentId = `ag_auditprint_deleted_${crypto.randomUUID().replace(/-/g, "")}`;

    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      agent_id: orphanAgentId, // never inserted into `agents` — proves no join is required
      action: "list_products",
      detail: { count: 1 },
    });

    const args = parseArgs([`--session=${sessionId}`]);
    const rows = await fetchAuditRows(args);
    expect(rows.length).toBe(1);
    expect(rows[0]!.agent_id).toBe(orphanAgentId);

    const output = render(args, rows, { useColor: false, now: new Date() });
    expect(output).toContain("list_products");
  });

  test("non-TTY (useColor: false) output contains no ANSI escapes", async () => {
    const sessionId = uniqueSession("no-ansi");
    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "checkout",
      amount_paise: 5000,
      rule: "SPEND_CAP",
      decision: "block",
      reason_code: "SPEND_CAP_EXCEEDED",
      detail: { spent_paise: 9000, cap_paise: 10000, attempted_paise: 5000 },
    });

    const args = parseArgs([`--session=${sessionId}`]);
    const rows = await fetchAuditRows(args);
    const output = render(args, rows, { useColor: false, now: new Date() });

    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(output)).toBe(false);
    expect(output).toContain("BLOCK");
  });

  test("useColor: true wraps the decision cell in ANSI codes that strip back to the same text", async () => {
    const sessionId = uniqueSession("ansi");
    await writeAuditEvent({
      ...baseInput,
      session_id: sessionId,
      action: "list_products",
    });

    const args = parseArgs([`--session=${sessionId}`]);
    const rows = await fetchAuditRows(args);
    const now = new Date();
    const colored = render(args, rows, { useColor: true, now });
    const plain = render(args, rows, { useColor: false, now });

    // eslint-disable-next-line no-control-regex
    expect(/\x1b\[/.test(colored)).toBe(true);
    expect(stripAnsi(colored)).toBe(plain);
  });

  test("the usage block prints when no filter flag is passed", () => {
    const args = parseArgs([]);
    const output = render(args, [], { useColor: false, now: new Date() });

    expect(output).toBe(USAGE);
    expect(output.toLowerCase()).toContain("usage");
    expect(output).toContain("--session=<id>");
  });

  test("--limit is respected and defaults sanely", () => {
    const withLimit = parseArgs(["--merchant=m_x", "--limit=3"]);
    expect(withLimit.limit).toBe(3);

    const withoutLimit = parseArgs(["--merchant=m_x"]);
    expect(withoutLimit.limit).toBeGreaterThan(0);

    expect(() => parseArgs(["--limit=0"])).toThrow();
    expect(() => parseArgs(["--limit=nope"])).toThrow();
  });

  test("relativeTime renders short strings, never a full ISO timestamp", () => {
    const now = new Date("2026-08-24T12:00:00.000Z");
    expect(relativeTime(new Date("2026-08-24T11:59:59.500Z"), now)).toBe(
      "just now"
    );
    expect(relativeTime(new Date("2026-08-24T11:59:30.000Z"), now)).toBe(
      "30s ago"
    );
    expect(relativeTime(new Date("2026-08-24T11:00:00.000Z"), now)).toBe(
      "1h ago"
    );
    for (const value of [
      relativeTime(new Date("2026-08-23T12:00:00.000Z"), now),
      relativeTime(new Date("2026-08-24T11:59:30.000Z"), now),
    ]) {
      expect(value).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    }
  });

  test("formatDetail surfaces the specific numbers per reason code, not raw JSON", () => {
    const row = (overrides: Partial<AuditRow>): AuditRow => ({
      id: "ae_x",
      merchant_id: MERCHANT,
      session_id: "s_x",
      agent_id: AGENT,
      order_id: null,
      action: "checkout",
      amount_paise: null,
      rule: "ALLOW",
      decision: "allow",
      reason_code: "ALLOWED",
      detail: null,
      latency_ms: 1,
      ts: new Date(),
      ...overrides,
    });

    expect(formatDetail(row({}))).toBe("—");

    expect(
      formatDetail(
        row({
          reason_code: "STALE_CATALOG",
          detail: { mismatch: "price", true_price_paise: 12000 },
        })
      )
    ).toContain("₹120.00");

    expect(
      formatDetail(
        row({
          reason_code: "STALE_CATALOG",
          detail: {
            mismatch: "stock",
            requested_quantity: 5,
            true_stock: 2,
          },
        })
      )
    ).toContain("2");

    expect(
      formatDetail(
        row({
          reason_code: "SPEND_CAP_EXCEEDED",
          detail: {
            spent_paise: 9000,
            cap_paise: 10000,
            attempted_paise: 5000,
          },
        })
      )
    ).toBe("spent ₹90.00 of ₹100.00 cap");

    expect(
      formatDetail(
        row({
          reason_code: "CATEGORY_NOT_ALLOWED",
          detail: { item_id: "sku-1", category: "electronics" },
        })
      )
    ).toBe('category "electronics" not allowed');

    expect(
      formatDetail(
        row({
          reason_code: "PENDING_APPROVAL",
          amount_paise: 50000,
          detail: { approval_threshold_paise: 40000 },
        })
      )
    ).toContain("₹500.00");

    expect(
      formatDetail(
        row({
          reason_code: "RAZORPAY_ERROR",
          detail: { http_status: 502, razorpay_code: "GATEWAY_ERROR" },
        })
      )
    ).toBe("razorpay HTTP 502 (GATEWAY_ERROR)");

    expect(
      formatDetail(
        row({ reason_code: "INVALID_REQUEST", detail: { field: "items" } })
      )
    ).toBe('invalid field "items"');
  });
});
