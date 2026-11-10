import { Controller, Delete, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { config } from '../../config';
import { requireUser, userFrom } from '../../auth/user';
import { decode, int, obj, str } from '../../core/body';
import { fail, noContent, notFound, ok } from '../../core/envelope';
import { randomID } from '../../core/ids';
import { ID_PATTERN, validateContent } from '../../core/validate';
import { db, isDuplicateKey } from '../../db/mongo';
import { Doc, parseContent, shareOut } from '../../db/models';
import { planFor } from './shared';

const SHARE_CODE_LEN = 8;

/** Go's url.Parse(s) succeeding with scheme "https" (Go lowercases the scheme). */
function isHTTPS(s: string): boolean {
  if (/[\x00-\x1f\x7f]/.test(s)) return false;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(s);
  return !!m && m[1].toLowerCase() === 'https';
}

/** Go's url.PathEscape. */
function pathEscape(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%24/g, '$').replace(/%26/g, '&').replace(/%2B/g, '+').replace(/%2C/g, ',')
    .replace(/%3A/g, ':').replace(/%3B/g, ';').replace(/%3D/g, '=').replace(/%40/g, '@');
}

@Controller()
export class SharesController {
  // POST /v1/shares: a short link to a snapshot of a design. Signing in is optional;
  // only signed-in owners can revoke their links.
  @Post('v1/shares')
  async create(@Req() req: Request, @Res() res: Response) {
    const b = obj(decode(req), 'body');
    const body = {
      designId: str(b, 'designId', 'body'),
      planId: str(b, 'planId', 'body'),
      planVersion: int(b, 'planVersion', 'body'),
      content: parseContent(b.content, 'content'),
      imageUrl: str(b, 'imageUrl', 'body'),
    };
    const s = await db();
    const plan = await planFor(s, body.planId, body.planVersion);
    const errs = validateContent(body.content, plan, 'content.');
    if (body.designId !== '' && !ID_PATTERN.test(body.designId)) errs.add('designId', 'invalid id');
    if (body.imageUrl !== '' && (!isHTTPS(body.imageUrl) || body.imageUrl.length > 1024)) {
      errs.add('imageUrl', 'must be an https URL');
    }
    errs.throwIfAny();
    const cfg = config();
    const now = new Date();
    const sh: Doc = { _id: '' };
    const u = userFrom(req);
    if (u) sh.ownerId = u.id;
    if (body.designId) sh.designId = body.designId;
    Object.assign(sh, { planId: plan.planId, planVersion: plan.version, content: body.content });
    if (body.imageUrl) sh.imageUrl = body.imageUrl;
    sh.viewCount = 0;
    sh.createdAt = now;
    let expiresAt: Date | null = null;
    if (cfg.shareTTLms > 0) {
      expiresAt = new Date(now.getTime() + cfg.shareTTLms);
      sh.expiresAt = expiresAt;
    }
    for (let attempt = 0; ; attempt++) {
      sh._id = randomID(SHARE_CODE_LEN);
      try {
        await s.shares.insertOne(sh);
        break;
      } catch (err) {
        if (!isDuplicateKey(err) || attempt === 2) throw err;
      }
    }
    const link = `${cfg.shareBase}/designer/${pathEscape(plan.planId)}?share=${sh._id}`;
    ok(res, 201, { code: sh._id, expiresAt, url: link });
  }

  // GET /v1/shares/:code: the snapshot, which the app opens as a new unsaved design.
  @Get('v1/shares/:code')
  async get(@Req() req: Request, @Res() res: Response) {
    const s = await db();
    const sh = await s.shares.findOneAndUpdate(
      { _id: req.params.code as string },
      { $inc: { viewCount: 1 } },
      { returnDocument: 'after' },
    );
    if (!sh) throw notFound('Share link');
    // MongoDB removes expired links in the background, so check here as well.
    if (sh.revokedAt || (sh.expiresAt && Date.now() > new Date(sh.expiresAt).getTime())) {
      throw fail(410, 'SHARE_GONE', 'This share link has been turned off or has expired.');
    }
    res.setHeader('Cache-Control', 'private, no-store');
    ok(res, 200, shareOut(sh));
  }

  // DELETE /v1/shares/:code: turn a link off.
  @Delete('v1/shares/:code')
  async revoke(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const s = await db();
    const r = await s.shares.updateOne(
      { _id: req.params.code as string, ownerId: u.id, revokedAt: { $exists: false } },
      { $set: { revokedAt: new Date() } },
    );
    if (r.matchedCount === 0) throw notFound('Share link');
    noContent(res);
  }
}
