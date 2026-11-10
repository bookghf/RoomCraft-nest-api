// Shared logic for the back office catalog routes. Ported from the Go API's admin_catalog.go.
//
// Staff edit catalogItems and categories directly. The apps only see those edits after a
// publish, which copies them into a new catalogVersions document.

import { Changes, diffJSON } from '../../core/admin';
import { Obj, int, num, obj, str } from '../../core/body';
import { fail } from '../../core/envelope';
import { CEILING_MAX, FieldErrors, HEX_COLOR, ID_PATTERN, quote } from '../../core/validate';
import { Store } from '../../db/mongo';
import { Doc, ZERO_TIME, categoryOut as coreCategoryOut, itemOut as coreItemOut, parseItem, putOmit, putPtr } from '../../db/models';
import { latestCatalog } from '../../db/store';

// Publish states of an editable item compared with the newest published catalog.
export const STATE_PUBLISHED = 'published'; // same as in the published catalog
export const STATE_NEW = 'new'; // not published yet
export const STATE_CHANGED = 'changed'; // edited since the last publish
export const STATE_REMOVING = 'removing'; // retired, still in the published catalog until the next publish
export const STATE_RETIRED = 'retired'; // retired and already gone from the published catalog

// ---- Go map encoding ----
// Go's encoding/json writes map keys in sorted order. Structs keep their field order, so only
// values that were Go maps (map[string]any responses, decoded diff values, Text) are sorted.

/** Sorts the keys of every object, recursively (a value decoded into map[string]any). */
export function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const o: Doc = {};
    for (const k of Object.keys(v as object).sort()) o[k] = sortDeep((v as Doc)[k]);
    return o;
  }
  return v;
}

/** Sorts only the top-level keys (a map[string]any of struct values). */
export function sortTop<T extends Doc>(v: T): T {
  const o: Doc = {};
  for (const k of Object.keys(v).sort()) o[k] = v[k];
  return o as T;
}

/** diffJSON, shown as Go shows map[string]model.Change: keys sorted, values as decoded maps. */
export function diff(before: unknown, after: unknown): Changes | null {
  const c = diffJSON(before, after);
  return c ? (sortDeep(c) as Changes) : null;
}

/** A Text map stored with sorted keys, so this API shows it like Go does. */
function sortText(t: Record<string, string>): Record<string, string> {
  return sortTop(t);
}

/**
 * Item JSON as Go writes it: core itemOut, with the map values (name, colour names,
 * model.params) in sorted key order. Go-written documents store maps in random order.
 */
export function itemOut(it: Doc): Doc {
  const o = coreItemOut(it);
  if (o.name && typeof o.name === 'object') o.name = sortTop(o.name);
  if (Array.isArray(o.colors)) for (const c of o.colors) if (c.name && typeof c.name === 'object') c.name = sortTop(c.name);
  if (o.model?.params) o.model.params = sortDeep(o.model.params);
  return o;
}

/** Category JSON with the name map in sorted key order, as Go writes it. */
export function categoryOut(c: Doc): Doc {
  const o = coreCategoryOut(c);
  if (o.name && typeof o.name === 'object') o.name = sortTop(o.name);
  return o;
}

// ---- Items ----

/** The newest published catalog and its items by id; null/empty before the first publish. */
export async function publishedIndex(s: Store): Promise<{ v: Doc | null; byID: Map<string, Doc> }> {
  const v = await latestCatalog(s);
  const byID = new Map<string, Doc>();
  for (const it of v?.items ?? []) byID.set(it._id, it);
  return { v, byID };
}

export function allItems(s: Store): Promise<Doc[]> {
  return s.items.find({}, { sort: { sortOrder: 1, _id: 1 } }).toArray();
}

/** Go's adminItem: the client item fields, bookkeeping fields and the publish state. */
export function adminItemOut(it: Doc, published: Map<string, Doc>, usageCount?: number): Doc {
  const o = itemOut(it);
  o.sortOrder = it.sortOrder ?? 0;
  o.createdAt = it.createdAt ?? ZERO_TIME;
  o.updatedAt = it.updatedAt ?? ZERO_TIME;
  putOmit(o, 'updatedBy', it.updatedBy);
  putPtr(o, 'retiredAt', it.retiredAt);
  const pub = published.get(it._id);
  let changes: Changes | null = null;
  if (it.retiredAt && pub) o.publishState = STATE_REMOVING;
  else if (it.retiredAt) o.publishState = STATE_RETIRED;
  else if (!pub) o.publishState = STATE_NEW;
  else {
    changes = diff(itemOut(pub), itemOut(it));
    o.publishState = changes ? STATE_CHANGED : STATE_PUBLISHED;
  }
  if (changes) o.changes = changes;
  putPtr(o, 'usageCount', usageCount);
  return o;
}

/** Go's itemMatches: q (lower case) in the id, the SKU or a name in any language. */
export function itemMatches(it: Doc, q: string): boolean {
  if (String(it._id).includes(q) || String(it.sku ?? '').toLowerCase().includes(q)) return true;
  return Object.values((it.name ?? {}) as Record<string, string>).some((n) => String(n).toLowerCase().includes(q));
}

/**
 * Parses an item body like Go's json.Decode into model.CatalogItem. price is decoded (so a
 * wrong type is an error) but never stored; priceSatang must be an integer (int64).
 */
export function parseItemBody(v: unknown): Doc {
  const o = obj(v, 'item');
  num(o, 'price', 'item');
  int(o, 'priceSatang', 'item');
  const it = parseItem(o, 'item');
  it.name = sortText(it.name);
  for (const c of it.colors) c.name = sortText(c.name);
  if (it.model?.params) it.model.params = sortDeep(it.model.params);
  return it;
}

const MOUNTS = new Set(['floor', 'wall', 'ceiling']);

export async function validateItem(s: Store, it: Doc): Promise<void> {
  const errs = new FieldErrors();
  if ((await s.categories.countDocuments({ _id: it.category })) === 0) errs.add('category', `unknown category ${quote(it.category)}`);
  if (!MOUNTS.has(it.mount)) errs.add('mount', 'must be floor, wall or ceiling');
  for (const lang of ['en', 'th', 'zh']) {
    if ((it.name?.[lang] ?? '').trim() === '') errs.add(`name.${lang}`, 'required');
  }
  if (it.priceSatang < 0 || it.priceSatang > 100_000_000_00) errs.add('priceSatang', 'must be between 0 and 100,000,000 THB (in satang)');
  const sz = it.size;
  if (sz.w <= 0 || sz.d <= 0 || sz.h <= 0 || sz.w > 10 || sz.d > 10 || sz.h > 3) errs.add('size', 'w and d must be 0–10 m, h 0–3 m');
  if (it.mountHeight !== undefined && (it.mountHeight < 0 || it.mountHeight > CEILING_MAX)) {
    errs.add('mountHeight', `must be 0–${CEILING_MAX.toFixed(1)} m`);
  }
  if (it.colors.length === 0) errs.add('colors', 'at least one colour');
  const seen = new Set<string>();
  it.colors.forEach((c: Doc, i: number) => {
    if (!ID_PATTERN.test(c.id) || seen.has(c.id) || !HEX_COLOR.test(c.hex) || (c.name?.en ?? '').trim() === '') {
      errs.add(`colors[${i}]`, 'needs a unique id, a hex colour and an English name');
    }
    seen.add(c.id);
  });
  if (!it.model.template) errs.add('model.template', 'required');
  if (it.mount !== 'floor' && (it.surface || it.stackable || it.flat)) {
    errs.add('mount', 'surface, stackable and flat only apply to floor items');
  }
  if (it.sku) {
    if ((await s.items.countDocuments({ sku: it.sku, _id: { $ne: it._id } })) > 0) errs.add('sku', 'already used by another item');
  }
  errs.throwIfAny();
}

/** A stored item with Go's field order: client fields, then bookkeeping fields. */
export function storedItem(it: Doc, extra: { sortOrder: number; createdAt?: Date; updatedAt: Date; updatedBy?: string; retiredAt?: Date }): Doc {
  const { _id, ...rest } = it;
  const d: Doc = { _id, ...rest, sortOrder: extra.sortOrder };
  if (extra.createdAt) d.createdAt = extra.createdAt;
  d.updatedAt = extra.updatedAt;
  if (extra.updatedBy) d.updatedBy = extra.updatedBy;
  if (extra.retiredAt) d.retiredAt = extra.retiredAt;
  return d;
}

// ---- Publishing ----

export function categoriesSorted(s: Store): Promise<Doc[]> {
  return s.categories.find({}, { sort: { sortOrder: 1, _id: 1 } }).toArray();
}

const ref = (it: Doc) => ({ id: it._id, name: it.name && typeof it.name === 'object' ? sortTop(it.name) : it.name ?? null });

/** Compares the editable catalog with the newest published version. */
export async function pendingChanges(s: Store) {
  const { v: pubV, byID: published } = await publishedIndex(s);
  const items = await allItems(s);
  const c = {
    publishedVersion: '',
    added: [] as Doc[],
    changed: [] as Doc[],
    removed: [] as Doc[],
    categoriesChanged: [] as string[],
    hasChanges: false,
  };
  const live = new Set<string>();
  for (const it of items) {
    if (it.retiredAt) continue;
    live.add(it._id);
    const pub = published.get(it._id);
    if (!pub) c.added.push(ref(it));
    else {
      const d = diff(itemOut(pub), itemOut(it));
      if (d) c.changed.push({ ...ref(it), changes: d });
    }
  }
  let pubCats: Doc[] = [];
  if (pubV) {
    c.publishedVersion = pubV._id;
    pubCats = pubV.categories ?? [];
    for (const it of pubV.items ?? []) if (!live.has(it._id)) c.removed.push(ref(it));
  }
  const cats = await categoriesSorted(s);
  const pubByID = new Map(pubCats.map((pc) => [pc._id, pc]));
  const pubOrder = pubCats.map((pc) => pc._id);
  const order: string[] = [];
  for (const cat of cats) {
    order.push(cat._id);
    const pc = pubByID.get(cat._id);
    if (!pc || diffJSON(categoryOut(pc), categoryOut(cat)) !== null) c.categoriesChanged.push(cat._id);
  }
  if (c.categoriesChanged.length === 0 && order.join('\u0000') !== pubOrder.join('\u0000')) c.categoriesChanged.push('(order)');
  c.hasChanges = !pubV || c.added.length + c.changed.length + c.removed.length + c.categoriesChanged.length > 0;
  return c;
}

/** Go's time.Format("2006-01-02.150405") in UTC. */
function autoVersion(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}.${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** Reads {version?, notes?}. notesDefault applies when notes is empty before trimming (rollback). */
export function publishBody(raw: unknown | undefined, notesDefault = ''): { version: string; notes: string } {
  const o: Obj = raw === undefined ? {} : obj(raw, 'publishBody');
  let version = raw === undefined ? '' : str(o, 'version', 'publishBody');
  let notes = raw === undefined ? '' : str(o, 'notes', 'publishBody');
  if (notes === '' && notesDefault) notes = notesDefault;
  version = version.trim();
  notes = notes.trim();
  if (version === '') version = autoVersion();
  if (!ID_PATTERN.test(version.replaceAll('.', '_'))) {
    FieldErrors.of('version', "letters, digits, '.', '-' or '_' only").throwIfAny();
  }
  if (Buffer.byteLength(notes) > 500) FieldErrors.of('notes', 'at most 500 characters').throwIfAny();
  return { version, notes };
}

/** Go's versionSummary. itemCount is given when the items aren't loaded (list). */
export function versionSummaryOut(v: Doc, itemCount?: number): Doc {
  const o: Doc = { version: v._id ?? v.version, publishedAt: v.publishedAt ?? ZERO_TIME };
  putOmit(o, 'publishedBy', v.publishedBy);
  putOmit(o, 'notes', v.notes);
  o.itemCount = itemCount ?? (v.items ?? []).length;
  putOmit(o, 'rolledBackFrom', v.rolledBackFrom);
  return o;
}

export const versionExists = (version: string) => fail(409, 'VERSION_EXISTS', `Catalog version ${version} already exists.`);

// ---- Categories ----

/** Go's adminCategory: the category, sortOrder and the number of live items. */
export function adminCategoryOut(c: Doc, itemCount: number): Doc {
  return { ...categoryOut(c), sortOrder: c.sortOrder ?? 0, itemCount };
}

export { sortText };
