import type { NextConfig } from "next";

/**
 * `pg` (node-postgres) is only ever imported from server actions
 * (app/actions.ts), never from a client component. `serverExternalPackages`
 * keeps Next from trying to bundle it for any runtime other than Node, and
 * is a second line of defense alongside the "use server" boundary — see
 * lib/assert-server-only.ts for the runtime assertion.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg"],
};

export default nextConfig;
