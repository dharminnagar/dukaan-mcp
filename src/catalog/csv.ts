/**
 * Merchant catalog CSV ingestion. Expected headers: sku,name,price,stock,category
 * (order-independent — `csv-parse`'s `columns: true` maps by header name).
 *
 * Header is line 1, so the first data row is line 2. Errors surface the file
 * line number because onboarding is a human fixing a spreadsheet, not a
 * program consuming an index.
 */
import { parse } from 'csv-parse/sync';
import { Product } from '../shared/contracts';

export interface CsvParseError {
  readonly line: number;
  readonly message: string;
}

/** Thrown by parseCatalogCsv. Carries the file line number as a real property, not just in the text. */
function csvError(line: number, message: string): Error & CsvParseError {
  const err = new Error(`line ${line}: ${message}`) as Error & CsvParseError;
  Object.defineProperty(err, 'line', { value: line, enumerable: true });
  return err;
}

/**
 * "499.50" -> 49950. Deliberately no `parseFloat(x) * 100` anywhere: that is
 * silently wrong for inputs like "0.29" (0.29 * 100 === 28.999999999999996 in
 * IEEE-754). Instead split the string into integer/fractional parts and
 * combine them as integers.
 */
export function rupeesToPaise(input: string): number {
  const withoutSeparators = input.trim().replace(/,/g, '');
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(withoutSeparators);
  if (match === null) {
    throw new Error(
      `Invalid rupee amount ${JSON.stringify(input)}: expected digits, optional comma separators, and at most 2 decimal places`,
    );
  }
  const [, rupeesPart, paisePart] = match;
  // rupeesPart is guaranteed by the regex's mandatory first group.
  const rupees = Number.parseInt(rupeesPart!, 10);
  const paise = Number.parseInt((paisePart ?? '').padEnd(2, '0'), 10);
  return rupees * 100 + paise;
}

const REQUIRED_COLUMNS = ['sku', 'name', 'price', 'stock', 'category'] as const;

type RawRow = Record<string, string | undefined>;

function requireField(
  row: RawRow,
  column: (typeof REQUIRED_COLUMNS)[number],
  line: number,
): string {
  const value = row[column];
  if (value === undefined || value.trim().length === 0) {
    throw csvError(line, `missing required field "${column}"`);
  }
  return value.trim();
}

/** The shape rows are validated against before being handed back to the caller. */
const CatalogRow = Product.omit({ updated_at: true });

export function parseCatalogCsv(
  csv: string,
  merchantId: string,
): { readonly products: Omit<Product, 'updated_at'>[] } {
  const rows: RawRow[] = parse(csv, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
  });

  if (rows.length === 0) {
    throw csvError(1, 'CSV has no data rows');
  }

  const products: Omit<Product, 'updated_at'>[] = [];
  const seenSkus = new Set<string>();

  rows.forEach((row, index) => {
    const line = index + 2; // line 1 is the header

    for (const column of REQUIRED_COLUMNS) {
      requireField(row, column, line);
    }

    const sku = requireField(row, 'sku', line);
    const name = requireField(row, 'name', line);
    const priceRupees = requireField(row, 'price', line);
    const stockRaw = requireField(row, 'stock', line);
    const category = requireField(row, 'category', line);

    if (seenSkus.has(sku)) {
      throw csvError(line, `duplicate sku "${sku}"`);
    }
    seenSkus.add(sku);

    let pricePaise: number;
    try {
      pricePaise = rupeesToPaise(priceRupees);
    } catch (err) {
      throw csvError(line, `invalid price "${priceRupees}": ${(err as Error).message}`);
    }

    if (!/^\d+$/.test(stockRaw)) {
      throw csvError(line, `invalid stock "${stockRaw}": must be a non-negative integer`);
    }
    const stock = Number.parseInt(stockRaw, 10);

    const result = CatalogRow.safeParse({
      merchant_id: merchantId,
      id: sku,
      name,
      price_paise: pricePaise,
      stock,
      category,
    });
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join('; ');
      throw csvError(line, `invalid row: ${messages}`);
    }

    products.push(result.data);
  });

  return { products };
}
