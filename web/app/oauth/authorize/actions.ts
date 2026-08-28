"use server";

/**
 * Server actions backing the /authorize consent screen. Called directly
 * from the "use client" ConsentForm, same pattern as
 * `web/lib/buyer-actions.ts`'s `connect`.
 *
 * SECURITY NOTE: a Next server action is a real POST endpoint with a stable
 * action id — anyone who can see the client bundle can call it directly
 * with arbitrary arguments, not just via the rendered form. Every check
 * page.tsx already did for its own rendering (client exists, redirect_uri
 * is registered, resource is ours) is repeated here as the actual
 * enforcement, not assumed from how the page looks.
 */
import "../../../lib/assert-server-only";
import {
  getClient,
  isRegisteredRedirectUri,
} from "../../../../src/oauth/clients";
import { createAuthCode } from "../../../../src/oauth/codes";
import { mcpResourceUrl } from "../../../../src/oauth/urls";
import { rupeesToPaise } from "../../../../src/catalog/csv";
import { getSessionBuyer, merchantExists } from "../../../lib/buyer-queries";

const CODE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

async function requireValidRequest(args: {
  clientId: string;
  redirectUri: string;
  resource: string;
}): Promise<void> {
  const client = await getClient(args.clientId);
  if (client === null) {
    throw new Error("Unknown client_id.");
  }
  if (!isRegisteredRedirectUri(client, args.redirectUri)) {
    throw new Error(
      "redirect_uri does not exactly match this client's registration."
    );
  }
  if (args.resource !== mcpResourceUrl()) {
    throw new Error(`Unknown resource ${JSON.stringify(args.resource)}.`);
  }
}

export interface ApproveConsentArgs {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly state: string | null;
  readonly merchantId: string;
  readonly capRupees: string;
}

export interface ConsentOutcome {
  readonly redirectTo: string;
}

/**
 * Mints an authorization code and returns the URL to send the browser to.
 * A `window.location.href = redirectTo` in the client component, not a
 * Next `redirect()` — the destination is the CLIENT's redirect_uri, an
 * arbitrary origin `next/navigation`'s redirect has no business targeting.
 */
export async function approveConsent(
  args: ApproveConsentArgs
): Promise<ConsentOutcome> {
  const buyer = await getSessionBuyer();
  if (buyer === null) {
    throw new Error("You must be signed in to approve this request.");
  }
  await requireValidRequest(args);

  if (!CODE_CHALLENGE_RE.test(args.codeChallenge)) {
    throw new Error("Malformed code_challenge.");
  }
  if (!(await merchantExists(args.merchantId))) {
    throw new Error(`No such merchant: ${args.merchantId}.`);
  }

  let buyerCapPaise: number | null = null;
  if (args.capRupees.trim() !== "") {
    buyerCapPaise = rupeesToPaise(args.capRupees);
    if (buyerCapPaise <= 0) {
      throw new Error(
        `Invalid cap ${JSON.stringify(args.capRupees)}: must be greater than zero.`
      );
    }
  }

  const code = await createAuthCode({
    clientId: args.clientId,
    buyerId: buyer.id,
    merchantId: args.merchantId,
    redirectUri: args.redirectUri,
    codeChallenge: args.codeChallenge,
    resource: args.resource,
    buyerCapPaise,
  });

  const redirectTo = new URL(args.redirectUri);
  redirectTo.searchParams.set("code", code.raw);
  if (args.state !== null) redirectTo.searchParams.set("state", args.state);
  return { redirectTo: redirectTo.toString() };
}

export interface DenyConsentArgs {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly state: string | null;
}

export async function denyConsent(
  args: DenyConsentArgs
): Promise<ConsentOutcome> {
  await requireValidRequest(args);

  const redirectTo = new URL(args.redirectUri);
  redirectTo.searchParams.set("error", "access_denied");
  if (args.state !== null) redirectTo.searchParams.set("state", args.state);
  return { redirectTo: redirectTo.toString() };
}
