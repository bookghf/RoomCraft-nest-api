import { sortedMap } from '../db/models';
import type { DItem, Doc } from '../db/models';
import type { PublishedCatalog } from './catalog';

export interface QuoteLine {
  itemId: string;
  colorId?: string;
  sku?: string;
  name: Doc | null;
  quantity: number;
  unitSatang: number;
  lineSatang: number;
}

export interface Quote {
  catalogVersion: string;
  currency: string;
  lines: QuoteLine[];
  itemCount: number;
  totalSatang: number;
  unavailable: { itemId: string; quantity: number }[];
}

/**
 * Groups placed items by product and colour, in the order they were first placed, and
 * prices them from the published catalog. Items the catalog doesn't know are listed separately.
 */
export function buildQuote(items: DItem[], cat: PublishedCatalog): Quote {
  const q: Quote = { catalogVersion: cat.version, currency: 'THB', lines: [], itemCount: 0, totalSatang: 0, unavailable: [] };
  const lineAt = new Map<string, number>();
  const missingAt = new Map<string, number>();
  for (const it of items) {
    q.itemCount++;
    const ci = cat.byID.get(it.itemId);
    if (!ci) {
      const i = missingAt.get(it.itemId);
      if (i !== undefined) q.unavailable[i].quantity++;
      else {
        missingAt.set(it.itemId, q.unavailable.length);
        q.unavailable.push({ itemId: it.itemId, quantity: 1 });
      }
      continue;
    }
    const price = Number(ci.priceSatang ?? 0);
    const key = `${it.itemId}/${it.colorId}`;
    const i = lineAt.get(key);
    if (i !== undefined) {
      q.lines[i].quantity++;
      q.lines[i].lineSatang += price;
    } else {
      lineAt.set(key, q.lines.length);
      const line: QuoteLine = { itemId: it.itemId } as QuoteLine;
      if (it.colorId) line.colorId = it.colorId;
      if (ci.sku) line.sku = ci.sku;
      line.name = sortedMap(ci.name ?? null);
      line.quantity = 1;
      line.unitSatang = price;
      line.lineSatang = price;
      q.lines.push(line);
    }
    q.totalSatang += price;
  }
  return q;
}
