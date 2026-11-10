import { Controller, Delete, Get, Post, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { requireUser } from '../../auth/user';
import { Obj, arr, decode, num, obj, optBool, str, strElem } from '../../core/body';
import { publishedCatalog } from '../../core/catalog';
import { fail, noContent, ok } from '../../core/envelope';
import { buildQuote } from '../../core/quote';
import { FieldErrors, ID_PATTERN, checkID, validName, validateContent } from '../../core/validate';
import { Store, db, isDuplicateKey } from '../../db/mongo';
import {
  DesignContent, Doc, designOut, draftOut, parseDItem, preferencesOut, shareOut,
} from '../../db/models';
import { findPlanVersion } from '../../db/store';
import { RECENT_ITEMS_LIMIT, preferences, trimDrafts } from './shared';

const LANGUAGES = new Set(['en', 'th', 'zh']);

// ---- Import from the device ----

/** A design as the web and phone apps store it on the device today. */
interface LocalDesign {
  id: string;
  planId: string;
  name: string;
  content: DesignContent;
  updatedAt: string;
}

function surface(v: unknown, path: string) {
  const o = obj(v, path);
  return { material: str(o, 'material', path), color: str(o, 'color', path) };
}

function parseLocalDesign(v: unknown, path: string): LocalDesign {
  const o = obj(v, path);
  const content: DesignContent = {
    items: arr(o, 'items', path, parseDItem),
    floor: surface(o.floor, `${path}.floor`),
    wall: surface(o.wall, `${path}.wall`),
    ceiling: num(o, 'ceiling', path),
  };
  if (o.size !== undefined && o.size !== null) {
    const s = obj(o.size, `${path}.size`);
    content.size = { w: num(s, 'w', `${path}.size`), d: num(s, 'd', `${path}.size`) };
  }
  return { id: str(o, 'id', path), planId: str(o, 'planId', path), name: str(o, 'name', path), content, updatedAt: str(o, 'updatedAt', path) };
}

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** The device's updatedAt (RFC 3339), truncated to milliseconds, or fallback. */
function timeOf(s: string, fallback: Date): Date {
  if (!RFC3339.test(s)) return fallback;
  const t = new Date(s);
  return Number.isNaN(t.getTime()) ? fallback : t;
}

// ---- Personal data (Thailand PDPA) ----

/** Everything stored about a resident, including soft-deleted designs. */
async function exportUser(s: Store, userId: string): Promise<Doc> {
  const designs = await s.designs.find({ ownerId: userId }).toArray();
  const drafts = await s.drafts.find({ ownerId: userId }).toArray();
  const shares = await s.shares.find({ ownerId: userId }).toArray();
  const prefs = await preferences(s, userId);
  return {
    designs: designs.map(designOut),
    drafts: drafts.map(draftOut),
    exportedAt: new Date(),
    preferences: preferencesOut(prefs),
    recentItems: prefs.recentItems,
    shares: shares.map(shareOut),
    userId,
  };
}

@Controller()
export class MeController {
  // GET /v1/me/preferences
  @Get('v1/me/preferences')
  async getPreferences(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    ok(res, 200, preferencesOut(await preferences(await db(), u.id)));
  }

  // PUT /v1/me/preferences: {lang?, measure?}; fields left out are kept.
  @Put('v1/me/preferences')
  async putPreferences(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const b = obj(decode(req), 'body');
    const lang = b.lang === undefined || b.lang === null ? undefined : str(b, 'lang', 'body');
    let measure: Doc | undefined;
    if (b.measure !== undefined && b.measure !== null) {
      const m = obj(b.measure, 'body.measure');
      measure = {
        item: optBool(m, 'item', 'body.measure') ?? false,
        distance: optBool(m, 'distance', 'body.measure') ?? false,
        room: optBool(m, 'room', 'body.measure') ?? false,
      };
    }
    const set: Doc = { updatedAt: new Date() };
    if (lang !== undefined) {
      if (!LANGUAGES.has(lang)) FieldErrors.of('lang', 'must be en, th or zh').throwIfAny();
      set.lang = lang;
    }
    if (measure) set.measure = measure;
    const s = await db();
    await s.preferences.updateOne({ _id: u.id }, { $set: set }, { upsert: true });
    ok(res, 200, preferencesOut(await preferences(s, u.id)));
  }

  // GET /v1/me/recent-items
  @Get('v1/me/recent-items')
  async getRecentItems(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const p = await preferences(await db(), u.id);
    ok(res, 200, { items: p.recentItems });
  }

  // POST /v1/me/recent-items {itemId}: moves the item to the front and keeps the newest 12.
  @Post('v1/me/recent-items')
  async addRecentItem(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const itemId = str(obj(decode(req), 'body'), 'itemId', 'body');
    checkID('itemId', itemId);
    // One pipeline update: [item] + (list without item), cut to the limit.
    const without = {
      $filter: {
        input: { $ifNull: ['$recentItems', []] },
        as: 'x',
        cond: { $ne: ['$$x', { $literal: itemId }] },
      },
    };
    const update = [{
      $set: {
        recentItems: { $slice: [{ $concatArrays: [[{ $literal: itemId }], without] }, RECENT_ITEMS_LIMIT] },
        updatedAt: '$$NOW',
      },
    }];
    const s = await db();
    const p = await s.preferences.findOneAndUpdate({ _id: u.id }, update, { upsert: true, returnDocument: 'after' });
    ok(res, 200, { items: p?.recentItems ?? null });
  }

  // POST /v1/me/import: one-time upload of what the device saved before the user signed in.
  // It never overwrites anything already on the server, so it can be retried.
  @Post('v1/me/import')
  async importLocal(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const b = obj(decode(req), 'body');
    const body = {
      designs: arr(b, 'designs', 'body', parseLocalDesign),
      recent: arr(b, 'recent', 'body', (v, path) => {
        const o: Obj = obj(v, path);
        return { id: str(o, 'id', path), savedId: str(o, 'savedId', path), doc: parseLocalDesign(o.doc, `${path}.doc`) };
      }),
      recentItems: arr(b, 'recentItems', 'body', strElem),
    };
    if (body.designs.length > 200 || body.recent.length > 50) {
      throw fail(400, 'TOO_MANY', 'Import at most 200 designs and 50 recent entries at a time.');
    }
    const s = await db();
    const cat = await publishedCatalog();
    const now = new Date();
    const designs = { imported: 0, skipped: 0, invalid: [] as string[] };
    const drafts = { imported: 0, skipped: 0, invalid: [] as string[] };
    const idOK = (id: string) => ID_PATTERN.test(id);

    for (const d of body.designs) {
      const [name, validN] = validName(d.name);
      const plan = await findPlanVersion(s, d.planId, 0);
      const c = d.content;
      if (!idOK(d.id) || !validN || !plan || validateContent(c, plan, '').length > 0) {
        designs.invalid.push(d.id);
        continue;
      }
      const qt = buildQuote(c.items, cat);
      const at = timeOf(d.updatedAt, now);
      const doc: Doc = { _id: d.id, ownerId: u.id, planId: plan.planId, planVersion: plan.version, name, content: c };
      if (cat.version) doc.catalogVersion = cat.version;
      Object.assign(doc, { itemCount: qt.itemCount, totalSatang: qt.totalSatang, version: 1, createdAt: at, updatedAt: at });
      try {
        await s.designs.insertOne(doc);
        designs.imported++;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        designs.skipped++;
      }
    }

    for (const e of body.recent) {
      const plan = await findPlanVersion(s, e.doc.planId, 0);
      const c = e.doc.content;
      if (!idOK(e.id) || !plan || validateContent(c, plan, '').length > 0 || (e.savedId !== '' && !idOK(e.savedId))) {
        drafts.invalid.push(e.id);
        continue;
      }
      const d: Doc = { _id: e.id, ownerId: u.id };
      if (e.savedId) d.designId = e.savedId;
      Object.assign(d, { planId: plan.planId, planVersion: plan.version, content: c, updatedAt: timeOf(e.doc.updatedAt, now) });
      try {
        await s.drafts.insertOne(d);
        drafts.imported++;
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        drafts.skipped++;
      }
    }
    await trimDrafts(s, u.id);

    // Recently used items are only taken from the device when the server has none yet.
    let items: string[] = [];
    for (const id of body.recentItems) {
      if (idOK(id) && items.length < RECENT_ITEMS_LIMIT) items.push(id);
    }
    const r = await s.preferences.updateOne(
      { _id: u.id, 'recentItems.0': { $exists: false } },
      { $set: { recentItems: items, updatedAt: now } },
    );
    if (r.matchedCount === 0) {
      const p: Doc = { _id: u.id };
      if (items.length > 0) p.recentItems = items;
      p.updatedAt = now;
      try {
        await s.preferences.insertOne(p);
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        items = []; // the server already had a list
      }
    }
    ok(res, 200, { designs, drafts, recentItems: items.length });
  }

  // GET /v1/me/export: everything stored about the user.
  @Get('v1/me/export')
  async exportMe(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const data = await exportUser(await db(), u.id);
    const day = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="roomcraft-export-${day}.json"`);
    ok(res, 200, data);
  }

  // DELETE /v1/me: permanently deletes everything stored about the user, including soft-deleted designs.
  @Delete('v1/me')
  async deleteMe(@Req() req: Request, @Res() res: Response) {
    const u = requireUser(req);
    const s = await db();
    for (const coll of [s.designs, s.drafts, s.shares]) await coll.deleteMany({ ownerId: u.id });
    await s.preferences.deleteOne({ _id: u.id });
    noContent(res);
  }
}
