// Residents: a SmartWorld JWT (or the X-Dev-User header when AUTH_DEV=true).
// Back office staff sign in separately; see auth/staff.ts.

import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { errUnauthorized } from '../core/envelope';

export interface User {
  id: string;
}

/**
 * Reads the resident from the request. Returns null when there are no credentials and
 * throws UNAUTHORIZED when there are bad ones. Used by the auth middleware.
 */
export function authenticate(req: Request): User | null {
  const cfg = config();
  const h = req.headers.authorization;
  if (h) {
    if (!h.startsWith('Bearer ') || !cfg.jwtSecret) throw errUnauthorized();
    const token = h.slice('Bearer '.length);
    let claims: jwt.JwtPayload;
    try {
      const opts: jwt.VerifyOptions = { algorithms: ['HS256', 'HS384', 'HS512'] };
      if (cfg.jwtIssuer) opts.issuer = cfg.jwtIssuer;
      const decoded = jwt.verify(token, cfg.jwtSecret, opts);
      if (typeof decoded === 'string') throw new Error('not a claims object');
      claims = decoded;
    } catch {
      throw errUnauthorized();
    }
    if (typeof claims.exp !== 'number' || typeof claims.sub !== 'string' || claims.sub === '') {
      throw errUnauthorized();
    }
    return { id: claims.sub };
  }
  if (cfg.authDev) {
    const id = req.headers['x-dev-user'];
    if (typeof id === 'string' && id !== '') return { id };
  }
  return null;
}

/** The signed-in resident, or null. Set by the auth middleware. */
export function userFrom(req: Request): User | null {
  return ((req as any).user as User | undefined) ?? null;
}

/** The signed-in resident, or UNAUTHORIZED. */
export function requireUser(req: Request): User {
  const u = userFrom(req);
  if (!u) throw errUnauthorized();
  return u;
}
