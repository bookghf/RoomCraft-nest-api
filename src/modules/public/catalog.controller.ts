import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { publishedCatalog } from '../../core/catalog';
import { atoi, fail, limitParam, notFound, ok, q } from '../../core/envelope';
import { db } from '../../db/mongo';
import { Doc, itemOut, roomTypeOut } from '../../db/models';
import { findItem } from '../../db/store';

// Go's strconv.ParseFloat for plain decimal and exponent forms (and inf/infinity/nan).
const FLOAT = /^[+-]?((\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?|inf|infinity|nan)$/i;

function itemMatches(it: Doc, query: string): boolean {
  if (String(it._id).includes(query) || String(it.sku ?? '').toLowerCase().includes(query)) return true;
  for (const n of Object.values((it.name ?? {}) as Record<string, string>)) {
    if (String(n).toLowerCase().includes(query)) return true;
  }
  return false;
}

@Controller()
export class CatalogController {
  // GET /v1/catalog: the whole published catalog. Clients send If-None-Match with the
  // version they have and get 304 when nothing changed.
  @Get('v1/catalog')
  async getCatalog(@Req() req: Request, @Res() res: Response) {
    const cat = await publishedCatalog();
    const tag = `"${cat.version}"`;
    res.setHeader('ETag', tag);
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (req.headers['if-none-match'] === tag) {
      res.status(304).end();
      return;
    }
    res.status(200).setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(cat.body);
  }

  // GET /v1/catalog/items?category=&mount=&q=&maxPrice=&includeHidden=&limit=&cursor=
  // q matches any language, the item id or the SKU. maxPrice is in baht.
  @Get('v1/catalog/items')
  async listItems(@Req() req: Request, @Res() res: Response) {
    const cat = await publishedCatalog();
    const category = q(req.query, 'category');
    const mount = q(req.query, 'mount');
    const query = q(req.query, 'q').trim().toLowerCase();
    const includeHidden = q(req.query, 'includeHidden') === 'true';
    let maxSatang = -1;
    const mp = q(req.query, 'maxPrice');
    if (mp !== '') {
      const f = FLOAT.test(mp) ? Number(mp.replace(/^([+-]?)inf(inity)?$/i, '$1Infinity')) : NaN;
      if (!FLOAT.test(mp) || f < 0) throw fail(400, 'INVALID_PARAM', 'maxPrice must be a number of baht.');
      maxSatang = Math.trunc(f * 100);
    }
    const matches: Doc[] = [];
    for (const it of cat.doc.items ?? []) {
      if ((it.hidden && !includeHidden) || (category !== '' && it.category !== category) || (mount !== '' && it.mount !== mount) ||
        (maxSatang >= 0 && Number(it.priceSatang ?? 0) > maxSatang) || (query !== '' && !itemMatches(it, query))) {
        continue;
      }
      matches.push(it);
    }
    let offset = atoi(q(req.query, 'cursor'));
    if (!Number.isFinite(offset)) offset = 0;
    offset = Math.max(0, Math.min(offset, matches.length));
    const end = Math.min(offset + limitParam(q(req.query, 'limit'), 100, 200), matches.length);
    const next = end < matches.length ? String(end) : '';
    ok(res, 200, { catalogVersion: cat.version, items: matches.slice(offset, end).map(itemOut), nextCursor: next });
  }

  // GET /v1/catalog/items/:id: also returns hidden and retired items, so old designs can still render them.
  @Get('v1/catalog/items/:id')
  async getItem(@Req() req: Request, @Res() res: Response) {
    const id = req.params.id as string;
    const cat = await publishedCatalog();
    const known = cat.byID.get(id);
    if (known) return ok(res, 200, itemOut(known));
    const it = await findItem(await db(), id);
    if (!it) throw notFound('Catalog item');
    ok(res, 200, itemOut(it));
  }

  // GET /v1/room-types
  @Get('v1/room-types')
  async listRoomTypes(@Res() res: Response) {
    const s = await db();
    const types = await s.roomTypes.find({}, { sort: { sortOrder: 1 } }).toArray();
    res.setHeader('Cache-Control', 'public, max-age=300');
    ok(res, 200, types.map(roomTypeOut));
  }
}
