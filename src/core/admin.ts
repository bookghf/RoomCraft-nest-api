// Shared back office helpers: audit log, field diffs and paging. Ported from admin_common.go.

import type { Request } from 'express';
import type { Collection, Filter, Sort } from 'mongodb';
import { db } from '../db/mongo';
import { Doc, deepSorted } from '../db/models';
import { randomID } from './ids';
import { clientIP } from './http';
import { goJSONReplacer } from './json';

// ---- Audit log ----

export type Changes = Record<string, { from: unknown; to: unknown }>;

/**
 * Records a back office action. It runs after the action succeeded, so a failure to write
 * the log is reported but never undoes the action.
 */
export async function audit(
  req: Request, actor: Doc, action: string, targetType: string, targetID: string, summary: string, changes?: Changes | null,
): Promise<void> {
  const e: Doc = { _id: randomID(16), at: new Date(), actorId: actor._id ?? '', actorEmail: actor.email ?? '', action };
  if (targetType) e.targetType = targetType;
  if (targetID) e.targetId = targetID;
  if (summary) e.summary = summary;
  if (changes && Object.keys(changes).length > 0) e.changes = changes;
  const ip = clientIP(req);
  if (ip) e.ip = ip;
  try {
    const s = await db();
    await s.audit.insertOne(e);
  } catch (err) {
    console.error(JSON.stringify({ time: new Date().toISOString(), level: 'ERROR', msg: 'audit write failed', action, target: targetID, err: String(err) }));
  }
}

/** A value as plain JSON (dates become Go-formatted strings), for comparing and storing. */
function toPlain(v: unknown): any {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v, goJSONReplacer));
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as any)[k], (b as any)[k]));
}

/**
 * Compares two values field by field, as the API shows them (pass the xxxOut() form),
 * and returns what changed, or null when nothing did.
 */
export function diffJSON(before: unknown, after: unknown): Changes | null {
  const b: Doc = toPlain(before) ?? {};
  const a: Doc = toPlain(after) ?? {};
  const changes: Changes = {};
  for (const [k, av] of Object.entries(a)) {
    if (!(k in b) || !deepEqual(b[k], av)) changes[k] = { from: k in b ? b[k] : null, to: av };
  }
  for (const [k, bv] of Object.entries(b)) {
    if (!(k in a)) changes[k] = { from: bv, to: null };
  }
  if (Object.keys(changes).length === 0) return null;
  // Go writes the changes map, and maps inside the values, with sorted keys.
  const sorted: Changes = {};
  for (const k of Object.keys(changes).sort()) sorted[k] = { from: deepSorted(changes[k].from), to: deepSorted(changes[k].to) };
  return sorted;
}

// ---- Paging for back office tables ----

export interface Paging {
  page: number;
  size: number;
}

function intOr0(v: unknown): number {
  const s = typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '';
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : 0;
}

/** ?page= (from 1) and ?pageSize= (default 25, at most 100). */
export function pageParams(req: Request): Paging {
  const p = intOr0((req.query as any).page);
  let size = intOr0((req.query as any).pageSize);
  if (size < 1) size = 25;
  return { page: Math.max(1, p), size: Math.min(size, 100) };
}

export const skipOf = (p: Paging) => (p.page - 1) * p.size;

export function pageOf<T>(items: T[] | null | undefined, total: number, p: Paging) {
  return { items: items ?? [], total, page: p.page, pageSize: p.size };
}

/** Pages a list that was filtered in memory. */
export function pageSlice<T>(items: T[], p: Paging) {
  const start = Math.min(skipOf(p), items.length);
  const end = Math.min(start + p.size, items.length);
  return pageOf(items.slice(start, end), items.length, p);
}

/** Runs a filtered, sorted query for one page and counts all matches. */
export async function findPage(coll: Collection<any>, filter: Filter<any>, sort: Sort, p: Paging): Promise<{ total: number; docs: Doc[] }> {
  const total = await coll.countDocuments(filter);
  const docs = await coll.find(filter, { sort }).skip(skipOf(p)).limit(p.size).toArray();
  return { total, docs };
}
