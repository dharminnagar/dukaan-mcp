/**
 * The merchant directory a signed-in buyer connects from. Server component,
 * no client fetching: `listMerchantDirectory` reads directly at request
 * time, matching `web/app/dashboard/[merchantId]/page.tsx`'s shape.
 */
import { redirect } from "next/navigation";
import {
  getSessionBuyer,
  listMerchantDirectory,
} from "../../../lib/buyer-queries";
import { ConnectButton } from "./ConnectButton";
import { LogoutButton } from "./LogoutButton";

export const metadata = { title: "Dukaan MCP — connect a store" };

export default async function StoresPage() {
  const buyer = await getSessionBuyer();
  if (buyer === null) redirect("/buyer");

  const merchants = await listMerchantDirectory(buyer.id);

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <header className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Stores</h1>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {buyer.email}
          </p>
        </div>
        <LogoutButton />
      </header>

      {merchants.length === 0 ? (
        <div className="rounded-md border border-dashed border-[var(--color-border)] px-5 py-8 text-center text-sm text-[var(--color-muted)]">
          No stores onboarded yet.
        </div>
      ) : (
        <ul className="flex flex-col gap-4">
          {merchants.map((m) => (
            <li
              key={m.id}
              className="rounded-md border border-[var(--color-border)] bg-white px-5 py-4">
              <div className="flex items-baseline justify-between gap-2">
                <h2 className="text-base font-semibold">{m.name}</h2>
                <span className="font-mono text-xs text-[var(--color-muted)]">
                  {m.id}
                </span>
              </div>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {m.productCount} product{m.productCount === 1 ? "" : "s"} ·{" "}
                {m.categories.join(", ")}
              </p>
              <ConnectButton
                merchantId={m.id}
                alreadyConnected={m.connectedAgentId !== null}
              />
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
