import { describe, expect, test } from 'bun:test';
import { parseCatalogCsv, rupeesToPaise } from '../src/catalog/csv';

describe('rupeesToPaise', () => {
  test('parses two-decimal rupee strings', () => {
    expect(rupeesToPaise('499.50')).toBe(49950);
  });

  test('parses one-decimal rupee strings', () => {
    expect(rupeesToPaise('499.5')).toBe(49950);
  });

  test('parses whole-rupee strings', () => {
    expect(rupeesToPaise('499')).toBe(49900);
  });

  test('parses comma thousands separators', () => {
    expect(rupeesToPaise('1,299.00')).toBe(129900);
  });

  test('is exact for values that are lossy under float multiplication', () => {
    // 0.29 * 100 === 28.999999999999996 in IEEE-754. This must not happen here.
    expect(rupeesToPaise('0.29')).toBe(29);
  });

  test('rejects sub-paise precision', () => {
    expect(() => rupeesToPaise('499.505')).toThrow();
  });

  test('rejects non-numeric input', () => {
    expect(() => rupeesToPaise('abc')).toThrow();
  });

  test('rejects negative amounts', () => {
    expect(() => rupeesToPaise('-5.00')).toThrow();
  });
});

describe('parseCatalogCsv', () => {
  const headerA = 'sku,name,price,stock,category';
  const rowA = 'p1,Widget,100.00,10,tools';

  const headerB = 'name,category,sku,stock,price';
  const rowB = 'Widget,tools,p1,10,100.00';

  test('parses a minimal catalog into product rows', () => {
    const csv = `${headerA}\n${rowA}\n`;
    const { products } = parseCatalogCsv(csv, 'm_test');
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      merchant_id: 'm_test',
      id: 'p1',
      name: 'Widget',
      price_paise: 10000,
      stock: 10,
      category: 'tools',
    });
  });

  test('the merchant-a smoke fixture parses to 5 products', async () => {
    const csv = await Bun.file(`${import.meta.dir}/../fixtures/merchant-a.csv`).text();
    const { products } = parseCatalogCsv(csv, 'm_smoke');
    expect(products).toHaveLength(5);
    expect(products.every((p) => p.merchant_id === 'm_smoke')).toBe(true);
  });

  test('column order does not affect the parsed product set', () => {
    const csvA = `${headerA}\n${rowA}\n`;
    const csvB = `${headerB}\n${rowB}\n`;
    expect(parseCatalogCsv(csvA, 'm_test')).toEqual(parseCatalogCsv(csvB, 'm_test'));
  });

  test('a row missing price throws naming the file line number', () => {
    const csv = `${headerA}\np1,Widget,,10,tools\n`;
    expect(() => parseCatalogCsv(csv, 'm_test')).toThrow(/line 2/);
  });

  test('the SECOND row missing a field is reported at line 3, not line 2', () => {
    const csv = `${headerA}\np1,Widget,100.00,10,tools\np2,Gadget,,5,tools\n`;
    expect(() => parseCatalogCsv(csv, 'm_test')).toThrow(/line 3/);
  });

  test('a duplicate sku throws naming its line', () => {
    const csv = `${headerA}\np1,Widget,100.00,10,tools\np1,Widget Two,50.00,5,tools\n`;
    expect(() => parseCatalogCsv(csv, 'm_test')).toThrow(/line 3/);
  });

  test('a zero price is rejected by the shared Product schema', () => {
    const csv = `${headerA}\np1,Widget,0,10,tools\n`;
    expect(() => parseCatalogCsv(csv, 'm_test')).toThrow(/line 2/);
  });

  test('an empty CSV throws', () => {
    expect(() => parseCatalogCsv(`${headerA}\n`, 'm_test')).toThrow();
  });
});
