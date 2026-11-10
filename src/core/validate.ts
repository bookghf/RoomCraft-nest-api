// Validation shared by designs, drafts, shares and import. Same rules and messages as the Go API.

import { fail } from './envelope';
import type { DItem, DesignContent, Doc } from '../db/models';

// Limits match the web editor (see roomcraft/src/features/designer/data/plans.ts).
export const MAX_ITEMS = 500;
export const MAX_NAME_LEN = 60;
export const CEILING_MIN = 2.4;
export const CEILING_MAX = 3.0;
export const ROOM_SIZE_MIN = 2.0;
export const ROOM_SIZE_MAX = 10.0;
export const MAX_COORDINATE = 100.0;
export const EPS = 1e-6;

export const FLOOR_MATERIALS = new Set(['wood', 'tile', 'marble', 'concrete', 'carpet']);
export const WALL_MATERIALS = new Set(['paint', 'stripes', 'brick', 'panel', 'subway', 'concrete']);
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface FieldError {
  field: string;
  message: string;
}

/** A list of field errors; err() returns a 400 VALIDATION_ERROR, or null when empty. */
export class FieldErrors {
  readonly list: FieldError[] = [];

  get length(): number {
    return this.list.length;
  }

  add(field: string, message: string): void {
    this.list.push({ field, message });
  }

  /** Appends another list's errors (Go's append(errs, other...)). */
  merge(other: FieldErrors): this {
    this.list.push(...other.list);
    return this;
  }

  err() {
    if (this.list.length === 0) return null;
    return fail(400, 'VALIDATION_ERROR', 'The request has invalid fields.', [...this.list]);
  }

  /** Throws the VALIDATION_ERROR when there are errors. */
  throwIfAny(): void {
    const e = this.err();
    if (e) throw e;
  }

  static of(field: string, message: string): FieldErrors {
    const e = new FieldErrors();
    e.add(field, message);
    return e;
  }
}

/** Go's utf8.RuneCountInString. */
export const runeCount = (s: string) => [...s].length;

/** Go's %q for a string. */
export const quote = (s: string) => JSON.stringify(s);

export function checkID(field: string, id: string): void {
  if (!ID_PATTERN.test(id)) {
    throw fail(400, 'INVALID_ID', `${field} must be 1–64 letters, digits, '-' or '_'.`);
  }
}

/** Trims the name and reports whether it has 1–60 characters. */
export function validName(name: string): [string, boolean] {
  const t = name.trim();
  const n = runeCount(t);
  return [t, n >= 1 && n <= MAX_NAME_LEN];
}

/**
 * Checks a design against the same rules as the editor. It also drops a room size on plans
 * that can't be resized (mutates c). prefix names the field in errors.
 */
export function validateContent(c: DesignContent, plan: Doc, prefix: string): FieldErrors {
  const errs = new FieldErrors();
  const f = (name: string) => prefix + name;

  if (c.items.length > MAX_ITEMS) errs.add(f('items'), `at most ${MAX_ITEMS} items`);
  const uids = new Set<string>();
  c.items.forEach((it, i) => {
    if (it.uid === '' || Buffer.byteLength(it.uid) > 64) {
      errs.add(f(`items[${i}].uid`), 'required, at most 64 characters');
    } else if (uids.has(it.uid)) {
      errs.add(f(`items[${i}].uid`), `duplicate uid ${quote(it.uid)}`);
    }
    uids.add(it.uid);
  });
  c.items.forEach((it: DItem, i) => {
    const at = (field: string) => f(`items[${i}].${field}`);
    if (!ID_PATTERN.test(it.itemId)) errs.add(at('itemId'), 'invalid item id');
    if (Buffer.byteLength(it.colorId) > 64) errs.add(at('colorId'), 'at most 64 characters');
    if (Math.abs(it.x) > MAX_COORDINATE || Math.abs(it.z) > MAX_COORDINATE || it.y < -EPS || it.y > CEILING_MAX + EPS) {
      errs.add(at('x'), 'position is outside the room');
    }
    if (Math.abs(it.rot) > 100) errs.add(at('rot'), 'rotation must be in radians');
    const side = it.side ?? 0;
    if (side !== 0 && side !== 1 && side !== -1) errs.add(at('side'), 'must be 1 or -1');
    const on = it.on ?? '';
    if (on !== '' && (on === it.uid || !uids.has(on))) errs.add(at('on'), 'must be the uid of another item in this design');
  });
  if (!FLOOR_MATERIALS.has(c.floor.material)) errs.add(f('floor.material'), `unknown floor material ${quote(c.floor.material)}`);
  if (!HEX_COLOR.test(c.floor.color)) errs.add(f('floor.color'), 'must be a hex colour like #c9a77c');
  if (!WALL_MATERIALS.has(c.wall.material)) errs.add(f('wall.material'), `unknown wall material ${quote(c.wall.material)}`);
  if (!HEX_COLOR.test(c.wall.color)) errs.add(f('wall.color'), 'must be a hex colour like #ede8e0');
  if (c.ceiling < CEILING_MIN - EPS || c.ceiling > CEILING_MAX + EPS) {
    errs.add(f('ceiling'), `must be between ${CEILING_MIN.toFixed(2)} and ${CEILING_MAX.toFixed(2)} m`);
  }
  if (!plan.spec?.resizable) {
    delete c.size;
  } else if (c.size) {
    for (const v of [c.size.w, c.size.d]) {
      if (v < ROOM_SIZE_MIN - EPS || v > ROOM_SIZE_MAX + EPS) {
        errs.add(f('size'), `width and depth must be between ${ROOM_SIZE_MIN.toFixed(0)} and ${ROOM_SIZE_MAX.toFixed(0)} m`);
        break;
      }
    }
  }
  return errs;
}

/**
 * Lists items and colours the published catalog doesn't know. They never block a save,
 * so a design made with a newer catalog can't be lost.
 */
export function catalogWarnings(items: DItem[], cat: { version: string; byID: Map<string, Doc> }): string[] {
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const ci = cat.byID.get(it.itemId);
    if (!ci && !seen.has(it.itemId)) {
      warnings.push(`Item ${quote(it.itemId)} is not in catalog ${cat.version}.`);
    } else if (ci && it.colorId !== '' && !hasColor(ci, it.colorId) && !seen.has(`${it.itemId}/${it.colorId}`)) {
      warnings.push(`Colour ${quote(it.colorId)} is not offered for ${quote(it.itemId)}; the default colour is shown.`);
      seen.add(`${it.itemId}/${it.colorId}`);
    }
    seen.add(it.itemId);
  }
  return warnings;
}

export function hasColor(it: Doc, colorId: string): boolean {
  return (it.colors ?? []).some((c: Doc) => c.id === colorId);
}
