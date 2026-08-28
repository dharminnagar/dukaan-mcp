"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { logout } from "../../../lib/buyer-actions";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await logout();
        router.push("/buyer");
        router.refresh();
      }}
      className="h-fit rounded-md border border-[var(--color-border)] px-3 py-1.5 text-sm disabled:opacity-50">
      {busy ? "Logging out..." : "Log out"}
    </button>
  );
}
