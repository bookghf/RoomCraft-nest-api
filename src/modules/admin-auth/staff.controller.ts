// Staff management (owner only): /v1/admin/staff. Ported from the Go API's admin_auth.go.

import { Controller, Get, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PERM, ROLE_PERMS, checkPassword, hashPassword, requireStaff, validRole } from '../../auth/staff';
import { audit, diffJSON } from '../../core/admin';
import { decode, obj, optBool, optStr, str } from '../../core/body';
import { fail, notFound, ok } from '../../core/envelope';
import { newStaffID } from '../../core/ids';
import { FieldErrors, MAX_NAME_LEN, runeCount, validName } from '../../core/validate';
import { db, isDuplicateKey } from '../../db/mongo';
import { Doc, ROLE_OWNER, staffOut } from '../../db/models';
import { MIN_PASSWORD_LEN } from '../../auth/staff';

const ROLE_MESSAGE = 'must be owner, catalog_manager, support or viewer';

// An RFC 5322 addr-spec (dot-atom or quoted local part, dot-atom or literal domain), which is
// what Go's net/mail.ParseAddress accepts when the parsed address must equal the input.
const ATEXT = "[A-Za-z0-9!#$%&'*+\\-/=?^_`{|}~\\u0080-\\uFFFF]";
const DOT_ATOM = `${ATEXT}+(?:\\.${ATEXT}+)*`;
const QUOTED = '"(?:[^"\\\\\\r\\n]|\\\\.)*"';
const EMAIL = new RegExp(`^(?:${DOT_ATOM}|${QUOTED})@(?:${DOT_ATOM}|\\[[^\\[\\]\\\\]*\\])$`, 'u');

/** Go's map[string][]perm encoded as JSON: keys sorted. */
function sortedRoles(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(ROLE_PERMS).sort()) out[k] = ROLE_PERMS[k];
  return out;
}

@Controller('v1/admin/staff')
export class AdminStaffController {
  // GET /v1/admin/staff
  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.staffManage);
    const s = await db();
    const list = await s.staff.find({}, { sort: { disabled: 1, email: 1 } }).toArray();
    ok(res, 200, { items: list.map(staffOut), roles: sortedRoles() });
  }

  // POST /v1/admin/staff {email, name, role, password}: the new account must change its password at first sign-in.
  @Post()
  async create(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.staffManage);
    const body = obj(decode(req), 'body');
    const rawEmail = str(body, 'email', 'body');
    const rawName = str(body, 'name', 'body');
    const role = str(body, 'role', 'body');
    const password = str(body, 'password', 'body');

    const errs = new FieldErrors();
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL.test(email)) errs.add('email', 'must be a valid email address');
    const [name, validN] = validName(rawName);
    if (!validN) errs.add('name', `1–${MAX_NAME_LEN} characters`);
    if (!validRole(role)) errs.add('role', ROLE_MESSAGE);
    if (runeCount(password) < MIN_PASSWORD_LEN || Buffer.byteLength(password) > 72) {
      errs.add('password', `must be ${MIN_PASSWORD_LEN}–72 characters`);
    }
    errs.throwIfAny();

    const hash = await hashPassword(password);
    const now = new Date();
    const st: Doc = {
      _id: newStaffID(), email, name, role, disabled: false, mustChangePassword: true,
      passwordHash: hash, tokenVersion: 0, failedLogins: 0, createdAt: now, updatedAt: now,
    };
    const s = await db();
    try {
      await s.staff.insertOne(st);
    } catch (err) {
      if (isDuplicateKey(err)) throw fail(409, 'EMAIL_TAKEN', 'A staff account with this email already exists.');
      throw err;
    }
    await audit(req, actor, 'staff.create', 'staff', st._id, `Created ${email} (${role})`);
    ok(res, 201, staffOut(st));
  }

  // PATCH /v1/admin/staff/:id {name?, role?, disabled?}
  @Patch(':id')
  async update(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.staffManage);
    const body = obj(decode(req), 'body');
    const bName = optStr(body, 'name', 'body');
    const bRole = optStr(body, 'role', 'body');
    const bDisabled = optBool(body, 'disabled', 'body');
    const s = await db();
    const before = await s.staff.findOne({ _id: req.params.id });
    if (!before) throw notFound('Staff account');

    const set: Doc = { updatedAt: new Date() };
    const update: Doc = { $set: set };
    if (bName !== undefined) {
      const [name, valid] = validName(bName);
      if (!valid) FieldErrors.of('name', `1–${MAX_NAME_LEN} characters`).throwIfAny();
      set.name = name;
    }
    const demoting = bRole !== undefined && bRole !== ROLE_OWNER;
    const disabling = bDisabled === true;
    if (bRole !== undefined) {
      if (!validRole(bRole)) FieldErrors.of('role', ROLE_MESSAGE).throwIfAny();
      set.role = bRole;
    }
    if (bDisabled !== undefined) {
      set.disabled = bDisabled;
      if (bDisabled) update.$inc = { tokenVersion: 1 }; // sign out at once
    }
    if (before._id === actor._id && (demoting || disabling)) {
      throw fail(409, 'SELF_CHANGE', "You can't remove your own owner access. Ask another owner.");
    }
    if (before.role === ROLE_OWNER && !before.disabled && (demoting || disabling)) {
      const n = await s.staff.countDocuments({ role: ROLE_OWNER, disabled: { $ne: true } });
      if (n <= 1) throw fail(409, 'LAST_OWNER', 'There must always be at least one active owner.');
    }
    const after = await s.staff.findOneAndUpdate({ _id: before._id }, update, { returnDocument: 'after' });
    if (!after) throw notFound('Staff account');
    await audit(req, actor, 'staff.update', 'staff', after._id, `Updated ${after.email}`, diffJSON(staffOut(before), staffOut(after)));
    ok(res, 200, staffOut(after));
  }

  // POST /v1/admin/staff/:id/reset-password {password}: a temporary password, to be changed at next sign-in.
  @Post(':id/reset-password')
  async resetPassword(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.staffManage);
    const body = obj(decode(req), 'body');
    const password = str(body, 'password', 'body');
    checkPassword('password', password);
    const hash = await hashPassword(password);
    const s = await db();
    const st = await s.staff.findOneAndUpdate(
      { _id: req.params.id },
      {
        $set: { passwordHash: hash, mustChangePassword: true, failedLogins: 0, updatedAt: new Date() },
        $unset: { lockedUntil: '' },
        $inc: { tokenVersion: 1 },
      },
      { returnDocument: 'after' },
    );
    if (!st) throw notFound('Staff account');
    await audit(req, actor, 'staff.reset_password', 'staff', st._id, `Reset password for ${st.email}`);
    ok(res, 200, staffOut(st));
  }
}
