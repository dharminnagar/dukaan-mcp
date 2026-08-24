import { describe, expect, mock, test } from 'bun:test';
import { FakeRazorpayAdapter, RazorpayHttpAdapter } from '../src/razorpay';
import type { CreateOrderInput, CreateOrderResult } from '../src/razorpay';

/**
 * This suite never touches the network or the DB — `fetch` and `sleep` are
 * both injected per `RazorpayHttpAdapterDeps`, which keeps `bun run eval`'s
 * reproducibility claim (fast, offline, free) intact. See
 * `scripts/smoke-razorpay.ts` for the one live check, run manually and kept
 * out of `bun test`.
 */

const TEST_KEY_ID = 'rzp_test_fake0000000001';
const TEST_KEY_SECRET = 'fake_secret_value_should_never_be_logged';

const BASE_INPUT: CreateOrderInput = {
  amount_paise: 4999,
  merchant_id: 'm_rzp_test',
  session_id: 's_rzp_test',
  receipt: 'rzp-test-receipt-1',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function orderBody(id: string): unknown {
  return { id, entity: 'order', amount: 4999, currency: 'INR', status: 'created' };
}

function razorpayErrorBody(code: string, description: string): unknown {
  return { error: { code, description } };
}

/** Builds fetch mock + sleep spy + a fixed random, wired into one adapter. */
function buildAdapter(
  responses: Response[],
  opts: { random?: () => number } = {},
): {
  adapter: RazorpayHttpAdapter;
  fetchMock: ReturnType<typeof mock>;
  sleepMock: ReturnType<typeof mock>;
} {
  let call = 0;
  const fetchMock = mock(async (_url: string, _init?: RequestInit) => {
    const response = responses[call];
    call += 1;
    if (response === undefined) {
      throw new Error('fetchMock called more times than responses were scripted');
    }
    return response;
  });
  const sleepMock = mock(async (_ms: number) => undefined);

  const adapter = new RazorpayHttpAdapter(TEST_KEY_ID, TEST_KEY_SECRET, {
    fetch: fetchMock as unknown as typeof fetch,
    sleep: sleepMock as unknown as (ms: number) => Promise<void>,
    random: opts.random,
  });
  return { adapter, fetchMock, sleepMock };
}

describe('RazorpayHttpAdapter — retry policy', () => {
  test('429 then success: retries once, applies a randomized backoff, and returns the order id', async () => {
    const { adapter, fetchMock, sleepMock } = buildAdapter(
      [jsonResponse(429, razorpayErrorBody('BAD_REQUEST_ERROR', 'Too many requests')), jsonResponse(200, orderBody('order_ABC123'))],
      { random: () => 0.4 },
    );

    const result = await adapter.createOrder(BASE_INPUT);

    expect(result).toEqual({ ok: true, razorpay_order_id: 'order_ABC123' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
    // BASE_DELAY_MS(500) * random(0.4) * 2^0 = 200
    expect(sleepMock.mock.calls[0]?.[0]).toBeCloseTo(200, 5);
  });

  test('the backoff delay is randomized, not a fixed constant', async () => {
    const low = buildAdapter(
      [jsonResponse(429, razorpayErrorBody('X', 'x')), jsonResponse(200, orderBody('order_LOW'))],
      { random: () => 0.1 },
    );
    const high = buildAdapter(
      [jsonResponse(429, razorpayErrorBody('X', 'x')), jsonResponse(200, orderBody('order_HIGH'))],
      { random: () => 0.9 },
    );

    await low.adapter.createOrder(BASE_INPUT);
    await high.adapter.createOrder(BASE_INPUT);

    const lowDelay = low.sleepMock.mock.calls[0]?.[0] as number;
    const highDelay = high.sleepMock.mock.calls[0]?.[0] as number;
    expect(lowDelay).not.toEqual(highDelay);
    expect(lowDelay).toBeLessThan(highDelay);
  });

  test('two consecutive 429s: gives up after exactly one retry, no loop, returns RAZORPAY_ERROR', async () => {
    const { adapter, fetchMock, sleepMock } = buildAdapter([
      jsonResponse(429, razorpayErrorBody('BAD_REQUEST_ERROR', 'Too many requests')),
      jsonResponse(429, razorpayErrorBody('BAD_REQUEST_ERROR', 'Too many requests')),
    ]);

    const result = await adapter.createOrder(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason_code).toBe('RAZORPAY_ERROR');
      expect(result.error.http_status).toBe(429);
      expect(result.error.retryable).toBe(true);
    }
    // Capped at 1 retry: exactly 2 fetch calls, exactly 1 sleep, never a 3rd attempt.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleepMock).toHaveBeenCalledTimes(1);
  });

  test('a 500 is never retried: one fetch call, {ok:false}, no throw', async () => {
    const { adapter, fetchMock, sleepMock } = buildAdapter([
      jsonResponse(500, razorpayErrorBody('SERVER_ERROR', 'Something went wrong')),
    ]);

    const result = await adapter.createOrder(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason_code).toBe('RAZORPAY_ERROR');
      expect(result.error.http_status).toBe(500);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleepMock).toHaveBeenCalledTimes(0);
  });
});

describe('RazorpayHttpAdapter — success path', () => {
  test('returns an order_-prefixed id and sends integer paise plus both notes fields', async () => {
    const { adapter, fetchMock } = buildAdapter([jsonResponse(200, orderBody('order_TTgT79PWPuu8Fh'))]);

    const result = await adapter.createOrder(BASE_INPUT);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.razorpay_order_id.startsWith('order_')).toBe(true);
    }

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string) as {
      amount: number;
      currency: string;
      receipt: string;
      notes: { merchant_id: string; session_id: string };
    };
    expect(Number.isInteger(sentBody.amount)).toBe(true);
    expect(sentBody.amount).toBe(BASE_INPUT.amount_paise);
    expect(sentBody.currency).toBe('INR');
    expect(sentBody.notes.merchant_id).toBe(BASE_INPUT.merchant_id);
    expect(sentBody.notes.session_id).toBe(BASE_INPUT.session_id);
  });

  test('a 2xx body without a valid order_ id is a RAZORPAY_ERROR, not a throw', async () => {
    const { adapter } = buildAdapter([jsonResponse(200, { id: 'not-an-order-id' })]);

    const result = await adapter.createOrder(BASE_INPUT);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.reason_code).toBe('RAZORPAY_ERROR');
  });
});

describe('RazorpayHttpAdapter — programmer-error guards (throw, not {ok:false})', () => {
  test('refuses to construct against a non-test key', () => {
    expect(() => new RazorpayHttpAdapter('rzp_live_should_never_be_used', TEST_KEY_SECRET)).toThrow(/rzp_test_/);
  });

  test('throws on a non-integer amount_paise', async () => {
    const { adapter } = buildAdapter([jsonResponse(200, orderBody('order_X'))]);
    await expect(adapter.createOrder({ ...BASE_INPUT, amount_paise: 49.99 })).rejects.toThrow();
  });

  test('throws on a non-positive amount_paise', async () => {
    const { adapter } = buildAdapter([jsonResponse(200, orderBody('order_X'))]);
    await expect(adapter.createOrder({ ...BASE_INPUT, amount_paise: 0 })).rejects.toThrow();
  });

  test('throws on a blank merchant_id', async () => {
    const { adapter } = buildAdapter([jsonResponse(200, orderBody('order_X'))]);
    await expect(adapter.createOrder({ ...BASE_INPUT, merchant_id: '  ' })).rejects.toThrow();
  });
});

describe('RazorpayHttpAdapter — the key and secret never reach a log or an error message', () => {
  test('across a full success/failure/throw matrix, no console call and no result ever contains the secret', async () => {
    const consoleCalls: unknown[][] = [];
    const originalLog = console.log;
    const originalError = console.error;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => consoleCalls.push(args);
    console.error = (...args: unknown[]) => consoleCalls.push(args);
    console.warn = (...args: unknown[]) => consoleCalls.push(args);

    try {
      const results: unknown[] = [];

      const success = buildAdapter([jsonResponse(200, orderBody('order_LOGCHECK'))]);
      results.push(await success.adapter.createOrder(BASE_INPUT));

      const serverError = buildAdapter([jsonResponse(500, razorpayErrorBody('SERVER_ERROR', 'boom'))]);
      results.push(await serverError.adapter.createOrder(BASE_INPUT));

      const gaveUp = buildAdapter([
        jsonResponse(429, razorpayErrorBody('X', 'x')),
        jsonResponse(429, razorpayErrorBody('X', 'x')),
      ]);
      results.push(await gaveUp.adapter.createOrder(BASE_INPUT));

      let constructorErrorMessage = '';
      try {
        new RazorpayHttpAdapter('rzp_live_leaktest', TEST_KEY_SECRET);
      } catch (err) {
        constructorErrorMessage = (err as Error).message;
      }

      const haystack = JSON.stringify(results) + constructorErrorMessage + JSON.stringify(consoleCalls);
      expect(haystack).not.toContain(TEST_KEY_SECRET);
      expect(haystack).not.toContain(TEST_KEY_ID);
      expect(consoleCalls.length).toBe(0);
    } finally {
      console.log = originalLog;
      console.error = originalError;
      console.warn = originalWarn;
    }
  });
});

describe('FakeRazorpayAdapter', () => {
  test('call counter starts at zero, since asserting zero calls on the block/escalate path is the whole point', () => {
    const fake = new FakeRazorpayAdapter();
    expect(fake.callCount).toBe(0);
  });

  test('counts calls and records the inputs it was called with', async () => {
    const fake = new FakeRazorpayAdapter([{ ok: true, razorpay_order_id: 'order_FAKE1' }]);

    const result = await fake.createOrder(BASE_INPUT);

    expect(result).toEqual({ ok: true, razorpay_order_id: 'order_FAKE1' });
    expect(fake.callCount).toBe(1);
    expect(fake.calls).toEqual([BASE_INPUT]);
  });

  test('serves scripted responses in FIFO order across multiple calls', async () => {
    const blockResult: CreateOrderResult = {
      ok: false,
      error: { reason_code: 'RAZORPAY_ERROR', message: 'scripted', http_status: 500, razorpay_code: null, retryable: false },
    };
    const fake = new FakeRazorpayAdapter([{ ok: true, razorpay_order_id: 'order_FIRST' }]);
    fake.enqueue(blockResult);

    const first = await fake.createOrder(BASE_INPUT);
    const second = await fake.createOrder(BASE_INPUT);

    expect(first).toEqual({ ok: true, razorpay_order_id: 'order_FIRST' });
    expect(second).toEqual(blockResult);
    expect(fake.callCount).toBe(2);
  });

  test('throws when called with an empty queue, so a misconfigured test fails loudly rather than hanging', async () => {
    const fake = new FakeRazorpayAdapter();
    await expect(fake.createOrder(BASE_INPUT)).rejects.toThrow(/empty response queue/);
  });
});
