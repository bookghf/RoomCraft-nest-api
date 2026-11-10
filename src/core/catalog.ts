// The newest published catalog, kept in memory and re-read every CATALOG_TTL_MS, so a
// publish on one instance reaches the others within that time. Same as the Go API.

import { fail } from './envelope';
import { db } from '../db/mongo';
import { Doc, catalogVersionOut } from '../db/models';
import { latestCatalog } from '../db/store';
import { goJSON } from './json';

export const CATALOG_TTL_MS = 30_000;

export interface PublishedCatalog {
  version: string;
  /** The stored version document. */
  doc: Doc;
  /** Stored items by id (priceSatang, colors, name, sku...). */
  byID: Map<string, Doc>;
  /** The GET /v1/catalog response body, encoded once. */
  body: string;
}

let cached: PublishedCatalog | undefined;
let loadedAt = 0;
let loading: Promise<PublishedCatalog> | undefined;

async function load(): Promise<PublishedCatalog> {
  const s = await db();
  let v: Doc | null;
  try {
    v = await latestCatalog(s);
  } catch (err) {
    if (cached) {
      console.warn(JSON.stringify({ time: new Date().toISOString(), level: 'WARN', msg: 'catalog reload failed, serving cached version', err: String(err) }));
      return cached;
    }
    throw err;
  }
  if (!v) {
    if (cached) return cached;
    throw fail(503, 'CATALOG_NOT_PUBLISHED', 'No catalog has been published yet. Run the seed command.');
  }
  const byID = new Map<string, Doc>();
  for (const it of v.items ?? []) byID.set(it._id, it);
  cached = { version: v._id, doc: v, byID, body: '' };
  cached.body = goJSON({ success: true, data: catalogVersionOut(v) });
  loadedAt = Date.now();
  return cached;
}

export async function publishedCatalog(): Promise<PublishedCatalog> {
  if (cached && Date.now() - loadedAt <= CATALOG_TTL_MS) return cached;
  loading ??= load().finally(() => {
    loading = undefined;
  });
  return loading;
}

/** Forces the next publishedCatalog() call to re-read the catalog (after a publish). */
export function invalidateCatalog(): void {
  loadedAt = 0;
}
