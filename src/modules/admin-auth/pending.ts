// How many changes the next catalog publish would make, for the dashboard. Mirrors the Go
// API's pendingChanges (admin_catalog.go): items compared in their API (JSON) form.

import { diffJSON } from '../../core/admin';
import type { Store } from '../../db/mongo';
import { categoryOut, itemOut } from '../../db/models';
import { latestCatalog } from '../../db/store';

export async function pendingChangeCount(s: Store): Promise<number> {
  const pubV = await latestCatalog(s);
  const published = new Map<string, any>();
  for (const it of pubV?.items ?? []) published.set(it._id, it);
  const items = await s.items.find({}, { sort: { sortOrder: 1, _id: 1 } }).toArray();

  let added = 0;
  let changed = 0;
  let removed = 0;
  const live = new Set<string>();
  for (const it of items) {
    if (it.retiredAt) continue;
    live.add(it._id);
    const pub = published.get(it._id);
    if (!pub) added++;
    else if (diffJSON(itemOut(pub), itemOut(it))) changed++;
  }
  const pubCats: any[] = pubV?.categories ?? [];
  for (const it of pubV?.items ?? []) if (!live.has(it._id)) removed++;

  const cats = await s.categories.find({}, { sort: { sortOrder: 1, _id: 1 } }).toArray();
  const pubCatByID = new Map(pubCats.map((c) => [c._id, c]));
  let categoriesChanged = 0;
  for (const c of cats) {
    const pc = pubCatByID.get(c._id);
    if (!pc || diffJSON(categoryOut(pc), categoryOut(c))) categoriesChanged++;
  }
  const order = cats.map((c) => c._id).join('\u0000');
  const pubOrder = pubCats.map((c) => c._id).join('\u0000');
  if (categoriesChanged === 0 && order !== pubOrder) categoriesChanged = 1; // "(order)"
  return added + changed + removed + categoriesChanged;
}
