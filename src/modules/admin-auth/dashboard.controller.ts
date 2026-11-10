// Back office dashboard and audit log. Ported from the Go API's admin_support.go
// (adminDashboard) and admin_common.go (adminListAudit).

import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PERM, requireStaff } from '../../auth/staff';
import { findPage, pageOf, pageParams } from '../../core/admin';
import { publishedCatalog } from '../../core/catalog';
import { atoi, ok, q } from '../../core/envelope';
import { quoteMeta } from '../../core/ids';
import { db } from '../../db/mongo';
import { Doc, auditOut, isEmpty } from '../../db/models';
import { findPlanVersion } from '../../db/store';
import { pendingChangeCount } from './pending';

// Thailand has no daylight saving, so a fixed +07:00 offset is exact.
const BANGKOK_MS = 7 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** YYYY-MM-DD of a Bangkok-midnight instant. */
const ymd = (bangkokMidnight: number) => new Date(bangkokMidnight + BANGKOK_MS).toISOString().slice(0, 10);

@Controller('v1/admin')
export class AdminDashboardController {
  // GET /v1/admin/dashboard?days=30
  @Get('dashboard')
  async dashboard(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.dashboard);
    let days = atoi(q(req.query, 'days'));
    if (!Number.isFinite(days) || days < 7 || days > 365) days = 30;

    const nowMs = Date.now();
    // Midnight today in Bangkok, as a UTC instant.
    const today = Math.floor((nowMs + BANGKOK_MS) / DAY_MS) * DAY_MS - BANGKOK_MS;
    const fromMs = today - (days - 1) * DAY_MS;
    const from = new Date(fromMs);
    const live = { deletedAt: { $exists: false } };
    const inRange = { deletedAt: { $exists: false }, createdAt: { $gte: from } };
    const s = await db();

    const totals: Doc = {};
    const counts: [string, any, Doc][] = [
      ['designs', s.designs, live],
      ['designsInRange', s.designs, inRange],
      ['drafts', s.drafts, {}],
      ['shares', s.shares, {}],
      ['sharesInRange', s.shares, { createdAt: { $gte: from } }],
      ['activeShares', s.shares, {
        revokedAt: { $exists: false },
        $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gt: new Date() } }],
      }],
    ];
    for (const [key, coll, filter] of counts) totals[key] = await coll.countDocuments(filter);

    const owners: string[] = await s.designs.distinct('ownerId', live);
    const activeDesign: string[] = await s.designs.distinct('ownerId', { deletedAt: { $exists: false }, updatedAt: { $gte: from } });
    const activeDraft: string[] = await s.drafts.distinct('ownerId', { updatedAt: { $gte: from } });
    totals.users = owners.length;
    totals.activeUsers = new Set([...activeDesign, ...activeDraft]).size;

    const sum = await s.designs.aggregate([
      { $match: live },
      { $group: { _id: null, total: { $sum: '$totalSatang' } } },
    ]).toArray();
    totals.designValueSatang = sum.length > 0 ? Number(sum[0].total ?? 0) : 0;

    // Designs created per day, in Bangkok time, with empty days filled in.
    const perDayRows = await s.designs.aggregate([
      { $match: inRange },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: '+07:00' } },
          designs: { $sum: 1 }, owners: { $addToSet: '$ownerId' },
        },
      },
      { $project: { designs: 1, users: { $size: '$owners' } } },
    ]).toArray();
    const byDate = new Map<string, Doc>();
    for (const row of perDayRows) byDate.set(row._id, { date: row._id, designs: row.designs ?? 0, users: row.users ?? 0 });
    const perDay: Doc[] = [];
    for (let d = fromMs; d <= today; d += DAY_MS) {
      const key = ymd(d);
      perDay.push(byDate.get(key) ?? { date: key, designs: 0, users: 0 });
    }

    const cat = await publishedCatalog();
    const itemRows = await s.designs.aggregate([
      { $match: live },
      { $unwind: '$content.items' },
      { $group: { _id: '$content.items.itemId', placements: { $sum: 1 }, designs: { $addToSet: '$_id' } } },
      { $project: { itemId: '$_id', placements: 1, designs: { $size: '$designs' } } },
      { $sort: { placements: -1, _id: 1 } },
      { $limit: 10 },
    ]).toArray();
    const topItems = itemRows.map((r) => {
      const o: Doc = { itemId: r.itemId ?? '' };
      const name = cat.byID.get(r.itemId)?.name;
      if (!isEmpty(name)) o.name = name;
      o.placements = r.placements ?? 0;
      o.designs = r.designs ?? 0;
      return o;
    });

    const planRows = await s.designs.aggregate([
      { $match: live },
      { $group: { _id: '$planId', designs: { $sum: 1 } } },
      { $project: { planId: '$_id', designs: 1 } },
      { $sort: { designs: -1, _id: 1 } },
      { $limit: 10 },
    ]).toArray();
    const topPlans: Doc[] = [];
    for (const r of planRows) {
      const o: Doc = { planId: r.planId ?? '' };
      const p = await findPlanVersion(s, r.planId, 0);
      if (p) {
        if (!isEmpty(p.spec?.name)) o.name = p.spec.name;
        if (p.kind) o.kind = p.kind;
      }
      o.designs = r.designs ?? 0;
      topPlans.push(o);
    }

    const pending = await pendingChangeCount(s);
    // Go encodes these as maps, so keys come out sorted alphabetically.
    const sortedTotals: Doc = {};
    for (const k of Object.keys(totals).sort()) sortedTotals[k] = totals[k];
    ok(res, 200, {
      catalog: {
        items: (cat.doc.items ?? []).length,
        pendingChanges: pending,
        publishedAt: cat.doc.publishedAt,
        version: cat.version,
      },
      perDay,
      range: { days, from: ymd(fromMs), to: ymd(today) },
      topItems,
      topPlans,
      totals: sortedTotals,
    });
  }

  // GET /v1/admin/audit?actor=&action=&targetType=&targetId=&page=&pageSize=
  @Get('audit')
  async auditLog(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.auditRead);
    const filter: Doc = {};
    const actor = q(req.query, 'actor');
    if (actor) filter.$or = [{ actorId: actor }, { actorEmail: actor }];
    const action = q(req.query, 'action');
    if (action) filter.action = { $regex: '^' + quoteMeta(action) };
    const targetType = q(req.query, 'targetType');
    if (targetType) filter.targetType = targetType;
    const targetId = q(req.query, 'targetId');
    if (targetId) filter.targetId = targetId;
    const pg = pageParams(req);
    const s = await db();
    const { total, docs } = await findPage(s.audit, filter, { at: -1 }, pg);
    ok(res, 200, pageOf(docs.map(auditOut), total, pg));
  }
}
