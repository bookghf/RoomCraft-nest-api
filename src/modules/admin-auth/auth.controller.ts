// Back office sign-in: /v1/admin/auth/*. Ported from the Go API's admin_auth.go.

import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  BCRYPT_COST, LOCKOUT_MS, MAX_FAILED_LOGINS, ROLE_PERMS,
  checkPassword, comparePassword, dummyCompare, newSession, requireStaff,
} from '../../auth/staff';
import { audit } from '../../core/admin';
import { decode, obj, str } from '../../core/body';
import { fail, noContent, ok } from '../../core/envelope';
import { FieldErrors } from '../../core/validate';
import { db } from '../../db/mongo';
import { staffOut } from '../../db/models';
import bcrypt from 'bcryptjs';

const badCredentials = () => fail(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');

@Controller('v1/admin/auth')
export class AdminAuthController {
  // POST /v1/admin/auth/login {email, password}
  @Post('login')
  async login(@Req() req: Request, @Res() res: Response) {
    const body = obj(decode(req), 'body');
    const email = str(body, 'email', 'body').trim().toLowerCase();
    const password = str(body, 'password', 'body');
    const s = await db();
    const st = await s.staff.findOne({ email });
    if (!st) {
      await dummyCompare(password);
      throw badCredentials();
    }
    const now = new Date();
    if (st.lockedUntil && now < st.lockedUntil) {
      const mins = Math.trunc((st.lockedUntil.getTime() - now.getTime()) / 60_000) + 1;
      throw fail(429, 'ACCOUNT_LOCKED', `Too many failed sign-ins. Try again in ${mins} minutes.`);
    }
    if (!(await comparePassword(st.passwordHash, password)) || st.disabled) {
      const update = (st.failedLogins ?? 0) + 1 >= MAX_FAILED_LOGINS
        ? { $set: { failedLogins: 0, lockedUntil: new Date(now.getTime() + LOCKOUT_MS) } }
        : { $inc: { failedLogins: 1 } };
      await s.staff.updateOne({ _id: st._id }, update);
      await audit(req, st, 'auth.login_failed', 'staff', st._id, 'Failed sign-in');
      throw badCredentials();
    }
    await s.staff.updateOne({ _id: st._id }, { $set: { failedLogins: 0, lastLoginAt: now }, $unset: { lockedUntil: '' } });
    st.lastLoginAt = now;
    const sess = newSession(st);
    await audit(req, st, 'auth.login', 'staff', st._id, 'Signed in');
    ok(res, 200, sess);
  }

  // GET /v1/admin/auth/me
  @Get('me')
  async me(@Req() req: Request, @Res() res: Response) {
    const st = await requireStaff(req);
    // Go encodes a map, so keys come out sorted; a role without permissions is null.
    ok(res, 200, { permissions: ROLE_PERMS[st.role] ?? null, staff: staffOut(st) });
  }

  // POST /v1/admin/auth/password {currentPassword, newPassword}: also signs out other sessions.
  @Post('password')
  async changePassword(@Req() req: Request, @Res() res: Response) {
    const st = await requireStaff(req);
    const body = obj(decode(req), 'body');
    const current = str(body, 'currentPassword', 'body');
    const next = str(body, 'newPassword', 'body');
    if (!(await comparePassword(st.passwordHash, current))) {
      FieldErrors.of('currentPassword', 'is incorrect').throwIfAny();
    }
    checkPassword('newPassword', next);
    if (next === current) {
      FieldErrors.of('newPassword', 'must be different from the current password').throwIfAny();
    }
    const hash = await bcrypt.hash(next, BCRYPT_COST);
    const s = await db();
    const after = await s.staff.findOneAndUpdate(
      { _id: st._id },
      { $set: { passwordHash: hash, mustChangePassword: false, updatedAt: new Date() }, $inc: { tokenVersion: 1 } },
      { returnDocument: 'after' },
    );
    if (!after) throw new Error('staff account disappeared during password change');
    await audit(req, after, 'auth.password_change', 'staff', after._id, 'Changed own password');
    ok(res, 200, newSession(after));
  }

  // POST /v1/admin/auth/logout: signs the account out on every device.
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    const st = await requireStaff(req);
    const s = await db();
    await s.staff.updateOne({ _id: st._id }, { $inc: { tokenVersion: 1 } });
    await audit(req, st, 'auth.logout', 'staff', st._id, 'Signed out everywhere');
    noContent(res);
  }
}
