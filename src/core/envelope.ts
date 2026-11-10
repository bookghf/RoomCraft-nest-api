// Every response uses the SmartWorld ApiResponse envelope:
// {"success": true, "data": ...} or {"success": false, "error": {"code", "message", "details"}}.
//
// Handlers write successful responses with ok() and throw ApiError for failures;
// ApiErrorFilter (core/error.filter.ts) turns thrown errors into the envelope.

import type { Response } from 'express';
import { goJSON } from './json';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }

  toJSON() {
    const e: Record<string, unknown> = { code: this.code, message: this.message };
    if (this.details !== undefined && this.details !== null) e.details = this.details;
    return e;
  }
}

export function fail(status: number, code: string, message: string, details?: unknown): ApiError {
  return new ApiError(status, code, message, details);
}

export const errUnauthorized = () => fail(401, 'UNAUTHORIZED', 'Sign in to use this endpoint.');
export const errForbidden = () => fail(403, 'FORBIDDEN', "You don't have access to this resource.");
export const notFound = (what: string) => fail(404, 'NOT_FOUND', `${what} not found.`);

export function sendJSON(res: Response, status: number, body: unknown): void {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(goJSON(body));
}

/** Writes {"success": true, "data": data}. Like Go, a null/undefined data is left out. */
export function ok(res: Response, status: number, data: unknown): void {
  const body: Record<string, unknown> = { success: true };
  if (data !== undefined && data !== null) body.data = data;
  sendJSON(res, status, body);
}

export function sendError(res: Response, err: ApiError): void {
  sendJSON(res, err.status, { success: false, error: err.toJSON() });
}

/** 204 No Content. */
export function noContent(res: Response): void {
  res.status(204).end();
}

// ---- Versions (optimistic locking) ----

export const etag = (version: number) => `"v${version}"`;

/** The version in an If-Match header, or 0 when there is none. */
export function ifMatch(header: string | undefined): number {
  let h = (header ?? '').trim();
  if (!h) return 0;
  if (h.startsWith('W/')) h = h.slice(2);
  h = h.replace(/^"+|"+$/g, '');
  if (h.startsWith('v')) h = h.slice(1);
  const n = /^[+-]?\d+$/.test(h) ? parseInt(h, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) {
    throw fail(400, 'INVALID_IF_MATCH', 'If-Match must look like "v3".');
  }
  return n;
}

/** ?limit=, clamped to [1, max]. */
export function limitParam(value: unknown, def: number, max: number): number {
  const s = typeof value === 'string' ? value : '';
  const n = /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : NaN;
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(n, max);
}

/** A query string value as Go's r.URL.Query().Get would return it. */
export function q(query: unknown, key: string): string {
  const v = (query as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : '';
  return typeof v === 'string' ? v : '';
}

/** Go's strconv.Atoi: an integer string, else NaN. */
export function atoi(s: string): number {
  return /^[+-]?\d+$/.test(s) ? parseInt(s, 10) : NaN;
}
