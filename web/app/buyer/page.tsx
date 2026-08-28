"use client";

/**
 * Buyer register / log in. Calls the server actions in
 * `web/lib/buyer-actions.ts` directly, the same pattern
 * `web/app/page.tsx` uses for `onboard` — no `<form action>`, just an
 * async function awaited from a client component and wrapped in
 * try/catch, so a thrown Error (duplicate email, bad password) becomes a
 * message on screen instead of Next's default error overlay.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { login, register } from "../../lib/buyer-actions";

type Mode = "login" | "register";

/**
 * DUK-35: /oauth/authorize sends a signed-out buyer here with
 * `?next=/oauth/authorize?...` so login returns them to the consent screen
 * instead of always landing on /buyer/stores. Restricted to a same-origin
 * relative path (must start with exactly one `/`, never `//`) so this can
 * never become an open redirect via a crafted `next` value.
 */
function safeNextPath(next: string | null): string {
  if (next === null) return "/buyer/stores";
  return next.startsWith("/") && !next.startsWith("//")
    ? next
    : "/buyer/stores";
}

export default function BuyerAuthPage() {
  return (
    <Suspense fallback={null}>
      <BuyerAuthForm />
    </Suspense>
  );
}

function BuyerAuthForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = safeNextPath(searchParams.get("next"));
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await register(email, password);
      }
      router.push(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">
        {mode === "login" ? "Log in" : "Create an account"}
      </h1>
      <p className="mt-1 text-sm text-[var(--color-muted)]">
        Connect your own agent to any store on Dukaan MCP.
      </p>

      <form
        className="mt-6 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}>
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            type="password"
            required
            minLength={8}
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
          />
        </label>

        {error !== null && (
          <p className="rounded-md bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="mt-2 rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Working..." : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "login" ? "register" : "login");
          setError(null);
        }}
        className="mt-4 text-sm text-[var(--color-accent)] underline">
        {mode === "login"
          ? "No account yet? Register."
          : "Already have an account? Log in."}
      </button>
    </main>
  );
}
