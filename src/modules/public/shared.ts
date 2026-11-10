// Helpers shared by the public controllers (ported from plans.go, designs.go, drafts.go, me.go).

import { fail, notFound } from '../../core/envelope';
import { quote } from '../../core/validate';
import { Store } from '../../db/mongo';
import { DEFAULT_MEASURE, Doc } from '../../db/models';
import { findPlanVersion } from '../../db/store';
import type { User } from '../../auth/user';

/** The plan a design is saved against; version 0 means the newest. 400 UNKNOWN_PLAN when missing. */
export async function planFor(s: Store, id: string, version: number): Promise<Doc> {
  const p = await findPlanVersion(s, id, version);
  if (!p) {
    let what = `Plan ${quote(id)}`;
    if (version > 0) what += ` version ${version}`;
    throw fail(400, 'UNKNOWN_PLAN', `${what} does not exist.`);
  }
  return p;
}

/** A live design that belongs to the user, or 404. */
export async function ownDesign(s: Store, u: User, id: string): Promise<Doc> {
  const d = await s.designs.findOne({ _id: id, ownerId: u.id, deletedAt: { $exists: false } });
  if (!d) throw notFound('Design');
  return d;
}

/** How many unsaved designs Recent keeps per user, like the web app. */
export const RECENT_LIMIT = 10;

/** Drops the user's oldest drafts beyond RECENT_LIMIT. */
export async function trimDrafts(s: Store, ownerId: string): Promise<void> {
  const old = await s.drafts
    .find({ ownerId }, { sort: { updatedAt: -1 }, skip: RECENT_LIMIT, projection: { _id: 1 } })
    .toArray();
  if (old.length === 0) return;
  await s.drafts.deleteMany({ ownerId, _id: { $in: old.map((o) => o._id) } });
}

/** How many recently used catalog items are remembered, like the web app. */
export const RECENT_ITEMS_LIMIT = 12;

/** The user's preferences with defaults filled in (measure, recentItems). */
export async function preferences(s: Store, userId: string): Promise<Doc> {
  const p: Doc = (await s.preferences.findOne({ _id: userId })) ?? { _id: userId };
  if (!p.measure) p.measure = { ...DEFAULT_MEASURE };
  if (!Array.isArray(p.recentItems)) p.recentItems = [];
  return p;
}

/** Go's base64.RawURLEncoding cursor "<unixMillis>:<id>". */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.getTime()}:${id}`).toString('base64url');
}

export function decodeCursor(c: string): { at: Date; id: string } | null {
  // Raw URL encoding: no padding, URL-safe alphabet, and never a length of 4n+1.
  if (!/^[A-Za-z0-9_-]*$/.test(c) || c.length % 4 === 1) return null;
  const s = Buffer.from(c, 'base64url').toString('utf8');
  const i = s.indexOf(':');
  if (i < 0) return null;
  const ms = s.slice(0, i);
  if (!/^[+-]?\d+$/.test(ms)) return null;
  return { at: new Date(parseInt(ms, 10)), id: s.slice(i + 1) };
}

/**
 * A map with its keys sorted, at every level, the way Go's encoding/json writes maps
 * (Text values such as name/description, model params). Struct-like objects must not go through this.
 */
export function sortMap<T>(v: T): T {
  if (!v || typeof v !== 'object' || Array.isArray(v) || v instanceof Date) return v;
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, sortMap(o[k])])) as T;
}
