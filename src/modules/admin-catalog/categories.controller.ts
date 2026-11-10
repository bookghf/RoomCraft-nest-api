import { Controller, Delete, Get, Put, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Changes, audit } from '../../core/admin';
import { decode, int, obj, str, text } from '../../core/body';
import { fail, noContent, notFound, ok } from '../../core/envelope';
import { FieldErrors, checkID } from '../../core/validate';
import { PERM, requireStaff } from '../../auth/staff';
import { db } from '../../db/mongo';
import { Doc } from '../../db/models';
import { adminCategoryOut, allItems, categoriesSorted, diff, sortText } from './helpers';

@Controller('v1/admin/categories')
export class CategoriesController {
  // GET /v1/admin/categories: with the number of live items in each.
  @Get()
  async list(@Req() req: Request, @Res() res: Response) {
    await requireStaff(req, PERM.catalogRead);
    const s = await db();
    const cats = await categoriesSorted(s);
    const counts = new Map<string, number>();
    for (const it of await allItems(s)) {
      if (!it.retiredAt) counts.set(it.category, (counts.get(it.category) ?? 0) + 1);
    }
    ok(res, 200, cats.map((c) => adminCategoryOut(c, counts.get(c._id) ?? 0)));
  }

  // PUT /v1/admin/categories/:id {name, icon?, sortOrder}: create or update. The apps see it after a publish.
  @Put(':id')
  async put(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogWrite);
    const id = req.params.id as string;
    checkID('id', id);
    const o = obj(decode(req), 'body');
    const name = text(o, 'name', 'body');
    const icon = str(o, 'icon', 'body');
    const sortOrder = int(o, 'sortOrder', 'body');
    const errs = new FieldErrors();
    for (const lang of ['en', 'th', 'zh']) {
      if ((name[lang] ?? '').trim() === '') errs.add(`name.${lang}`, 'required');
    }
    errs.throwIfAny();
    const s = await db();
    const before = await s.categories.findOne({ _id: id });
    const c: Doc = { _id: id, name: sortText(name) };
    if (icon.trim()) c.icon = icon.trim();
    c.sortOrder = sortOrder;
    c.updatedAt = new Date();
    await s.categories.replaceOne({ _id: id }, c, { upsert: true });
    let action = 'catalog.category.create';
    let changes: Changes | null = null;
    if (before) {
      action = 'catalog.category.update';
      changes = diff(adminCategoryOut(before, 0), adminCategoryOut(c, 0));
    }
    await audit(req, actor, action, 'category', id, name.en ?? '', changes);
    ok(res, 200, adminCategoryOut(c, 0));
  }

  // DELETE /v1/admin/categories/:id: only when no item (even a retired one) uses it.
  @Delete(':id')
  async remove(@Req() req: Request, @Res() res: Response) {
    const actor = await requireStaff(req, PERM.catalogWrite);
    const id = req.params.id as string;
    const s = await db();
    const n = await s.items.countDocuments({ category: id });
    if (n > 0) throw fail(409, 'CATEGORY_IN_USE', `${n} items use this category. Move them first.`);
    const r = await s.categories.deleteOne({ _id: id });
    if (r.deletedCount === 0) throw notFound('Category');
    await audit(req, actor, 'catalog.category.delete', 'category', id, 'Deleted category ' + id);
    noContent(res);
  }
}
