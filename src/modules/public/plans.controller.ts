import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PublishedCatalog, publishedCatalog } from '../../core/catalog';
import { atoi, notFound, ok, q } from '../../core/envelope';
import { db } from '../../db/mongo';
import { Doc, isEmpty, planOut } from '../../db/models';
import { findPlanVersion } from '../../db/store';
import { sortMap } from './shared';

/** A plan without geometry, for list screens (Go's planSummary). */
function summarizePlan(p: Doc, cat: PublishedCatalog): Doc {
  const spec = p.spec ?? {};
  const sr = spec.showroom;
  const o: Doc = { id: p.planId, version: p.version ?? 0, kind: p.kind ?? '' };
  if (!isEmpty(p.roomType)) o.roomType = p.roomType;
  o.name = sortMap(spec.name ?? null);
  if (sr && !isEmpty(sr.description)) o.description = sortMap(sr.description);
  o.area = spec.area === undefined ? null : spec.area;
  if (sr && !isEmpty(sr.thumbnail)) o.thumbnail = sr.thumbnail;
  o.ceiling = spec.ceiling ?? 0;
  if (spec.resizable) o.resizable = { w: spec.resizable.w ?? 0, d: spec.resizable.d ?? 0 };
  let itemCount = 0;
  let total = 0;
  if (sr) {
    const items: Doc[] = sr.items ?? [];
    itemCount = items.length;
    for (const it of items) {
      const ci = cat.byID.get(it.itemId);
      if (ci) total += Number(ci.priceSatang ?? 0);
    }
  }
  o.itemCount = itemCount;
  o.presetTotalSatang = total;
  return o;
}

@Controller()
export class PlansController {
  // GET /v1/plans?kind=unit|showroom|empty&roomType=bedroom: newest version of each plan, without geometry.
  @Get('v1/plans')
  async listPlans(@Req() req: Request, @Res() res: Response) {
    const s = await db();
    const match: Doc = { archivedAt: { $exists: false } };
    const kind = q(req.query, 'kind');
    if (kind) match.kind = kind;
    const rt = q(req.query, 'roomType');
    if (rt) match.roomType = rt;
    const plans = await s.plans
      .aggregate([
        { $match: match },
        { $sort: { planId: 1, version: -1 } },
        { $group: { _id: '$planId', doc: { $first: '$$ROOT' } } },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { sortOrder: 1, planId: 1 } },
      ])
      .toArray();
    const cat = await publishedCatalog();
    res.setHeader('Cache-Control', 'public, max-age=300');
    ok(res, 200, plans.map((p) => summarizePlan(p, cat)));
  }

  // GET /v1/plans/:id: newest version with geometry (and the furnished preset for showrooms).
  @Get('v1/plans/:id')
  async getPlan(@Req() req: Request, @Res() res: Response) {
    const p = await findPlanVersion(await db(), req.params.id as string, 0);
    if (!p) throw notFound('Plan');
    res.setHeader('Cache-Control', 'public, max-age=300');
    ok(res, 200, planOut(p));
  }

  // GET /v1/plans/:id/versions/:version: an exact version. Published versions never change.
  @Get('v1/plans/:id/versions/:version')
  async getPlanVersion(@Req() req: Request, @Res() res: Response) {
    const v = atoi(req.params.version as string);
    if (!Number.isFinite(v) || v < 1) throw notFound('Plan version');
    const p = await findPlanVersion(await db(), req.params.id as string, v);
    if (!p) throw notFound('Plan');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    ok(res, 200, planOut(p));
  }
}
