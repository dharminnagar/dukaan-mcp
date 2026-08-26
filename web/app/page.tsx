"use client";

import { useMemo, useState } from "react";
import { onboard, startMapping } from "./actions";
import type { PolicyFormInput } from "./actions";
import { CANONICAL_FIELDS, isLowConfidence } from "../lib/mapping-types";
import type {
  CanonicalField,
  ColumnMapping,
  MappingProposal,
} from "../lib/mapping-types";
import { isValidMerchantId, slugifyMerchantId } from "../lib/merchant-id";

type Step = 1 | 2 | 3;

interface PolicyDraft {
  spendCapRupees: string;
  approvalThresholdRupees: string;
  categoryAllowlistRaw: string;
  window: string;
}

interface OnboardResult {
  token: string;
  endpoint: string;
  productCount: number;
  merchantId: string;
  buyerCapPaise: number | null;
}

const CANONICAL_FIELD_LABELS: Record<CanonicalField, string> = {
  sku: "SKU / product id",
  name: "Product name",
  price: "Price",
  stock: "Stock",
  category: "Category",
};

const NO_MATCH = "__none__";

/**
 * Integer paise -> a rupee string for display. Splits with `/` and `%` rather
 * than dividing by 100 and calling toFixed, so the rendered figure can never
 * pick up a binary-floating-point artefact on the way to the screen.
 */
function formatPaise(paise: number): string {
  return `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Step 1 state
  const [merchantName, setMerchantName] = useState("");
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  /**
   * The BUYER's cap, kept out of `PolicyDraft` on purpose: the policy is the
   * merchant's own exposure limit, and this is the limit imposed on the agent
   * by whoever funds it. Blank means the buyer sets no cap. Never parsed to a
   * number here — it goes to the server as the string the merchant typed, and
   * `rupeesToPaise` converts it with integer string maths.
   */
  const [buyerCapRupees, setBuyerCapRupees] = useState("");
  const [policy, setPolicy] = useState<PolicyDraft>({
    spendCapRupees: "",
    approvalThresholdRupees: "",
    categoryAllowlistRaw: "",
    window: "24h",
  });

  // Step 2 state
  const [header, setHeader] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [proposal, setProposal] = useState<MappingProposal | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [selections, setSelections] = useState<Record<CanonicalField, string>>({
    sku: NO_MATCH,
    name: NO_MATCH,
    price: NO_MATCH,
    stock: NO_MATCH,
    category: NO_MATCH,
  });
  const [fixedCategory, setFixedCategory] = useState<string>("");

  // Step 3 state
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [copied, setCopied] = useState<"token" | "endpoint" | null>(null);

  const merchantId = useMemo(
    () => (merchantName.trim() ? slugifyMerchantId(merchantName) : ""),
    [merchantName]
  );
  const categoryOptions = useMemo(
    () => parseAllowlist(policy.categoryAllowlistRaw),
    [policy.categoryAllowlistRaw]
  );

  const step1Valid =
    merchantName.trim().length > 0 &&
    isValidMerchantId(merchantId) &&
    csvText !== null &&
    policy.spendCapRupees.trim().length > 0 &&
    policy.approvalThresholdRupees.trim().length > 0 &&
    categoryOptions.length > 0 &&
    policy.window.trim().length > 0;

  const categoryResolved =
    selections.category !== NO_MATCH || fixedCategory.trim().length > 0;
  const step2Valid =
    selections.sku !== NO_MATCH &&
    selections.name !== NO_MATCH &&
    selections.price !== NO_MATCH &&
    selections.stock !== NO_MATCH &&
    categoryResolved;

  async function handleFileChange(file: File | null) {
    setError(null);
    if (file === null) {
      setCsvText(null);
      setFileName(null);
      return;
    }
    const text = await file.text();
    setCsvText(text);
    setFileName(file.name);
  }

  async function handleContinueToMapping() {
    if (!step1Valid || csvText === null) return;
    setBusy(true);
    setError(null);
    try {
      const { header, previewRows, proposal, usedFallback } =
        await startMapping(csvText);
      setHeader(header);
      setPreviewRows(previewRows);
      setProposal(proposal);
      setUsedFallback(usedFallback);

      const next: Record<CanonicalField, string> = {
        sku: NO_MATCH,
        name: NO_MATCH,
        price: NO_MATCH,
        stock: NO_MATCH,
        category: NO_MATCH,
      };
      for (const field of CANONICAL_FIELDS) {
        const guess = proposal.mapping[field];
        const confidence = proposal.confidence[field];
        // Low-confidence proposals render flagged and unselected — the
        // merchant must actively choose rather than trust a shaky guess.
        if (guess !== null && !isLowConfidence(confidence)) {
          next[field] = guess;
        }
      }
      setSelections(next);
      setFixedCategory(categoryOptions[0] ?? "");
      setStep(2);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read that file."
      );
    } finally {
      setBusy(false);
    }
  }

  function buildColumnMapping(): ColumnMapping | null {
    if (!step2Valid) return null;
    return {
      sku: selections.sku,
      name: selections.name,
      price: selections.price,
      stock: selections.stock,
      category:
        selections.category !== NO_MATCH
          ? { kind: "column", column: selections.category }
          : { kind: "fixed", value: fixedCategory.trim() },
    };
  }

  async function handleConfirmMapping() {
    const mapping = buildColumnMapping();
    if (mapping === null || csvText === null) return;
    setBusy(true);
    setError(null);
    try {
      const policyInput: PolicyFormInput = {
        spend_cap_rupees: policy.spendCapRupees.trim(),
        approval_threshold_rupees: policy.approvalThresholdRupees.trim(),
        category_allowlist: categoryOptions,
        window: policy.window.trim(),
      };
      const outcome = await onboard(
        csvText,
        mapping,
        merchantName,
        policyInput,
        buyerCapRupees.trim()
      );
      setResult(outcome);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Onboarding failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy(kind: "token" | "endpoint", value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard API unavailable (e.g. insecure context) — nothing to do,
      // the value is already selectable on screen.
    }
  }

  const mappedPreview = useMemo(() => {
    const mapping = buildColumnMapping();
    if (mapping === null) return [];
    return previewRows.slice(0, 10).map((row) => ({
      sku: row[mapping.sku] ?? "",
      name: row[mapping.name] ?? "",
      price: row[mapping.price] ?? "",
      stock: row[mapping.stock] ?? "",
      category:
        mapping.category.kind === "fixed"
          ? mapping.category.value
          : (row[mapping.category.column] ?? ""),
    }));
  }, [previewRows, selections, fixedCategory]);

  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">
          Onboard a merchant
        </h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Upload a product catalog and a spend policy. Your agent token is ready
          in under a minute.
        </p>
        <ol className="mt-6 flex gap-6 text-sm">
          {(["Upload + policy", "Confirm mapping", "Done"] as const).map(
            (label, i) => {
              const n = (i + 1) as Step;
              const active = n === step;
              const done = n < step;
              return (
                <li
                  key={label}
                  className={
                    "flex items-center gap-2 " +
                    (active
                      ? "font-semibold text-[var(--color-ink)]"
                      : done
                        ? "text-[var(--color-accent)]"
                        : "text-[var(--color-muted)]")
                  }>
                  <span
                    className={
                      "flex h-5 w-5 items-center justify-center rounded-full text-xs " +
                      (active
                        ? "bg-[var(--color-accent)] text-white"
                        : done
                          ? "border border-[var(--color-accent)] text-[var(--color-accent)]"
                          : "border border-[var(--color-border)]")
                    }>
                    {done ? "✓" : n}
                  </span>
                  {label}
                </li>
              );
            }
          )}
        </ol>
      </header>

      {error !== null && (
        <div
          role="alert"
          className="mb-6 rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      {step === 1 && (
        <StepUpload
          merchantName={merchantName}
          setMerchantName={setMerchantName}
          merchantId={merchantId}
          fileName={fileName}
          onFileChange={handleFileChange}
          policy={policy}
          setPolicy={setPolicy}
          buyerCapRupees={buyerCapRupees}
          setBuyerCapRupees={setBuyerCapRupees}
          categoryOptions={categoryOptions}
          valid={step1Valid}
          busy={busy}
          onContinue={handleContinueToMapping}
        />
      )}

      {step === 2 && proposal !== null && (
        <StepMapping
          header={header}
          proposal={proposal}
          usedFallback={usedFallback}
          selections={selections}
          setSelections={setSelections}
          fixedCategory={fixedCategory}
          setFixedCategory={setFixedCategory}
          categoryOptions={categoryOptions}
          mappedPreview={mappedPreview}
          valid={step2Valid}
          busy={busy}
          onBack={() => setStep(1)}
          onConfirm={handleConfirmMapping}
        />
      )}

      {step === 3 && result !== null && (
        <StepDone result={result} copied={copied} onCopy={handleCopy} />
      )}
    </main>
  );
}

/* -------------------------------------------------------------- Step 1 */

function LabeledField({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-[var(--color-ink)]">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p>
      )}
    </div>
  );
}

const fieldClass =
  "mt-1 block w-full rounded-md border border-[var(--color-border)] bg-white px-3 py-2 text-sm outline-none focus-visible:border-[var(--color-accent)]";

function StepUpload(props: {
  merchantName: string;
  setMerchantName: (v: string) => void;
  merchantId: string;
  fileName: string | null;
  onFileChange: (f: File | null) => void;
  policy: PolicyDraft;
  setPolicy: React.Dispatch<React.SetStateAction<PolicyDraft>>;
  buyerCapRupees: string;
  setBuyerCapRupees: (v: string) => void;
  categoryOptions: string[];
  valid: boolean;
  busy: boolean;
  onContinue: () => void;
}) {
  const {
    merchantName,
    setMerchantName,
    merchantId,
    fileName,
    onFileChange,
    policy,
    setPolicy,
    buyerCapRupees,
    setBuyerCapRupees,
    categoryOptions,
    valid,
    busy,
    onContinue,
  } = props;

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-base font-semibold">Merchant</h2>
        <LabeledField
          label="Merchant name"
          hint={
            merchantId
              ? `Merchant id: ${merchantId}`
              : "The merchant id is derived from this name."
          }>
          <input
            className={fieldClass}
            value={merchantName}
            onChange={(e) => setMerchantName(e.target.value)}
            placeholder="Sunny's Kirana Store"
          />
        </LabeledField>

        <LabeledField
          label="Product catalog (CSV)"
          hint="Any spreadsheet export works — Shopify, Tally, a plain sheet. You'll confirm the column mapping next.">
          <input
            type="file"
            accept=".csv,text/csv"
            className={fieldClass + " cursor-pointer"}
            onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          />
        </LabeledField>
        {fileName !== null && (
          <p className="text-xs text-[var(--color-muted)]">
            Selected: <span className="font-medium">{fileName}</span>
          </p>
        )}
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Spend policy</h2>
        <div className="grid grid-cols-2 gap-4">
          <LabeledField label="Spend cap (₹, per window)">
            <input
              className={fieldClass}
              inputMode="decimal"
              value={policy.spendCapRupees}
              onChange={(e) =>
                setPolicy((p) => ({ ...p, spendCapRupees: e.target.value }))
              }
              placeholder="5000.00"
            />
          </LabeledField>
          <LabeledField label="Approval threshold (₹, per order)">
            <input
              className={fieldClass}
              inputMode="decimal"
              value={policy.approvalThresholdRupees}
              onChange={(e) =>
                setPolicy((p) => ({
                  ...p,
                  approvalThresholdRupees: e.target.value,
                }))
              }
              placeholder="1500.00"
            />
          </LabeledField>
        </div>
        <LabeledField
          label="Allowed categories"
          hint={
            categoryOptions.length > 0
              ? `${categoryOptions.length} categor${categoryOptions.length === 1 ? "y" : "ies"}: ${categoryOptions.join(", ")}`
              : "Comma-separated. An agent can only buy from these categories."
          }>
          <input
            className={fieldClass}
            value={policy.categoryAllowlistRaw}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                categoryAllowlistRaw: e.target.value,
              }))
            }
            placeholder="staples, dairy, snacks, household"
          />
        </LabeledField>
        <LabeledField label="Spend window" hint="A duration like 24h, 7d, 30m.">
          <input
            className={fieldClass}
            value={policy.window}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, window: e.target.value }))
            }
            placeholder="24h"
          />
        </LabeledField>
      </section>

      <section className="space-y-4">
        <h2 className="text-base font-semibold">Buyer limit</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Separate from the spend policy above, and deliberately so: the policy
          is the merchant&apos;s own exposure limit, this is the ceiling the
          party funding the agent puts on it. Whichever is tighter binds.
        </p>
        <LabeledField
          label="Buyer cap (₹, per window) — optional"
          hint="Leave blank for no buyer cap. Set once, when the token is minted; it is never raised afterwards.">
          <input
            className={fieldClass}
            inputMode="decimal"
            value={buyerCapRupees}
            onChange={(e) => setBuyerCapRupees(e.target.value)}
            placeholder="2500.00"
          />
        </LabeledField>
      </section>

      <button
        type="button"
        disabled={!valid || busy}
        onClick={onContinue}
        className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:enabled:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40">
        {busy ? "Reading catalog…" : "Continue to column mapping"}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------- Step 2 */

function StepMapping(props: {
  header: string[];
  proposal: MappingProposal;
  usedFallback: boolean;
  selections: Record<CanonicalField, string>;
  setSelections: React.Dispatch<
    React.SetStateAction<Record<CanonicalField, string>>
  >;
  fixedCategory: string;
  setFixedCategory: (v: string) => void;
  categoryOptions: string[];
  mappedPreview: {
    sku: string;
    name: string;
    price: string;
    stock: string;
    category: string;
  }[];
  valid: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const {
    header,
    proposal,
    usedFallback,
    selections,
    setSelections,
    fixedCategory,
    setFixedCategory,
    categoryOptions,
    mappedPreview,
    valid,
    busy,
    onBack,
    onConfirm,
  } = props;

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-[var(--color-warn-border)] bg-[var(--color-warn-bg)] px-4 py-3 text-sm">
        <strong className="font-semibold">Check this before confirming.</strong>{" "}
        Automated column detection can be wrong. Review every dropdown and the
        preview table below against your actual file.
      </div>

      {usedFallback && (
        <p className="text-sm text-[var(--color-muted)]">
          Automatic column detection was unavailable, so columns were matched by
          exact name only (sku, name, price, stock, category). Pick the right
          column for each field below.
        </p>
      )}

      <section className="space-y-3">
        <h2 className="text-base font-semibold">Column mapping</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CANONICAL_FIELDS.filter((f) => f !== "category").map((field) => {
            const confidence = proposal.confidence[field];
            const flagged = isLowConfidence(confidence);
            return (
              <div key={field}>
                <label className="flex items-center justify-between text-sm font-medium">
                  {CANONICAL_FIELD_LABELS[field]}
                  {flagged && (
                    <span className="rounded bg-[var(--color-warn-bg)] px-1.5 py-0.5 text-xs font-normal text-[#8a6100]">
                      low confidence — check
                    </span>
                  )}
                </label>
                <select
                  className={fieldClass}
                  value={selections[field]}
                  onChange={(e) =>
                    setSelections((s) => ({ ...s, [field]: e.target.value }))
                  }>
                  <option value={NO_MATCH}>-- choose a column --</option>
                  {header.map((h) => (
                    <option key={h} value={h}>
                      {h}
                    </option>
                  ))}
                </select>
              </div>
            );
          })}

          <div>
            <label className="flex items-center justify-between text-sm font-medium">
              {CANONICAL_FIELD_LABELS.category}
              {isLowConfidence(proposal.confidence.category) && (
                <span className="rounded bg-[var(--color-warn-bg)] px-1.5 py-0.5 text-xs font-normal text-[#8a6100]">
                  low confidence — check
                </span>
              )}
            </label>
            <select
              className={fieldClass}
              value={selections.category}
              onChange={(e) =>
                setSelections((s) => ({ ...s, category: e.target.value }))
              }>
              <option value={NO_MATCH}>-- no category column --</option>
              {header.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
            {selections.category === NO_MATCH && (
              <div className="mt-2">
                <label className="block text-xs font-medium text-[var(--color-muted)]">
                  No category column found. Choose one category for every row in
                  this upload.
                </label>
                <select
                  className={fieldClass}
                  value={fixedCategory}
                  onChange={(e) => setFixedCategory(e.target.value)}>
                  {categoryOptions.length === 0 && (
                    <option value="">
                      -- add categories to the allowlist first --
                    </option>
                  )}
                  {categoryOptions.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">
          Preview ({mappedPreview.length} of the rows shown)
        </h2>
        <div className="overflow-x-auto rounded-md border border-[var(--color-border)]">
          <table className="w-full min-w-[500px] text-left text-sm">
            <thead className="bg-gray-50 text-xs uppercase text-[var(--color-muted)]">
              <tr>
                <th className="px-3 py-2">sku</th>
                <th className="px-3 py-2">name</th>
                <th className="px-3 py-2">price</th>
                <th className="px-3 py-2">stock</th>
                <th className="px-3 py-2">category</th>
              </tr>
            </thead>
            <tbody>
              {mappedPreview.map((row, i) => (
                <tr key={i} className="border-t border-[var(--color-border)]">
                  <td className="px-3 py-2">{row.sku || "—"}</td>
                  <td className="px-3 py-2">{row.name || "—"}</td>
                  <td className="px-3 py-2">{row.price || "—"}</td>
                  <td className="px-3 py-2">{row.stock || "—"}</td>
                  <td className="px-3 py-2">{row.category || "—"}</td>
                </tr>
              ))}
              {mappedPreview.length === 0 && (
                <tr>
                  <td
                    className="px-3 py-4 text-center text-[var(--color-muted)]"
                    colSpan={5}>
                    Choose columns above to see a preview.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex gap-3">
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border border-[var(--color-border)] px-4 py-2 text-sm font-medium text-[var(--color-ink)] hover:bg-gray-50">
          Back
        </button>
        <button
          type="button"
          disabled={!valid || busy}
          onClick={onConfirm}
          className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:enabled:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40">
          {busy ? "Onboarding…" : "Confirm and onboard merchant"}
        </button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- Step 3 */

function StepDone(props: {
  result: OnboardResult;
  copied: "token" | "endpoint" | null;
  onCopy: (kind: "token" | "endpoint", value: string) => void;
}) {
  const { result, copied, onCopy } = props;
  return (
    <div className="space-y-6">
      <div className="rounded-md border border-[var(--color-accent)] bg-[#f0f7f3] px-4 py-3 text-sm text-[var(--color-accent)]">
        Merchant onboarded — {result.productCount} product
        {result.productCount === 1 ? "" : "s"} loaded and ready.
        {result.buyerCapPaise !== null && (
          <> Buyer cap: ₹{formatPaise(result.buyerCapPaise)} per window.</>
        )}
      </div>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Agent token</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Shown once. Copy it now — it cannot be retrieved again.
        </p>
        <div className="flex items-center gap-2">
          <code className="block flex-1 overflow-x-auto rounded-md border border-[var(--color-border)] bg-white px-3 py-2 text-sm">
            {result.token}
          </code>
          <button
            type="button"
            onClick={() => onCopy("token", result.token)}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-gray-50">
            {copied === "token" ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">MCP endpoint</h2>
        <div className="flex items-center gap-2">
          <code className="block flex-1 overflow-x-auto rounded-md border border-[var(--color-border)] bg-white px-3 py-2 text-sm">
            {result.endpoint}
          </code>
          <button
            type="button"
            onClick={() => onCopy("endpoint", result.endpoint)}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm font-medium hover:bg-gray-50">
            {copied === "endpoint" ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-base font-semibold">Gate dashboard</h2>
        <p className="text-xs text-[var(--color-muted)]">
          Every decision this merchant&apos;s agents get, with the reason code
          and which party&apos;s cap bound.
        </p>
        <a
          href={`/dashboard/${result.merchantId}`}
          className="inline-block rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--color-accent-hover)]">
          Open dashboard
        </a>
      </section>
    </div>
  );
}
