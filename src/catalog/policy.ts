/**
 * Merchant policy ingestion. The on-disk JSON is human-authored (rupees and
 * duration strings); this module converts it to the paise/seconds shape the
 * rest of the system uses and re-validates with the shared `Policy` schema
 * from src/shared/contracts.ts — which is also where the
 * approval_threshold <= spend_cap refine lives, so the unreachable-escalate
 * check is defined exactly once. Postgres's `policy_threshold_reachable`
 * CHECK constraint is the second, independent copy of the same rule.
 */
import { z } from "zod";
import { Policy } from "../shared/contracts";
import { rupeesToPaise } from "./csv";

const WINDOW_UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

/** "24h" | "7d" | "30m" | "3600s" -> seconds. */
export function parseWindow(s: string): number {
  const match = /^(\d+)(s|m|h|d)$/.exec(s.trim());
  if (match === null) {
    throw new Error(
      `Invalid window ${JSON.stringify(s)}: expected a positive integer followed by s, m, h, or d`
    );
  }
  const [, amountStr, unit] = match;
  const amount = Number.parseInt(amountStr!, 10);
  // unit is one of the WINDOW_UNIT_SECONDS keys by construction of the regex.
  const unitSeconds = WINDOW_UNIT_SECONDS[unit!]!;
  return amount * unitSeconds;
}

const RawPolicyInput = z.object({
  spend_cap_rupees: z.string().min(1),
  approval_threshold_rupees: z.string().min(1),
  category_allowlist: z.array(z.string()),
  window: z.string().min(1),
  /**
   * The merchant's cap on the sum across every one of its agents, in rupees.
   *
   * Optional, and blank is the same as absent: both mean NULL, no aggregate
   * constraint — the behaviour that predates the column. `.optional()` rather
   * than `.min(1)` so a form that always posts the field can post "" and a
   * policy JSON written before the column existed still parses.
   */
  merchant_total_cap_rupees: z.string().optional(),
});

/**
 * Blank or absent -> `null`. Delegates to `rupeesToPaise`, the codebase's ONE
 * integer-string rupee converter, because `0.29 * 100` is 28.999999999999996
 * and a second converter would eventually get that wrong.
 *
 * Zero is rejected rather than silently coerced to "no cap": a merchant who
 * types 0 means "allow nothing", and storing that as NULL would mean the exact
 * opposite. The column's own CHECK (> 0) is the second, independent copy of
 * this rule.
 */
function merchantTotalCapToPaise(input: string | undefined): number | null {
  if (input === undefined || input.trim() === "") return null;
  const paise = rupeesToPaise(input);
  if (paise <= 0) {
    throw new Error(
      `Invalid merchant total cap ${JSON.stringify(input)}: must be greater than zero. ` +
        `Leave it blank for no aggregate cap.`
    );
  }
  return paise;
}

export function parsePolicy(json: unknown, merchantId: string): Policy {
  const rawResult = RawPolicyInput.safeParse(json);
  if (!rawResult.success) {
    const messages = rawResult.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`invalid policy input: ${messages}`);
  }
  const raw = rawResult.data;

  const candidate = {
    merchant_id: merchantId,
    spend_cap_paise: rupeesToPaise(raw.spend_cap_rupees),
    approval_threshold_paise: rupeesToPaise(raw.approval_threshold_rupees),
    category_allowlist: raw.category_allowlist,
    window_seconds: parseWindow(raw.window),
    merchant_total_cap_paise: merchantTotalCapToPaise(
      raw.merchant_total_cap_rupees
    ),
  };

  const result = Policy.safeParse(candidate);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => issue.message)
      .join("; ");
    throw new Error(`invalid policy: ${messages}`);
  }
  return result.data;
}
