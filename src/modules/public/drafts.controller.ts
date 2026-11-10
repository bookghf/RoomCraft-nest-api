import { Controller, Delete, Get, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { requireUser } from '../../auth/user';
import { decode, int, obj, str } from '../../core/body';
import { fail, noContent, notFound, ok } from '../../core/envelope';
import { checkID, validateContent } from '../../core/validate';
import { db, isDuplicateKey } from '../../db/mongo';
import { Doc, draftOut, parseContent } from '../../db/models';
import { RECENT_LIMIT, planFor, trimDrafts } from './shared';

@Controller()
export class DraftsController {
  // GET /v1/drafts: unsaved work, newest first.
  @Get('v1/drafts')
  async list(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const s = await db();
    const drafts = await s.drafts.find({ ownerId: u.id }, { sort: { updatedAt: -1 }, limit: RECENT_LIMIT }).toArray();
    res.setHeader('Cache-Control', 'private, no-store');
    ok(res, 200, drafts.map(draftOut));
  }

  // PUT /v1/drafts/:id: autosave. Clients send at most one every few seconds while editing.
  @Put('v1/drafts/:id')
  async save(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const id = req.params.id as string;
    checkID('id', id);
    const b = obj(decode(req), 'body');
    const body = {
      planId: str(b, 'planId', 'body'),
      planVersion: int(b, 'planVersion', 'body'),
      designId: str(b, 'designId', 'body'),
      content: parseContent(b.content, 'content'),
    };
    if (body.designId !== '') checkID('designId', body.designId);
    const s = await db();
    const plan = await planFor(s, body.planId, body.planVersion);
    validateContent(body.content, plan, 'content.').throwIfAny();
    const d: Doc = { _id: id, ownerId: u.id };
    if (body.designId) d.designId = body.designId;
    Object.assign(d, { planId: plan.planId, planVersion: plan.version, content: body.content, updatedAt: new Date() });
    try {
      await s.drafts.replaceOne({ _id: id, ownerId: u.id }, d, { upsert: true });
    } catch (err) {
      // Another user has a draft with this id.
      if (isDuplicateKey(err)) throw fail(409, 'ID_TAKEN', 'This draft id is already in use.');
      throw err;
    }
    await trimDrafts(s, u.id);
    ok(res, 200, { id: d._id, planVersion: d.planVersion, updatedAt: d.updatedAt });
  }

  // DELETE /v1/drafts/:id: discard unsaved work (the X on a Recent card).
  @Delete('v1/drafts/:id')
  async remove(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const s = await db();
    const r = await s.drafts.deleteOne({ _id: req.params.id as string, ownerId: u.id });
    if (r.deletedCount === 0) throw notFound('Draft');
    noContent(res);
  }
}
