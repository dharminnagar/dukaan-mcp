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
  exactHeaderFallback,
  lowConfidenceFields,
  parseModelMappingResponse,
  readHeaderAndSamples,
  renameToCanonicalCsv,
} from "../web/lib/mapping";
import { parseCatalogCsv } from "../src/catalog/csv";
import { pool, query, queryOne } from "../src/db/pool";

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
    await expect(
      onboard(SHOPIFY_CSV, SHOPIFY_MAPPING, name, policy)
    ).rejects.toThrow();

    const agentRows = await query(
      "SELECT id FROM agents WHERE merchant_id = $1",
      [merchantId]
    );
    expect(agentRows).toHaveLength(1);

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
