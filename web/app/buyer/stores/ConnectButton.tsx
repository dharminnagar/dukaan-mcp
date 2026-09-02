"use client";

/**
 * The one interactive piece on an otherwise server-rendered directory page.
 * Mints an agent via `connect` (web/lib/buyer-actions.ts) and shows the raw
 * token exactly once — reloading this page never shows it again, because
 * only the SHA-256 lives server-side after this render.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { connect, regenerateToken } from "../../../lib/buyer-actions";
import type { ConnectResult } from "../../../lib/buyer-actions";

export function ConnectButton({
  merchantId,
  alreadyConnected,
}: {
  merchantId: string;
  alreadyConnected: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [capRupees, setCapRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectResult | null>(null);

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await connect(merchantId, capRupees);
      setResult(r);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitRegenerate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const r = await regenerateToken(merchantId);
      setResult(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (result !== null) {
    return (
      <div className="mt-3 rounded-md border border-[var(--color-border)] bg-[var(--color-warn-bg)] p-3 text-sm">
        <p className="font-medium">
          Connected. This token is shown once — copy it now.
        </p>
        <p className="mt-2 break-all font-mono text-xs">{result.token}</p>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Endpoint: <span className="font-mono">{result.endpoint}</span>
        </p>
        {result.buyerCapPaise !== null && (
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            Your cap: Rs {(result.buyerCapPaise / 100).toFixed(2)}
          </p>
        )}
        <div className="mt-3 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]">
          <p className="font-medium text-[var(--color-fg)]">
            Connecting this to an AI client
          </p>
          <p className="mt-1">
            <strong>Manual setup</strong> (a client that asks for a server URL
            and a bearer token): use the endpoint above as the server URL, and
            the token above as the bearer token.
          </p>
          <p className="mt-1">
            <strong>Sign-in setup</strong> (a client with its own remote MCP
            connector, using OAuth): give the client just the endpoint above, no
            token. The client discovers sign-in on its own from this server's{" "}
            <code>/.well-known/oauth-protected-resource</code> and{" "}
            <code>/.well-known/oauth-authorization-server</code>, then walks you
            through authorizing in your browser.
          </p>
        </div>
      </div>
    );
  }

  if (alreadyConnected) {
    return (
      <div className="mt-3 flex flex-col gap-2">
        <p className="text-sm text-[var(--color-muted)]">
          You are already connected to this store.
        </p>
        {error !== null && (
          <p className="rounded-md bg-[var(--color-danger-bg)] px-2 py-1 text-xs text-[var(--color-danger)]">
            {error}
          </p>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void submitRegenerate()}
          className="w-fit rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50">
          {busy ? "Regenerating..." : "Regenerate token"}
        </button>
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white">
        Connect
      </button>
    );
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-xs">
        Your spend cap (rupees, optional)
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 500"
          value={capRupees}
          onChange={(e) => setCapRupees(e.target.value)}
          className="w-40 rounded-md border border-[var(--color-border)] px-2 py-1 text-sm"
        />
      </label>
      {error !== null && (
        <p className="rounded-md bg-[var(--color-danger-bg)] px-2 py-1 text-xs text-[var(--color-danger)]">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => void submit()}
          className="rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Connecting..." : "Confirm connect"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm">
          Cancel
        </button>
      </div>
    </div>
  );
}
