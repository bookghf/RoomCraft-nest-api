// Back office staff: roles, permissions, tokens. Ported from the Go API's admin_auth.go.
//
// Staff tokens are HS256 JWTs signed with ADMIN_JWT_SECRET, audience "roomcraft-backoffice",
// issuer "roomcraft-api", and a `ver` claim that must match the account's tokenVersion, so
// changing the password or signing out ends every older token. Tokens issued by the Go API
// are accepted here and the other way round.

import type { Request } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { errForbidden, errUnauthorized, fail } from '../core/envelope';
import { FieldErrors, runeCount } from '../core/validate';
import { db } from '../db/mongo';
import { Doc, ROLE_CATALOG_MANAGER, ROLE_OWNER, ROLE_SUPPORT, ROLE_VIEWER, staffOut } from '../db/models';

export const ADMIN_PREFIX = '/v1/admin/';
export const ADMIN_AUDIENCE = 'roomcraft-backoffice';
export const ADMIN_ISSUER = 'roomcraft-api';
export const MIN_PASSWORD_LEN = 10;
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
export const BCRYPT_COST = 12;

// ---- Roles and permissions ----

export const PERM = {
  dashboard: 'dashboard.read',
  catalogRead: 'catalog.read',
  catalogWrite: 'catalog.write',
  catalogPublish: 'catalog.publish',
  plansWrite: 'plans.write',
  designsRead: 'designs.read',
  usersRead: 'users.read',
  usersDelete: 'users.delete',
  sharesRead: 'shares.read',
  sharesRevoke: 'shares.revoke',
  auditRead: 'audit.read',
  staffManage: 'staff.manage',
} as const;
export type Perm = (typeof PERM)[keyof typeof PERM];

/** The whole access model. Catalog read also covers plans, categories and room types. */
export const ROLE_PERMS: Record<string, Perm[]> = {
  [ROLE_OWNER]: [
    PERM.dashboard, PERM.catalogRead, PERM.catalogWrite, PERM.catalogPublish, PERM.plansWrite,
    PERM.designsRead, PERM.usersRead, PERM.usersDelete, PERM.sharesRead, PERM.sharesRevoke, PERM.auditRead, PERM.staffManage,
  ],
  [ROLE_CATALOG_MANAGER]: [PERM.dashboard, PERM.catalogRead, PERM.catalogWrite, PERM.catalogPublish, PERM.plansWrite],
  [ROLE_SUPPORT]: [PERM.dashboard, PERM.catalogRead, PERM.designsRead, PERM.usersRead, PERM.sharesRead, PERM.sharesRevoke],
  [ROLE_VIEWER]: [PERM.dashboard, PERM.catalogRead],
};

export const can = (st: Doc, p: Perm) => (ROLE_PERMS[st.role] ?? []).includes(p);
export const validRole = (role: string) => Object.prototype.hasOwnProperty.call(ROLE_PERMS, role);

// ---- Tokens ----

export function issueStaffToken(st: Doc): { token: string; expiresAt: Date } {
  const cfg = config();
  const now = Date.now();
  const expiresAt = new Date(now + cfg.adminTokenTTLms);
  const token = jwt.sign(
    {
      ver: st.tokenVersion ?? 0,
      iss: ADMIN_ISSUER,
      sub: st._id,
      aud: [ADMIN_AUDIENCE],
      exp: Math.floor(expiresAt.getTime() / 1000),
      iat: Math.floor(now / 1000),
    },
    cfg.adminJWTSecret,
    { algorithm: 'HS256', noTimestamp: true },
  );
  return { token, expiresAt };
}

/** The staff account behind the request's back office token, or UNAUTHORIZED. */
export async function staffFromToken(req: Request): Promise<Doc> {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) throw errUnauthorized();
  let claims: jwt.JwtPayload;
  try {
    const decoded = jwt.verify(h.slice('Bearer '.length), config().adminJWTSecret, {
      algorithms: ['HS256'], audience: ADMIN_AUDIENCE, issuer: ADMIN_ISSUER,
    });
    if (typeof decoded === 'string') throw new Error('not a claims object');
    claims = decoded;
  } catch {
    throw errUnauthorized();
  }
  if (typeof claims.exp !== 'number' || typeof claims.sub !== 'string' || claims.sub === '') throw errUnauthorized();
  const s = await db();
  const st = await s.staff.findOne({ _id: claims.sub });
  if (!st) throw errUnauthorized();
  // A disabled account, a password change or "sign out everywhere" ends every older token.
  if (st.disabled || (st.tokenVersion ?? 0) !== (claims.ver ?? 0)) throw errUnauthorized();
  return st;
}

/**
 * Checks the back office token and the permission. No permission only needs a signed-in
 * account, and is allowed while a password change is pending.
 */
export async function requireStaff(req: Request, p?: Perm): Promise<Doc> {
  const st = await staffFromToken(req);
  if (p) {
    if (st.mustChangePassword) throw fail(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your password before continuing.');
    if (!can(st, p)) throw errForbidden();
  }
  return st;
}

/** {token, expiresAt, staff, permissions}, as returned by sign-in and password change. */
export function newSession(st: Doc): Doc {
  const { token, expiresAt } = issueStaffToken(st);
  return { token, expiresAt, staff: staffOut(st), permissions: ROLE_PERMS[st.role] ?? [] };
}

// ---- Passwords ----

/** Throws a VALIDATION_ERROR unless the password has 10–72 characters (72 bytes for bcrypt). */
export function checkPassword(field: string, pw: string): void {
  if (runeCount(pw) < MIN_PASSWORD_LEN || Buffer.byteLength(pw) > 72) {
    FieldErrors.of(field, `must be ${MIN_PASSWORD_LEN}–72 characters`).throwIfAny();
  }
}

export const hashPassword = (pw: string) => bcrypt.hash(pw, BCRYPT_COST);
export const comparePassword = (hash: string, pw: string) => bcrypt.compare(pw, hash ?? '').catch(() => false);

/** Keeps a failed sign-in for an unknown email as slow as for a known one. */
let dummyHash: Promise<string> | undefined;
export function dummyCompare(pw: string): Promise<boolean> {
  dummyHash ??= bcrypt.hash('roomcraft-dummy-password', BCRYPT_COST);
  return dummyHash.then((h) => bcrypt.compare(pw, h));
}
