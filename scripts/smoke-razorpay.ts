/**
 * DUK-6 smoke test: prove a real Razorpay test-mode Order can be created.
 *
 * This is the narrowest possible probe of the one thing the whole payment
 * story rests on — that `POST /v1/orders` returns a real `order_` id — and it
 * is the first video asset. It deliberately does NOT retry, back off, or shape
 * errors; that is the DUK-16 adapter's job. If this fails, the failure should
 * be loud and unprocessed.
 *
 * Also exercises `notes.merchant_id`, which is the logical-tenancy mechanism
 * the trade-off table commits to: one test account, with each order recording
 * which merchant it belongs to. Production would use Partner Auth and
 * `X-Razorpay-Account` instead.
 *
 * NEVER logs the key or secret. Prints the key id's prefix only, so a reader
 * can confirm it is a test key without the value reaching a terminal scroll,
 * a screen recording, or a CI log.
 */
const KEY_ID = process.env.RAZORPAY_KEY_ID;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

const ORDERS_URL = 'https://api.razorpay.com/v1/orders';

/** Paise. Deliberately small and obviously synthetic. */
const AMOUNT_PAISE = 4999;
const DEMO_MERCHANT_ID = 'm_demo_kirana';

interface RazorpayOrder {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string | null;
  status: string;
  attempts: number;
  notes: Record<string, string>;
  created_at: number;
}

function requireEnv(): { keyId: string; keySecret: string } {
  if (KEY_ID === undefined || KEY_ID.trim() === '') {
    throw new Error('RAZORPAY_KEY_ID is not set. Add it to .env — see setup/razorpay-setup.html.');
  }
  if (KEY_SECRET === undefined || KEY_SECRET.trim() === '') {
    throw new Error(
      'RAZORPAY_KEY_SECRET is not set. Add it to .env — it is shown only once at generation.',
    );
  }
  if (!KEY_ID.startsWith('rzp_test_')) {
    throw new Error(
      `RAZORPAY_KEY_ID does not start with rzp_test_. Refusing to run: this script must never ` +
        `touch a live key. Base URL is identical for test and live, so the key is the only guard.`,
    );
  }
  return { keyId: KEY_ID, keySecret: KEY_SECRET };
}

async function createOrder(keyId: string, keySecret: string): Promise<RazorpayOrder> {
  // Receipt must be stable enough to read on camera but unique per run, so a
  // second run does not look like a replay of the first.
  const receipt = `duk6-smoke-${Math.floor(performance.timeOrigin)}`;

  const response = await fetch(ORDERS_URL, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount: AMOUNT_PAISE,
      currency: 'INR',
      receipt,
      notes: { merchant_id: DEMO_MERCHANT_ID, source: 'duk6-smoke' },
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    // Surface Razorpay's own error body verbatim. Their error shape carries the
    // actionable part (code, description, field) and paraphrasing it loses that.
    throw new Error(`Razorpay returned HTTP ${response.status}: ${text}`);
  }
  return JSON.parse(text) as RazorpayOrder;
}

const { keyId, keySecret } = requireEnv();
console.log(`key id prefix: ${keyId.slice(0, 9)}… (test mode confirmed)`);

const order = await createOrder(keyId, keySecret);

console.log('');
console.log('  order id     ', order.id);
console.log('  entity       ', order.entity);
console.log('  amount       ', `${order.amount} paise (₹${(order.amount / 100).toFixed(2)})`);
console.log('  currency     ', order.currency);
console.log('  status       ', order.status);
console.log('  attempts     ', order.attempts);
console.log('  receipt      ', order.receipt);
console.log('  notes        ', JSON.stringify(order.notes));
console.log('  created_at   ', new Date(order.created_at * 1000).toISOString());
console.log('');

if (!order.id.startsWith('order_')) {
  throw new Error(`Expected an id prefixed 'order_', got ${JSON.stringify(order.id)}`);
}
console.log(`PASS: real Razorpay test-mode order created — ${order.id}`);
