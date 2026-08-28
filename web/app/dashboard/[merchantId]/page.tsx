/**
 * Merchant dashboard (DUK-32) — sales and the gate's decisions on one
 * screen, on purpose: revenue sitting next to allow/block/escalate is the
 * one view where the product's whole argument (a policy layer, not just a
 * checkout) is visible at a glance. Server-rendered, no client fetch: every
 * number here comes from `web/lib/dashboard-queries.ts` at request time.
 *
 * NO AUTH ON THIS ROUTE, DELIBERATELY. This page is keyed on the
 * `merchantId` path segment alone — no session, no cookie, no token check.
 * That is a known, accepted gap, not an oversight: the agent token minted
 * during onboarding is the AGENT's credential (it authenticates MCP tool
 * calls) and must not double as a merchant login, and building real
 * merchant auth is out of scope this close to the deadline this project is
 * shipping against. A query-param token or an obfuscated merchant id would
 * look like security without being any — worse than an honest hole, because
 * it invites trusting a check that isn't one. Real merchant auth is future
 * work, tracked separately from DUK-32.
 */
import { notFound } from "next/navigation";
import {
  formatRupees,
  loadAgentCounts,
  loadAgentSpend,
  loadMerchantExposure,
  loadRecentDecisions,
  loadRevenueSummary,
  loadTopAgentSpend,
} from "../../../lib/dashboard-queries";
import type {
  Decision,
  ReasonCode,
  TopAgentSpend,
} from "../../../lib/dashboard-queries";
import { isValidMerchantId } from "../../../lib/merchant-id";

/** A short plain-English gloss beside the code — never instead of it. */
const REASON_GLOSS: Record<ReasonCode, string> = {
  ALLOWED: "let through",
  STALE_CATALOG: "asserted price/qty didn't match the live catalog",
  SPEND_CAP_EXCEEDED: "would breach the spend cap",
  CATEGORY_NOT_ALLOWED: "category not on the allowlist",
  PENDING_APPROVAL: "above the approval threshold, awaiting merchant sign-off",
  RAZORPAY_ERROR: "payment provider call failed",
  UNAUTHENTICATED: "no valid agent token",
  INVALID_REQUEST: "malformed checkout request",
};

const DECISION_LABEL: Record<Decision, string> = {
  allow: "ALLOW",
  block: "BLOCK",
  escalate: "ESCALATE",
};

function windowLabel(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Overrides the layout's title, which names the onboarding flow. The tab label
 * is on camera in the demo, so a dashboard reading "merchant onboarding" is a
 * visible seam.
 */
export const metadata = { title: "Dukaan MCP — merchant dashboard" };

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ merchantId: string }>;
}) {
  const { merchantId } = await params;
  if (!isValidMerchantId(merchantId)) notFound();

  // `revenue` is fetched first, on its own, because `loadTopAgentSpend`
  // needs its `window_seconds` — reading the policy row happens inside both
  // functions regardless, so this costs one query, not two.
  const revenue = await loadRevenueSummary(merchantId);

  // No policy row for this merchant id at all — nothing to show, not even
  // an empty state, since we cannot tell "onboarded, no orders yet" apart
  // from "not a merchant".
  if (revenue === null) notFound();

  const [spend, decisions, agentCounts, exposure, topAgents] =
    await Promise.all([
      loadAgentSpend(merchantId),
      loadRecentDecisions(merchantId),
      loadAgentCounts(merchantId),
      loadMerchantExposure(merchantId),
      loadTopAgentSpend(merchantId, revenue.window_seconds),
    ]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Merchant dashboard
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">{merchantId}</p>
      </header>

      <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-[var(--color-border)] bg-white px-5 py-4">
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Revenue ({windowLabel(revenue.window_seconds)})
          </p>
          <p className="mt-1 text-2xl font-semibold">
            {formatRupees(revenue.revenue_paise)}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {revenue.order_count} order{revenue.order_count === 1 ? "" : "s"}
          </p>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-white px-5 py-4">
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Agents registered
          </p>
          <p className="mt-1 text-2xl font-semibold">
            {agentCounts.buyer_registered + agentCounts.merchant_minted}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {agentCounts.buyer_registered} buyer-registered,{" "}
            {agentCounts.merchant_minted} merchant-minted
          </p>
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-white px-5 py-4">
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Merchant exposure ({windowLabel(revenue.window_seconds)})
          </p>
          {exposure === null || exposure.cap_paise === null ? (
            <>
              <p className="mt-1 text-2xl font-semibold">
                {formatRupees(exposure?.spent_paise ?? revenue.revenue_paise)}
              </p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                no aggregate limit set
              </p>
            </>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold">
                {formatRupees(exposure.spent_paise)}
                <span className="text-base font-normal text-[var(--color-muted)]">
                  {" "}
                  / {formatRupees(exposure.cap_paise)}
                </span>
              </p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                summed across every agent
              </p>
            </>
          )}
        </div>

        <div className="rounded-md border border-[var(--color-border)] bg-white px-5 py-4">
          <p className="text-xs uppercase tracking-wide text-[var(--color-muted)]">
            Newest agent{spend !== null ? `  ${spend.agent_label}` : ""}
          </p>
          {spend === null ? (
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              No agent on this merchant yet.
            </p>
          ) : (
            <>
              <p className="mt-1 text-2xl font-semibold">
                {formatRupees(spend.spent_paise)}
                <span className="text-base font-normal text-[var(--color-muted)]">
                  {" "}
                  / {formatRupees(spend.effective_cap.cap_paise)}
                </span>
              </p>
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                bound by: {spend.effective_cap.bound_by} — the most recently
                added agent, not the merchant total
              </p>
            </>
          )}
        </div>
      </section>

      <section className="mb-6">
        <h2 className="mb-3 text-base font-semibold">
          Top agents by spend ({windowLabel(revenue.window_seconds)})
        </h2>
        {topAgents.agents.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] bg-white px-5 py-8 text-center">
            <p className="text-sm text-[var(--color-muted)]">
              No agent had spend in this window yet.
            </p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-white">
              <table className="w-full min-w-[560px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-border)] text-xs uppercase tracking-wide text-[var(--color-muted)]">
                    <th className="px-4 py-2 font-medium">Agent</th>
                    <th className="px-4 py-2 font-medium">Provisioned by</th>
                    <th className="px-4 py-2 font-medium">Spend / cap</th>
                    <th className="px-4 py-2 font-medium">Bound by</th>
                  </tr>
                </thead>
                <tbody>
                  {topAgents.agents.map((a: TopAgentSpend) => (
                    <tr
                      key={a.agent_id}
                      className="border-t border-[var(--color-border)] first:border-t-0">
                      <td className="px-4 py-2 align-top">{a.agent_label}</td>
                      <td className="px-4 py-2 align-top">
                        {a.buyer_registered ? "buyer" : "merchant"}
                      </td>
                      <td className="px-4 py-2 align-top">
                        {formatRupees(a.spent_paise)}
                        <span className="text-[var(--color-muted)]">
                          {" "}
                          / {formatRupees(a.effective_cap.cap_paise)}
                        </span>
                      </td>
                      <td className="px-4 py-2 align-top">
                        {a.effective_cap.bound_by}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {topAgents.total_with_spend > topAgents.agents.length && (
              <p className="mt-2 text-sm text-[var(--color-muted)]">
                and {topAgents.total_with_spend - topAgents.agents.length} more
                agent
                {topAgents.total_with_spend - topAgents.agents.length === 1
                  ? ""
                  : "s"}{" "}
                with spend in this window not shown
              </p>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-base font-semibold">Recent decisions</h2>
        {decisions.length === 0 ? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] bg-white px-5 py-8 text-center">
            <p className="text-sm font-medium text-[var(--color-ink)]">
              No checkout decisions yet.
            </p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              This merchant is onboarded and the gate is live — decisions show
              up here the moment an agent calls checkout.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-[var(--color-border)] bg-white">
            <table className="w-full min-w-[560px] text-left text-sm">
              <tbody>
                {decisions.map((d) => (
                  <tr
                    key={d.id}
                    className="border-t border-[var(--color-border)] first:border-t-0">
                    <td className="whitespace-nowrap px-4 py-2 align-top">
                      <DecisionBadge decision={d.decision} />
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 align-top font-mono text-xs">
                      {d.reason_code}
                      <div className="mt-0.5 font-sans text-xs font-normal text-[var(--color-muted)]">
                        {REASON_GLOSS[d.reason_code]}
                      </div>
                    </td>
                    <td className="px-4 py-2 align-top">{d.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function DecisionBadge({ decision }: { decision: Decision }) {
  const styles: Record<Decision, string> = {
    allow: "bg-[#f0f7f3] text-[var(--color-accent)]",
    block: "bg-[var(--color-danger-bg)] text-[var(--color-danger)]",
    escalate: "bg-[var(--color-warn-bg)] text-[#8a6100]",
  };
  return (
    <span
      className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${styles[decision]}`}>
      {DECISION_LABEL[decision]}
    </span>
  );
}
