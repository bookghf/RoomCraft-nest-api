// Back office plans and room types. Ported from the Go API's admin_plans.go.

import { Controller, Delete, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PERM, requireStaff } from '../../auth/staff';
import { audit, diffJSON } from '../../core/admin';
import { decode, obj, int, str, text } from '../../core/body';
import { publishedCatalog } from '../../core/catalog';
import { fail, noContent, notFound, ok, q } from '../../core/envelope';
import {
  CEILING_MAX, CEILING_MIN, EPS, FLOOR_MATERIALS, FieldErrors, HEX_COLOR, ID_PATTERN, MAX_COORDINATE, WALL_MATERIALS, checkID, quote,
} from '../../core/validate';
import { db } from '../../db/mongo';
import { Doc, parsePlanSpec } from '../../db/models';
import { ConflictError, findPlanVersion, publishPlan } from '../../db/store';
import { adminPlanOut, adminRoomTypeOut, summarizePlan, textOrNull } from './support.helpers';

const PLAN_EMPTY = 'empty';
const PLAN_UNIT = 'unit';
const PLAN_SHOWROOM = 'showroom';

function validatePlanSpec(kind: string, spec: Doc): FieldErrors {
  const errs = new FieldErrors();
  if (kind !== PLAN_EMPTY && kind !== PLAN_UNIT && kind !== PLAN_SHOWROOM) errs.add('kind', 'must be empty, unit or showroom');
  if (!ID_PATTERN.test(spec.id)) errs.add('spec.id', "1–64 letters, digits, '-' or '_'");
  if (String(spec.name?.en ?? '').trim() === '') errs.add('spec.name.en', 'required');
  const zones: Doc[] = spec.zones ?? [];
  if (zones.length === 0) errs.add('spec.zones', 'at least one zone');
  zones.forEach((z, i) => {
    const poly: [number, number][] = z.polygon ?? [];
    if (poly.length < 3) errs.add(`spec.zones[${i}].polygon`, 'needs at least 3 corners');
    for (const pt of poly) {
      if (pt[0] < -MAX_COORDINATE || pt[0] > MAX_COORDINATE || pt[1] < -MAX_COORDINATE || pt[1] > MAX_COORDINATE) {
        errs.add(`spec.zones[${i}].polygon`, `corners must be within ±${MAX_COORDINATE.toFixed(0)} m`);
        break;
      }
    }
  });
  if (spec.ceiling < CEILING_MIN - EPS || spec.ceiling > CEILING_MAX + EPS) {
    errs.add('spec.ceiling', `must be between ${CEILING_MIN.toFixed(2)} and ${CEILING_MAX.toFixed(2)} m`);
  }
  if ((kind === PLAN_SHOWROOM) !== !!spec.showroom) errs.add('spec.showroom', 'required for showrooms and only for showrooms');
  if ((kind === PLAN_EMPTY) !== !!spec.resizable) errs.add('spec.resizable', 'required for the empty room and only for it');
  const sr = spec.showroom;
  if (sr) {
    if (!FLOOR_MATERIALS.has(sr.floor.material) || !HEX_COLOR.test(sr.floor.color)) {
      errs.add('spec.showroom.floor', 'needs a known material and a hex colour');
    }
    if (!WALL_MATERIALS.has(sr.wall.material) || !HEX_COLOR.test(sr.wall.color)) {
      errs.add('spec.showroom.wall', 'needs a known material and a hex colour');
    }
  }
  return errs;
}

@Controller('v1/admin')
export class AdminPlansController {
  // GET /v1/admin/plans?kind=&roomType=: every plan, archived ones too, with its newest version.
  @Get('plans')
  async list(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const match: Doc = {};
    const kind = q(req.query, 'kind');
    if (kind) match.kind = kind;
    const rt = q(req.query, 'roomType');
    if (rt) match.roomType = rt;
    const rows = await s.plans.aggregate([
      { $match: match },
      { $sort: { planId: 1, version: -1 } },
      { $group: { _id: '$planId', doc: { $first: '$$ROOT' }, versionCount: { $sum: 1 } } },
      { $sort: { 'doc.sortOrder': 1, _id: 1 } },
    ]).toArray();
    // Saved designs per plan, for "is anyone using this?".
    const used = new Map<string, number>();
    const counts = await s.designs.aggregate([
      { $match: { deletedAt: { $exists: false } } },
      { $group: { _id: '$planId', n: { $sum: 1 } } },
    ]).toArray();
    for (const c of counts) used.set(c._id, Number(c.n));
    const cat = await publishedCatalog();
    const out = rows.map((row) => {
      const o = summarizePlan(row.doc, cat);
      o.versionCount = Number(row.versionCount ?? 0);
      o.designCount = used.get(row.doc.planId) ?? 0;
      o.publishedAt = row.doc.publishedAt;
      if (row.doc.publishedBy) o.publishedBy = row.doc.publishedBy;
      if (row.doc.archivedAt) o.archivedAt = row.doc.archivedAt;
      return o;
    });
    ok(res, 200, out);
  }

  // GET /v1/admin/plans/:id/versions: every version, newest first, with geometry.
  @Get('plans/:id/versions')
  async versions(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const plans = await s.plans.find({ planId: req.params.id }, { sort: { version: -1 } }).toArray();
    if (plans.length === 0) throw notFound('Plan');
    ok(res, 200, plans.map(adminPlanOut));
  }

  // POST /v1/admin/plans {kind, roomType?, spec, notes?}: publish the spec as the next version of plan spec.id.
  // Saved designs keep the version they were made with, so older versions are never changed.
  @Post('plans')
  async publish(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.plansWrite);
    const body = obj(decode(req), 'body');
    const kind = str(body, 'kind', 'body');
    let roomType = str(body, 'roomType', 'body');
    const spec = parsePlanSpec(body.spec, 'spec');
    const notes = str(body, 'notes', 'body');
    const s = await db();
    const errs = validatePlanSpec(kind, spec);
    const sr = spec.showroom;
    if (sr) {
      if (roomType === '') roomType = sr.type;
      if ((await s.roomTypes.countDocuments({ _id: roomType })) === 0) errs.add('roomType', `unknown room type ${quote(roomType)}`);
      const cat = await publishedCatalog();
      (sr.items as Doc[]).forEach((it, i) => {
        if (!cat.byID.has(it.itemId)) errs.add(`spec.showroom.items[${i}].itemId`, `${quote(it.itemId)} is not in the published catalog`);
      });
    }
    errs.throwIfAny();
    const prev = await findPlanVersion(s, spec.id, 0);
    if (prev && prev.kind !== kind) {
      throw fail(409, 'KIND_MISMATCH', `Plan ${prev.planId} is a ${prev.kind}; a new version can't change that.`);
    }
    let p: Doc;
    try {
      p = await publishPlan(s, kind, roomType, 0, spec, actor._id, notes.trim());
    } catch (err) {
      if (err instanceof ConflictError) throw fail(409, 'VERSION_EXISTS', 'Another publish of this plan just happened. Try again.');
      throw err;
    }
    await audit(req, actor, 'plan.publish', 'plan', p.planId, `Published ${p.planId} version ${p.version}`);
    ok(res, 201, adminPlanOut(p));
  }

  // POST /v1/admin/plans/:id/archive and /restore: hide a plan from the apps' lists, or show it again.
  @Post('plans/:id/archive')
  archive(@Req() req: Request, @Res() res: Response) {
    return this.setArchived(req, res, true);
  }

  @Post('plans/:id/restore')
  restore(@Req() req: Request, @Res() res: Response) {
    return this.setArchived(req, res, false);
  }

  private async setArchived(req: Request, res: Response, archive: boolean) {
    const actor = await requireStaff(req, PERM.plansWrite);
    const id = req.params.id as string;
    const s = await db();
    const action = archive ? 'plan.archive' : 'plan.restore';
    const update = archive ? { $set: { archivedAt: new Date() } } : { $unset: { archivedAt: '' } };
    const r = await s.plans.updateMany({ planId: id }, update);
    if (r.matchedCount === 0) throw notFound('Plan');
    await audit(req, actor, action, 'plan', id, `${action.replace(/^plan\./, '')} ${id}`);
    noContent(res);
  }

  // ---- Room types ----

  // GET /v1/admin/room-types
  @Get('room-types')
  async listRoomTypes(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const types = await s.roomTypes.find({}, { sort: { sortOrder: 1 } }).toArray();
    const out: Doc[] = [];
    for (const t of types) {
      // Every plan has a version 1, so this counts plans rather than versions.
      const n = await s.plans.countDocuments({ roomType: t._id, version: 1 });
      out.push(adminRoomTypeOut(t, n));
    }
    ok(res, 200, out);
  }

  // PUT /v1/admin/room-types/:id {name, blurb, gradient, sortOrder}: live in the apps at once.
  @Put('room-types/:id')
  async putRoomType(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.plansWrite);
    const id = req.params.id as string;
    checkID('id', id);
    const body = obj(decode(req), 'body');
    const name = body.name === undefined || body.name === null ? null : text(body, 'name', 'body');
    const blurb = body.blurb === undefined || body.blurb === null ? null : text(body, 'blurb', 'body');
    const gradientRaw = str(body, 'gradient', 'body');
    const sortOrder = int(body, 'sortOrder', 'body');
    const errs = new FieldErrors();
    for (const lang of ['en', 'th', 'zh']) {
      if (String(name?.[lang] ?? '').trim() === '') errs.add(`name.${lang}`, 'required');
    }
    const g = gradientRaw.trim();
    if (g !== '' && (!g.startsWith('linear-gradient(') || /[;{}<>]/.test(g) || Buffer.byteLength(g) > 200)) {
      errs.add('gradient', 'must be a CSS linear-gradient(...)');
    }
    errs.throwIfAny();
    const s = await db();
    const before = await s.roomTypes.findOne({ _id: id });
    const rt: Doc = { _id: id, name: textOrNull(name), blurb: textOrNull(blurb), gradient: g, sortOrder, updatedAt: new Date() };
    await s.roomTypes.replaceOne({ _id: id }, rt, { upsert: true });
    if (before) {
      await audit(req, actor, 'roomType.update', 'roomType', id, rt.name?.en ?? '', diffJSON(adminRoomTypeOut(before), adminRoomTypeOut(rt)));
    } else {
      await audit(req, actor, 'roomType.create', 'roomType', id, rt.name?.en ?? '');
    }
    ok(res, 200, adminRoomTypeOut(rt));
  }

  // DELETE /v1/admin/room-types/:id: only when no showroom uses it.
  @Delete('room-types/:id')
  async deleteRoomType(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.plansWrite);
    const id = req.params.id as string;
    const s = await db();
    if ((await s.plans.countDocuments({ roomType: id })) > 0) throw fail(409, 'ROOM_TYPE_IN_USE', 'Showrooms use this room type.');
    const r = await s.roomTypes.deleteOne({ _id: id });
    if (r.deletedCount === 0) throw notFound('Room type');
    await audit(req, actor, 'roomType.delete', 'roomType', id, `Deleted room type ${id}`);
    noContent(res);
  }
}
