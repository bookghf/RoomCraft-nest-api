// Reading JSON request bodies the way the Go API's json.Decoder did:
//
//  - Missing fields and null become zero values ("" / 0 / false / [] / {}).
//  - A value of the wrong type is an INVALID_JSON error, as Go's decoder would report.
//  - Unknown fields are ignored.
//
// The raw body is collected by rawBody() in core/http.ts (so Vercel's lazy req.body helper
// never runs) and parsed only when a handler calls decode().

import type { Request } from 'express';
import { fail } from './envelope';

/** Body size limits, as in the Go API. */
export const MAX_BODY = 256 << 10;
export const MAX_IMPORT_BODY = 4 << 20;

/** Parses the request body as JSON. An empty body is an error, like Go's io.EOF. */
export function decode(req: Request): unknown {
  const raw: Buffer | undefined = (req as any).rawBody;
  if (!raw || raw.length === 0) {
    throw fail(400, 'INVALID_JSON', 'Request body is not valid JSON: EOF');
  }
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch (e) {
    throw fail(400, 'INVALID_JSON', 'Request body is not valid JSON: ' + (e as Error).message);
  }
}

/** True when the request has a body at all (Go's r.ContentLength != 0). */
export function hasBody(req: Request): boolean {
  const raw: Buffer | undefined = (req as any).rawBody;
  return !!raw && raw.length > 0;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function mismatch(v: unknown, path: string, want: string): never {
  throw fail(400, 'INVALID_JSON', `Request body is not valid JSON: json: cannot unmarshal ${typeName(v)} into field ${path} of type ${want}`);
}

export type Obj = Record<string, unknown>;

/** An object (Go struct): null/undefined become {}. */
export function obj(v: unknown, path: string): Obj {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) mismatch(v, path, 'object');
  return v as Obj;
}

export function str(o: Obj, key: string, path: string): string {
  const v = o[key];
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') mismatch(v, `${path}.${key}`, 'string');
  return v;
}

export function num(o: Obj, key: string, path: string): number {
  const v = o[key];
  if (v === undefined || v === null) return 0;
  if (typeof v !== 'number') mismatch(v, `${path}.${key}`, 'number');
  return v;
}

export function int(o: Obj, key: string, path: string): number {
  const v = num(o, key, path);
  if (!Number.isInteger(v)) mismatch(v, `${path}.${key}`, 'integer');
  return v;
}

export function bool(o: Obj, key: string, path: string): boolean {
  const v = o[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') mismatch(v, `${path}.${key}`, 'boolean');
  return v;
}

/** A *float64: undefined when missing or null. */
export function optNum(o: Obj, key: string, path: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number') mismatch(v, `${path}.${key}`, 'number');
  return v;
}

/** A *string / *bool etc.: undefined when missing or null, else checked. */
export function optStr(o: Obj, key: string, path: string): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') mismatch(v, `${path}.${key}`, 'string');
  return v;
}

export function optBool(o: Obj, key: string, path: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') mismatch(v, `${path}.${key}`, 'boolean');
  return v;
}

/** A slice: null/undefined become []. Each element goes through fn. */
export function arr<T>(o: Obj, key: string, path: string, fn: (v: unknown, path: string) => T): T[] {
  const v = o[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) mismatch(v, `${path}.${key}`, 'array');
  return v.map((x, i) => fn(x, `${path}.${key}[${i}]`));
}

export function strElem(v: unknown, path: string): string {
  if (v === null) return '';
  if (typeof v !== 'string') mismatch(v, path, 'string');
  return v;
}

export function numElem(v: unknown, path: string): number {
  if (v === null) return 0;
  if (typeof v !== 'number') mismatch(v, path, 'number');
  return v;
}

/** A Text (map[string]string), e.g. {"en": "...", "th": "..."}. null/undefined become {}. */
export function text(o: Obj, key: string, path: string): Record<string, string> {
  const v = o[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) mismatch(v, `${path}.${key}`, 'object');
  const out: Record<string, string> = {};
  for (const [k, s] of Object.entries(v as Obj)) {
    if (s === null) {
      out[k] = '';
      continue;
    }
    if (typeof s !== 'string') mismatch(s, `${path}.${key}.${k}`, 'string');
    out[k] = s;
  }
  return out;
}

/** A map[string]any: kept as is. null/undefined become undefined (Go nil map). */
export function anyMap(o: Obj, key: string, path: string): Obj | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) mismatch(v, `${path}.${key}`, 'object');
  return v as Obj;
}

/** A [2]float64 point. Go's fixed-size arrays take at most 2 values and pad with 0. */
export function xz(v: unknown, path: string): [number, number] {
  if (v === null) return [0, 0];
  if (!Array.isArray(v)) mismatch(v, path, 'array');
  const a = v.map((x, i) => numElem(x, `${path}[${i}]`));
  return [a[0] ?? 0, a[1] ?? 0];
}
