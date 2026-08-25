/**
 * Razorpay Orders API adapter (DUK-16).
 *
 * `createOrder` NEVER throws for an API-level failure. Every HTTP outcome —
 * 429, 5xx, a malformed body — becomes `{ ok: false, error }` so the buyer
 * agent gets a re-plannable result instead of an unhandled rejection. A throw
 * here is reserved for a programmer error the caller cannot recover from at
 * runtime: a non-test key, or a `CreateOrderInput` that violates its own
 * invariants (non-integer/non-positive paise, a blank id field).
 *
 * RETRY POLICY: Razorpay documents that a rate limiter exists and that 429
 * should be handled with "randomized exponential backoff," but publishes no
 * numeric limits to target. We do exactly what is documented and stop there:
 * on 429, wait `random() * BASE_DELAY_MS * 2^attempt` (full jitter, so
 * concurrent callers don't retry in lockstep) and retry ONCE. A second 429,
 * or any non-429 failure, gives up immediately — this is a payment path, and
 * an autonomous agent looping on it is a worse failure mode than surfacing
 * `{ ok: false }` and letting the gate escalate to a human. Non-429 failures
 * (500, network error) are never retried; only Razorpay's own documented
 * rate-limit signal earns a retry.
 *
 * PAISE INVARIANT: `amount_paise` is sent to Razorpay's `amount` field
 * verbatim, as an integer. No rupee/paise conversion happens in this module —
 * that boundary is `rupeesToPaise` in `src/catalog/csv.ts`, and it is the
 * only place float math on money is allowed to *not* happen. This module
 * only asserts the invariant already holds by the time it gets here.
 *
 * NEVER logs the key or secret, in any code path, success or failure —
 * matching `scripts/smoke-razorpay.ts`, which this adapter supersedes as the
 * production path. Refuses to construct against a key that does not start
 * with `rzp_test_`, because the Orders API base URL is identical for test
 * and live and the key prefix is the only guard.
 */
import type { RazorpayError } from "../shared/contracts";

export interface CreateOrderInput {
  readonly amount_paise: number;
  readonly merchant_id: string;
  readonly session_id: string;
  readonly receipt: string;
}

export type CreateOrderResult =
  | { readonly ok: true; readonly razorpay_order_id: string }
  | { readonly ok: false; readonly error: RazorpayError };

export interface RazorpayAdapter {
  createOrder(input: CreateOrderInput): Promise<CreateOrderResult>;
}

const ORDERS_URL = "https://api.razorpay.com/v1/orders";

/** Retries capped at 1: one initial attempt plus one retry, never more. */
const MAX_RETRIES = 1;

/** Full-jitter base. The actual wait is `random() * BASE_DELAY_MS * 2^attempt`. */
const BASE_DELAY_MS = 500;

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

/** Throws — these are caller bugs, not API-level failures. */
function validateInput(input: CreateOrderInput): void {
  if (!Number.isInteger(input.amount_paise) || input.amount_paise <= 0) {
    throw new Error(
      `createOrder: amount_paise must be a positive integer, got ${JSON.stringify(input.amount_paise)}`
    );
  }
  if (!nonBlank(input.merchant_id)) {
    throw new Error("createOrder: merchant_id must not be blank");
  }
  if (!nonBlank(input.session_id)) {
    throw new Error("createOrder: session_id must not be blank");
  }
  if (!nonBlank(input.receipt)) {
    throw new Error("createOrder: receipt must not be blank");
  }
}

interface RazorpayOrderBody {
  id?: unknown;
}

interface RazorpayErrorBody {
  error?: { code?: unknown; description?: unknown };
}

/** Razorpay's error body carries `{ error: { code, description, ... } }`. Best-effort; never throws. */
function extractRazorpayCode(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as RazorpayErrorBody;
    return typeof parsed.error?.code === "string" ? parsed.error.code : null;
  } catch {
    return null;
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function razorpayError(
  message: string,
  httpStatus: number | null,
  razorpayCode: string | null,
  retryable: boolean
): RazorpayError {
  return {
    reason_code: "RAZORPAY_ERROR",
    message,
    http_status: httpStatus,
    razorpay_code: razorpayCode,
    retryable,
  };
}

export interface RazorpayHttpAdapterDeps {
  /** Defaults to the global `fetch`. Tests stub this. */
  readonly fetch?: typeof fetch;
  /** Defaults to a real `setTimeout`-backed sleep. Tests inject a fast/spyable one. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Defaults to `Math.random`. Tests inject a fixed value to assert the jitter formula. */
  readonly random?: () => number;
}

/**
 * The real adapter: `POST https://api.razorpay.com/v1/orders` over HTTP
 * Basic auth. See the module comment for the retry policy and why it never
 * throws for an API-level failure.
 */
export class RazorpayHttpAdapter implements RazorpayAdapter {
  private readonly authorizationHeader: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly randomFn: () => number;

  constructor(
    keyId: string,
    keySecret: string,
    deps: RazorpayHttpAdapterDeps = {}
  ) {
    if (!keyId.startsWith("rzp_test_")) {
      throw new Error(
        "RazorpayHttpAdapter: RAZORPAY_KEY_ID does not start with rzp_test_. Refusing to construct: " +
          "the Orders API base URL is identical for test and live, so the key prefix is the only guard " +
          "against this adapter accidentally moving real money."
      );
    }
    // Never retained as a bare keyId/keySecret field — pre-encoded once here
    // so no later code path can log the raw secret by accident.
    this.authorizationHeader = `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString("base64")}`;
    this.fetchFn = deps.fetch ?? fetch;
    this.sleepFn =
      deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomFn = deps.random ?? Math.random;
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    validateInput(input);

    const body = JSON.stringify({
      amount: input.amount_paise,
      currency: "INR",
      receipt: input.receipt,
      notes: { merchant_id: input.merchant_id, session_id: input.session_id },
    });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let response: Response;
      try {
        response = await this.fetchFn(ORDERS_URL, {
          method: "POST",
          headers: {
            authorization: this.authorizationHeader,
            "content-type": "application/json",
          },
          body,
        });
      } catch (err) {
        // Network-level failure (DNS, connection reset, timeout). Not a 429,
        // so it does not get the retry budget — see the module comment.
        return {
          ok: false,
          error: razorpayError(
            `Network error contacting Razorpay: ${(err as Error).message}`,
            null,
            null,
            true
          ),
        };
      }

      if (response.ok) {
        const parsed = (await response.json()) as RazorpayOrderBody;
        if (typeof parsed.id !== "string" || !parsed.id.startsWith("order_")) {
          return {
            ok: false,
            error: razorpayError(
              `Razorpay returned HTTP ${response.status} with no valid order_ id in the body`,
              response.status,
              null,
              false
            ),
          };
        }
        return { ok: true, razorpay_order_id: parsed.id };
      }

      const canRetry = response.status === 429 && attempt < MAX_RETRIES;
      if (canRetry) {
        const delayMs = this.randomFn() * BASE_DELAY_MS * 2 ** attempt;
        await this.sleepFn(delayMs);
        continue;
      }

      const text = await safeReadText(response);
      return {
        ok: false,
        error: razorpayError(
          `Razorpay returned HTTP ${response.status}${text ? `: ${text}` : ""}`,
          response.status,
          extractRazorpayCode(text),
          response.status === 429 || response.status >= 500
        ),
      };
    }

    // Unreachable: the loop above always returns on its last iteration
    // (attempt === MAX_RETRIES never satisfies canRetry).
    throw new Error(
      "createOrder: retry loop exited without returning — this is a bug in RazorpayHttpAdapter"
    );
  }
}

/**
 * Test double for DUK-13's handler tests and DUK-14's gate tests. Scriptable
 * FIFO response queue plus a call counter/log, so "assert zero calls on the
 * block path" is `expect(adapter.callCount).toBe(0)` and "assert the escalate
 * path never reaches Razorpay" is the same one-liner.
 */
export class FakeRazorpayAdapter implements RazorpayAdapter {
  callCount = 0;
  readonly calls: CreateOrderInput[] = [];
  private readonly queue: CreateOrderResult[];

  constructor(responses: readonly CreateOrderResult[] = []) {
    this.queue = [...responses];
  }

  /** Queue one more response, FIFO, for a future `createOrder` call. */
  enqueue(result: CreateOrderResult): void {
    this.queue.push(result);
  }

  async createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
    this.callCount += 1;
    this.calls.push(input);
    const next = this.queue.shift();
    if (next === undefined) {
      throw new Error(
        "FakeRazorpayAdapter.createOrder called with an empty response queue — call enqueue() first."
      );
    }
    return next;
  }
}
