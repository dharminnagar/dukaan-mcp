/**
 * OAuth 2.1 /authorize — the buyer login + consent screen an MCP client's
 * browser lands on after discovery + DCR. Server component: the buyer's
 * session is read from their existing cookie exactly like
 * `web/app/buyer/stores/page.tsx`, so a buyer already logged in from the
 * paste-a-token flow sees consent immediately, no second login.
 *
 * Two failure classes are handled very differently, on purpose:
 *   - unknown client_id / redirect_uri not registered -> rendered as an
 *     error PAGE, never a redirect. Redirecting an error to an
 *     attacker-supplied, unverified redirect_uri is the textbook OAuth
 *     open-redirect mistake; this cannot happen because nothing here
 *     touches redirect_uri until it has been checked against the client's
 *     registration.
 *   - buyer not signed in -> redirect to /buyer, carrying every original
 *     query param via `next` so login returns here with nothing lost.
 */
import {
  getClient,
  isRegisteredRedirectUri,
} from "../../../../src/oauth/clients";
import {
  getSessionBuyer,
  listMerchantDirectory,
} from "../../../lib/buyer-queries";
import { parseAuthorizeParams } from "./params";
import { ConsentForm } from "./ConsentForm";

function ErrorPage({ title, message }: { title: string; message: string }) {
  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight text-[var(--color-danger)]">
        {title}
      </h1>
      <p className="mt-3 text-sm text-[var(--color-muted)]">{message}</p>
    </main>
  );
}

export const metadata = { title: "Authorize — Dukaan MCP" };

export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const parsed = parseAuthorizeParams(raw);
  if (!parsed.ok) {
    return (
      <ErrorPage title="Invalid authorization request" message={parsed.error} />
    );
  }
  const { clientId, redirectUri, codeChallenge, resource, state } =
    parsed.request;

  const client = await getClient(clientId);
  if (client === null) {
    return (
      <ErrorPage
        title="Unknown client"
        message={`No client is registered with id ${clientId}. Register it first via POST /api/oauth/register.`}
      />
    );
  }
  if (!isRegisteredRedirectUri(client, redirectUri)) {
    return (
      <ErrorPage
        title="redirect_uri mismatch"
        message="This redirect_uri does not exactly match one this client registered. Refusing to redirect anywhere for safety — check the client's registration."
      />
    );
  }

  const buyer = await getSessionBuyer();
  if (buyer === null) {
    const qs = new URLSearchParams();
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string") qs.set(key, value);
    }
    const next = `/oauth/authorize?${qs.toString()}`;
    return (
      <main className="mx-auto max-w-sm px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          Sign in to continue
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          {client.clientName} wants to connect to a store on your behalf. Sign
          in or create an account first.
        </p>
        <a
          href={`/buyer?next=${encodeURIComponent(next)}`}
          className="mt-6 inline-block rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white">
          Continue to sign in
        </a>
      </main>
    );
  }

  const merchants = (await listMerchantDirectory(buyer.id)).filter(
    (m) => m.connectedAgentId === null
  );

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Connect a store</h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">{buyer.email}</p>

      {merchants.length === 0 ? (
        <p className="mt-6 rounded-md border border-dashed border-[var(--color-border)] px-4 py-6 text-center text-sm text-[var(--color-muted)]">
          No stores available to connect — you may already be connected to every
          onboarded store.
        </p>
      ) : (
        <ConsentForm
          clientName={client.clientName}
          clientId={client.id}
          redirectUri={redirectUri}
          codeChallenge={codeChallenge}
          resource={resource}
          state={state}
          merchants={merchants.map((m) => ({ id: m.id, name: m.name }))}
        />
      )}
    </main>
  );
}
