/**
 * DUK-20/DUK-27's web onboarding UI, tested at the layer that matters:
 * `web/lib/mapping.ts`'s pure parsing/rename logic (offline, stubbed
 * `fetch` — same discipline as tests/eval-llm.test.ts) and `web/app/actions.ts`'s
 * `onboard` against real Postgres, namespaced `m_web_*` so it never
 * collides with the DUK-11 demo merchants or another test file's fixtures.
 *
 * Nothing here makes a live OpenRouter call — see web/lib/openrouter.ts's
 * module doc; `proposeMapping` is exercised with `OPENROUTER_API_KEY`
 * either unset or with `globalThis.fetch` monkey-patched to a stub for the
 * duration of one test, always restored in a `finally`.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { onboard, proposeMapping } from "../web/app/actions";
import { slugifyMerchantId } from "../web/lib/merchant-id";
import type { ColumnMapping } from "../web/lib/mapping-types";
import {
  availableCategoriesFor,
  categoryColumnVerdict,
  exactHeaderFallback,
  lowConfidenceFields,
  parseModelMappingResponse,
  readCsvColumns,
  readHeaderAndSamples,
  renameToCanonicalCsv,
  selectedFrom,
} from "../web/lib/mapping";
import { parseCatalogCsv } from "../src/catalog/csv";
import { pool, query, queryOne } from "../src/db/pool";

const REPO_ROOT = `${import.meta.dir}/..`;
const DEMO_MERCHANT_A_CSV = await Bun.file(
  `${REPO_ROOT}/fixtures/demo-merchant-a.csv`
).text();
const MERCHANT_A_CSV = await Bun.file(
  `${REPO_ROOT}/fixtures/merchant-a.csv`
).text();
const SHOPIFY_EXPORT_CSV = await Bun.file(
  `${REPO_ROOT}/fixtures/shopify-export.csv`
).text();

async function cleanupMerchant(merchantId: string): Promise<void> {
  await pool.query("DELETE FROM merchants WHERE id = $1", [merchantId]);
}

/** A Shopify-style export: none of the five canonical header names, in a different order. */
const SHOPIFY_CSV = `Handle,Title,Variant SKU,Variant Price,Variant Inventory Qty,Product Category
toor-dal,Toor Dal 1kg,sku-w01,145.00,40,groceries
basmati-rice,Basmati Rice 5kg,sku-w02,499.50,15,groceries
amul-butter,Amul Butter 500g,sku-w03,265.00,25,dairy
`;

const SHOPIFY_HEADER = [
  "Handle",
  "Title",
  "Variant SKU",
  "Variant Price",
  "Variant Inventory Qty",
  "Product Category",
];

const SHOPIFY_MAPPING: ColumnMapping = {
  sku: "Variant SKU",
  name: "Title",
  price: "Variant Price",
  stock: "Variant Inventory Qty",
  category: { kind: "column", column: "Product Category" },
};

describe("parseModelMappingResponse (offline, no network)", () => {
  test("a Shopify-style header maps correctly", () => {
    const raw = JSON.stringify({
      mapping: {
        sku: "Variant SKU",
        name: "Title",
        price: "Variant Price",
        stock: "Variant Inventory Qty",
        category: "Product Category",
      },
      confidence: {
        sku: 0.95,
        name: 0.97,
        price: 0.9,
        stock: 0.85,
        category: 0.8,
      },
    });

    const proposal = parseModelMappingResponse(raw, SHOPIFY_HEADER);
    expect(proposal).not.toBeNull();
    expect(proposal?.mapping).toEqual({
      sku: "Variant SKU",
      name: "Title",
      price: "Variant Price",
      stock: "Variant Inventory Qty",
      category: "Product Category",
    });
  });

  test("a malformed model response falls back rather than throwing", () => {
    expect(
      parseModelMappingResponse("not json at all {{{", SHOPIFY_HEADER)
    ).toBeNull();
    expect(
      parseModelMappingResponse(JSON.stringify({ mapping: {} }), SHOPIFY_HEADER)
    ).toBeNull();
    // A response that names a column NOT in the header — the model
    // hallucinating — must also be rejected, not silently accepted.
    const hallucinated = JSON.stringify({
      mapping: {
        sku: "SKU Code", // not in SHOPIFY_HEADER
        name: "Title",
        price: "Variant Price",
        stock: "Variant Inventory Qty",
        category: "Product Category",
      },
      confidence: {
        sku: 0.9,
        name: 0.9,
        price: 0.9,
        stock: 0.9,
        category: 0.9,
      },
    });
    expect(parseModelMappingResponse(hallucinated, SHOPIFY_HEADER)).toBeNull();
    // Never throws for any of the above.
    expect(() =>
      parseModelMappingResponse("garbage", SHOPIFY_HEADER)
    ).not.toThrow();
  });

  test("a missing category column forces the single-category path", () => {
    const raw = JSON.stringify({
      mapping: {
        sku: "Variant SKU",
        name: "Title",
        price: "Variant Price",
        stock: "Variant Inventory Qty",
        category: null,
      },
      confidence: { sku: 0.9, name: 0.9, price: 0.9, stock: 0.9, category: 0 },
    });
    const proposal = parseModelMappingResponse(raw, SHOPIFY_HEADER);
    expect(proposal?.mapping.category).toBeNull();

    // exactHeaderFallback on a header with no "category" column agrees.
    const fallback = exactHeaderFallback(["sku", "name", "price", "stock"]);
    expect(fallback.mapping.category).toBeNull();
  });

  test("a low-confidence field comes back flagged", () => {
    const raw = JSON.stringify({
      mapping: {
        sku: "Variant SKU",
        name: "Title",
        price: "Variant Price",
        stock: "Variant Inventory Qty",
        category: "Product Category",
      },
      confidence: {
        sku: 0.95,
        name: 0.97,
        price: 0.9,
        stock: 0.4,
        category: 0.8,
      },
    });
    const proposal = parseModelMappingResponse(raw, SHOPIFY_HEADER);
    expect(proposal).not.toBeNull();
    expect(lowConfidenceFields(proposal!.confidence)).toEqual(["stock"]);
  });
});

describe("readHeaderAndSamples (offline)", () => {
  test("returns only the header plus the first 3 data rows, never the whole file", () => {
    const bigCsv =
      "sku,name,price,stock,category\n" +
      Array.from(
        { length: 50 },
        (_, i) => `sku-${i},Item ${i},10.00,5,staples`
      ).join("\n");
    const { header, sampleRows } = readHeaderAndSamples(bigCsv, 3);
    expect(header).toEqual(["sku", "name", "price", "stock", "category"]);
    expect(sampleRows).toHaveLength(3);
    expect(sampleRows[0]).toEqual(["sku-0", "Item 0", "10.00", "5", "staples"]);
  });

  test("a CSV with fewer data rows than sampleCount returns only what exists, not padded", () => {
    const csv = "sku,name,price,stock,category\nsku-1,Item 1,10.00,5,staples\n";
    const { sampleRows } = readHeaderAndSamples(csv, 3);
    expect(sampleRows).toHaveLength(1);
  });

  test("startMapping's model boundary has not regressed: readHeaderAndSamples never returns row data past its own row/column count, even against the real demo CSV", () => {
    // The model boundary this guards: `startMapping` builds its prompt from
    // exactly this function's return value (web/app/actions.ts). A
    // regression that widened it to the whole parsed file would leak every
    // row into the LLM prompt instead of the header + 3 samples the
    // contract promises.
    const { header, sampleRows } = readHeaderAndSamples(DEMO_MERCHANT_A_CSV, 3);
    expect(header).toEqual(["sku", "name", "price", "stock", "category"]);
    expect(sampleRows).toHaveLength(3);
    for (const row of sampleRows) {
      expect(row).toHaveLength(header.length);
    }
  });
});

describe("renameToCanonicalCsv (offline, deterministic)", () => {
  test("rewrites a Shopify-style export into the canonical shape parseCatalogCsv accepts", () => {
    const canonical = renameToCanonicalCsv(SHOPIFY_CSV, SHOPIFY_MAPPING);
    expect(canonical.startsWith("sku,name,price,stock,category\n")).toBe(true);

    const { products } = parseCatalogCsv(canonical, "m_web_test");
    expect(products).toHaveLength(3);
    expect(products[0]).toMatchObject({
      id: "sku-w01",
      name: "Toor Dal 1kg",
      price_paise: 14500,
      stock: 40,
      category: "groceries",
    });
  });

  test("a fixed category is applied to every row uniformly — never inferred per row", () => {
    const mapping: ColumnMapping = {
      ...SHOPIFY_MAPPING,
      category: { kind: "fixed", value: "general" },
    };
    const canonical = renameToCanonicalCsv(SHOPIFY_CSV, mapping);
    const { products } = parseCatalogCsv(canonical, "m_web_test");
    // All three rows get "general", even though the source file's own
    // "Product Category" column has two different real values (groceries,
    // dairy) — proving the fixed branch can never read per-row data, only
    // apply one literal supplied once by the merchant.
    expect(products.every((p) => p.category === "general")).toBe(true);
  });
});

describe("readCsvColumns (offline)", () => {
  test("the bug guard: category values are collected over the WHOLE file, not a preview slice", () => {
    // fixtures/demo-merchant-a.csv has 25 rows and 6 distinct categories, but
    // "personal-care" first appears at row 22 and "beverages" at row 24 — an
    // implementation that only scans a short preview (the 20-row slice the
    // old parseCsvRowObjects capped at) would silently drop both.
    const { columnValues } = readCsvColumns(DEMO_MERCHANT_A_CSV);
    const category = columnValues["category"];
    expect(category?.distinctCount).toBe(6);
    expect(category?.values).toEqual([
      "staples",
      "dairy",
      "snacks",
      "household",
      "personal-care",
      "beverages",
    ]);
    expect(category?.values).toContain("personal-care");
    expect(category?.values).toContain("beverages");
    expect(category?.truncated).toBe(false);
  });

  test("the same trap, made deliberately airtight: a category first appearing well past any plausible preview window", () => {
    // The default previewLimit is 10 and the old buggy behaviour capped at
    // 20 rows — this puts the novel category at row 500, an order of
    // magnitude past either number, so no plausible "just raise the preview
    // size a bit" fix would happen to paper over a real regression here.
    const rows = Array.from(
      { length: 499 },
      (_, i) => `sku-${i},Item ${i},10.00,5,staples`
    );
    rows.push("sku-late,Late Arrival,10.00,5,late-blooming-category");
    const csv = ["sku,name,price,stock,category", ...rows].join("\n");
    const { columnValues, rowCount } = readCsvColumns(csv);
    expect(rowCount).toBe(500);
    const category = columnValues["category"];
    expect(category?.distinctCount).toBe(2);
    expect(category?.values).toContain("late-blooming-category");
  });

  test("exactly at the distinct cap: NOT truncated, and values are shipped in full", () => {
    // The boundary the trap above doesn't reach: distinctCount === cap must
    // still ship every value, not just "under cap".
    const rows = Array.from(
      { length: 10 },
      (_, i) => `sku-${i},Item ${i},10.00,5,cat-${i}`
    );
    const csv = ["sku,name,price,stock,category", ...rows].join("\n");
    const { columnValues } = readCsvColumns(csv, { distinctCap: 10 });
    const category = columnValues["category"];
    expect(category?.truncated).toBe(false);
    expect(category?.distinctCount).toBe(10);
    expect(category?.values).toHaveLength(10);
    expect(category?.values).toEqual(
      Array.from({ length: 10 }, (_, i) => `cat-${i}`)
    );
  });

  test("one value past the distinct cap: truncated, values dropped, count still exact", () => {
    const rows = Array.from(
      { length: 11 },
      (_, i) => `sku-${i},Item ${i},10.00,5,cat-${i}`
    );
    const csv = ["sku,name,price,stock,category", ...rows].join("\n");
    const { columnValues } = readCsvColumns(csv, { distinctCap: 10 });
    const category = columnValues["category"];
    expect(category?.truncated).toBe(true);
    expect(category?.values).toEqual([]);
    expect(category?.distinctCount).toBe(11);
  });

  test("a column past the distinct cap is truncated: no values shipped, count still accurate", () => {
    const rows = Array.from(
      { length: 300 },
      (_, i) => `sku-${i},Item ${i},10.00,5,cat-${i}`
    );
    const csv = ["sku,name,price,stock,category", ...rows].join("\n");
    const { columnValues } = readCsvColumns(csv, { distinctCap: 200 });
    const category = columnValues["category"];
    expect(category?.truncated).toBe(true);
    expect(category?.values).toEqual([]);
    expect(category?.distinctCount).toBe(300);
  });

  test("a blank cell is counted in blankRows and omitted from values", () => {
    const csv = [
      "sku,name,price,stock,category",
      "sku-1,Item 1,10.00,5,staples",
      "sku-2,Item 2,10.00,5,",
      "sku-3,Item 3,10.00,5,staples",
    ].join("\n");
    const { columnValues } = readCsvColumns(csv);
    const category = columnValues["category"];
    expect(category?.blankRows).toBe(1);
    expect(category?.values).not.toContain("");
    expect(category?.values).toEqual(["staples"]);
  });

  test("a column that is entirely blank behaves sanely: zero distinct values, every row counted blank, never truncated", () => {
    const csv = [
      "sku,name,price,stock,category",
      "sku-1,Item 1,10.00,5,",
      "sku-2,Item 2,10.00,5, ",
      "sku-3,Item 3,10.00,5,",
    ].join("\n");
    const { columnValues } = readCsvColumns(csv);
    const category = columnValues["category"];
    expect(category?.values).toEqual([]);
    expect(category?.distinctCount).toBe(0);
    expect(category?.blankRows).toBe(3);
    expect(category?.truncated).toBe(false);
  });

  test("case is preserved, never folded: 'Dairy' and 'dairy' are two distinct values", () => {
    // This is CORRECT, not a bug to fix later. The gate (src/gate/index.ts)
    // compares categories with a bare `===`, and neither it nor
    // src/catalog/policy.ts case-folds. Folding "Dairy"/"dairy" together
    // here would let the allowlist contain a normalised form that then
    // fails to `===`-match the catalog's actual (unfolded) category string
    // on every purchase — manufacturing exactly the silent-block bug DUK-27
    // exists to close, just moved one level up. If a future "cleanup"
    // introduces case-insensitive dedup in readCsvColumns, this must go red.
    const csv = [
      "sku,name,price,stock,category",
      "sku-1,Item 1,10.00,5,Dairy",
      "sku-2,Item 2,10.00,5,dairy",
    ].join("\n");
    const { columnValues } = readCsvColumns(csv);
    const category = columnValues["category"];
    expect(category?.distinctCount).toBe(2);
    expect(category?.values).toEqual(["Dairy", "dairy"]);
  });

  test("previewRows is capped while rowCount reports the true total", () => {
    const rows = Array.from(
      { length: 50 },
      (_, i) => `sku-${i},Item ${i},10.00,5,staples`
    );
    const csv = ["sku,name,price,stock,category", ...rows].join("\n");
    const { previewRows, rowCount } = readCsvColumns(csv, {
      previewLimit: 10,
    });
    expect(rowCount).toBe(50);
    expect(previewRows).toHaveLength(10);
  });
});

describe("selectedFrom and categoryColumnVerdict (offline, pure helpers)", () => {
  test("selectedFrom keeps the exclusion set as the stored state — a stale category becomes unrepresentable", () => {
    const excluded = new Set<string>();
    const firstPass = selectedFrom(["A", "B"], excluded);
    expect(firstPass).toEqual(["A", "B"]);

    excluded.add("B");
    const afterExcludingB = selectedFrom(["A", "B"], excluded);
    expect(afterExcludingB).toEqual(["A"]);

    // Remapping to a new column's values: "B" lingers in the exclusion set as
    // an unreachable string, but "C" and "D" are not in it, so they arrive
    // ticked rather than inheriting the old column's unticks.
    const afterRemap = selectedFrom(["C", "D"], excluded);
    expect(afterRemap).toEqual(["C", "D"]);
  });

  test("a stale category is unrepresentable — the load-bearing property, pinned directly", () => {
    // This is the exact claim the exclusion-set design makes (see
    // selectedFrom's doc comment in mapping-types.ts): once the merchant
    // remaps away from a column, that column's category strings can never
    // again appear in the submitted allowlist, no matter what the exclusion
    // set still contains. A regression here would mean a category the
    // merchant never saw or chose slipping into `category_allowlist`. If
    // this state were ever "simplified" to a selected-set instead of an
    // exclusion-set, this assertion is what would catch it: a selected-set
    // naively carried across a remap could still contain "B".
    const excluded = new Set<string>(["B"]);
    // "B" is deliberately IN the available list here too, unlike the
    // remap case below — a `selectedFrom` that degraded into a no-op
    // (returning `available` untouched, the exact "simplify to a
    // selected-set" regression this test exists to catch) would still pass
    // a version of this assertion that never put "B" in `available` in the
    // first place. Put it in both, so a no-op is forced to fail here.
    const stillPresent = selectedFrom(["A", "B", "C"], excluded);
    expect(stillPresent).not.toContain("B");
    expect(stillPresent).toEqual(["A", "C"]);

    // And once remapped away, "B" is unreachable even though it is still
    // sitting in the exclusion set.
    const allowlist = selectedFrom(["C", "D"], excluded);
    expect(allowlist).not.toContain("B");
    expect(allowlist).toEqual(["C", "D"]);
  });

  test("A -> B -> A restores the merchant's earlier unticks", () => {
    const excluded = new Set<string>();
    expect(selectedFrom(["A", "B"], excluded)).toEqual(["A", "B"]);

    excluded.add("B");
    expect(selectedFrom(["A", "B"], excluded)).toEqual(["A"]);

    // Remap away...
    expect(selectedFrom(["C", "D"], excluded)).toEqual(["C", "D"]);

    // ...and remap back. "B" was never removed from the exclusion set by the
    // remap away from it, only rendered unreachable — so it is still there
    // once "B" is reachable again.
    expect(selectedFrom(["A", "B"], excluded)).toEqual(["A"]);
    expect(excluded.has("B")).toBe(true);
  });

  test("an empty exclusion set is the all-ticked default, over any available list", () => {
    const excluded = new Set<string>();
    expect(selectedFrom(["A", "B", "C"], excluded)).toEqual(["A", "B", "C"]);
    expect(selectedFrom([], excluded)).toEqual([]);
    expect(selectedFrom(["staples", "dairy", "snacks"], excluded)).toEqual([
      "staples",
      "dairy",
      "snacks",
    ]);
  });

  test("categoryColumnVerdict on the real fixtures: every fixture's category column is 'ok'", () => {
    // The regression cases this ticket exists to guard: without the
    // NEARLY_UNIQUE_MIN_ROWS floor, a 5-row catalog with 4 (or 3) distinct
    // categories trips the >50%-distinct ratio and wrongly verdicts
    // "review" — which would put a filter box and a scary banner in front
    // of the demo merchant's five-row catalog for no reason.
    const merchantA = readCsvColumns(MERCHANT_A_CSV);
    expect(
      categoryColumnVerdict(
        merchantA.columnValues["category"],
        merchantA.rowCount
      )
    ).toBe("ok");
    expect(merchantA.rowCount).toBe(5);
    expect(merchantA.columnValues["category"]?.distinctCount).toBe(4);

    const shopifyExport = readCsvColumns(SHOPIFY_EXPORT_CSV);
    expect(
      categoryColumnVerdict(
        shopifyExport.columnValues["Product Type"],
        shopifyExport.rowCount
      )
    ).toBe("ok");
    expect(shopifyExport.rowCount).toBe(5);
    expect(shopifyExport.columnValues["Product Type"]?.distinctCount).toBe(3);

    const demoMerchantA = readCsvColumns(DEMO_MERCHANT_A_CSV);
    expect(
      categoryColumnVerdict(
        demoMerchantA.columnValues["category"],
        demoMerchantA.rowCount
      )
    ).toBe("ok");
  });

  test("categoryColumnVerdict: ok, review, and unusable bands", () => {
    const ok = {
      values: ["a", "b", "c"],
      distinctCount: 3,
      blankRows: 0,
      truncated: false,
    };
    expect(categoryColumnVerdict(ok, 100)).toBe("ok");

    const review = {
      values: Array.from({ length: 41 }, (_, i) => `cat-${i}`),
      distinctCount: 41,
      blankRows: 0,
      truncated: false,
    };
    expect(categoryColumnVerdict(review, 1000)).toBe("review");

    // NEARLY_UNIQUE_MIN_ROWS (20) gates the ratio check: below it, a small
    // catalog with a few categories must not be flagged just because the
    // ratio looks high — the exact case fixtures/shopify-export.csv covers.
    const nearlyUniqueSmallCatalog = {
      values: ["a", "b", "c"],
      distinctCount: 3,
      blankRows: 0,
      truncated: false,
    };
    expect(categoryColumnVerdict(nearlyUniqueSmallCatalog, 4)).toBe("ok");

    const nearlyUniqueLargeCatalog = {
      values: Array.from({ length: 11 }, (_, i) => `cat-${i}`),
      distinctCount: 11,
      blankRows: 0,
      truncated: false,
    };
    expect(categoryColumnVerdict(nearlyUniqueLargeCatalog, 20)).toBe("review");

    const unusable = {
      values: [],
      distinctCount: 300,
      blankRows: 0,
      truncated: true,
    };
    expect(categoryColumnVerdict(unusable, 1000)).toBe("unusable");

    expect(categoryColumnVerdict(undefined, 100)).toBe("ok");
  });
});

describe("availableCategoriesFor (offline, pure helper)", () => {
  const columnValues = readCsvColumns(DEMO_MERCHANT_A_CSV).columnValues;

  test("column branch: returns that column's distinct values", () => {
    expect(availableCategoriesFor("category", "", columnValues)).toEqual(
      columnValues["category"]?.values ?? []
    );
  });

  test("column branch: an unmapped/unknown column name yields an empty list rather than throwing", () => {
    expect(availableCategoriesFor("no-such-column", "", columnValues)).toEqual(
      []
    );
  });

  test("fixed branch: a trimmed, non-blank literal is the sole option", () => {
    expect(availableCategoriesFor(null, "general", columnValues)).toEqual([
      "general",
    ]);
    // Leading/trailing whitespace around a real value is trimmed, same as
    // the CSV parser's own `trim: true`.
    expect(availableCategoriesFor(null, "  general  ", columnValues)).toEqual([
      "general",
    ]);
  });

  test("fixed branch: a blank or whitespace-only literal yields no options at all", () => {
    expect(availableCategoriesFor(null, "", columnValues)).toEqual([]);
    expect(availableCategoriesFor(null, "   ", columnValues)).toEqual([]);
  });
});

describe("proposeMapping (offline — fetch is always stubbed or absent)", () => {
  test("no OPENROUTER_API_KEY set returns null without calling fetch", async () => {
    const original = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("fetch should not have been called");
    }) as unknown as typeof fetch;
    try {
      const result = await proposeMapping(SHOPIFY_HEADER, [
        ["toor-dal", "Toor Dal 1kg", "sku-w01", "145.00", "40"],
      ]);
      expect(result).toBeNull();
      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
      if (original !== undefined) process.env["OPENROUTER_API_KEY"] = original;
    }
  });

  test("a failed API call (stubbed non-2xx) falls back to null, never throws", async () => {
    const original = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("rate limited", { status: 429 })) as unknown as typeof fetch;
    try {
      const result = await proposeMapping(SHOPIFY_HEADER, [
        ["toor-dal", "Toor Dal 1kg", "sku-w01", "145.00", "40"],
      ]);
      expect(result).toBeNull();
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = original;
    }
  });

  test("a well-formed stubbed model response validates end to end", async () => {
    const original = process.env["OPENROUTER_API_KEY"];
    process.env["OPENROUTER_API_KEY"] = "test-key";
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  mapping: {
                    sku: "Variant SKU",
                    name: "Title",
                    price: "Variant Price",
                    stock: "Variant Inventory Qty",
                    category: "Product Category",
                  },
                  confidence: {
                    sku: 0.95,
                    name: 0.95,
                    price: 0.9,
                    stock: 0.9,
                    category: 0.9,
                  },
                }),
              },
            },
          ],
        }),
        { status: 200 }
      )) as unknown as typeof fetch;
    try {
      const result = await proposeMapping(SHOPIFY_HEADER, [
        ["toor-dal", "Toor Dal 1kg", "sku-w01", "145.00", "40", "groceries"],
      ]);
      expect(result?.mapping.sku).toBe("Variant SKU");
    } finally {
      globalThis.fetch = originalFetch;
      if (original === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = original;
    }
  });
});

describe("onboard (integration, against real Postgres, namespaced m_web_*)", () => {
  test("onboards a merchant end to end from a Shopify-style CSV and a resolved mapping", async () => {
    const name = "Web Onboard Smoke Kirana";
    const merchantId = slugifyMerchantId(name);
    expect(merchantId.startsWith("m_web_onboard")).toBe(true);
    await cleanupMerchant(merchantId);

    const result = await onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, {
      spend_cap_rupees: "5000.00",
      approval_threshold_rupees: "1500.00",
      category_allowlist: ["groceries", "dairy"],
      window: "24h",
    });

    expect(result.productCount).toBe(3);
    expect(result.token).toMatch(/^dk_/);
    expect(result.endpoint).toContain("/mcp");

    const productCount = await queryOne<{ count: string }>(
      "SELECT count(*)::text AS count FROM products WHERE merchant_id = $1",
      [merchantId]
    );
    expect(productCount?.count).toBe("3");

    await cleanupMerchant(merchantId);
  });

  test("nothing is written to products when the mapping produces an invalid row", async () => {
    const name = "Web Onboard Bad Row";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    // Map "price" at a column that actually holds the SKU string — produces
    // an unparseable price, which parseCatalogCsv (via createMerchant) must
    // reject before any row is written.
    const badMapping: ColumnMapping = {
      ...SHOPIFY_MAPPING,
      price: "Variant SKU",
    };

    await expect(
      onboard(SHOPIFY_CSV, badMapping, name, {
        spend_cap_rupees: "5000.00",
        approval_threshold_rupees: "1500.00",
        category_allowlist: ["groceries", "dairy"],
        window: "24h",
      })
    ).rejects.toThrow();

    const merchantRow = await queryOne(
      "SELECT id FROM merchants WHERE id = $1",
      [merchantId]
    );
    expect(merchantRow).toBeNull();
    const rows = await query("SELECT id FROM products WHERE merchant_id = $1", [
      merchantId,
    ]);
    expect(rows).toHaveLength(0);
  });

  test("a duplicate merchant name/id is rejected without a partial write", async () => {
    const name = "Web Onboard Dupe";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const policy = {
      spend_cap_rupees: "5000.00",
      approval_threshold_rupees: "1500.00",
      category_allowlist: ["groceries", "dairy"],
      window: "24h",
    };

    await onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, policy);

    // Asserting the MESSAGE, not just that it rejects. A repeated name is the
    // one failure a human hits by accident, and Postgres words it as
    // "duplicate key value violates unique constraint", which lands on screen
    // mid-demo as alarming and unactionable. `toThrow()` alone passed happily
    // while that was what the merchant saw.
    await expect(
      onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, policy)
    ).rejects.toThrow(/already exists/i);
    await expect(
      onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, policy)
    ).rejects.not.toThrow(/duplicate key|unique constraint/i);

    const agentRows = await query(
      "SELECT id FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(agentRows).toHaveLength(1);

    await cleanupMerchant(merchantId);
  });
});

describe("onboard: an allowlist derived from the CSV's own categories, end to end", () => {
  test("excluding a category via the derived-checkboxes flow keeps it out of the written policy row, in the surviving order", async () => {
    // This is the actual DUK-27 flow, wired end to end: read the categories
    // out of the CSV (readCsvColumns), let the merchant untick two of them
    // (selectedFrom), and onboard with the result — then check what
    // Postgres actually stored, not just what was passed in.
    const { columnValues, rowCount } = readCsvColumns(DEMO_MERCHANT_A_CSV);
    expect(categoryColumnVerdict(columnValues["category"], rowCount)).toBe(
      "ok"
    );
    const available = availableCategoriesFor("category", "", columnValues);
    expect(available).toEqual([
      "staples",
      "dairy",
      "snacks",
      "household",
      "personal-care",
      "beverages",
    ]);

    const excluded = new Set<string>(["personal-care", "beverages"]);
    const allowlist = selectedFrom(available, excluded);
    expect(allowlist).toEqual(["staples", "dairy", "snacks", "household"]);

    const name = "Web Onboard Derived Allowlist";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const mapping: ColumnMapping = {
      sku: "sku",
      name: "name",
      price: "price",
      stock: "stock",
      category: { kind: "column", column: "category" },
    };

    const result = await onboard(DEMO_MERCHANT_A_CSV, mapping, name, {
      spend_cap_rupees: "5000.00",
      approval_threshold_rupees: "1500.00",
      category_allowlist: allowlist,
      window: "24h",
    });
    expect(result.productCount).toBe(25);

    const row = await queryOne<{ category_allowlist: string[] }>(
      "SELECT category_allowlist FROM policies WHERE merchant_id = $1",
      [merchantId]
    );
    expect(row?.category_allowlist).toEqual([
      "staples",
      "dairy",
      "snacks",
      "household",
    ]);
    // The genuinely-excluded categories are absent, not just unordered-equal
    // to a shorter list — `toEqual` above already proves this, but the
    // explicit negative assertion is what a reader skimming for "did the
    // exclusion actually work" should see without re-deriving it.
    expect(row?.category_allowlist).not.toContain("personal-care");
    expect(row?.category_allowlist).not.toContain("beverages");

    await cleanupMerchant(merchantId);
  });
});

describe("onboard: buyer cap and the dashboard link", () => {
  test("returns the merchantId that was actually written, for the success screen's dashboard link", async () => {
    // Returned rather than re-derived on the client: the success screen links
    // to /dashboard/<id>, and re-slugifying the name there would be a second
    // implementation of the id that could drift from the row.
    const name = "Web Onboard Dash Link";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const result = await onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, {
      spend_cap_rupees: "5000.00",
      approval_threshold_rupees: "1500.00",
      category_allowlist: ["groceries", "dairy"],
      window: "24h",
    });

    expect(result.merchantId).toBe(merchantId);
    const row = await queryOne<{ id: string }>(
      "SELECT id FROM merchants WHERE id = $1",
      [merchantId]
    );
    expect(row?.id).toBe(merchantId);

    await cleanupMerchant(merchantId);
  });

  test("an omitted buyer cap leaves the agent row NULL — the field is optional end to end", async () => {
    const name = "Web Onboard No Buyer Cap";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const result = await onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, {
      spend_cap_rupees: "5000.00",
      approval_threshold_rupees: "1500.00",
      category_allowlist: ["groceries", "dairy"],
      window: "24h",
    });

    expect(result.buyerCapPaise).toBeNull();
    const row = await queryOne<{ buyer_cap_paise: number | null }>(
      "SELECT buyer_cap_paise FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(row?.buyer_cap_paise).toBeNull();

    await cleanupMerchant(merchantId);
  });

  test("a blank buyer cap field is the same as leaving it out — the form always sends a string", async () => {
    // The form passes `buyerCapRupees.trim()` unconditionally, so "" is the
    // shape an untouched optional field actually arrives in; it must not
    // become a zero cap, which would block every order.
    const name = "Web Onboard Blank Buyer Cap";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const result = await onboard(
      SHOPIFY_CSV,
      SHOPIFY_MAPPING,
      name,
      {
        spend_cap_rupees: "5000.00",
        approval_threshold_rupees: "1500.00",
        category_allowlist: ["groceries", "dairy"],
        window: "24h",
      },
      ""
    );

    expect(result.buyerCapPaise).toBeNull();
    await cleanupMerchant(merchantId);
  });

  test("a rupee buyer cap from the form reaches the agent row as integer paise", async () => {
    const name = "Web Onboard Buyer Cap";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    const result = await onboard(
      SHOPIFY_CSV,
      SHOPIFY_MAPPING,
      name,
      {
        spend_cap_rupees: "5000.00",
        approval_threshold_rupees: "1500.00",
        category_allowlist: ["groceries", "dairy"],
        window: "24h",
      },
      "2500.50"
    );

    expect(result.buyerCapPaise).toBe(250_050);
    const row = await queryOne<{ buyer_cap_paise: number | null }>(
      "SELECT buyer_cap_paise FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(row?.buyer_cap_paise).toBe(250_050);

    await cleanupMerchant(merchantId);
  });

  test("a malformed buyer cap rejects the whole onboarding without a partial write", async () => {
    const name = "Web Onboard Bad Buyer Cap";
    const merchantId = slugifyMerchantId(name);
    await cleanupMerchant(merchantId);

    await expect(
      onboard(
        SHOPIFY_CSV,
        SHOPIFY_MAPPING,
        name,
        {
          spend_cap_rupees: "5000.00",
          approval_threshold_rupees: "1500.00",
          category_allowlist: ["groceries", "dairy"],
          window: "24h",
        },
        "twenty five hundred"
      )
    ).rejects.toThrow();

    const merchantRow = await queryOne(
      "SELECT id FROM merchants WHERE id = $1",
      [merchantId]
    );
    expect(merchantRow).toBeNull();
  });

  /**
   * STATIC guard, like the MCP_PORT one below: the dashboard route is built by
   * a different ticket, so this asserts the LINK exists and points at the
   * agreed path rather than rendering the page.
   */
  test("the success screen links to /dashboard/<merchantId>", async () => {
    const src = await Bun.file(
      new URL("../web/app/page.tsx", import.meta.url)
    ).text();

    expect(src).toContain("`/dashboard/${result.merchantId}`");
  });
});

describe("MCP endpoint handed to the merchant", () => {
  /**
   * STATIC guard, not a behavioural one: MCP_ENDPOINT is read at module load,
   * so a runtime test would need to re-import with a mutated env, and the trap
   * this protects against is textual anyway.
   *
   * `process.env.PORT` inside the Next process is NEXT's port (3000), not the
   * MCP server's (8787). Reading it here once shipped a success screen whose
   * endpoint 404'd — the single value the whole onboarding flow exists to
   * produce. Asserting on the source keeps the two servers' names disjoint.
   */
  test("derives the endpoint from MCP_PORT, never from bare PORT", async () => {
    const src = await Bun.file(
      new URL("../web/app/actions.ts", import.meta.url)
    ).text();

    expect(src).not.toMatch(/process\.env\[["']PORT["']\]/);
    expect(src).not.toMatch(/process\.env\.PORT\b/);
    expect(src).toContain('process.env["MCP_PORT"]');
  });
});

afterAll(async () => {
  // src/db/pool.ts's Pool is a process-wide singleton shared by every test
  // file in the same `bun test` process — never call closePool() here.
});
