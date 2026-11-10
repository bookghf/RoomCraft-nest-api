// Parity test for the back office catalog routes (admin_catalog.go).
//
//   GOAPI=... NEST_DIST=.build-admin-catalog test/parity/pair.sh admin-catalog 9103 9203
//   node test/parity/admin-catalog.mjs
//
// Gets an owner token on each server by clearing mustChangePassword on its seeded owner.

import { execFileSync } from 'node:child_process';
import { Pair, staffToken } from './lib.mjs';

const GO_DB = 'parity_admin-catalog_go';
const NEST_DB = 'parity_admin-catalog_nest';
const mongo = (js) => execFileSync('docker', ['exec', 'rc-parity-mongo', 'mongosh', '--quiet', '--eval', js]).toString().trim();

async function ownerToken(dbName) {
  const out = mongo(`const s=db.getSiblingDB(${JSON.stringify(dbName)}).staff;
    s.updateOne({}, {$set:{mustChangePassword:false}}); const st=s.findOne(); print(st._id + ' ' + (st.tokenVersion||0))`);
  const [id, ver] = out.split(' ');
  return staffToken(id, Number(ver));
}

const p = new Pair(9103, 9203);
const vars = { go: { tok: await ownerToken(GO_DB) }, nest: { tok: await ownerToken(NEST_DB) } };
const auth = { Authorization: 'Bearer ${tok}' };
// Fields that depend on the server: audit ids, the acting staff id, auto version names.
const ignore = ['data.updatedBy', 'data.items[].updatedBy', 'data.publishedBy', 'data[].publishedBy', 'data.summary.publishedBy'];
const req = (method, path, opts = {}) => p.same(method, path, { headers: auth, vars, ignore, ...opts });

const item = (over = {}) => ({
  id: 'test-lamp', category: 'lighting', mount: 'floor',
  name: { en: 'Test lamp', th: 'โคมทดสอบ', zh: '测试灯' },
  priceSatang: 123450, sku: 'TL-1', size: { w: 0.4, d: 0.4, h: 1.5 },
  colors: [{ id: 'black', hex: '#111111', name: { en: 'Black', th: 'ดำ', zh: '黑色' } }],
  model: { template: 'shape', params: { shape: 'lamp' } }, ...over,
});

// ---- Auth and permissions ----
await p.same('GET', '/v1/admin/catalog/items', { label: 'no token' });
await p.same('GET', '/v1/admin/catalog/items', { headers: { Authorization: 'Bearer junk' }, label: 'bad token' });

// ---- List ----
await req('GET', '/v1/admin/catalog/items');
await req('GET', '/v1/admin/catalog/items?page=2&pageSize=10');
await req('GET', '/v1/admin/catalog/items?pageSize=500&page=0');
await req('GET', '/v1/admin/catalog/items?category=bedroom');
await req('GET', '/v1/admin/catalog/items?q=BED');
await req('GET', '/v1/admin/catalog/items?q=เตียง');
await req('GET', '/v1/admin/catalog/items?state=published&pageSize=3');
await req('GET', '/v1/admin/catalog/items?state=new');

// ---- Get ----
await req('GET', '/v1/admin/catalog/items/bed-double');
await req('GET', '/v1/admin/catalog/items/nope');

// ---- Create: validation ----
await req('POST', '/v1/admin/catalog/items', { raw: '', label: 'create empty body' });
await req('POST', '/v1/admin/catalog/items', { raw: '{bad', label: 'create bad json', ignore: [...ignore, 'error.message'] });
await req('POST', '/v1/admin/catalog/items', { body: item({ id: 'bad id!' }), label: 'create bad id' });
await req('POST', '/v1/admin/catalog/items', { body: { id: 'x1' }, label: 'create all invalid' });
await req('POST', '/v1/admin/catalog/items', {
  body: item({ id: 'x2', category: 'nope', mount: 'wall', surface: true, priceSatang: -1, size: { w: 0, d: 11, h: 4 }, mountHeight: 9,
    colors: [{ id: 'a', hex: 'red', name: {} }, { id: 'a', hex: '#fff', name: { en: 'A' } }], model: {}, sku: 'BED-DBL' }),
  label: 'create many errors',
});
await req('POST', '/v1/admin/catalog/items', { body: item({ priceSatang: 'x' }), label: 'create wrong type', ignore: [...ignore, 'error.message'] });
await req('POST', '/v1/admin/catalog/items', { body: item({ priceSatang: 1.5 }), label: 'create float satang', ignore: [...ignore, 'error.message'] });
await req('POST', '/v1/admin/catalog/items', { body: item({ id: 'bed-double', sku: '' }), label: 'create duplicate id' });

// ---- Create, then list/get show it as new ----
await req('POST', '/v1/admin/catalog/items', { body: item({ price: 999, sortOrder: 5, mountHeight: 0 }), label: 'create ok' });
await req('POST', '/v1/admin/catalog/items', { body: item({ id: 'test-lamp-2', sku: 'TL-1' }), label: 'create sku taken' });
await req('GET', '/v1/admin/catalog/items/test-lamp');
await req('GET', '/v1/admin/catalog/items?state=new');

// ---- Update ----
await req('PUT', '/v1/admin/catalog/items/nope', { body: item(), label: 'update missing' });
await req('PUT', '/v1/admin/catalog/items/bed-double', { body: { category: 'nope' }, label: 'update invalid' });
const bed = (await p.both('GET', '/v1/admin/catalog/items/bed-double', { headers: auth, vars })).go.json.data;
const bedBody = { ...bed, priceSatang: 1099000, name: { ...bed.name, en: 'Double bed XL' }, hidden: true };
await req('PUT', '/v1/admin/catalog/items/bed-double', { body: bed, label: 'update unchanged' });
await req('PUT', '/v1/admin/catalog/items/bed-double', { body: bedBody, label: 'update changed' });
await req('GET', '/v1/admin/catalog/items/bed-double');
await req('GET', '/v1/admin/catalog/items?state=changed');

// ---- Retire / restore ----
await req('POST', '/v1/admin/catalog/items/sofa-3/retire');
await req('POST', '/v1/admin/catalog/items/sofa-3/retire', { label: 'retire again' });
await req('POST', '/v1/admin/catalog/items/test-lamp/retire', { label: 'retire unpublished' });
await req('POST', '/v1/admin/catalog/items/test-lamp/restore');
await req('POST', '/v1/admin/catalog/items/test-lamp/restore', { label: 'restore again' });
await req('POST', '/v1/admin/catalog/items/nope/retire', { label: 'retire missing' });
await req('GET', '/v1/admin/catalog/items?state=removing');

// ---- Categories ----
await req('GET', '/v1/admin/categories');
await req('PUT', '/v1/admin/categories/bad%20id', { body: { name: { en: 'x' } }, label: 'category bad id' });
await req('PUT', '/v1/admin/categories/outdoor', { body: { name: { en: 'Outdoor' } }, label: 'category missing names' });
await req('PUT', '/v1/admin/categories/outdoor', { body: { name: { zh: '户外', en: 'Outdoor', th: 'กลางแจ้ง' }, icon: '  sun ', sortOrder: 9 }, label: 'category create' });
await req('PUT', '/v1/admin/categories/outdoor', { body: { name: { en: 'Outdoors', th: 'กลางแจ้ง', zh: '户外' }, sortOrder: 2 }, label: 'category update' });
await req('PUT', '/v1/admin/categories/outdoor', { body: { name: { en: 'Outdoors' }, sortOrder: 'x' }, label: 'category wrong type', ignore: [...ignore, 'error.message'] });
await req('GET', '/v1/admin/categories');
await req('DELETE', '/v1/admin/categories/bedroom', { label: 'delete category in use' });
await req('DELETE', '/v1/admin/categories/nope', { label: 'delete missing category' });

// ---- Changes and publish ----
await req('GET', '/v1/admin/catalog/changes');
await req('POST', '/v1/admin/catalog/publish', { body: { version: 'bad version!' }, label: 'publish bad version' });
await req('POST', '/v1/admin/catalog/publish', { body: { version: 'v1', notes: 'x'.repeat(501) }, label: 'publish long notes' });
await req('POST', '/v1/admin/catalog/publish', { body: { version: '2026-10-29.2' }, label: 'publish existing version' });
await req('POST', '/v1/admin/catalog/publish', { body: { version: ' 2026-11-01.1 ', notes: '  First edit  ' }, label: 'publish ok' });
await req('POST', '/v1/admin/catalog/publish', { body: { version: '2026-11-01.9' }, label: 'publish no changes' });
await req('GET', '/v1/admin/catalog/changes', { label: 'changes after publish' });
await req('GET', '/v1/admin/catalog/items?state=removing', { label: 'removing after publish' });
await req('GET', '/v1/admin/catalog/items?state=retired', { label: 'retired after publish' });
await req('DELETE', '/v1/admin/categories/outdoor', { label: 'delete category' });

// Auto version name: compare shape, not the timestamp.
await req('PUT', '/v1/admin/categories/bath', { body: { name: { en: 'Bath', th: 'ห้องน้ำ', zh: '浴室' } }, label: 'category for auto publish' });
const auto = await p.both('POST', '/v1/admin/catalog/publish', { headers: auth, vars });
const autoOK = auto.go.status === 201 && auto.nest.status === 201 && /^\d{4}-\d\d-\d\d\.\d{6}$/.test(auto.nest.json.data.version)
  && auto.go.json.data.itemCount === auto.nest.json.data.itemCount;
if (autoOK) p.passed++;
else p.failures.push({ label: 'publish auto version', problems: [JSON.stringify(auto.go.json), JSON.stringify(auto.nest.json)] });
const autoVer = { go: auto.go.json.data.version, nest: auto.nest.json.data.version };

// ---- Versions ----
await req('GET', '/v1/admin/catalog/versions', { ignore: [...ignore, 'data[].version'] });
await req('GET', '/v1/admin/catalog/versions/2026-11-01.1');
await req('GET', '/v1/admin/catalog/versions/2026-10-29.2');
await req('GET', '/v1/admin/catalog/versions/nope');
await req('GET', '/v1/admin/catalog/versions/:v', { vars: { go: { ...vars.go, v: autoVer.go }, nest: { ...vars.nest, v: autoVer.nest } }, ignore: [...ignore, 'data.summary.version'], label: 'get auto version' });

// ---- Rollback ----
await req('POST', '/v1/admin/catalog/versions/nope/rollback', { body: { version: 'r1' }, label: 'rollback missing' });
await req('POST', '/v1/admin/catalog/versions/2026-10-29.2/rollback', { body: { version: '2026-11-01.1' }, label: 'rollback version exists' });
await req('POST', '/v1/admin/catalog/versions/2026-10-29.2/rollback', { body: { version: 'r-2' }, label: 'rollback ok' });
await req('POST', '/v1/admin/catalog/versions/2026-11-01.1/rollback', { body: { version: 'r-3', notes: 'Back again' }, label: 'rollback with notes' });
await req('GET', '/v1/admin/catalog/items?state=retired', { label: 'retired after rollback' });
await req('GET', '/v1/admin/catalog/items/sofa-3', { label: 'restored by rollback' });
await req('GET', '/v1/admin/catalog/changes', { label: 'changes after rollback' });
await req('GET', '/v1/admin/categories', { label: 'categories after rollback' });
await req('GET', '/v1/admin/catalog/versions', { ignore: [...ignore, 'data[].version'], label: 'versions after rollback' });

// ---- Public catalog reflects the publish (Go only; Nest public routes may not exist yet) ----
const pub = await p.send(p.go, 'GET', '/v1/catalog');
if (pub.status === 200 && pub.json.data.version === 'r-3') p.passed++;
else p.failures.push({ label: 'go public catalog after rollback', problems: [`status ${pub.status} version ${pub.json?.data?.version}`] });
const nestPub = await p.send(p.nest, 'GET', '/v1/catalog');
if (nestPub.status === 200) {
  if (nestPub.json.data.version === 'r-3') p.passed++;
  else p.failures.push({ label: 'nest public catalog after rollback', problems: [`version ${nestPub.json.data.version}`] });
}

// ---- Audit entries written ----
const auditOf = (d) => mongo(`print(JSON.stringify(db.getSiblingDB(${JSON.stringify(d)}).auditLog.find({}, {_id:0, at:0, ip:0, actorId:0}).sort({at:1}).toArray().map(e => [e.action, e.targetType, e.targetId, e.summary, Object.keys(e.changes||{}).sort().join(',')])))`);
const ga = JSON.parse(auditOf(GO_DB)).map((e) => (e[0] === 'catalog.publish' && /^\d{4}-/.test(e[2]) && e[2] !== '2026-11-01.1' ? [e[0], e[1], '<auto>', e[3], e[4]] : e));
const na = JSON.parse(auditOf(NEST_DB)).map((e) => (e[0] === 'catalog.publish' && /^\d{4}-/.test(e[2]) && e[2] !== '2026-11-01.1' ? [e[0], e[1], '<auto>', e[3], e[4]] : e));
if (JSON.stringify(ga) === JSON.stringify(na)) p.passed++;
else p.failures.push({ label: 'audit log', problems: [`go=${JSON.stringify(ga)}`, `nest=${JSON.stringify(na)}`] });

// ---- Stored items have the same fields ----
const keysOf = (d) => mongo(`print(JSON.stringify(db.getSiblingDB(${JSON.stringify(d)}).catalogItems.find({_id:{$in:['test-lamp','bed-double','sofa-3']}}).sort({_id:1}).toArray().map(x => Object.keys(x).sort().join(','))))`);
if (keysOf(GO_DB) === keysOf(NEST_DB)) p.passed++;
else p.failures.push({ label: 'stored item fields', problems: [keysOf(GO_DB), keysOf(NEST_DB)] });

p.report();
