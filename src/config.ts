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

/**
 * An OPTIONAL integer-paise setting: `null` when unset or blank, and a loud
 * throw for anything that is not a positive whole number of paise.
 *
 * Exported, and taking `raw` as an argument rather than reading process.env
 * itself, so a test can drive every rejection branch without mutating the
 * environment of a module that is evaluated once at import.
 *
 * The regex, not `Number.parseInt`, is what does the rejecting: parseInt("1.5")
 * is 1 and parseInt("12abc") is 12, so a fat-fingered rupee figure would be
 * silently truncated into a plausible-looking paise ceiling. Money in this
 * codebase is integer paise end to end; a decimal point here means the operator
 * meant rupees, and guessing which is worse than refusing to boot.
 */
export function parsePositivePaiseEnv(
  name: string,
  raw: string | undefined
): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: expected a positive whole number of PAISE ` +
        `(digits only — 250000 means Rs 2,500.00), or leave it unset for no limit.`
    );
  }
  const value = Number.parseInt(trimmed, 10);
  if (value <= 0 || !Number.isSafeInteger(value)) {
    throw new Error(
      `Invalid ${name}=${JSON.stringify(raw)}: must be greater than 0 and within ` +
        `Number.MAX_SAFE_INTEGER paise, or unset for no limit.`
    );
  }
  return value;
}

export const env = {
  DATABASE_URL: required("DATABASE_URL"),
  PORT: Number.parseInt(optional("PORT", "8787"), 10),
  NODE_ENV: optional("NODE_ENV", "development"),
  /**
   * The platform's ceiling on the spend cap a merchant may set for itself, in
   * paise. `null` — the default — means the platform imposes no ceiling and the
   * gate falls back to exactly the two-party behaviour that predates it.
   *
   * NOT `required()`, and that is load-bearing: a fresh clone with no ceiling
   * configured must still run `bun run db:migrate` and `bun run eval`, because
   * the eval's reproducibility claim is the project's central honesty claim.
   * Validated eagerly here rather than lazily at the call site so a typo fails
   * at boot instead of at the first checkout of the day.
   */
  PLATFORM_SPEND_CEILING_PAISE: parsePositivePaiseEnv(
    "PLATFORM_SPEND_CEILING_PAISE",
    process.env["PLATFORM_SPEND_CEILING_PAISE"]
  ),
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
