// Back office support: designs, residents and share links. Ported from the Go API's admin_support.go.

import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PERM, requireStaff } from '../../auth/staff';
import { audit, pageOf, pageParams, skipOf } from '../../core/admin';
import { decode, obj, str } from '../../core/body';
import { publishedCatalog } from '../../core/catalog';
import { notFound, noContent, ok, q } from '../../core/envelope';
import { quoteMeta } from '../../core/ids';
import { buildQuote } from '../../core/quote';
import { FieldErrors } from '../../core/validate';
import { db } from '../../db/mongo';
import { Doc, designOut, preferencesOut, putPtr } from '../../db/models';
import { findPlanVersion } from '../../db/store';
import {
  adminPlanOut, deleteUser, designRowOut, draftRowOut, exportUser, preferencesOf, shareRowOut,
} from './support.helpers';

@Controller('v1/admin')
export class AdminSupportController {
  // ---- Designs ----

  // GET /v1/admin/designs?q=&owner=&planId=&deleted=include|only&page=&pageSize=
  @Get('designs')
  async listDesigns(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.designsRead);
    const filter: Doc = {};
    switch (q(req.query, 'deleted')) {
      case 'include':
        break;
      case 'only':
        filter.deletedAt = { $exists: true };
        break;
      default:
        filter.deletedAt = { $exists: false };
    }
    const owner = q(req.query, 'owner');
    if (owner) filter.ownerId = owner;
    const planId = q(req.query, 'planId');
    if (planId) filter.planId = planId;
    const term = q(req.query, 'q').trim();
    if (term) filter.$or = [{ _id: term }, { name: { $regex: quoteMeta(term), $options: 'i' } }];
    const pg = pageParams(req);
    const s = await db();
    const total = await s.designs.countDocuments(filter);
    const rows = await s.designs
      .find(filter, { sort: { updatedAt: -1, _id: -1 }, projection: { content: 0 } })
      .skip(skipOf(pg)).limit(pg.size).toArray();
    ok(res, 200, pageOf(rows.map(designRowOut), total, pg));
  }

  // GET /v1/admin/designs/:id: the design, the plan version it uses and its shopping list. Logged.
  @Get('designs/:id')
  async getDesign(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.designsRead);
    const s = await db();
    const d = await s.designs.findOne({ _id: req.params.id });
    if (!d) throw notFound('Design');
    const cat = await publishedCatalog();
    const p = await findPlanVersion(s, d.planId ?? '', d.planVersion ?? 0);
    await audit(req, actor, 'design.view', 'design', d._id, `Viewed design of ${d.ownerId ?? ''}`);
    const design = designOut(d);
    design.ownerId = d.ownerId ?? '';
    putPtr(design, 'deletedAt', d.deletedAt);
    ok(res, 200, { design, plan: p ? adminPlanOut(p) : null, quote: buildQuote(d.content?.items ?? [], cat) });
  }

  // ---- Residents ----

  // GET /v1/admin/users?q=&page=: residents who have saved designs, most recently active first.
  @Get('users')
  async listUsers(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.usersRead);
    const match: Doc = { deletedAt: { $exists: false } };
    const term = q(req.query, 'q').trim();
    if (term) match.ownerId = { $regex: '^' + quoteMeta(term), $options: 'i' };
    const pg = pageParams(req);
    const s = await db();
    const result = await s.designs.aggregate([
      { $match: match },
      { $group: { _id: '$ownerId', designs: { $sum: 1 }, valueSatang: { $sum: '$totalSatang' }, lastActivity: { $max: '$updatedAt' } } },
      {
        $facet: {
          total: [{ $count: 'n' }],
          items: [{ $sort: { lastActivity: -1, _id: 1 } }, { $skip: skipOf(pg) }, { $limit: pg.size }],
        },
      },
    ]).toArray();
    let total = 0;
    let rows: Doc[] = [];
    if (result.length > 0) {
      rows = result[0].items ?? [];
      if (result[0].total?.length > 0) total = Number(result[0].total[0].n);
    }
    const items = rows.map((r) => ({
      userId: r._id ?? '',
      designs: Number(r.designs ?? 0),
      valueSatang: Number(r.valueSatang ?? 0),
      lastActivity: r.lastActivity ?? '0001-01-01T00:00:00Z',
    }));
    ok(res, 200, pageOf(items, total, pg));
  }

  // GET /v1/admin/users/:id: everything about one resident. Logged.
  @Get('users/:id')
  async getUser(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.usersRead);
    const id = req.params.id as string;
    const s = await db();
    const designs = await s.designs.find({ ownerId: id }, { sort: { updatedAt: -1 }, projection: { content: 0 } }).toArray();
    const drafts = await s.drafts.aggregate([
      { $match: { ownerId: id } },
      { $sort: { updatedAt: -1 } },
      { $project: { designId: 1, planId: 1, planVersion: 1, updatedAt: 1, itemCount: { $size: '$content.items' } } },
    ]).toArray();
    const shares = await s.shares.find({ ownerId: id }, { sort: { createdAt: -1 }, projection: { content: 0 } }).toArray();
    const now = new Date();
    const prefs = await preferencesOf(s, id);
    if (designs.length === 0 && drafts.length === 0 && shares.length === 0 && !prefs.found) throw notFound('Resident');
    await audit(req, actor, 'user.view', 'user', id, 'Viewed resident data');
    // Go marshals map[string]any with sorted keys.
    ok(res, 200, {
      designs: designs.map(designRowOut),
      drafts: drafts.map(draftRowOut),
      preferences: preferencesOut(prefs.doc),
      recentItems: prefs.recentItems,
      shares: shares.map((sh) => shareRowOut(sh, now)),
      userId: id,
    });
  }

  // GET /v1/admin/users/:id/export: a copy of everything stored, for a PDPA access request. Logged.
  @Get('users/:id/export')
  async exportUser(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.usersRead);
    const id = req.params.id as string;
    const data = await exportUser(await db(), id);
    await audit(req, actor, 'user.export', 'user', id, 'Exported resident data');
    ok(res, 200, data);
  }

  // DELETE /v1/admin/users/:id {confirm: id}: permanently deletes a resident's data (PDPA erasure). Logged.
  @Delete('users/:id')
  async deleteUser(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.usersDelete);
    const id = req.params.id as string;
    const body = obj(decode(req), 'body');
    if (str(body, 'confirm', 'body') !== id) FieldErrors.of('confirm', 'type the resident id to confirm').throwIfAny();
    const c = await deleteUser(await db(), id);
    await audit(req, actor, 'user.delete', 'user', id, `Erased resident data: ${c.designs} designs, ${c.drafts} drafts, ${c.shares} shares`);
    ok(res, 200, c);
  }

  // ---- Share links ----

  // GET /v1/admin/shares?owner=&status=active|revoked|expired&page=
  @Get('shares')
  async listShares(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.sharesRead);
    const filter: Doc = {};
    const now = new Date();
    const owner = q(req.query, 'owner');
    if (owner) filter.ownerId = owner;
    switch (q(req.query, 'status')) {
      case 'active':
        filter.revokedAt = { $exists: false };
        filter.$or = [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: now } }];
        break;
      case 'revoked':
        filter.revokedAt = { $exists: true };
        break;
      case 'expired':
        filter.revokedAt = { $exists: false };
        filter.expiresAt = { $lte: now };
        break;
    }
    const pg = pageParams(req);
    const s = await db();
    const total = await s.shares.countDocuments(filter);
    const rows = await s.shares
      .find(filter, { sort: { createdAt: -1 }, projection: { content: 0 } })
      .skip(skipOf(pg)).limit(pg.size).toArray();
    ok(res, 200, pageOf(rows.map((r) => shareRowOut(r, now)), total, pg));
  }

  // POST /v1/admin/shares/:code/revoke: turn off a link, e.g. after a complaint.
  @Post('shares/:code/revoke')
  async revokeShare(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.sharesRevoke);
    const code = req.params.code as string;
    const s = await db();
    const r = await s.shares.updateOne({ _id: code, revokedAt: { $exists: false } }, { $set: { revokedAt: new Date() } });
    if (r.matchedCount === 0) throw notFound('Active share link');
    await audit(req, actor, 'share.revoke', 'share', code, 'Revoked share link');
    noContent(res);
  }
}
