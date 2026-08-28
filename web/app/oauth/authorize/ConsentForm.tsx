"use client";

/**
 * The one interactive piece of the consent screen. Picks a merchant (only
 * ones the buyer isn't already connected to — see page.tsx), an optional
 * spend cap, then approves or denies, mirroring
 * `web/app/buyer/stores/ConnectButton.tsx`'s shape for the same decision.
 */
import { useState } from "react";
import { approveConsent, denyConsent } from "./actions";

export interface ConsentMerchant {
  readonly id: string;
  readonly name: string;
}

export function ConsentForm({
  clientName,
  clientId,
  redirectUri,
  codeChallenge,
  resource,
  state,
  merchants,
}: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  state: string | null;
  merchants: readonly ConsentMerchant[];
}) {
  const [merchantId, setMerchantId] = useState(merchants[0]?.id ?? "");
  const [capRupees, setCapRupees] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function approve(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await approveConsent({
        clientId,
        redirectUri,
        codeChallenge,
        resource,
        state,
        merchantId,
        capRupees,
      });
      window.location.href = redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function deny(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = await denyConsent({
        clientId,
        redirectUri,
        resource,
        state,
      });
      window.location.href = redirectTo;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 flex flex-col gap-4">
      <p className="text-sm">
        <span className="font-semibold">{clientName}</span> wants to connect an
        agent to a store on your behalf. It will be able to browse the catalog
        and place orders within the cap you set below.
      </p>

      <label className="flex flex-col gap-1 text-sm">
        Store
        <select
          value={merchantId}
          onChange={(e) => setMerchantId(e.target.value)}
          className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">
          {merchants.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Spend cap (rupees, optional)
        <input
          type="text"
          inputMode="decimal"
          placeholder="e.g. 500"
          value={capRupees}
          onChange={(e) => setCapRupees(e.target.value)}
          className="w-40 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
        />
      </label>

      {error !== null && (
        <p className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || merchantId === ""}
          onClick={() => void approve()}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Working..." : "Approve"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void deny()}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm disabled:opacity-50">
          Deny
        </button>
      </div>
    </div>
  );
}
