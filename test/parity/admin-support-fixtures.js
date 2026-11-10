// mongosh script: identical resident data and staff accounts for the admin-support parity test.
// Run with: docker exec -i rc-parity-mongo mongosh --quiet --eval "const DBS=['a','b']" --file - < this file
// (admin-support.mjs does this). Field names are the Go API's.

const D = (s) => new Date(s);
const content = (items, extra = {}) => ({
  items,
  floor: { material: 'wood', color: '#c9a77c' },
  wall: { material: 'paint', color: '#ede8e0' },
  ceiling: 2.6,
  ...extra,
});
const item = (uid, itemId, colorId, x = 1, z = 1) => ({ uid, itemId, colorId, x, y: 0, z, rot: 0 });

for (const name of DBS) {
  const x = db.getSiblingDB(name);
  const catalogVersion = x.catalogVersions.find().sort({ publishedAt: -1 }).limit(1).toArray()[0]._id;
  x.designs.deleteMany({});
  x.drafts.deleteMany({});
  x.shares.deleteMany({});
  x.preferences.deleteMany({});
  x.auditLog.deleteMany({});

  x.designs.insertMany([
    { _id: 'd-a1', ownerId: 'alice', planId: '1br-30', planVersion: 1, name: 'Alice Bedroom',
      content: content([item('u1', 'bed-double', 'oak'), item('u2', 'bed-double', 'oak', 2, 2), item('u3', 'bedside-table', 'walnut'), item('u4', 'ghost-item', '')]),
      catalogVersion, itemCount: 4, totalSatang: NumberLong(2127000), version: 2, createdAt: D('2026-10-01T08:00:00Z'), updatedAt: D('2026-11-01T10:00:00.5Z') },
    { _id: 'd-a2', ownerId: 'alice', planId: 'empty', planVersion: 1, name: 'Alice Studio',
      content: content([item('u1', 'wardrobe', 'white')], { size: { w: 5, d: 4 } }),
      catalogVersion, itemCount: 1, totalSatang: 799000, version: 1, createdAt: D('2026-10-02T08:00:00Z'), updatedAt: D('2026-11-02T10:00:00Z') },
    { _id: 'd-a3', ownerId: 'alice', planId: '1br-30', planVersion: 1, name: 'Old one',
      content: content([]), catalogVersion, itemCount: 0, totalSatang: 0, version: 3,
      createdAt: D('2026-10-03T08:00:00Z'), updatedAt: D('2026-11-03T10:00:00Z'), deletedAt: D('2026-11-03T10:00:00Z') },
    { _id: 'd-b1', ownerId: 'bob', planId: 'bedroom-calm', planVersion: 1, name: "Bob's [special] room",
      content: content([item('u1', 'bed-single', 'navy')]), catalogVersion, itemCount: 1, totalSatang: 549000, version: 1,
      createdAt: D('2026-10-04T08:00:00Z'), updatedAt: D('2026-10-15T10:00:00Z') },
    { _id: 'd-c1', ownerId: 'carol', planId: '1br-30', planVersion: 7, name: 'Carol old plan',
      content: content([item('u1', 'bed-double', 'grey')]), itemCount: 1, totalSatang: 999000, version: 1,
      createdAt: D('2026-08-01T08:00:00Z'), updatedAt: D('2026-09-01T10:00:00Z') },
  ]);
  x.drafts.insertMany([
    { _id: 'dr-a1', ownerId: 'alice', designId: 'd-a1', planId: '1br-30', planVersion: 1,
      content: content([item('u1', 'bed-double', 'oak')]), updatedAt: D('2026-11-05T09:00:00Z') },
    { _id: 'dr-a2', ownerId: 'alice', planId: 'empty', planVersion: 1, content: content([]), updatedAt: D('2026-11-04T09:00:00Z') },
    { _id: 'dr-c1', ownerId: 'carol', planId: '1br-30', planVersion: 1,
      content: content([item('u1', 'bed-double', 'oak'), item('u2', 'wardrobe', 'oak')]), updatedAt: D('2026-09-02T09:00:00Z') },
  ]);
  x.shares.insertMany([
    { _id: 'shACT001', ownerId: 'alice', designId: 'd-a1', planId: '1br-30', planVersion: 1, content: content([item('u1', 'bed-double', 'oak')]),
      imageUrl: 'https://img.test/a.png', viewCount: 3, createdAt: D('2026-11-01T11:00:00Z') },
    { _id: 'shACT002', ownerId: 'bob', planId: 'bedroom-calm', planVersion: 1, content: content([]), viewCount: 0,
      createdAt: D('2026-10-16T11:00:00Z'), expiresAt: D('2030-01-01T00:00:00Z') },
    { _id: 'shEXP001', ownerId: 'alice', planId: '1br-30', planVersion: 1, content: content([]), viewCount: 9,
      createdAt: D('2025-12-01T11:00:00Z'), expiresAt: D('2026-01-01T00:00:00Z') },
    { _id: 'shREV001', ownerId: 'bob', designId: 'd-b1', planId: 'bedroom-calm', planVersion: 1, content: content([]), viewCount: 1,
      createdAt: D('2026-10-17T11:00:00Z'), revokedAt: D('2026-10-18T11:00:00Z') },
    { _id: 'shANON01', planId: 'empty', planVersion: 1, content: content([]), viewCount: 0, createdAt: D('2026-10-20T11:00:00Z') },
    { _id: 'shCAR001', ownerId: 'carol', planId: '1br-30', planVersion: 1, content: content([]), viewCount: 2, createdAt: D('2026-09-03T11:00:00Z') },
  ]);
  x.preferences.insertMany([
    { _id: 'alice', lang: 'th', measure: { item: true, distance: false, room: true }, recentItems: ['bed-double', 'wardrobe'], updatedAt: D('2026-11-05T12:00:00Z') },
    { _id: 'dave', lang: 'en', updatedAt: D('2026-07-01T12:00:00Z') },
  ]);

  // Staff in every role (same ids in both databases), plus one who must change their password.
  x.staff.deleteMany({ _id: { $in: ['stf_viewer', 'stf_support', 'stf_catmgr', 'stf_newbie'] } });
  const now = D('2026-11-01T00:00:00Z');
  const st = (id, role, extra = {}) => ({ _id: id, email: id + '@parity.local', name: id, role, disabled: false, mustChangePassword: false,
    passwordHash: 'x', tokenVersion: 0, failedLogins: 0, createdAt: now, updatedAt: now, ...extra });
  x.staff.insertMany([st('stf_viewer', 'viewer'), st('stf_support', 'support'), st('stf_catmgr', 'catalog_manager'), st('stf_newbie', 'owner', { mustChangePassword: true })]);
  // The seeded owner gets a fixed id, so both servers record the same publishedBy/actorId.
  const o = x.staff.findOne({ email: 'owner@parity.local' });
  if (o && o._id !== 'stf_owner') {
    x.staff.deleteOne({ _id: o._id });
    x.staff.insertOne({ ...o, _id: 'stf_owner', mustChangePassword: false, tokenVersion: 0 });
  }
}
