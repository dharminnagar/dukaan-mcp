"use client";

import { useMemo, useRef, useState } from "react";
import { onboard, startMapping } from "./actions";
import type { PolicyFormInput } from "./actions";
import {
  CANONICAL_FIELDS,
  availableCategoriesFor,
  categoryColumnVerdict,
  isLowConfidence,
  selectedFrom,
} from "../lib/mapping-types";
import type {
  CanonicalField,
  CategoryColumnVerdict,
  ColumnMapping,
  ColumnValueSummary,
  MappingProposal,
} from "../lib/mapping-types";
import { isValidMerchantId, slugifyMerchantId } from "../lib/merchant-id";

type Step = 1 | 2 | 3;

interface PolicyDraft {
  spendCapRupees: string;
  approvalThresholdRupees: string;
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

function emptySelections(): Record<CanonicalField, string> {
  return {
    sku: NO_MATCH,
    name: NO_MATCH,
    price: NO_MATCH,
    stock: NO_MATCH,
    category: NO_MATCH,
  };
}

/**
 * Integer paise -> a rupee string for display. Splits with `/` and `%` rather
 * than dividing by 100 and calling toFixed, so the rendered figure can never
 * pick up a binary-floating-point artefact on the way to the screen.
 */
function formatPaise(paise: number): string {
  return `${Math.trunc(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export default function OnboardingPage() {
  const [step, setStep] = useState<Step>(1);
  const [error, setError] = useState<string | null>(null);
  /** Guards the onboard call on step 2. */
  const [busy, setBusy] = useState(false);
  /**
   * Guards the `startMapping` call on step 1. Split from `busy` because the two
   * now gate different buttons on different screens — one flag would disable
   * the policy step's Continue while a re-upload was still resolving.
   */
  const [mappingBusy, setMappingBusy] = useState(false);

  // Step 1 state — merchant, catalog, and the mapping derived from the catalog
  const [merchantName, setMerchantName] = useState("");
  const [csvText, setCsvText] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [header, setHeader] = useState<string[]>([]);
  const [previewRows, setPreviewRows] = useState<Record<string, string>[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [columnValues, setColumnValues] = useState<
    Readonly<Record<string, ColumnValueSummary>>
  >({});
  const [proposal, setProposal] = useState<MappingProposal | null>(null);
  const [usedFallback, setUsedFallback] = useState(false);
  const [selections, setSelections] =
    useState<Record<CanonicalField, string>>(emptySelections);
  const [fixedCategory, setFixedCategory] = useState<string>("");

  /**
   * Monotonic id for the `startMapping` call in flight. Picking file A and then
   * file B before A resolves would otherwise let A's slower response overwrite
   * B's mapping — `mappingBusy` does not prevent it, because the file input is
   * deliberately never disabled (a merchant who picked the wrong file must be
   * able to correct it immediately, not wait out a model call).
   */
  const mappingReqId = useRef(0);

  // Step 2 state — the policy
  const [policy, setPolicy] = useState<PolicyDraft>({
    spendCapRupees: "",
    approvalThresholdRupees: "",
    window: "24h",
  });
  /**
   * The categories the merchant has UNTICKED, never the ones they kept.
   *
   * Storing the exclusion makes all-ticked the default of the data structure,
   * and makes a stale category unrepresentable: the submitted allowlist is
   * always the CURRENT mapping's values with this set removed, so remapping the
   * category column can never leak a previous column's values into the policy.
   * Storing the selection instead would force a choice between re-seeding on
   * every transition (silently discarding deliberate unticks) and not
   * re-seeding (submitting a quietly wrong policy that never throws).
   *
   * Never cleared, for the same reason: entries naming a column that is no
   * longer mapped are unreachable strings that cost nothing, and keeping them
   * means A -> B -> A restores the merchant's earlier unticks.
   *
   * If an "onboard another merchant" action is ever added to step 3, this
   * must be reset then — otherwise one merchant's unticks leak into the next.
   */
  const [excludedCategories, setExcludedCategories] = useState<
    ReadonlySet<string>
  >(new Set());
  /**
   * The BUYER's cap, kept out of `PolicyDraft` on purpose: the policy is the
   * merchant's own exposure limit, and this is the limit imposed on the agent
   * by whoever funds it. Blank means the buyer sets no cap. Never parsed to a
   * number here — it goes to the server as the string the merchant typed, and
   * `rupeesToPaise` converts it with integer string maths.
   */
  const [buyerCapRupees, setBuyerCapRupees] = useState("");

  // Step 3 state
  const [result, setResult] = useState<OnboardResult | null>(null);
  const [copied, setCopied] = useState<"token" | "endpoint" | null>(null);

  const merchantId = useMemo(
    () => (merchantName.trim() ? slugifyMerchantId(merchantName) : ""),
    [merchantName]
  );

  const categoryColumn =
    selections.category === NO_MATCH ? null : selections.category;
  const categorySummary =
    categoryColumn === null ? undefined : columnValues[categoryColumn];
  const categoryVerdict = categoryColumnVerdict(categorySummary, rowCount);

  const availableCategories = availableCategoriesFor(
    categoryColumn,
    fixedCategory,
    columnValues
  );
  const selectedCategories = selectedFrom(
    availableCategories,
    excludedCategories
  );

  const mappingComplete =
    selections.sku !== NO_MATCH &&
    selections.name !== NO_MATCH &&
    selections.price !== NO_MATCH &&
    selections.stock !== NO_MATCH &&
    (categoryColumn !== null || fixedCategory.trim().length > 0);

  /**
   * The column each canonical field is actually reading from right now — null
   * for category's fixed-literal path, since a typed-in literal has no rows to
   * be blank.
   */
  const mappedColumnFor = (field: CanonicalField): string | null =>
    field === "category"
      ? categoryColumn
      : selections[field] !== NO_MATCH
        ? selections[field]
        : null;

  /**
   * `requireField` (src/catalog/csv.ts) throws on a missing or whitespace-only
   * cell for every one of these five fields, not just category. A blank in any
   * mapped column is therefore a guaranteed server-side failure — surfacing it
   * only after the merchant has filled in the whole policy screen just delays
   * that failure, so this is computed here and gates step 1's Continue instead.
   */
  const blankFieldIssues: readonly {
    field: CanonicalField;
    column: string;
    blankRows: number;
  }[] = CANONICAL_FIELDS.flatMap((field) => {
    const column = mappedColumnFor(field);
    if (column === null) return [];
    const summary = columnValues[column];
    if (summary === undefined || summary.blankRows === 0) return [];
    return [{ field, column, blankRows: summary.blankRows }];
  });

  /**
   * Deliberately carries NO policy predicate. Coupling the two was the bug this
   * reorder exists to remove: the merchant was made to write a spend policy
   * before the file that determines its categories had even been read.
   *
   * `categoryVerdict !== "unusable"` and `blankFieldIssues.length === 0` are
   * both here for the same reason: an identifier column masquerading as
   * category, or a blank cell in any mapped column, are both certain to fail
   * `onboard()` server-side — that is exactly the late failure this reorder
   * exists to remove, so both block Continue here rather than on step 2.
   */
  const step1Valid =
    merchantName.trim().length > 0 &&
    isValidMerchantId(merchantId) &&
    csvText !== null &&
    proposal !== null &&
    mappingComplete &&
    categoryVerdict !== "unusable" &&
    blankFieldIssues.length === 0;

  const step2Valid =
    policy.spendCapRupees.trim().length > 0 &&
    policy.approvalThresholdRupees.trim().length > 0 &&
    policy.window.trim().length > 0 &&
    categoryVerdict !== "unusable" &&
    selectedCategories.length > 0;

  function clearCatalog() {
    setCsvText(null);
    setFileName(null);
    setHeader([]);
    setPreviewRows([]);
    setRowCount(0);
    setColumnValues({});
    setProposal(null);
    setUsedFallback(false);
    setSelections(emptySelections());
    setFixedCategory("");
  }

  /**
   * Reads the file and proposes a mapping in one go, straight from the change
   * handler. Not a `useEffect` keyed on `csvText`: an effect double-fires under
   * StrictMode, which would double-bill the OpenRouter call on every upload.
   */
  async function handleFileChange(file: File | null) {
    const reqId = ++mappingReqId.current;
    setError(null);
    if (file === null) {
      clearCatalog();
      return;
    }
    setFileName(file.name);
    setMappingBusy(true);
    try {
      const text = await file.text();
      const mapping = await startMapping(text);
      if (reqId !== mappingReqId.current) return;

      setCsvText(text);
      setHeader(mapping.header);
      setPreviewRows(mapping.previewRows);
      setRowCount(mapping.rowCount);
      setColumnValues(mapping.columnValues);
      setProposal(mapping.proposal);
      setUsedFallback(mapping.usedFallback);

      const next = emptySelections();
      for (const field of CANONICAL_FIELDS) {
        const guess = mapping.proposal.mapping[field];
        const confidence = mapping.proposal.confidence[field];
        // Low-confidence proposals render flagged and unselected — the
        // merchant must actively choose rather than trust a shaky guess.
        if (guess !== null && !isLowConfidence(confidence)) {
          next[field] = guess;
        }
      }
      setSelections(next);
      setFixedCategory("");
    } catch (err) {
      if (reqId !== mappingReqId.current) return;
      // `readHeaderAndSamples` throws on an empty file. Clearing the catalog
      // keeps the mapping section from rendering half-populated and leaves the
      // file input ready for another attempt.
      clearCatalog();
      setError(
        err instanceof Error ? err.message : "Could not read that file."
      );
    } finally {
      if (reqId === mappingReqId.current) setMappingBusy(false);
    }
  }

  /** Clears the banner too: a failed onboard used to leave it up behind Back. */
  function goToStep(next: Step) {
    setError(null);
    setStep(next);
  }

  function toggleCategory(category: string) {
    setExcludedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  }

  /**
   * Ticks or unticks a specific list of categories. The caller passes the
   * currently VISIBLE ones, not every available one: with a filter applied,
   * "None" clearing categories the merchant cannot see is exactly the
   * silently-wrong policy this screen exists to prevent.
   */
  function setCategoriesTicked(categories: readonly string[], ticked: boolean) {
    setExcludedCategories((prev) => {
      const next = new Set(prev);
      for (const category of categories) {
        if (ticked) next.delete(category);
        else next.add(category);
      }
      return next;
    });
  }

  function buildColumnMapping(): ColumnMapping | null {
    if (!mappingComplete) return null;
    return {
      sku: selections.sku,
      name: selections.name,
      price: selections.price,
      stock: selections.stock,
      category:
        categoryColumn !== null
          ? { kind: "column", column: categoryColumn }
          : { kind: "fixed", value: fixedCategory.trim() },
    };
  }

  async function handleOnboard() {
    const mapping = buildColumnMapping();
    if (mapping === null || csvText === null || !step2Valid) return;
    setBusy(true);
    setError(null);
    try {
      const policyInput: PolicyFormInput = {
        spend_cap_rupees: policy.spendCapRupees.trim(),
        approval_threshold_rupees: policy.approvalThresholdRupees.trim(),
        category_allowlist: selectedCategories,
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
      goToStep(3);
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
          {(["Upload + mapping", "Spend policy", "Done"] as const).map(
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
        <div className="space-y-8">
          <StepUpload
            merchantName={merchantName}
            setMerchantName={setMerchantName}
            merchantId={merchantId}
            fileName={fileName}
            onFileChange={handleFileChange}
            mappingBusy={mappingBusy}
          />

          {proposal !== null && (
            <StepMapping
              header={header}
              proposal={proposal}
              usedFallback={usedFallback}
              selections={selections}
              setSelections={setSelections}
              fixedCategory={fixedCategory}
              setFixedCategory={setFixedCategory}
              categoryColumn={categoryColumn}
              categorySummary={categorySummary}
              categoryVerdict={categoryVerdict}
              rowCount={rowCount}
              mappedPreview={mappedPreview}
              blankFieldIssues={blankFieldIssues}
            />
          )}

          <button
            type="button"
            disabled={!step1Valid || mappingBusy}
            onClick={() => goToStep(2)}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:enabled:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40">
            Continue to spend policy
          </button>
        </div>
      )}

      {step === 2 && (
        <StepPolicy
          policy={policy}
          setPolicy={setPolicy}
          buyerCapRupees={buyerCapRupees}
          setBuyerCapRupees={setBuyerCapRupees}
          categoryColumn={categoryColumn}
          categorySummary={categorySummary}
          categoryVerdict={categoryVerdict}
          rowCount={rowCount}
          available={availableCategories}
          excluded={excludedCategories}
          onToggleCategory={toggleCategory}
          onSetAllCategories={setCategoriesTicked}
          valid={step2Valid}
          busy={busy}
          onBack={() => goToStep(1)}
          onConfirm={handleOnboard}
        />
      )}

      {step === 3 && result !== null && (
        <StepDone result={result} copied={copied} onCopy={handleCopy} />
      )}
    </main>
  );
}

/* ------------------------------------------------------------ shared bits */

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

/** The sentence naming what a chosen category column actually contains. */
function categorySourceLine(
  categoryColumn: string,
  summary: ColumnValueSummary,
  rowCount: number
): string {
  const values = `${summary.distinctCount} distinct ${plural(summary.distinctCount, "value", "values")}`;
  return `From column "${categoryColumn}" — ${values} across ${rowCount} ${plural(rowCount, "row", "rows")}.`;
}

/* -------------------------------------------------------------- Step 1 */

function StepUpload(props: {
  merchantName: string;
  setMerchantName: (v: string) => void;
  merchantId: string;
  fileName: string | null;
  onFileChange: (f: File | null) => void;
  mappingBusy: boolean;
}) {
  const {
    merchantName,
    setMerchantName,
    merchantId,
    fileName,
    onFileChange,
    mappingBusy,
  } = props;

  return (
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
        hint="Any spreadsheet export works — Shopify, Tally, a plain sheet. Columns are matched as soon as you pick a file.">
        <input
          type="file"
          accept=".csv,text/csv"
          className={fieldClass + " cursor-pointer"}
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
        />
      </LabeledField>
      {fileName !== null && (
        <p className="text-xs text-[var(--color-muted)]">
          {mappingBusy ? "Reading " : "Selected: "}
          <span className="font-medium">{fileName}</span>
          {mappingBusy && " and matching columns…"}
        </p>
      )}
    </section>
  );
}

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
  categoryColumn: string | null;
  categorySummary: ColumnValueSummary | undefined;
  categoryVerdict: CategoryColumnVerdict;
  rowCount: number;
  mappedPreview: {
    sku: string;
    name: string;
    price: string;
    stock: string;
    category: string;
  }[];
  blankFieldIssues: readonly {
    field: CanonicalField;
    column: string;
    blankRows: number;
  }[];
}) {
  const {
    header,
    proposal,
    usedFallback,
    selections,
    setSelections,
    fixedCategory,
    setFixedCategory,
    categoryColumn,
    categorySummary,
    categoryVerdict,
    rowCount,
    mappedPreview,
    blankFieldIssues,
  } = props;

  return (
    <div className="space-y-6">
      <div className="rounded-md border border-[var(--color-warn-border)] bg-[var(--color-warn-bg)] px-4 py-3 text-sm">
        <strong className="font-semibold">Check this before continuing.</strong>{" "}
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

      {/*
        Hard block, not a warning: `requireField` (src/catalog/csv.ts) throws
        on a blank cell in any of these five fields, so onboarding cannot
        succeed while one is present. Listing every affected field here,
        rather than reporting only the first, is deliberate — fixing one
        blank at a time and re-uploading between each is a miserable loop.
      */}
      {blankFieldIssues.length > 0 && (
        <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-[var(--color-danger)]">
          <p className="font-semibold">
            Fix these blank cells before continuing.
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {blankFieldIssues.map(({ field, column, blankRows }) => (
              <li key={field}>
                {CANONICAL_FIELD_LABELS[field]}: {blankRows} of {rowCount}{" "}
                {plural(rowCount, "row", "rows")} have no value in &ldquo;
                {column}&rdquo;. Every row needs one, so fix the file and upload
                it again.
              </li>
            ))}
          </ul>
        </div>
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

            {/*
              Worth catching here rather than on the next screen: a mis-mapped
              category column is fixed with one dropdown change on THIS step,
              and is a dead end on the policy step.
            */}
            {categoryColumn !== null && categorySummary !== undefined && (
              <div className="mt-2 space-y-1 text-xs">
                {categoryVerdict === "ok" && (
                  <p className="text-[var(--color-muted)]">
                    {categorySourceLine(
                      categoryColumn,
                      categorySummary,
                      rowCount
                    )}
                  </p>
                )}
                {categoryVerdict === "review" && (
                  <p className="text-[#8a6100]">
                    &ldquo;{categoryColumn}&rdquo; holds{" "}
                    {categorySummary.distinctCount} distinct{" "}
                    {plural(categorySummary.distinctCount, "value", "values")}{" "}
                    across {rowCount} {plural(rowCount, "row", "rows")} — that
                    is a lot for a category. Check this is the right column.
                  </p>
                )}
                {categoryVerdict === "unusable" && (
                  <p className="text-[var(--color-danger)]">
                    &ldquo;{categoryColumn}&rdquo; holds{" "}
                    {categorySummary.distinctCount} distinct{" "}
                    {plural(categorySummary.distinctCount, "value", "values")}{" "}
                    across {rowCount} {plural(rowCount, "row", "rows")}. That is
                    an identifier, not a category — pick a different column, or
                    choose &ldquo;no category column&rdquo; and set one fixed
                    category.
                  </p>
                )}
              </div>
            )}

            {categoryColumn === null && (
              <div className="mt-2">
                <label className="block text-xs font-medium text-[var(--color-muted)]">
                  No category column found. Type one category to apply to every
                  row in this upload.
                </label>
                <input
                  className={fieldClass}
                  value={fixedCategory}
                  onChange={(e) => setFixedCategory(e.target.value)}
                  placeholder="groceries"
                />
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
    </div>
  );
}

/* -------------------------------------------------------------- Step 2 */

function CategoryPicker(props: {
  categoryColumn: string | null;
  categorySummary: ColumnValueSummary | undefined;
  categoryVerdict: CategoryColumnVerdict;
  rowCount: number;
  available: readonly string[];
  excluded: ReadonlySet<string>;
  onToggle: (category: string) => void;
  onSetAll: (categories: readonly string[], ticked: boolean) => void;
}) {
  const {
    categoryColumn,
    categorySummary,
    categoryVerdict,
    rowCount,
    available,
    excluded,
    onToggle,
    onSetAll,
  } = props;
  const [filter, setFilter] = useState("");

  if (categoryVerdict === "unusable") {
    return (
      <div className="rounded-md border border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-4 py-3 text-sm text-[var(--color-danger)]">
        The column mapped to category
        {categoryColumn !== null && <> (&ldquo;{categoryColumn}&rdquo;)</>} has
        {categorySummary !== undefined && (
          <> {categorySummary.distinctCount}</>
        )}{" "}
        distinct values — more than a category list can hold, and a sign the
        column is an identifier rather than a category. Go back and map a
        different column, or set one fixed category for the whole upload.
      </div>
    );
  }

  const visible =
    filter.trim().length === 0
      ? available
      : available.filter((c) =>
          c.toLowerCase().includes(filter.trim().toLowerCase())
        );
  const selectedCount = selectedFrom(available, excluded).length;

  return (
    <div className="space-y-3">
      {categoryVerdict === "review" && (
        <p className="rounded-md border border-[var(--color-warn-border)] bg-[var(--color-warn-bg)] px-3 py-2 text-xs text-[#8a6100]">
          That is an unusual number of categories for a catalog this size. It
          may be right — check the list below before continuing.
        </p>
      )}

      {categoryVerdict === "review" && (
        <div className="flex items-center gap-2">
          <input
            className="block w-full rounded-md border border-[var(--color-border)] bg-white px-3 py-1.5 text-sm outline-none focus-visible:border-[var(--color-accent)]"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter categories"
          />
          <button
            type="button"
            onClick={() => onSetAll(visible, true)}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
            All
          </button>
          <button
            type="button"
            onClick={() => onSetAll(visible, false)}
            className="shrink-0 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs font-medium hover:bg-gray-50">
            None
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {visible.map((category) => (
          <label
            key={category}
            className="flex items-center gap-2 rounded-md border border-[var(--color-border)] px-3 py-2 text-sm">
            <input
              type="checkbox"
              checked={!excluded.has(category)}
              onChange={() => onToggle(category)}
            />
            <span className="truncate" title={category}>
              {category}
            </span>
          </label>
        ))}
      </div>

      {visible.length === 0 && (
        <p className="text-xs text-[var(--color-muted)]">
          No category matches &ldquo;{filter}&rdquo;.
        </p>
      )}

      <p className="text-xs text-[var(--color-muted)]">
        {categoryColumn !== null && categorySummary !== undefined
          ? categorySourceLine(categoryColumn, categorySummary, rowCount)
          : "One fixed category, applied to every row in this upload."}{" "}
        {selectedCount} of {available.length} allowed.
      </p>
    </div>
  );
}

function StepPolicy(props: {
  policy: PolicyDraft;
  setPolicy: React.Dispatch<React.SetStateAction<PolicyDraft>>;
  buyerCapRupees: string;
  setBuyerCapRupees: (v: string) => void;
  categoryColumn: string | null;
  categorySummary: ColumnValueSummary | undefined;
  categoryVerdict: CategoryColumnVerdict;
  rowCount: number;
  available: readonly string[];
  excluded: ReadonlySet<string>;
  onToggleCategory: (category: string) => void;
  onSetAllCategories: (categories: readonly string[], ticked: boolean) => void;
  valid: boolean;
  busy: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  const {
    policy,
    setPolicy,
    buyerCapRupees,
    setBuyerCapRupees,
    categoryColumn,
    categorySummary,
    categoryVerdict,
    rowCount,
    available,
    excluded,
    onToggleCategory,
    onSetAllCategories,
    valid,
    busy,
    onBack,
    onConfirm,
  } = props;

  return (
    <div className="space-y-8">
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

        <div>
          <label className="block text-sm font-medium text-[var(--color-ink)]">
            Allowed categories
          </label>
          <p className="mb-2 mt-1 text-xs text-[var(--color-muted)]">
            Taken from your catalog. An agent can only buy from the categories
            left ticked.
          </p>
          <CategoryPicker
            categoryColumn={categoryColumn}
            categorySummary={categorySummary}
            categoryVerdict={categoryVerdict}
            rowCount={rowCount}
            available={available}
            excluded={excluded}
            onToggle={onToggleCategory}
            onSetAll={onSetAllCategories}
          />
        </div>

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
