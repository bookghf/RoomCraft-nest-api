// Helpers for the back office plans, room types and support routes.
// Ported from admin_plans.go and admin_support.go (and exportUser/deleteUser from me.go).

import { Store } from '../../db/mongo';
import {
  DEFAULT_MEASURE, Doc, ZERO_TIME, designOut, draftOut, planOut, preferencesOut, putOmit, putPtr, roomTypeOut, shareOut,
} from '../../db/models';
import type { PublishedCatalog } from '../../core/catalog';

/** A Text that may be missing: Go stored and showed a nil map as null. */
export function textOrNull(v: unknown): Record<string, string> | null {
  if (v === undefined || v === null) return null;
  return v as Record<string, string>;
}

/** Go's json encoder writes map keys in sorted order. */
export function sortedMap<T>(m: Record<string, T> | null | undefined): Record<string, T> | null {
  if (m === undefined || m === null) return null;
  const out: Record<string, T> = {};
  for (const k of Object.keys(m).sort()) out[k] = m[k];
  return out;
}

// ---- Plans ----

/** A plan version with the fields the apps don't see (Go's adminPlan). */
export function adminPlanOut(p: Doc): Doc {
  const o = planOut(p);
  putOmit(o, 'publishedBy', p.publishedBy);
  putOmit(o, 'notes', p.notes);
  putPtr(o, 'archivedAt', p.archivedAt);
  return o;
}

/** Go's summarizePlan: the plan without geometry, with the showroom preset priced. */
export function summarizePlan(p: Doc, cat: PublishedCatalog): Doc {
  const spec = p.spec ?? {};
  const o: Doc = { id: p.planId, version: p.version ?? 0, kind: p.kind ?? '' };
  putOmit(o, 'roomType', p.roomType);
  o.name = sortedMap(spec.name);
  const sr = spec.showroom;
  if (sr) putOmit(o, 'description', sortedMap(sr.description));
  o.area = spec.area ?? null;
  if (sr) putOmit(o, 'thumbnail', sr.thumbnail);
  o.ceiling = spec.ceiling ?? 0;
  putPtr(o, 'resizable', spec.resizable ? { w: spec.resizable.w ?? 0, d: spec.resizable.d ?? 0 } : undefined);
  let itemCount = 0;
  let preset = 0;
  if (sr) {
    const items: Doc[] = sr.items ?? [];
    itemCount = items.length;
    for (const it of items) {
      const ci = cat.byID.get(it.itemId);
      if (ci) preset += Number(ci.priceSatang ?? 0);
    }
  }
  o.itemCount = itemCount;
  o.presetTotalSatang = preset;
  return o;
}

// ---- Room types ----

/** A room type with its sort order and (in lists) how many showrooms use it. */
export function adminRoomTypeOut(rt: Doc, showroomCount = 0): Doc {
  const o = roomTypeOut(rt);
  o.name = sortedMap(rt.name);
  o.blurb = sortedMap(rt.blurb);
  o.sortOrder = rt.sortOrder ?? 0;
  o.showroomCount = showroomCount;
  return o;
}

// ---- Residents ----

/** A design row for back office tables (no content). */
export function designRowOut(d: Doc): Doc {
  const o: Doc = {
    id: d._id,
    ownerId: d.ownerId ?? '',
    planId: d.planId ?? '',
    planVersion: d.planVersion ?? 0,
    name: d.name ?? '',
    itemCount: d.itemCount ?? 0,
    totalSatang: Number(d.totalSatang ?? 0),
    version: d.version ?? 0,
    createdAt: d.createdAt ?? ZERO_TIME,
    updatedAt: d.updatedAt ?? ZERO_TIME,
  };
  putPtr(o, 'deletedAt', d.deletedAt);
  return o;
}

export function draftRowOut(d: Doc): Doc {
  const o: Doc = { id: d._id };
  putOmit(o, 'designId', d.designId);
  o.planId = d.planId ?? '';
  o.planVersion = d.planVersion ?? 0;
  o.itemCount = d.itemCount ?? 0;
  o.updatedAt = d.updatedAt ?? ZERO_TIME;
  return o;
}

/** revoked, expired or active. */
export function shareStatus(s: Doc, now: Date): string {
  if (s.revokedAt) return 'revoked';
  if (s.expiresAt && now.getTime() >= new Date(s.expiresAt).getTime()) return 'expired';
  return 'active';
}

export function shareRowOut(s: Doc, now: Date): Doc {
  const o: Doc = { code: s._id };
  putOmit(o, 'ownerId', s.ownerId);
  putOmit(o, 'designId', s.designId);
  o.planId = s.planId ?? '';
  o.viewCount = s.viewCount ?? 0;
  o.createdAt = s.createdAt ?? ZERO_TIME;
  putPtr(o, 'expiresAt', s.expiresAt);
  putPtr(o, 'revokedAt', s.revokedAt);
  o.status = shareStatus(s, now);
  return o;
}

/** A resident's preferences with defaults, like the Go API's preferences(). */
export async function preferencesOf(s: Store, userID: string): Promise<{ doc: Doc; found: boolean; recentItems: string[] }> {
  const doc = await s.preferences.findOne({ _id: userID });
  const p: Doc = { ...(doc ?? {}) };
  if (!p.measure) p.measure = { ...DEFAULT_MEASURE };
  const recentItems: string[] = Array.isArray(p.recentItems) ? p.recentItems : [];
  return { doc: p, found: !!doc && !!p.updatedAt, recentItems };
}

/** Everything stored about a resident, including soft-deleted designs (PDPA). */
export async function exportUser(s: Store, userID: string): Promise<Doc> {
  const designs = await s.designs.find({ ownerId: userID }).toArray();
  const drafts = await s.drafts.find({ ownerId: userID }).toArray();
  const shares = await s.shares.find({ ownerId: userID }).toArray();
  const prefs = await preferencesOf(s, userID);
  // Go marshals map[string]any with sorted keys.
  return {
    designs: designs.map(designOut),
    drafts: drafts.map(draftOut),
    exportedAt: new Date(),
    preferences: preferencesOut(prefs.doc),
    recentItems: prefs.recentItems,
    shares: shares.map(shareOut),
    userId: userID,
  };
}

/** Permanently deletes everything stored about a resident. */
export async function deleteUser(s: Store, userID: string): Promise<{ designs: number; drafts: number; shares: number; preferences: number }> {
  const designs = (await s.designs.deleteMany({ ownerId: userID })).deletedCount;
  const drafts = (await s.drafts.deleteMany({ ownerId: userID })).deletedCount;
  const shares = (await s.shares.deleteMany({ ownerId: userID })).deletedCount;
  const preferences = (await s.preferences.deleteOne({ _id: userID })).deletedCount;
  return { designs, drafts, shares, preferences };
}
