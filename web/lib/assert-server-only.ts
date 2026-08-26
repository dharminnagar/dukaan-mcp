/**
 * Runtime guard against `pg` (via app/actions.ts -> src/onboard/create-merchant.ts
 * -> src/db/pool.ts) ever reaching a client bundle. Deliberately a plain
 * `typeof window` check rather than the npm `server-only` package: that
 * package's current release throws unconditionally unless the bundler
 * resolves it through a `"react-server"` package.json export condition,
 * which Next's webpack/turbopack does but plain `bun test` does not — and
 * this file's whole job is to be importable from `tests/web-onboard.test.ts`
 * as well as from app/actions.ts. `window` is genuinely undefined in every
 * context this runs in except an actual browser, which is the one place
 * this guard needs to fire.
 */
if (typeof globalThis !== "undefined" && "window" in globalThis) {
  throw new Error(
    "web/app/actions.ts (and its dependencies, including `pg`) must never be imported into a client bundle."
  );
}

export {};
