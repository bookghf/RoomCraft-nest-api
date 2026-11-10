// The MongoDB connection and collections.
//
// The client is created once per process and reused across requests. On Vercel a warm
// function instance keeps it, so requests don't open a new connection each time.

import { Collection, Db, MongoClient } from 'mongodb';
import { config } from '../config';

export interface Store {
  client: MongoClient;
  db: Db;
  categories: Collection<any>;
  items: Collection<any>;
  catalogVersions: Collection<any>;
  plans: Collection<any>;
  roomTypes: Collection<any>;
  designs: Collection<any>;
  drafts: Collection<any>;
  preferences: Collection<any>;
  shares: Collection<any>;
  staff: Collection<any>;
  audit: Collection<any>;
}

/** How long soft-deleted designs are kept before MongoDB removes them. */
export const DELETED_DESIGN_RETENTION_SECONDS = 30 * 24 * 60 * 60;

let pending: Promise<Store> | undefined;

async function connect(): Promise<Store> {
  const cfg = config();
  const client = new MongoClient(cfg.mongoURI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 10_000,
    // Keep Int64 values (e.g. totalSatang written by the Go API) as plain numbers.
    promoteLongs: true,
  });
  await client.connect();
  await client.db('admin').command({ ping: 1 }, { timeoutMS: 10_000 });
  const db = client.db(cfg.mongoDB);
  return {
    client,
    db,
    categories: db.collection('categories'),
    items: db.collection('catalogItems'),
    catalogVersions: db.collection('catalogVersions'),
    plans: db.collection('plans'),
    roomTypes: db.collection('roomTypes'),
    designs: db.collection('designs'),
    drafts: db.collection('drafts'),
    preferences: db.collection('preferences'),
    shares: db.collection('shares'),
    staff: db.collection('staff'),
    audit: db.collection('auditLog'),
  };
}

/** The shared store, connecting on first use. A failed connection is retried on the next call. */
export function db(): Promise<Store> {
  pending ??= connect().catch((err) => {
    pending = undefined;
    throw err;
  });
  return pending;
}

export async function closeDB(): Promise<void> {
  if (!pending) return;
  const s = await pending.catch(() => undefined);
  pending = undefined;
  await s?.client.close();
}

/** True for MongoDB duplicate key errors (code 11000). */
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: number; writeErrors?: { code?: number }[] };
  return e?.code === 11000 || !!e?.writeErrors?.some((w) => w.code === 11000);
}

/** Creates the indexes the API relies on. Same as the Go API's EnsureIndexes. */
export async function ensureIndexes(s: Store): Promise<void> {
  const idx: [Collection<any>, { key: Record<string, 1 | -1>; unique?: boolean; expireAfterSeconds?: number }[]][] = [
    [s.items, [{ key: { category: 1, sortOrder: 1 } }]],
    [s.catalogVersions, [{ key: { publishedAt: -1 } }]],
    [s.plans, [
      { key: { planId: 1, version: -1 }, unique: true },
      { key: { kind: 1, sortOrder: 1 } },
    ]],
    [s.designs, [
      { key: { ownerId: 1, updatedAt: -1, _id: -1 } },
      { key: { createdAt: -1 } },
      { key: { planId: 1 } },
      { key: { 'content.items.itemId': 1 } },
      { key: { deletedAt: 1 }, expireAfterSeconds: DELETED_DESIGN_RETENTION_SECONDS },
    ]],
    [s.drafts, [
      { key: { ownerId: 1, updatedAt: -1 } },
      { key: { ownerId: 1, designId: 1 } },
    ]],
    [s.shares, [
      { key: { expiresAt: 1 }, expireAfterSeconds: 0 },
      { key: { ownerId: 1, createdAt: -1 } },
      { key: { createdAt: -1 } },
    ]],
    [s.staff, [{ key: { email: 1 }, unique: true }]],
    [s.audit, [
      { key: { at: -1 } },
      { key: { targetType: 1, targetId: 1, at: -1 } },
      { key: { actorId: 1, at: -1 } },
    ]],
  ];
  for (const [coll, models] of idx) {
    try {
      await coll.createIndexes(models);
    } catch (err) {
      throw new Error(`indexes on ${coll.collectionName}: ${(err as Error).message}`);
    }
  }
}
