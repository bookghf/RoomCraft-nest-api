import { Controller, Delete, Get, Patch, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { requireUser } from '../../auth/user';
import { decode, hasBody, int, obj, str } from '../../core/body';
import { publishedCatalog } from '../../core/catalog';
import { etag, fail, ifMatch, limitParam, noContent, notFound, ok, q } from '../../core/envelope';
import { randomID, truncateRunes } from '../../core/ids';
import { buildQuote } from '../../core/quote';
import { FieldErrors, MAX_NAME_LEN, catalogWarnings, checkID, validName, validateContent } from '../../core/validate';
import { db, isDuplicateKey } from '../../db/mongo';
import { Doc, designOut, designSummaryOut, parseContent } from '../../db/models';
import { decodeCursor, encodeCursor, ownDesign, planFor } from './shared';

const notDeleted = { $exists: false };

/** The client's copy is out of date: send the server copy so the app can offer keep / take / copy. */
const designConflict = (server: Doc) =>
  fail(409, 'DESIGN_CONFLICT', 'This design was changed on another device.', { server: designOut(server) });

@Controller()
export class DesignsController {
  // GET /v1/designs?limit=&cursor=: the user's saved designs, newest first, without content.
  @Get('v1/designs')
  async list(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const filter: Doc = { ownerId: u.id, deletedAt: notDeleted };
    const c = q(req.query, 'cursor');
    if (c !== '') {
      const cur = decodeCursor(c);
      if (!cur) throw fail(400, 'INVALID_CURSOR', 'cursor is not valid.');
      filter.$or = [{ updatedAt: { $lt: cur.at } }, { updatedAt: cur.at, _id: { $lt: cur.id } }];
    }
    const limit = limitParam(q(req.query, 'limit'), 20, 100);
    const s = await db();
    let items = await s.designs
      .find(filter, { sort: { updatedAt: -1, _id: -1 }, limit: limit + 1, projection: { content: 0 } })
      .toArray();
    let next = '';
    if (items.length > limit) {
      items = items.slice(0, limit);
      const last = items[limit - 1];
      next = encodeCursor(last.updatedAt, last._id);
    }
    ok(res, 200, { items: items.map(designSummaryOut), nextCursor: next });
  }

  // GET /v1/designs/:id
  @Get('v1/designs/:id')
  async get(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const d = await ownDesign(await db(), u, req.params.id as string);
    res.setHeader('ETag', etag(d.version ?? 0));
    res.setHeader('Cache-Control', 'private, no-store');
    ok(res, 200, designOut(d));
  }

  // PUT /v1/designs/:id: create or replace a saved design. The id comes from the client,
  // so the phone app can save offline and retry safely. Updating needs If-Match.
  @Put('v1/designs/:id')
  async save(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const id = req.params.id as string;
    checkID('id', id);
    const expected = ifMatch(req.headers['if-match'] as string | undefined);
    const b = obj(decode(req), 'body');
    const body = {
      name: str(b, 'name', 'body'),
      planId: str(b, 'planId', 'body'),
      planVersion: int(b, 'planVersion', 'body'),
      content: parseContent(b.content, 'content'),
      // The Recent entry this save replaces; it is deleted after saving.
      draftId: str(b, 'draftId', 'body'),
    };
    const s = await db();
    const [name, valid] = validName(body.name);
    const errs = new FieldErrors();
    if (!valid) errs.add('name', `1–${MAX_NAME_LEN} characters`);
    const plan = await planFor(s, body.planId, body.planVersion);
    errs.merge(validateContent(body.content, plan, 'content.'));
    errs.throwIfAny();
    const cat = await publishedCatalog();
    const qt = buildQuote(body.content.items, cat);
    const now = new Date();
    const fields: Doc = {
      planId: plan.planId, planVersion: plan.version, name, content: body.content,
      catalogVersion: cat.version, itemCount: qt.itemCount, totalSatang: qt.totalSatang, updatedAt: now,
    };

    const existing = await s.designs.findOne({ _id: id });
    let version = 1;
    if (!existing) {
      const d: Doc = {
        _id: id, ownerId: u.id, planId: plan.planId, planVersion: plan.version, name, content: body.content,
      };
      if (cat.version) d.catalogVersion = cat.version;
      Object.assign(d, { itemCount: qt.itemCount, totalSatang: qt.totalSatang, version: 1, createdAt: now, updatedAt: now });
      try {
        await s.designs.insertOne(d);
      } catch (err) {
        if (isDuplicateKey(err)) throw fail(409, 'DESIGN_CONFLICT', 'This design was just saved from another device. Reload it and try again.');
        throw err;
      }
    } else if (existing.ownerId !== u.id) {
      throw fail(409, 'ID_TAKEN', 'This design id is already in use. Save it with a new id.');
    } else {
      if (!existing.deletedAt) {
        if (expected === 0) {
          throw fail(428, 'IF_MATCH_REQUIRED', 'Send If-Match with the version you loaded to update a saved design.', { version: existing.version ?? 0 });
        }
        if (expected !== existing.version) throw designConflict(existing);
      }
      // A deleted design with this id is replaced, as if it were new.
      const r = await s.designs.updateOne(
        { _id: id, ownerId: u.id, version: existing.version },
        { $set: fields, $inc: { version: 1 }, $unset: { deletedAt: '' } },
      );
      if (r.matchedCount === 0) throw designConflict(await ownDesign(s, u, id));
      version = (existing.version ?? 0) + 1;
    }

    // The saved design now holds this work, so its Recent entries go.
    const draftFilter: Doc[] = [{ designId: id }];
    if (body.draftId !== '') draftFilter.push({ _id: body.draftId });
    await s.drafts.deleteMany({ ownerId: u.id, $or: draftFilter });

    res.setHeader('ETag', etag(version));
    ok(res, version === 1 ? 201 : 200, {
      id, version, planVersion: plan.version, catalogVersion: cat.version,
      itemCount: qt.itemCount, totalSatang: qt.totalSatang, updatedAt: now,
      warnings: catalogWarnings(body.content.items, cat),
    });
  }

  // PATCH /v1/designs/:id: rename. If-Match is optional here, since a rename can't lose work.
  @Patch('v1/designs/:id')
  async rename(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const expected = ifMatch(req.headers['if-match'] as string | undefined);
    const b = obj(decode(req), 'body');
    const [name, valid] = validName(str(b, 'name', 'body'));
    if (!valid) FieldErrors.of('name', `1–${MAX_NAME_LEN} characters`).throwIfAny();
    const id = req.params.id as string;
    const filter: Doc = { _id: id, ownerId: u.id, deletedAt: notDeleted };
    if (expected > 0) filter.version = expected;
    const s = await db();
    const d = await s.designs.findOneAndUpdate(
      filter,
      { $set: { name, updatedAt: new Date() }, $inc: { version: 1 } },
      { returnDocument: 'after', projection: { content: 0 } },
    );
    if (!d) throw designConflict(await ownDesign(s, u, id));
    res.setHeader('ETag', etag(d.version));
    ok(res, 200, { id: d._id, name: d.name, updatedAt: d.updatedAt, version: d.version });
  }

  // POST /v1/designs/:id/duplicate: copy as "Copy of <name>" (or the given name) under a new id.
  @Post('v1/designs/:id/duplicate')
  async duplicate(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const s = await db();
    const src = await ownDesign(s, u, req.params.id as string);
    let given = '';
    if (hasBody(req)) given = str(obj(decode(req), 'body'), 'name', 'body');
    let [name, valid] = validName(given);
    if (!valid) name = truncateRunes('Copy of ' + (src.name ?? ''), MAX_NAME_LEN);
    const now = new Date();
    const d: Doc = { ...src, _id: randomID(10), name, version: 1, createdAt: now, updatedAt: now };
    await s.designs.insertOne(d);
    res.setHeader('ETag', etag(1));
    ok(res, 201, designOut(d));
  }

  // DELETE /v1/designs/:id: soft delete; MongoDB removes it for good after 30 days.
  @Delete('v1/designs/:id')
  async remove(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const id = req.params.id as string;
    const s = await db();
    const r = await s.designs.updateOne(
      { _id: id, ownerId: u.id, deletedAt: notDeleted },
      { $set: { deletedAt: new Date() }, $inc: { version: 1 } },
    );
    if (r.matchedCount === 0) throw notFound('Design');
    await s.drafts.deleteMany({ ownerId: u.id, designId: id });
    noContent(res);
  }

  // GET /v1/designs/:id/quote: shopping list at today's prices.
  @Get('v1/designs/:id/quote')
  async quote(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const d = await ownDesign(await db(), u, req.params.id as string);
    const cat = await publishedCatalog();
    ok(res, 200, buildQuote(d.content?.items ?? [], cat));
  }
}
