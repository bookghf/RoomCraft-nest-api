// Parity test for the back office plans, room types, designs, users and shares routes.
//
//   GOAPI=... NEST_DIST=.build-admin-support test/parity/pair.sh admin-support 9104 9204
//   node test/parity/admin-support.mjs
//
// Loads identical fixtures into both databases, runs every route against both servers
// and compares the responses, then compares the audit log entries both servers wrote.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Pair, staffToken } from './lib.mjs';

const GO_DB = 'parity_admin-support_go';
const NEST_DB = 'parity_admin-support_nest';
const p = new Pair(9104, 9204);

const mongosh = (script, input) =>
  execFileSync('docker', ['exec', '-i', 'rc-parity-mongo', 'mongosh', '--quiet', '--eval', script, ...(input ? ['--file', '/dev/stdin'] : [])], {
    input, encoding: 'utf8',
  });

// ---- Fixtures and tokens ----

const fixtures = readFileSync(new URL('./admin-support-fixtures.js', import.meta.url), 'utf8');
execFileSync('docker', ['exec', '-i', 'rc-parity-mongo', 'sh', '-c', 'cat > /tmp/admin-support-fixtures.js'], { input: fixtures });
mongosh(`const DBS=['${GO_DB}','${NEST_DB}']; load('/tmp/admin-support-fixtures.js')`);

const owner = (dbName) => JSON.parse(mongosh(`const s=db.getSiblingDB('${dbName}').staff.findOne({email:'owner@parity.local'}); print(JSON.stringify({id:s._id, ver:s.tokenVersion}))`));
const og = owner(GO_DB), on = owner(NEST_DB);
const OWNER = { go: { t: await staffToken(og.id, og.ver) }, nest: { t: await staffToken(on.id, on.ver) } };
const tok = async (id) => 'Bearer ' + (await staffToken(id, 0));
const VIEWER = await tok('stf_viewer');
const SUPPORT = await tok('stf_support');
const CATMGR = await tok('stf_catmgr');
const NEWBIE = await tok('stf_newbie');

const asOwner = (extra = {}) => ({ headers: { Authorization: 'Bearer ${t}' }, vars: OWNER, ...extra });
const as = (auth, extra = {}) => ({ headers: { Authorization: auth }, ...extra });

// ---- Plans ----

const unitSpec = (id, extra = {}) => ({
  id, name: { en: 'Test unit', th: 'ทดสอบ', zh: '测试' }, area: 31.5,
  zones: [{ id: 'room', kind: 'room', name: { en: 'Room' }, polygon: [[0, 0], [5, 0], [5, 6], [0, 6]] }],
  openings: [{ type: 'door', at: [1, 0], width: 0.9 }, { type: 'window', at: [5, 3], width: 1.2, height: 1.2, sill: 0.9 }],
  fixtures: [{ id: 'f1', type: 'sink', x: 1, z: 1, rot: 0, w: 0.5, d: 0.5, h: 0.9 }],
  ceiling: 2.7, ...extra,
});
const showroomSpec = (id, extra = {}) => unitSpec(id, {
  showroom: {
    type: 'bedroom', description: { en: 'Calm', th: 'สงบ', zh: '平静' }, thumbnail: 'linear-gradient(135deg,#fff,#000)',
    floor: { material: 'wood', color: '#c9a77c' }, wall: { material: 'paint', color: '#ede8e0' },
    items: [{ itemId: 'bed-double', colorId: 'oak', x: 1, z: 1, rot: 0 }, { itemId: 'wardrobe', x: 2, z: 2, rot: 1.5 }],
  },
  ...extra,
});

await p.same('GET', '/v1/admin/plans', { label: 'plans: no token' });
await p.same('GET', '/v1/admin/plans', as('Bearer junk', { label: 'plans: bad token' }));
await p.same('GET', '/v1/admin/plans', as(NEWBIE, { label: 'plans: password change required' }));
await p.same('GET', '/v1/admin/plans', as(VIEWER, { label: 'plans: viewer' }));
await p.same('GET', '/v1/admin/plans', asOwner({ label: 'plans: owner' }));
await p.same('GET', '/v1/admin/plans?kind=showroom', asOwner());
await p.same('GET', '/v1/admin/plans?roomType=bedroom', asOwner());
await p.same('GET', '/v1/admin/plans?kind=nope', asOwner());
await p.same('GET', '/v1/admin/plans/1br-30/versions', asOwner());
await p.same('GET', '/v1/admin/plans/bedroom-calm/versions', as(SUPPORT));
await p.same('GET', '/v1/admin/plans/nope/versions', asOwner());

await p.same('POST', '/v1/admin/plans', as(VIEWER, { body: { kind: 'unit', spec: unitSpec('x') }, label: 'publish: viewer forbidden' }));
await p.same('POST', '/v1/admin/plans', asOwner({ raw: '{', headers: { Authorization: 'Bearer ${t}', 'Content-Type': 'application/json' }, label: 'publish: broken JSON', ignore: ['error.message'] }));
await p.same('POST', '/v1/admin/plans', asOwner({ label: 'publish: empty body' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: {}, label: 'publish: everything missing' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'unit', spec: 'x' }, label: 'publish: spec wrong type', ignore: ['error.message'] }));
await p.same('POST', '/v1/admin/plans', asOwner({
  label: 'publish: many errors',
  body: { kind: 'villa', spec: unitSpec('bad id!', { name: { th: 'x' }, ceiling: 3.5, resizable: { w: 4, d: 4 },
    zones: [{ id: 'z', polygon: [[0, 0], [1, 1]] }, { id: 'z2', polygon: [[0, 0], [500, 0], [0, 3]] }] }) },
}));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'unit', spec: unitSpec('t', { zones: [] }) }, label: 'publish: no zones' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'empty', spec: unitSpec('t') }, label: 'publish: empty without resizable' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'unit', spec: showroomSpec('t') }, label: 'publish: unit with showroom' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'showroom', spec: unitSpec('t') }, label: 'publish: showroom without showroom' }));
await p.same('POST', '/v1/admin/plans', asOwner({
  label: 'publish: showroom bad room type, item and surfaces',
  body: { kind: 'showroom', roomType: 'castle', spec: showroomSpec('t-show', { showroom: {
    type: 'bedroom', description: {}, thumbnail: '', floor: { material: 'lava', color: '#fff' }, wall: { material: 'paint', color: 'red' },
    items: [{ itemId: 'bed-double', x: 0, z: 0, rot: 0 }, { itemId: 'no-such-item', x: 0, z: 0, rot: 0 }] } }) },
}));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'unit', spec: unitSpec('test-unit'), notes: '  first  ' }, label: 'publish: new unit v1' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'unit', roomType: 'kids', spec: unitSpec('test-unit', { area: null, open: [[[0, 0], [1, 0]]] }) }, label: 'publish: unit v2' }));
await p.same('POST', '/v1/admin/plans', asOwner({ body: { kind: 'showroom', spec: showroomSpec('test-unit') }, label: 'publish: kind mismatch' }));
await p.same('POST', '/v1/admin/plans', as(CATMGR, { body: { kind: 'showroom', spec: showroomSpec('test-show'), notes: 'by cat manager' }, label: 'publish: showroom (room type from spec)' }));
await p.same('POST', '/v1/admin/plans', asOwner({
  body: { kind: 'empty', spec: unitSpec('test-empty', { resizable: { w: 4, d: 4 }, area: null }) }, label: 'publish: empty room',
}));
await p.same('GET', '/v1/admin/plans', asOwner({ label: 'plans after publishing' }));
await p.same('GET', '/v1/admin/plans/test-unit/versions', asOwner());

await p.same('POST', '/v1/admin/plans/1br-30/archive', as(VIEWER, { label: 'archive: viewer forbidden' }));
await p.same('POST', '/v1/admin/plans/1br-30/archive', asOwner());
await p.same('POST', '/v1/admin/plans/nope/archive', asOwner());
await p.same('GET', '/v1/admin/plans?kind=unit', asOwner({ label: 'plans: archived shows archivedAt' }));
await p.same('GET', '/v1/admin/plans/1br-30/versions', asOwner({ label: 'versions: archived' }));
await p.same('POST', '/v1/admin/plans/1br-30/restore', asOwner());
await p.same('POST', '/v1/admin/plans/nope/restore', asOwner());
await p.same('GET', '/v1/admin/plans?kind=unit', asOwner({ label: 'plans: restored' }));

// ---- Room types ----

const rtBody = (extra = {}) => ({ name: { en: 'Studio', th: 'สตูดิโอ', zh: '工作室' }, blurb: { en: 'Small and smart' }, gradient: ' linear-gradient(135deg,#111,#222) ', sortOrder: 9, ...extra });
await p.same('GET', '/v1/admin/room-types', as(VIEWER, { label: 'room types: viewer' }));
await p.same('GET', '/v1/admin/room-types', asOwner({ label: 'room types: owner' }));
await p.same('PUT', '/v1/admin/room-types/studio', as(SUPPORT, { body: rtBody(), label: 'put room type: support forbidden' }));
await p.same('PUT', '/v1/admin/room-types/bad.id', asOwner({ body: rtBody(), label: 'put room type: bad id' }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ label: 'put room type: empty body' }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ body: { name: { en: ' ', th: 'x' }, gradient: 'url(x)' }, label: 'put room type: invalid' }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ body: rtBody({ gradient: 'linear-gradient(1deg,#000);x' }), label: 'put room type: gradient with ;' }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ body: rtBody({ sortOrder: 'x' }), label: 'put room type: sortOrder wrong type', ignore: ['error.message'] }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ body: rtBody(), label: 'put room type: create' }));
await p.same('PUT', '/v1/admin/room-types/studio', asOwner({ body: rtBody({ blurb: undefined, gradient: '', sortOrder: 2 }), label: 'put room type: update, no blurb' }));
await p.same('PUT', '/v1/admin/room-types/bedroom', as(CATMGR, { body: rtBody({ name: { en: 'Bedroom', th: 'ห้องนอน', zh: '卧室' } }), label: 'put room type: update seeded' }));
await p.same('GET', '/v1/admin/room-types', asOwner({ label: 'room types after put' }));
await p.same('DELETE', '/v1/admin/room-types/bedroom', asOwner({ label: 'delete room type: in use' }));
await p.same('DELETE', '/v1/admin/room-types/kids', asOwner({ label: 'delete room type: used by test-unit v2 roomType' }));
await p.same('DELETE', '/v1/admin/room-types/studio', as(VIEWER, { label: 'delete room type: viewer forbidden' }));
await p.same('DELETE', '/v1/admin/room-types/studio', asOwner({ label: 'delete room type' }));
await p.same('DELETE', '/v1/admin/room-types/studio', asOwner({ label: 'delete room type: gone' }));

// ---- Designs ----

for (const qs of ['', '?deleted=include', '?deleted=only', '?owner=alice', '?planId=1br-30', '?q=special', '?q=%5Bspecial%5D', '?q=d-b1',
  '?q=ALICE', '?page=2&pageSize=2', '?pageSize=500', '?page=-1&pageSize=0', '?deleted=include&owner=alice&page=1&pageSize=2']) {
  await p.same('GET', '/v1/admin/designs' + qs, as(SUPPORT));
}
await p.same('GET', '/v1/admin/designs', as(VIEWER, { label: 'designs: viewer forbidden' }));
await p.same('GET', '/v1/admin/designs/d-a1', asOwner());
await p.same('GET', '/v1/admin/designs/d-a2', as(SUPPORT));
await p.same('GET', '/v1/admin/designs/d-a3', asOwner({ label: 'design: soft-deleted' }));
await p.same('GET', '/v1/admin/designs/d-c1', asOwner({ label: 'design: plan version missing' }));
await p.same('GET', '/v1/admin/designs/nope', asOwner());
await p.same('GET', '/v1/admin/designs/d-a1', as(CATMGR, { label: 'design: catalog manager forbidden' }));

// ---- Residents ----

for (const qs of ['', '?q=al', '?q=AL', '?q=zz', '?page=2&pageSize=1', '?pageSize=2']) {
  await p.same('GET', '/v1/admin/users' + qs, as(SUPPORT));
}
await p.same('GET', '/v1/admin/users', as(VIEWER, { label: 'users: viewer forbidden' }));
await p.same('GET', '/v1/admin/users/alice', asOwner());
await p.same('GET', '/v1/admin/users/bob', as(SUPPORT));
await p.same('GET', '/v1/admin/users/carol', asOwner());
await p.same('GET', '/v1/admin/users/dave', asOwner({ label: 'user: preferences only' }));
await p.same('GET', '/v1/admin/users/nobody', asOwner({ label: 'user: unknown' }));
await p.same('GET', '/v1/admin/users/alice/export', asOwner());
await p.same('GET', '/v1/admin/users/nobody/export', as(SUPPORT, { label: 'export: unknown resident' }));
await p.same('DELETE', '/v1/admin/users/carol', as(SUPPORT, { body: { confirm: 'carol' }, label: 'delete user: support forbidden' }));
await p.same('DELETE', '/v1/admin/users/carol', asOwner({ label: 'delete user: no body' }));
await p.same('DELETE', '/v1/admin/users/carol', asOwner({ body: { confirm: 'Carol' }, label: 'delete user: wrong confirm' }));
await p.same('DELETE', '/v1/admin/users/carol', asOwner({ body: { confirm: 'carol' }, label: 'delete user' }));
await p.same('DELETE', '/v1/admin/users/carol', asOwner({ body: { confirm: 'carol' }, label: 'delete user: again' }));
await p.same('GET', '/v1/admin/users/carol', asOwner({ label: 'user: after delete' }));
await p.same('GET', '/v1/admin/users', asOwner({ label: 'users: after delete' }));

// ---- Share links ----

for (const qs of ['', '?status=active', '?status=revoked', '?status=expired', '?status=bogus', '?owner=alice', '?owner=bob&status=active', '?page=2&pageSize=2']) {
  await p.same('GET', '/v1/admin/shares' + qs, as(SUPPORT));
}
await p.same('GET', '/v1/admin/shares', as(VIEWER, { label: 'shares: viewer forbidden' }));
await p.same('POST', '/v1/admin/shares/shACT001/revoke', as(VIEWER, { label: 'revoke: viewer forbidden' }));
await p.same('POST', '/v1/admin/shares/shACT001/revoke', as(SUPPORT));
await p.same('POST', '/v1/admin/shares/shACT001/revoke', asOwner({ label: 'revoke: already revoked' }));
await p.same('POST', '/v1/admin/shares/shREV001/revoke', asOwner({ label: 'revoke: revoked before' }));
await p.same('POST', '/v1/admin/shares/nope/revoke', asOwner());
await p.same('GET', '/v1/admin/shares?status=revoked', asOwner({ label: 'shares: revoked after revoke' }));
await p.same('GET', '/v1/admin/users/alice', asOwner({ label: 'user: after revoke' }));

// ---- Audit log written by both servers ----

const auditOf = (dbName) => JSON.parse(mongosh(
  `print(JSON.stringify(db.getSiblingDB('${dbName}').auditLog.find({}, {_id:0, at:0, ip:0}).sort({at:1}).toArray()))`,
)).map((e) => ({ ...e, actorId: e.actorEmail === 'owner@parity.local' ? '<owner>' : e.actorId,
  summary: e.summary, changes: e.changes ? Object.fromEntries(Object.keys(e.changes).sort().map((k) => [k, e.changes[k]])) : undefined }));
const ag = auditOf(GO_DB), an = auditOf(NEST_DB);
const normTime = (o) => JSON.parse(JSON.stringify(o).replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<time>"'));
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const a = JSON.stringify(sortKeys(normTime(ag))), b = JSON.stringify(sortKeys(normTime(an)));
if (a === b) {
  p.passed++;
  console.log(`audit log: ${ag.length} entries match`);
} else {
  const problems = [];
  for (let i = 0; i < Math.max(ag.length, an.length); i++) {
    const x = JSON.stringify(sortKeys(normTime(ag[i]))), y = JSON.stringify(sortKeys(normTime(an[i])));
    if (x !== y) problems.push(`#${i} go=${x}\n      nest=${y}`);
  }
  p.failures.push({ label: `audit log (go ${ag.length}, nest ${an.length})`, problems: problems.slice(0, 8) });
}

p.report();
