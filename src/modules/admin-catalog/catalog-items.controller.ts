import { Controller, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { audit, diffJSON, pageParams, pageSlice } from '../../core/admin';
import { decode } from '../../core/body';
import { fail, notFound, ok, q } from '../../core/envelope';
import { checkID } from '../../core/validate';
import { PERM, requireStaff } from '../../auth/staff';
import { db, isDuplicateKey } from '../../db/mongo';
import { Doc } from '../../db/models';
import { adminItemOut, allItems, itemOut, itemMatches, parseItemBody, publishedIndex, sortTop, storedItem, validateItem } from './helpers';

@Controller('v1/admin/catalog/items')
export class CatalogItemsController {
  // GET /v1/admin/catalog/items?q=&category=&state=&page=&pageSize=
  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const items = await allItems(s);
    const { v: pubV, byID: published } = await publishedIndex(s);
    const query = q(req.query, 'q').trim().toLowerCase();
    const category = q(req.query, 'category');
    const state = q(req.query, 'state');
    const out: Doc[] = [];
    const counts: Record<string, number> = {};
    for (const it of items) {
      const a = adminItemOut(it, published);
      counts[a.publishState] = (counts[a.publishState] ?? 0) + 1;
      if ((category && it.category !== category) || (state && a.publishState !== state) || (query && !itemMatches(it, query))) continue;
      out.push(a);
    }
    const page = pageSlice(out, pageParams(req));
    ok(res, 200, sortTop({
      items: page.items, total: page.total, page: page.page, pageSize: page.pageSize,
      publishedVersion: pubV ? pubV._id : '', stateCounts: sortTop(counts),
    }));
  }

  // GET /v1/admin/catalog/items/:id
  @Get(':id')
  async get(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const it = await s.items.findOne({ _id: req.params.id });
    if (!it) throw notFound('Catalog item');
    const { byID } = await publishedIndex(s);
    const n = await s.designs.countDocuments({ 'content.items.itemId': it._id, deletedAt: { $exists: false } });
    ok(res, 200, adminItemOut(it, byID, n));
  }

  // POST /v1/admin/catalog/items: a new item, not published until the next publish.
  @Post()
  async create(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogWrite);
    const it = parseItemBody(decode(req));
    checkID('id', it._id);
    const s = await db();
    await validateItem(s, it);
    const n = await s.items.countDocuments({});
    const now = new Date();
    const doc = storedItem(it, { sortOrder: n, createdAt: now, updatedAt: now, updatedBy: actor._id });
    try {
      await s.items.insertOne(doc);
    } catch (err) {
      if (isDuplicateKey(err)) throw fail(409, 'ID_TAKEN', 'An item with this id already exists.');
      throw err;
    }
    await audit(req, actor, 'catalog.item.create', 'catalogItem', doc._id, 'Created ' + (doc.name?.en ?? ''));
    const { byID } = await publishedIndex(s);
    ok(res, 201, adminItemOut(doc, byID));
  }

  // PUT /v1/admin/catalog/items/:id: replace an item's details. Retiring has its own endpoint.
  @Put(':id')
  async update(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogWrite);
    const s = await db();
    const id = req.params.id as string;
    const before = await s.items.findOne({ _id: id });
    if (!before) throw notFound('Catalog item');
    const it = parseItemBody(decode(req));
    it._id = id;
    await validateItem(s, it);
    const doc = storedItem(it, {
      sortOrder: before.sortOrder ?? 0, createdAt: before.createdAt, updatedAt: new Date(), updatedBy: actor._id, retiredAt: before.retiredAt,
    });
    const changes = diffJSON(itemOut(before), itemOut(doc));
    const { byID } = await publishedIndex(s);
    if (!changes) {
      ok(res, 200, adminItemOut(before, byID));
      return;
    }
    await s.items.replaceOne({ _id: id }, doc);
    await audit(req, actor, 'catalog.item.update', 'catalogItem', id, 'Edited ' + (doc.name?.en ?? ''), changes);
    ok(res, 200, adminItemOut(doc, (await publishedIndex(s)).byID));
  }

  // POST /v1/admin/catalog/items/:id/retire
  @Post(':id/retire')
  retire(@Req() req: Request, @Res() res: Response) {
    return this.setRetired(req, res, true);
  }

  // POST /v1/admin/catalog/items/:id/restore
  @Post(':id/restore')
  restore(@Req() req: Request, @Res() res: Response) {
    return this.setRetired(req, res, false);
  }

  private async setRetired(req: Request, res: Response, retire: boolean) {
    const actor = await requireStaff(req, PERM.catalogWrite);
    const s = await db();
    const now = new Date();
    const filter = { _id: req.params.id, retiredAt: { $exists: !retire } };
    const set: Doc = { updatedAt: now, updatedBy: actor._id };
    const update: Doc = { $set: set };
    let action = 'catalog.item.restore';
    if (retire) {
      set.retiredAt = now;
      action = 'catalog.item.retire';
    } else {
      update.$unset = { retiredAt: '' };
    }
    const it = await s.items.findOneAndUpdate(filter, update, { returnDocument: 'after' });
    if (!it) {
      throw fail(404, 'NOT_FOUND', 'Catalog item not found, or it is already ' + (retire ? 'retired' : 'active') + '.');
    }
    await audit(req, actor, action, 'catalogItem', it._id, action.replace(/^catalog\.item\./, '') + ' ' + (it.name?.en ?? ''));
    const { byID } = await publishedIndex(s);
    ok(res, 200, adminItemOut(it, byID));
  }
}
