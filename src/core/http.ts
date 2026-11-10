// Express middleware that runs before Nest's router, in the same order as the Go API:
// logging -> CORS -> auth -> rate limit -> (raw body) -> routes.

import type { NextFunction, Request, Response } from 'express';
import { config } from '../config';
import { authenticate, userFrom } from '../auth/user';
import { ADMIN_PREFIX } from '../auth/staff';
import { ApiError, fail, sendError } from './envelope';
import { MAX_BODY, MAX_IMPORT_BODY } from './body';

export function clientIP(req: Request): string {
  const f = req.headers['x-forwarded-for'];
  const first = Array.isArray(f) ? f[0] : f;
  if (first) return first.split(',')[0].trim();
  const addr = req.socket?.remoteAddress ?? '';
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr;
}

/** One JSON log line per request, like the Go API's slog output. */
export function logging(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  res.on('finish', () => {
    console.log(JSON.stringify({
      time: new Date().toISOString(), level: 'INFO', msg: 'request',
      method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start,
    }));
  });
  next();
}

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && config().corsOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.append('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-None-Match');
    res.setHeader('Access-Control-Expose-Headers', 'ETag');
    res.setHeader('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Resident auth. Back office routes check staff tokens themselves. */
export function auth(req: Request, res: Response, next: NextFunction): void {
  if (req.path.startsWith(ADMIN_PREFIX)) return next();
  try {
    const u = authenticate(req);
    if (u) (req as any).user = u;
  } catch (err) {
    sendError(res, err instanceof ApiError ? err : fail(401, 'UNAUTHORIZED', 'Sign in to use this endpoint.'));
    return;
  }
  next();
}

// ---- Rate limit ----

/**
 * A fixed number of writes per minute per user (or per IP when signed out). It is per
 * process (per function instance on Vercel); put a shared limiter at the gateway for a global limit.
 */
class RateLimiter {
  private window = 0;
  private counts = new Map<string, number>();
  constructor(readonly limit: number) {}

  allow(key: string): boolean {
    const now = Math.floor(Date.now() / 60_000);
    if (now !== this.window) {
      this.window = now;
      this.counts = new Map();
    }
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return n <= this.limit;
  }
}

let limiter: RateLimiter | undefined;

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  limiter ??= new RateLimiter(config().writesPerMinute);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && limiter.limit > 0) {
    const u = userFrom(req);
    const key = u ? `user:${u.id}` : `ip:${clientIP(req)}`;
    if (!limiter.allow(key)) {
      res.setHeader('Retry-After', '60');
      sendError(res, fail(429, 'RATE_LIMITED', 'Too many changes. Try again in a minute.'));
      return;
    }
  }
  next();
}

// ---- Raw body ----

/**
 * Collects the request body into req.rawBody (a Buffer) for decode() in core/body.ts.
 * Bodies over the limit (4 MB for /v1/me/import, 256 KB otherwise) get 413 TOO_LARGE.
 */
export function rawBody(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const limit = req.path === '/v1/me/import' ? MAX_IMPORT_BODY : MAX_BODY;
  const chunks: Buffer[] = [];
  let size = 0;
  let done = false;
  const tooLarge = () => {
    done = true;
    sendError(res, fail(413, 'TOO_LARGE', `Request body is over ${limit >> 10} KB.`));
    req.resume();
  };
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > limit) return tooLarge();
  req.on('data', (c: Buffer) => {
    if (done) return;
    size += c.length;
    if (size > limit) return tooLarge();
    chunks.push(c);
  });
  req.on('end', () => {
    if (done) return;
    done = true;
    (req as any).rawBody = Buffer.concat(chunks);
    next();
  });
  req.on('error', (err) => {
    if (done) return;
    done = true;
    next(err);
  });
}
