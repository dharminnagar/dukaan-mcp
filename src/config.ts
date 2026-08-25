function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in. ` +
        `For local Postgres run: bun run db:up`
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number.parseInt(optional("PORT", "8787"), 10),
  NODE_ENV: optional("NODE_ENV", "development"),
} as const;

/**
 * Razorpay credentials are NOT required at boot. `bun run db:migrate` and
 * `bun run eval` must work on a clone with no Razorpay account, because the
 * eval suite's reproducibility claim is load-bearing. Only the adapter
 * (DUK-16) calls this.
 */
export function requireRazorpay(): { keyId: string; keySecret: string } {
  return {
    keyId: required("RAZORPAY_KEY_ID"),
    keySecret: required("RAZORPAY_KEY_SECRET"),
  };
}
