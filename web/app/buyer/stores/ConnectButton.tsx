"use client";

/**
 * The one interactive piece on an otherwise server-rendered directory page.
 * Mints an agent via `connect` (web/lib/buyer-actions.ts) and shows the raw
 * token exactly once — reloading this page never shows it again, because
 * only the SHA-256 lives server-side after this render.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";
import { connect } from "../../../lib/buyer-actions";
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
      </div>
    );
  }

  if (alreadyConnected) {
    return (
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        You are already connected to this store.
      </p>
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
