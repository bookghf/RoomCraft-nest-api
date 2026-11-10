// Catalog and plan publishing, seeding and the first owner account. Ported from the Go
// API's internal/store package; documents are stored with the same field names.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Store, isDuplicateKey } from './mongo';
import { Doc, ROLE_OWNER, parseItem, parsePlanSpec } from './models';

/** A version or id that already exists. */
export class ConflictError extends Error {
  constructor() {
    super('already exists');
  }
}

const SORTED = { sortOrder: 1, _id: 1 } as const;

// ---- Catalog ----

/** The most recently published catalog version, or null when none is published. */
export async function latestCatalog(s: Store): Promise<Doc | null> {
  return s.catalogVersions.findOne({}, { sort: { publishedAt: -1 } });
}

/** Copies every item that isn't retired into a new, read-only catalog version. */
export function publishCatalog(s: Store, version: string, notes: string, by: string): Promise<Doc> {
  return doPublishCatalog(s, version, notes, by, '');
}

async function doPublishCatalog(s: Store, version: string, notes: string, by: string, rolledBackFrom: string): Promise<Doc> {
  const cats = await s.categories.find({}, { sort: SORTED }).toArray();
  const items = await s.items.find({ retiredAt: { $exists: false } }, { sort: SORTED }).toArray();
  const v: Doc = { _id: version, categories: cats, items };
  if (notes) v.notes = notes;
  if (by) v.publishedBy = by;
  v.publishedAt = new Date();
  if (rolledBackFrom) v.rolledBackFrom = rolledBackFrom;
  try {
    await s.catalogVersions.insertOne(v);
  } catch (err) {
    if (isDuplicateKey(err)) throw new ConflictError();
    throw err;
  }
  return v;
}

/**
 * Makes the editable catalog match an older version again, then publishes it as a new
 * version. Items added since are retired, not deleted. Returns null when `from` doesn't exist.
 */
export async function rollbackCatalog(s: Store, from: string, version: string, notes: string, by: string): Promise<Doc | null> {
  const old = await s.catalogVersions.findOne({ _id: from });
  if (!old) return null;
  const now = new Date();
  const keep: string[] = [];
  for (const [i, src] of (old.items ?? []).entries()) {
    const it: Doc = { ...src, sortOrder: i, updatedAt: now };
    if (by) it.updatedBy = by;
    else delete it.updatedBy;
    delete it.retiredAt;
    keep.push(it._id);
    const cur = await s.items.findOne({ _id: it._id });
    if (cur) it.createdAt = cur.createdAt;
    if (!it.createdAt) delete it.createdAt;
    await s.items.replaceOne({ _id: it._id }, it, { upsert: true });
  }
  await s.items.updateMany(
    { _id: { $nin: keep }, retiredAt: { $exists: false } },
    { $set: { retiredAt: now, updatedAt: now, updatedBy: by } },
  );
  for (const [i, src] of (old.categories ?? []).entries()) {
    const c: Doc = { ...src, sortOrder: i, updatedAt: now };
    await s.categories.replaceOne({ _id: c._id }, c, { upsert: true });
  }
  return doPublishCatalog(s, version, notes, by, from);
}

/** Any catalog item, including hidden and retired ones, so old designs can still render. */
export function findItem(s: Store, id: string): Promise<Doc | null> {
  return s.items.findOne({ _id: id });
}

// ---- Plans ----

export const planKey = (id: string, version: number) => `${id}@${version}`;

/** A plan version, or the newest one when version is 0. Null when there is none. */
export function findPlanVersion(s: Store, id: string, version: number): Promise<Doc | null> {
  if (version > 0) return s.plans.findOne({ _id: planKey(id, version) });
  return s.plans.findOne({ planId: id }, { sort: { version: -1 } });
}

/** Stores the spec as the next version of the plan. */
export async function publishPlan(
  s: Store, kind: string, roomType: string, sortOrder: number, spec: Doc, by: string, notes: string,
): Promise<Doc> {
  let version = 1;
  const cur = await findPlanVersion(s, spec.id, 0);
  if (cur) {
    version = (cur.version ?? 0) + 1;
    if (sortOrder === 0) sortOrder = cur.sortOrder ?? 0;
  }
  const p: Doc = { _id: planKey(spec.id, version), planId: spec.id, version, kind };
  if (roomType) p.roomType = roomType;
  p.sortOrder = sortOrder;
  p.spec = spec;
  p.publishedAt = new Date();
  if (by) p.publishedBy = by;
  if (notes) p.notes = notes;
  try {
    await s.plans.insertOne(p);
  } catch (err) {
    if (isDuplicateKey(err)) throw new ConflictError();
    throw err;
  }
  return p;
}

// ---- Seed ----

export interface SeedReport {
  categories: number;
  items: number;
  roomTypes: number;
  plans: number;
  catalogVersion: string;
  catalogPublished: boolean;
}

const SEED_DIR = join(__dirname, '..', '..', 'seed');

function readSeed(name: string): any {
  return JSON.parse(readFileSync(join(SEED_DIR, name), 'utf8'));
}

/**
 * Adds the starting data from seed/*.json. It only inserts what is missing, so it is safe
 * to run again and never overwrites edits made through the admin API.
 */
export async function seed(s: Store): Promise<SeedReport> {
  const catalog = readSeed('catalog.json');
  const roomTypes: any[] = readSeed('room-types.json');
  const plans: any[] = readSeed('plans.json');
  const rep: SeedReport = { categories: 0, items: 0, roomTypes: 0, plans: 0, catalogVersion: catalog.version, catalogPublished: false };

  const insertMissing = async (coll: Store['items'], id: string, doc: Doc) => {
    const { _id, ...rest } = doc;
    const res = await coll.updateOne({ _id: id }, { $setOnInsert: rest }, { upsert: true });
    return res.upsertedCount > 0;
  };
  const now = new Date();
  for (const [i, c] of (catalog.categories as any[]).entries()) {
    const doc: Doc = { _id: c.id, name: c.name ?? {} };
    if (c.icon) doc.icon = c.icon;
    doc.sortOrder = i;
    doc.updatedAt = now;
    if (await insertMissing(s.categories, c.id, doc)) rep.categories++;
  }
  for (const [i, raw] of (catalog.items as any[]).entries()) {
    const it = parseItem(raw, 'item');
    it.priceSatang = Math.round((raw.price ?? 0) * 100);
    it.sortOrder = i;
    it.createdAt = now;
    it.updatedAt = now;
    it.updatedBy = 'seed';
    if (await insertMissing(s.items, it._id, it)) rep.items++;
  }
  for (const [i, rt] of roomTypes.entries()) {
    const doc: Doc = { _id: rt.id, name: rt.name ?? {}, blurb: rt.blurb ?? {}, gradient: rt.gradient ?? '', sortOrder: i, updatedAt: now };
    if (await insertMissing(s.roomTypes, rt.id, doc)) rep.roomTypes++;
  }
  for (const [i, p] of plans.entries()) {
    const spec = parsePlanSpec(p.spec);
    if ((await s.plans.countDocuments({ planId: spec.id })) > 0) continue;
    const roomType = spec.showroom?.type ?? '';
    try {
      await publishPlan(s, p.kind, roomType, i + 1, spec, 'seed', 'Seeded from the RoomCraft web app');
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
    rep.plans++;
  }
  if ((await s.catalogVersions.countDocuments({ _id: catalog.version })) === 0) {
    try {
      await publishCatalog(s, catalog.version, 'Seeded from the RoomCraft web app', 'seed');
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
    }
    rep.catalogPublished = true;
  }
  return rep;
}

// ---- Staff ----

/**
 * Creates the first owner account when there are no staff yet. The password must be
 * changed at first sign-in. Returns false when staff already exist.
 */
export async function bootstrapOwner(s: Store, email: string, passwordHash: string, id: string): Promise<boolean> {
  if ((await s.staff.countDocuments({})) > 0) return false;
  const now = new Date();
  try {
    await s.staff.insertOne({
      _id: id, email, name: 'Owner', role: ROLE_OWNER, disabled: false, mustChangePassword: true,
      passwordHash, tokenVersion: 0, failedLogins: 0, createdAt: now, updatedAt: now,
    });
  } catch (err) {
    if (isDuplicateKey(err)) return false;
    throw err;
  }
  return true;
}
