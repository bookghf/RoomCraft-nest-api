// Parity test for the public and resident routes.
//   GOAPI=... NEST_DIST=.build-public test/parity/pair.sh public 9101 9201
//   node test/parity/public.mjs
import { Pair, residentToken } from './lib.mjs';

const p = new Pair(Number(process.env.GO_PORT ?? 9101), Number(process.env.NEST_PORT ?? 9201));
const A = { 'X-Dev-User': 'alice' };
const B = { 'X-Dev-User': 'bob' };
const C = { 'X-Dev-User': 'carol' };
const JSON_MSG = ['error.message']; // JSON parser messages differ between Go and Node

const content = (extra = {}) => ({
  items: [
    { uid: 'a', itemId: 'bed-double', colorId: 'oak', x: 1, y: 0, z: 1, rot: 0 },
    { uid: 'b', itemId: 'bed-double', colorId: 'oak', x: 2, y: 0, z: 1, rot: 1.5 },
    { uid: 'c', itemId: 'armchair', colorId: '', x: -1, y: 0, z: 2, rot: 0, wallId: 'w1', side: -1, locked: true },
  ],
  floor: { material: 'wood', color: '#c9a77c' },
  wall: { material: 'paint', color: '#ede8e0' },
  ceiling: 2.6,
  ...extra,
});

// ---- Catalog, room types, plans ----
const cat = await p.same('GET', '/v1/catalog');
const version = cat.go.json.data.version;
await p.same('GET', '/v1/catalog', { headers: { 'If-None-Match': `"${version}"` } });
await p.same('GET', '/v1/catalog', { headers: { 'If-None-Match': '"old"' } });
for (const qs of ['', '?category=bedroom', '?mount=wall', '?q=bed', '?q=%E0%B9%80%E0%B8%95%E0%B8%B5%E0%B8%A2%E0%B8%87', '?q=BED',
  '?maxPrice=5000', '?maxPrice=5000.5', '?maxPrice=abc', '?maxPrice=-1', '?maxPrice=1e3', '?includeHidden=true', '?limit=5',
  '?limit=5&cursor=5', '?cursor=999', '?cursor=-3', '?limit=0', '?limit=1000', '?category=nope', '?q=zzz']) {
  await p.same('GET', '/v1/catalog/items' + qs);
}
await p.same('GET', '/v1/catalog/items/bed-double');
await p.same('GET', '/v1/catalog/items/nope');
await p.same('GET', '/v1/room-types');

const plans = await p.same('GET', '/v1/plans');
const planIds = plans.go.json.data.map((x) => x.id);
for (const qs of ['?kind=showroom', '?kind=unit', '?kind=empty', '?roomType=bedroom', '?kind=nope']) await p.same('GET', '/v1/plans' + qs);
for (const id of planIds) {
  await p.same('GET', `/v1/plans/${id}`);
  await p.same('GET', `/v1/plans/${id}/versions/1`);
}
await p.same('GET', '/v1/plans/nope');
await p.same('GET', `/v1/plans/${planIds[0]}/versions/0`);
await p.same('GET', `/v1/plans/${planIds[0]}/versions/abc`);
await p.same('GET', `/v1/plans/${planIds[0]}/versions/2`);
const resizable = plans.go.json.data.find((x) => x.resizable)?.id ?? 'empty';
const unit = plans.go.json.data.find((x) => x.kind === 'unit')?.id ?? planIds[1];

// ---- Auth ----
await p.same('GET', '/v1/designs');
await p.same('GET', '/v1/designs', { headers: { Authorization: 'Bearer ' + await residentToken('tok-user') } });
await p.same('GET', '/v1/designs', { headers: { Authorization: 'Bearer ' + await residentToken('tok-user', { secret: 'wrong' }) } });
await p.same('GET', '/v1/designs', { headers: { Authorization: 'Bearer ' + await residentToken('') } });

// ---- Designs ----
const body = (o = {}) => ({ name: 'My room', planId: unit, content: content(), ...o });
await p.same('PUT', '/v1/designs/d1', { headers: A, body: body() });
await p.same('PUT', '/v1/designs/d1', { headers: A, body: body() }); // 428
await p.same('PUT', '/v1/designs/d1', { headers: { ...A, 'If-Match': '"v1"' }, body: body({ name: '  Renamed room  ' }) });
await p.same('PUT', '/v1/designs/d1', { headers: { ...A, 'If-Match': '"v1"' }, body: body() }); // 409 conflict
await p.same('PUT', '/v1/designs/d1', { headers: { ...A, 'If-Match': 'abc' }, body: body() });
await p.same('PUT', '/v1/designs/d1', { headers: { ...A, 'If-Match': 'W/"v2"' }, body: body({ name: 'Weak etag' }) });
await p.same('PUT', '/v1/designs/d1', { headers: B, body: body() }); // ID_TAKEN
await p.same('PUT', '/v1/designs/bad%20id', { headers: A, body: body() });
await p.same('PUT', '/v1/designs/' + 'x'.repeat(65), { headers: A, body: body() });
await p.same('PUT', '/v1/designs/d9', { headers: A, raw: '{bad json', ignore: JSON_MSG });
await p.same('PUT', '/v1/designs/d9', { headers: A, raw: '' });
await p.same('PUT', '/v1/designs/d9', { headers: A, raw: '[]', ignore: JSON_MSG });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ name: 5 }), ignore: JSON_MSG });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ name: '' }) });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ name: 'x'.repeat(61) }) });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ name: 'ห้อง'.repeat(15) }) });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ planId: 'nope' }) });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ planVersion: 99 }) });
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ name: '', planId: 'nope' }) });
await p.same('PUT', '/v1/designs/d9', {
  headers: A,
  body: body({
    name: '',
    content: {
      items: [
        { uid: 'a', itemId: 'bed double', colorId: 'x'.repeat(65), x: 101, y: 0, z: 0, rot: 0 },
        { uid: 'a', itemId: 'bed-double', colorId: '', x: 0, y: 3.5, z: 0, rot: 200, side: 2, on: 'zz' },
        { uid: '', itemId: 'bed-double', colorId: '', x: 0, y: -1, z: 0, rot: 0, on: '' },
        { uid: 'self', itemId: 'bed-double', colorId: '', x: 0, y: 0, z: 0, rot: 0, on: 'self' },
      ],
      floor: { material: 'lava', color: 'red' },
      wall: { material: 'glass', color: '#12' },
      ceiling: 5,
    },
  }),
});
await p.same('PUT', '/v1/designs/d9', { headers: A, body: body({ planId: resizable, content: content({ size: { w: 1, d: 20 } }) }) });
await p.same('PUT', '/v1/designs/d8', { headers: A, body: body({ planId: resizable, content: content({ size: { w: 3, d: 4 } }) }) });
await p.same('PUT', '/v1/designs/d7', { headers: A, body: body({ content: content({ size: { w: 3, d: 4 } }) }) }); // size dropped
await p.same('PUT', '/v1/designs/d6', {
  headers: A,
  body: body({ content: content({ items: [
    { uid: 'a', itemId: 'not-in-catalog', colorId: '', x: 0, y: 0, z: 0, rot: 0 },
    { uid: 'b', itemId: 'not-in-catalog', colorId: '', x: 0, y: 0, z: 0, rot: 0 },
    { uid: 'c', itemId: 'bed-double', colorId: 'purple', x: 0, y: 0, z: 0, rot: 0 },
    { uid: 'd', itemId: 'bed-double', colorId: 'purple', x: 0, y: 0, z: 0, rot: 0, on: 'c' },
  ] }) }),
});
await p.same('GET', '/v1/designs/d1', { headers: A });
await p.same('GET', '/v1/designs/d1', { headers: B });
await p.same('GET', '/v1/designs/d1/quote', { headers: A });
await p.same('GET', '/v1/designs/d6/quote', { headers: A });
await p.same('GET', '/v1/designs/nope/quote', { headers: A });

// paging: cursors encode each server's own timestamps
await p.same('GET', '/v1/designs', { headers: A });
const page1 = await p.same('GET', '/v1/designs?limit=2', { headers: A, ignore: ['data.nextCursor'] });
const cur = { go: { c: page1.go.json.data.nextCursor }, nest: { c: page1.nest.json.data.nextCursor } };
const page2 = await p.same('GET', '/v1/designs?limit=2&cursor=:c', { headers: A, vars: cur, ignore: ['data.nextCursor'] });
const cur2 = { go: { c: page2.go.json.data.nextCursor }, nest: { c: page2.nest.json.data.nextCursor } };
await p.same('GET', '/v1/designs?limit=2&cursor=:c', { headers: A, vars: cur2, ignore: ['data.nextCursor'] });
await p.same('GET', '/v1/designs?cursor=!!!', { headers: A });
await p.same('GET', '/v1/designs?cursor=YWJj', { headers: A });
await p.same('GET', '/v1/designs?cursor=YWJjOmQ', { headers: A });
await p.same('GET', '/v1/designs?limit=0', { headers: A });

// rename
await p.same('PATCH', '/v1/designs/d1', { headers: A, body: { name: 'New name' } });
await p.same('PATCH', '/v1/designs/d1', { headers: { ...A, 'If-Match': '"v1"' }, body: { name: 'Stale' } });
await p.same('PATCH', '/v1/designs/d1', { headers: { ...A, 'If-Match': '"v4"' }, body: { name: 'Fresh' } });
await p.same('PATCH', '/v1/designs/d1', { headers: A, body: { name: ' ' } });
await p.same('PATCH', '/v1/designs/nope', { headers: A, body: { name: 'X' } });
await p.same('PATCH', '/v1/designs/d1', { headers: B, body: { name: 'X' } });

// duplicate (new random ids)
const dupIgnore = ['data.id'];
await p.same('POST', '/v1/designs/d1/duplicate', { headers: A, ignore: dupIgnore });
await p.same('POST', '/v1/designs/d1/duplicate', { headers: A, body: { name: 'Second copy' }, ignore: dupIgnore });
await p.same('POST', '/v1/designs/d1/duplicate', { headers: A, body: { name: '' }, ignore: dupIgnore });
await p.same('POST', '/v1/designs/d8/duplicate', { headers: A, body: { name: 'y'.repeat(70) }, ignore: dupIgnore });
await p.same('POST', '/v1/designs/nope/duplicate', { headers: A });

// delete and replace a deleted design
await p.same('DELETE', '/v1/designs/d7', { headers: A });
await p.same('DELETE', '/v1/designs/d7', { headers: A });
await p.same('GET', '/v1/designs/d7', { headers: A });
await p.same('PUT', '/v1/designs/d7', { headers: A, body: body({ name: 'Back again' }) });

// ---- Drafts ----
await p.same('GET', '/v1/drafts', { headers: A });
for (let i = 1; i <= 12; i++) {
  await p.same('PUT', `/v1/drafts/dr${i}`, { headers: A, body: { planId: unit, content: content(), designId: i === 3 ? 'd1' : '' } });
}
await p.same('GET', '/v1/drafts', { headers: A });
await p.same('PUT', '/v1/drafts/dr12', { headers: B, body: { planId: unit, content: content() } }); // ID_TAKEN
await p.same('PUT', '/v1/drafts/bad id', { headers: A, body: { planId: unit, content: content() } });
await p.same('PUT', '/v1/drafts/dr20', { headers: A, body: { planId: unit, designId: 'bad id', content: content() } });
await p.same('PUT', '/v1/drafts/dr20', { headers: A, body: { planId: 'nope', content: content() } });
await p.same('PUT', '/v1/drafts/dr20', { headers: A, body: { planId: unit, content: content({ ceiling: 9 }) } });
await p.same('PUT', '/v1/drafts/dr20', { headers: A, raw: '' });
await p.same('DELETE', '/v1/drafts/dr12', { headers: A });
await p.same('DELETE', '/v1/drafts/dr12', { headers: A });
// saving a design removes its drafts and the given draftId
await p.same('PUT', '/v1/designs/d1', { headers: { ...A, 'If-Match': '"v5"' }, body: body({ draftId: 'dr11' }) });
await p.same('GET', '/v1/drafts', { headers: A });

// ---- Me ----
await p.same('GET', '/v1/me/preferences', { headers: C });
await p.same('GET', '/v1/me/recent-items', { headers: C });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: { lang: 'th' } });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: { lang: 'xx' } });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: { lang: '' } });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: { measure: { item: false, room: true } } });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: {} });
await p.same('PUT', '/v1/me/preferences', { headers: C, body: { lang: 1 }, ignore: JSON_MSG });
for (const id of ['bed-double', 'armchair', 'bed-double', ...Array.from({ length: 13 }, (_, i) => `item-${i}`)]) {
  await p.same('POST', '/v1/me/recent-items', { headers: C, body: { itemId: id } });
}
await p.same('POST', '/v1/me/recent-items', { headers: C, body: { itemId: 'bad id' } });
await p.same('POST', '/v1/me/recent-items', { headers: C, body: {} });
await p.same('GET', '/v1/me/recent-items', { headers: C });
await p.same('GET', '/v1/me/preferences', { headers: C });

// import (dave has nothing yet)
const D = { 'X-Dev-User': 'dave' };
const local = (id, o = {}) => ({ id, planId: unit, name: `Local ${id}`, ...content(), updatedAt: '2026-01-02T03:04:05.123456Z', ...o });
const importBody = {
  designs: [local('L1'), local('L2', { updatedAt: 'not a time' }), local('bad id'), local('L3', { name: '' }), local('L4', { planId: 'nope' }),
    local('L5', { ceiling: 9 }), local('L6', { updatedAt: '2026-05-06T07:08:09+07:00' })],
  recent: [
    { id: 'R1', savedId: 'L1', doc: local('x') },
    { id: 'R2', doc: local('y', { updatedAt: '' }) },
    { id: 'R3', savedId: 'bad id', doc: local('z') },
    { id: 'bad id', doc: local('w') },
  ],
  recentItems: ['bed-double', 'bad id', 'armchair'],
};
await p.same('POST', '/v1/me/import', { headers: D, body: importBody });
await p.same('POST', '/v1/me/import', { headers: D, body: importBody }); // all skipped
await p.same('POST', '/v1/me/import', { headers: D, body: { designs: Array.from({ length: 201 }, (_, i) => local(`T${i}`)) } });
await p.same('POST', '/v1/me/import', { headers: C, body: { recentItems: ['x1'] } }); // carol already has items
await p.same('POST', '/v1/me/import', { headers: { 'X-Dev-User': 'erin' }, body: {} });
await p.same('GET', '/v1/designs', { headers: D });
await p.same('GET', '/v1/designs/L1', { headers: D });
await p.same('GET', '/v1/drafts', { headers: D });
await p.same('GET', '/v1/me/recent-items', { headers: D });
await p.same('GET', '/v1/me/recent-items', { headers: { 'X-Dev-User': 'erin' } });
await p.same('GET', '/v1/me/export', { headers: D });
await p.same('GET', '/v1/me/export', { headers: { 'X-Dev-User': 'nobody' } });

// ---- Shares ----
const shareIgnore = ['data.code', 'data.url'];
const shareBody = (o = {}) => ({ planId: unit, content: content(), designId: 'L1', imageUrl: 'https://img.test/a.png', ...o });
const s1 = await p.same('POST', '/v1/shares', { headers: D, body: shareBody(), ignore: shareIgnore });
const s2 = await p.same('POST', '/v1/shares', { body: shareBody({ designId: '', imageUrl: '' }), ignore: shareIgnore });
await p.same('POST', '/v1/shares', { body: shareBody({ imageUrl: 'http://img.test/a.png', designId: 'bad id' }) });
await p.same('POST', '/v1/shares', { body: shareBody({ imageUrl: 'HTTPS://img.test/a.png' }), ignore: shareIgnore });
await p.same('POST', '/v1/shares', { body: shareBody({ imageUrl: 'https://x.test/' + 'a'.repeat(1100) }) });
await p.same('POST', '/v1/shares', { body: shareBody({ planId: 'nope' }) });
await p.same('POST', '/v1/shares', { body: shareBody({ content: content({ ceiling: 1 }) }) });
const codes1 = { go: { c: s1.go.json.data.code }, nest: { c: s1.nest.json.data.code } };
const codes2 = { go: { c: s2.go.json.data.code }, nest: { c: s2.nest.json.data.code } };
for (const [r, u] of [[s1, 'go'], [s1, 'nest']]) {
  if (!r[u].json.data.url.endsWith(`/designer/${unit}?share=${r[u].json.data.code}`)) p.failures.push({ label: `${u} share url`, problems: [r[u].json.data.url] });
}
await p.same('GET', '/v1/shares/:c', { vars: codes1, ignore: ['data.code'] });
await p.same('GET', '/v1/shares/:c', { vars: codes1, ignore: ['data.code'] });
await p.same('GET', '/v1/shares/:c', { vars: codes2, ignore: ['data.code'] });
await p.same('GET', '/v1/shares/nope');
await p.same('DELETE', '/v1/shares/:c', { vars: codes2, headers: D }); // not dave's
await p.same('DELETE', '/v1/shares/:c', { vars: codes1 }); // signed out
await p.same('DELETE', '/v1/shares/:c', { vars: codes1, headers: D });
await p.same('DELETE', '/v1/shares/:c', { vars: codes1, headers: D });
await p.same('GET', '/v1/shares/:c', { vars: codes1 });
await p.same('GET', '/v1/me/export', { headers: D, ignore: ['data.shares[].code'] });

// ---- Delete everything ----
await p.same('DELETE', '/v1/me', { headers: D });
await p.same('GET', '/v1/designs', { headers: D });
await p.same('GET', '/v1/me/export', { headers: D });
await p.same('DELETE', '/v1/me');

p.report();
