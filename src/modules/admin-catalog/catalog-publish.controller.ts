import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { audit } from '../../core/admin';
import { decode, hasBody } from '../../core/body';
import { invalidateCatalog } from '../../core/catalog';
import { fail, notFound, ok } from '../../core/envelope';
import { PERM, requireStaff } from '../../auth/staff';
import { db } from '../../db/mongo';
import { ConflictError, publishCatalog, rollbackCatalog } from '../../db/store';
import { categoryOut, itemOut, pendingChanges, publishBody, sortTop, versionExists, versionSummaryOut } from './helpers';

@Controller('v1/admin/catalog')
export class CatalogPublishController {
  // GET /v1/admin/catalog/changes: what the next publish would change.
  @Get('changes')
  async changes(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    ok(res, 200, await pendingChanges(await db()));
  }

  // POST /v1/admin/catalog/publish {version?, notes?}: make the current items the catalog the apps see.
  @Post('publish')
  async publish(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogPublish);
    const body = publishBody(hasBody(req) ? decode(req) : undefined);
    const s = await db();
    const changes = await pendingChanges(s);
    if (!changes.hasChanges) {
      throw fail(409, 'NO_CHANGES', `Nothing has changed since version ${changes.publishedVersion}.`);
    }
    let v;
    try {
      v = await publishCatalog(s, body.version, body.notes, actor._id);
    } catch (err) {
      if (err instanceof ConflictError) throw versionExists(body.version);
      throw err;
    }
    invalidateCatalog();
    await audit(req, actor, 'catalog.publish', 'catalogVersion', v._id,
      `Published ${v.items.length} items (+${changes.added.length}, ~${changes.changed.length}, -${changes.removed.length})`);
    ok(res, 201, versionSummaryOut(v));
  }

  // GET /v1/admin/catalog/versions: publish history, newest first.
  @Get('versions')
  async versions(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const list = await s.catalogVersions.aggregate([
      { $sort: { publishedAt: -1 } },
      { $project: { publishedAt: 1, publishedBy: 1, notes: 1, rolledBackFrom: 1, itemCount: { $size: '$items' } } },
    ]).toArray();
    ok(res, 200, list.map((v) => versionSummaryOut(v, v.itemCount)));
  }

  // GET /v1/admin/catalog/versions/:version
  @Get('versions/:version')
  async version(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const v = await s.catalogVersions.findOne({ _id: req.params.version });
    if (!v) throw notFound('Catalog version');
    ok(res, 200, sortTop({
      summary: versionSummaryOut(v),
      categories: Array.isArray(v.categories) ? v.categories.map(categoryOut) : null,
      items: Array.isArray(v.items) ? v.items.map(itemOut) : null,
    }));
  }

  // POST /v1/admin/catalog/versions/:version/rollback {version?, notes?}: publish an older catalog again.
  @Post('versions/:version/rollback')
  async rollback(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogPublish);
    const from = req.params.version as string;
    const body = publishBody(hasBody(req) ? decode(req) : undefined, 'Rolled back to ' + from);
    const s = await db();
    let v;
    try {
      v = await rollbackCatalog(s, from, body.version, body.notes, actor._id);
    } catch (err) {
      if (err instanceof ConflictError) throw versionExists(body.version);
      throw err;
    }
    if (!v) throw notFound('Catalog version');
    invalidateCatalog();
    await audit(req, actor, 'catalog.rollback', 'catalogVersion', v._id, 'Rolled back to ' + from);
    ok(res, 201, versionSummaryOut(v));
  }
}
