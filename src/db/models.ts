// Documents stored in MongoDB and how the API shows them.
//
// Stored field names are exactly the Go API's (its json tags, plus a few bson-only names
// such as _id, ownerId, sortOrder), so this API and the Go API can share one database.
//
// Each xxxOut() function turns a stored document into the JSON the Go API returned:
// same keys, same order, and Go's `omitempty` rules (empty strings, 0, false, nil and
// empty maps/slices left out; fields tagged json:"-" never shown).

import { Obj, arr, bool, num, obj, optNum, str, text, xz } from '../core/body';

export type Text = Record<string, string>;
export type XZ = [number, number];
export type Doc = Record<string, any>;

/** Go's zero time.Time, shown for time fields that were never set. */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

// ---- omitempty helpers ----

/** Go omitempty for strings, numbers, bools, maps and slices. */
export function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '' || v === 0 || v === false) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Date) return false;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

/** Sets o[key] = v unless v is empty (Go omitempty on a value type). */
export function putOmit(o: Doc, key: string, v: unknown): void {
  if (!isEmpty(v)) o[key] = v;
}

/** Sets o[key] = v unless v is null/undefined (Go omitempty on a pointer). */
export function putPtr(o: Doc, key: string, v: unknown): void {
  if (v !== undefined && v !== null) o[key] = v;
}

/** Removes keys whose value is empty, for storing a document like Go's omitempty. */
export function compact<T extends Doc>(o: T, keys: string[]): T {
  for (const k of keys) if (isEmpty(o[k])) delete o[k];
  return o;
}

// ---- Map key order ----
//
// Go writes struct fields in declaration order but map keys sorted. Text values
// ({"en", "th", "zh"}) and model params are maps, and Go stores them in random order,
// so sort them on the way out.

/** A map with its keys sorted, like Go's JSON encoding of map[string]T. */
export function sortedMap<T>(m: T): T {
  if (!m || typeof m !== 'object' || Array.isArray(m) || m instanceof Date) return m;
  const o: Doc = {};
  for (const k of Object.keys(m as Doc).sort()) o[k] = (m as Doc)[k];
  return o as T;
}

/** Sorts every object's keys, recursively (Go's encoding of map[string]any decoded from JSON/BSON). */
export function deepSorted<T>(v: T): T {
  if (Array.isArray(v)) return v.map(deepSorted) as T;
  if (!v || typeof v !== 'object' || v instanceof Date) return v;
  const o: Doc = {};
  for (const k of Object.keys(v as Doc).sort()) o[k] = deepSorted((v as Doc)[k]);
  return o as T;
}

/** A stored PlanSpec with its Text maps sorted (name, zone names, showroom description). */
export function specOut(spec: Doc | null | undefined): Doc | null {
  if (!spec) return null;
  const o: Doc = { ...spec };
  if (o.name) o.name = sortedMap(o.name);
  if (Array.isArray(o.zones)) o.zones = o.zones.map((z: Doc) => (z && z.name ? { ...z, name: sortedMap(z.name) } : z));
  if (o.showroom?.description) o.showroom = { ...o.showroom, description: sortedMap(o.showroom.description) };
  return o;
}

// ---- Catalog ----

export function categoryOut(c: Doc): Doc {
  const o: Doc = { id: c._id, name: sortedMap(c.name ?? null) };
  putOmit(o, 'icon', c.icon);
  return o;
}

export function colorOut(c: Doc): Doc {
  return { id: c.id ?? '', hex: c.hex ?? '', name: sortedMap(c.name ?? null) };
}

/** A catalog item as clients see it. price (baht) is derived from priceSatang. */
export function itemOut(it: Doc): Doc {
  const satang = Number(it.priceSatang ?? 0);
  const o: Doc = {
    id: it._id,
    category: it.category ?? '',
    mount: it.mount ?? '',
    name: sortedMap(it.name ?? null),
    price: satang / 100,
    priceSatang: satang,
  };
  putOmit(o, 'sku', it.sku);
  o.size = { w: it.size?.w ?? 0, d: it.size?.d ?? 0, h: it.size?.h ?? 0 };
  o.colors = Array.isArray(it.colors) ? it.colors.map(colorOut) : null;
  putOmit(o, 'surface', it.surface);
  putOmit(o, 'stackable', it.stackable);
  putOmit(o, 'flat', it.flat);
  putPtr(o, 'mountHeight', it.mountHeight);
  putOmit(o, 'light', it.light);
  const model: Doc = { template: it.model?.template ?? '' };
  putOmit(model, 'params', deepSorted(it.model?.params));
  o.model = model;
  putOmit(o, 'modelUrl', it.modelUrl);
  putOmit(o, 'thumbnailUrl', it.thumbnailUrl);
  putOmit(o, 'hidden', it.hidden);
  return o;
}

export function catalogVersionOut(v: Doc): Doc {
  const o: Doc = {
    version: v._id,
    categories: (v.categories ?? []).map(categoryOut),
    items: (v.items ?? []).map(itemOut),
  };
  putOmit(o, 'notes', v.notes);
  o.publishedAt = v.publishedAt ?? ZERO_TIME;
  return o;
}

/**
 * Parses a catalog item from JSON (seed file or admin body) into the stored shape,
 * without bookkeeping fields (sortOrder, createdAt, updatedAt, updatedBy, retiredAt).
 * price in the input is ignored here; callers set priceSatang.
 */
export function parseItem(v: unknown, path = 'item'): Doc {
  const o = obj(v, path);
  const it: Doc = {
    _id: str(o, 'id', path),
    category: str(o, 'category', path),
    mount: str(o, 'mount', path),
    name: text(o, 'name', path),
    priceSatang: num(o, 'priceSatang', path),
  };
  it.sku = str(o, 'sku', path);
  const size = obj(o.size, `${path}.size`);
  it.size = { w: num(size, 'w', `${path}.size`), d: num(size, 'd', `${path}.size`), h: num(size, 'h', `${path}.size`) };
  it.colors = arr(o, 'colors', path, (c, p) => {
    const co = obj(c, p);
    return { id: str(co, 'id', p), hex: str(co, 'hex', p), name: text(co, 'name', p) };
  });
  it.surface = bool(o, 'surface', path);
  it.stackable = bool(o, 'stackable', path);
  it.flat = bool(o, 'flat', path);
  const mh = optNum(o, 'mountHeight', path);
  if (mh !== undefined) it.mountHeight = mh;
  it.light = bool(o, 'light', path);
  const m = obj(o.model, `${path}.model`);
  const model: Doc = { template: str(m, 'template', `${path}.model`) };
  const params = m.params;
  if (params !== undefined && params !== null) {
    if (typeof params !== 'object' || Array.isArray(params)) obj(params, `${path}.model.params`);
    if (Object.keys(params as Obj).length > 0) model.params = params;
  }
  it.model = model;
  it.modelUrl = str(o, 'modelUrl', path);
  it.thumbnailUrl = str(o, 'thumbnailUrl', path);
  it.hidden = bool(o, 'hidden', path);
  return compact(it, ['sku', 'surface', 'stackable', 'flat', 'light', 'modelUrl', 'thumbnailUrl', 'hidden']);
}

// ---- Plans ----

function surfaceOf(v: unknown, path: string): Doc {
  const o = obj(v, path);
  return { material: str(o, 'material', path), color: str(o, 'color', path) };
}

/** Parses a PlanSpec (matches the web app's PlanSpec type) into its stored shape. */
export function parsePlanSpec(v: unknown, path = 'spec'): Doc {
  const o = obj(v, path);
  const spec: Doc = { id: str(o, 'id', path), name: text(o, 'name', path) };
  const area = optNum(o, 'area', path);
  spec.area = area === undefined ? null : area;
  spec.zones = arr(o, 'zones', path, (z, p) => {
    const zo = obj(z, p);
    return { id: str(zo, 'id', p), name: text(zo, 'name', p), kind: str(zo, 'kind', p), polygon: arr(zo, 'polygon', p, xz) };
  });
  const open = arr(o, 'open', path, (seg, p) => {
    if (seg === null) return [[0, 0], [0, 0]] as XZ[];
    if (!Array.isArray(seg)) xz(seg, p); // throws: a segment must be an array of points
    const pts = (seg as unknown[]).map((x, i) => xz(x, `${p}[${i}]`));
    return [pts[0] ?? [0, 0], pts[1] ?? [0, 0]] as XZ[];
  });
  if (open.length > 0) spec.open = open;
  spec.openings = arr(o, 'openings', path, (op, p) => {
    const oo = obj(op, p);
    const out: Doc = { type: str(oo, 'type', p), at: xz(oo.at ?? null, `${p}.at`), width: num(oo, 'width', p) };
    const h = optNum(oo, 'height', p);
    if (h !== undefined) out.height = h;
    const s = optNum(oo, 'sill', p);
    if (s !== undefined) out.sill = s;
    return out;
  });
  spec.fixtures = arr(o, 'fixtures', path, (f, p) => {
    const fo = obj(f, p);
    return {
      id: str(fo, 'id', p), type: str(fo, 'type', p),
      x: num(fo, 'x', p), z: num(fo, 'z', p), rot: num(fo, 'rot', p),
      w: num(fo, 'w', p), d: num(fo, 'd', p), h: num(fo, 'h', p),
    };
  });
  spec.ceiling = num(o, 'ceiling', path);
  if (o.resizable !== undefined && o.resizable !== null) {
    const r = obj(o.resizable, `${path}.resizable`);
    spec.resizable = { w: num(r, 'w', `${path}.resizable`), d: num(r, 'd', `${path}.resizable`) };
  }
  if (o.showroom !== undefined && o.showroom !== null) {
    const p = `${path}.showroom`;
    const so = obj(o.showroom, p);
    spec.showroom = {
      type: str(so, 'type', p),
      description: text(so, 'description', p),
      thumbnail: str(so, 'thumbnail', p),
      floor: surfaceOf(so.floor, `${p}.floor`),
      wall: surfaceOf(so.wall, `${p}.wall`),
      items: arr(so, 'items', p, (it, ip) => {
        const io = obj(it, ip);
        const out: Doc = { itemId: str(io, 'itemId', ip) };
        const colorId = str(io, 'colorId', ip);
        if (colorId) out.colorId = colorId;
        out.x = num(io, 'x', ip);
        out.z = num(io, 'z', ip);
        out.rot = num(io, 'rot', ip);
        return out;
      }),
    };
  }
  return spec;
}

/** One published plan version. Stored with _id "<planId>@<version>". */
export function planOut(p: Doc): Doc {
  const o: Doc = { id: p.planId, version: p.version ?? 0, kind: p.kind ?? '' };
  putOmit(o, 'roomType', p.roomType);
  putOmit(o, 'projectId', p.projectId);
  o.spec = specOut(p.spec);
  o.publishedAt = p.publishedAt ?? ZERO_TIME;
  return o;
}

export function roomTypeOut(rt: Doc): Doc {
  return { id: rt._id, name: sortedMap(rt.name ?? null), blurb: sortedMap(rt.blurb ?? null), gradient: rt.gradient ?? '' };
}

// ---- Designs ----

export interface DItem {
  uid: string;
  itemId: string;
  colorId: string;
  x: number;
  y: number;
  z: number;
  rot: number;
  wallId?: string;
  side?: number;
  on?: string;
  locked?: boolean;
}

export interface DesignContent {
  items: DItem[];
  floor: { material: string; color: string };
  wall: { material: string; color: string };
  ceiling: number;
  size?: { w: number; d: number };
}

/** Parses a DItem; empty optional fields are left out, as Go's omitempty stored them. */
export function parseDItem(v: unknown, path: string): DItem {
  const o = obj(v, path);
  const it: DItem = {
    uid: str(o, 'uid', path),
    itemId: str(o, 'itemId', path),
    colorId: str(o, 'colorId', path),
    x: num(o, 'x', path),
    y: num(o, 'y', path),
    z: num(o, 'z', path),
    rot: num(o, 'rot', path),
  };
  const wallId = str(o, 'wallId', path);
  if (wallId) it.wallId = wallId;
  const side = num(o, 'side', path);
  if (side) it.side = side;
  const on = str(o, 'on', path);
  if (on) it.on = on;
  if (bool(o, 'locked', path)) it.locked = true;
  return it;
}

/** Parses design content (what the editor saves, without the name and ids). */
export function parseContent(v: unknown, path = 'content'): DesignContent {
  const o = obj(v, path);
  const c: DesignContent = {
    items: arr(o, 'items', path, parseDItem),
    floor: surfaceOf(o.floor, `${path}.floor`) as DesignContent['floor'],
    wall: surfaceOf(o.wall, `${path}.wall`) as DesignContent['wall'],
    ceiling: num(o, 'ceiling', path),
  };
  if (o.size !== undefined && o.size !== null) {
    const s = obj(o.size, `${path}.size`);
    c.size = { w: num(s, 'w', `${path}.size`), d: num(s, 'd', `${path}.size`) };
  }
  return c;
}

/** A stored content document shown as Go showed DesignContent. */
export function contentOut(c: Doc | undefined): Doc {
  const o: Doc = {
    items: Array.isArray(c?.items) ? c!.items.map(dItemOut) : null,
    floor: { material: c?.floor?.material ?? '', color: c?.floor?.color ?? '' },
    wall: { material: c?.wall?.material ?? '', color: c?.wall?.color ?? '' },
    ceiling: c?.ceiling ?? 0,
  };
  putPtr(o, 'size', c?.size ? { w: c.size.w ?? 0, d: c.size.d ?? 0 } : undefined);
  return o;
}

export function dItemOut(it: Doc): Doc {
  const o: Doc = {
    uid: it.uid ?? '', itemId: it.itemId ?? '', colorId: it.colorId ?? '',
    x: it.x ?? 0, y: it.y ?? 0, z: it.z ?? 0, rot: it.rot ?? 0,
  };
  putOmit(o, 'wallId', it.wallId);
  putOmit(o, 'side', it.side);
  putOmit(o, 'on', it.on);
  putOmit(o, 'locked', it.locked);
  return o;
}

/** A full saved design. ownerId and deletedAt are never shown. */
export function designOut(d: Doc): Doc {
  const o: Doc = {
    id: d._id,
    planId: d.planId ?? '',
    planVersion: d.planVersion ?? 0,
    name: d.name ?? '',
    content: contentOut(d.content),
  };
  putOmit(o, 'catalogVersion', d.catalogVersion);
  o.itemCount = d.itemCount ?? 0;
  o.totalSatang = Number(d.totalSatang ?? 0);
  putOmit(o, 'thumbnailUrl', d.thumbnailUrl);
  o.version = d.version ?? 0;
  o.createdAt = d.createdAt ?? ZERO_TIME;
  o.updatedAt = d.updatedAt ?? ZERO_TIME;
  return o;
}

/** A design without its content, for list screens. */
export function designSummaryOut(d: Doc): Doc {
  const o: Doc = {
    id: d._id,
    planId: d.planId ?? '',
    planVersion: d.planVersion ?? 0,
    name: d.name ?? '',
    itemCount: d.itemCount ?? 0,
    totalSatang: Number(d.totalSatang ?? 0),
  };
  putOmit(o, 'thumbnailUrl', d.thumbnailUrl);
  o.version = d.version ?? 0;
  o.updatedAt = d.updatedAt ?? ZERO_TIME;
  return o;
}

export function draftOut(d: Doc): Doc {
  const o: Doc = { id: d._id };
  putOmit(o, 'designId', d.designId);
  o.planId = d.planId ?? '';
  o.planVersion = d.planVersion ?? 0;
  o.content = contentOut(d.content);
  o.updatedAt = d.updatedAt ?? ZERO_TIME;
  return o;
}

// ---- Users ----

export const DEFAULT_MEASURE = { item: true, distance: true, room: false };

/** Preferences as shown: {lang?, measure?, updatedAt}. recentItems is never shown here. */
export function preferencesOut(p: Doc): Doc {
  const o: Doc = {};
  putOmit(o, 'lang', p.lang);
  putPtr(o, 'measure', p.measure ? { item: !!p.measure.item, distance: !!p.measure.distance, room: !!p.measure.room } : undefined);
  o.updatedAt = p.updatedAt ?? ZERO_TIME;
  return o;
}

// ---- Shares ----

export function shareOut(s: Doc): Doc {
  const o: Doc = { code: s._id };
  putOmit(o, 'designId', s.designId);
  o.planId = s.planId ?? '';
  o.planVersion = s.planVersion ?? 0;
  o.content = contentOut(s.content);
  putOmit(o, 'imageUrl', s.imageUrl);
  o.viewCount = s.viewCount ?? 0;
  o.createdAt = s.createdAt ?? ZERO_TIME;
  putPtr(o, 'expiresAt', s.expiresAt);
  return o;
}

// ---- Back office ----

export const ROLE_OWNER = 'owner';
export const ROLE_CATALOG_MANAGER = 'catalog_manager';
export const ROLE_SUPPORT = 'support';
export const ROLE_VIEWER = 'viewer';

/** A staff account as shown. passwordHash, tokenVersion and lockout fields are never shown. */
export function staffOut(st: Doc): Doc {
  const o: Doc = {
    id: st._id,
    email: st.email ?? '',
    name: st.name ?? '',
    role: st.role ?? '',
    disabled: !!st.disabled,
    mustChangePassword: !!st.mustChangePassword,
  };
  putPtr(o, 'lastLoginAt', st.lastLoginAt);
  o.createdAt = st.createdAt ?? ZERO_TIME;
  o.updatedAt = st.updatedAt ?? ZERO_TIME;
  return o;
}

export function auditOut(e: Doc): Doc {
  const o: Doc = {
    id: e._id,
    at: e.at ?? ZERO_TIME,
    actorId: e.actorId ?? '',
    actorEmail: e.actorEmail ?? '',
    action: e.action ?? '',
  };
  putOmit(o, 'targetType', e.targetType);
  putOmit(o, 'targetId', e.targetId);
  putOmit(o, 'summary', e.summary);
  putOmit(o, 'changes', e.changes);
  putOmit(o, 'ip', e.ip);
  return o;
}
