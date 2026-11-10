// Parity: back office sign-in, staff, dashboard and audit log (Go vs NestJS).
// INVALID_JSON messages are not compared: Go's text names its internal struct types.
//
//   GOAPI=... NEST_DIST=.build-admin-auth test/parity/pair.sh admin-auth 9102 9202
//   node test/parity/admin-auth.mjs

import { Pair } from './lib.mjs';

const p = new Pair(Number(process.env.GO_PORT ?? 9102), Number(process.env.NEST_PORT ?? 9202));
const OWNER = 'owner@parity.local';
// expiresAt: Go formats it in the server's local zone with microseconds (same instant).
const IDS = ['data.expiresAt', 'data.id', 'data.staff.id', 'data.items[].id', 'data.items[].actorId', 'data.items[].targetId'];

// Per-server tokens and ids.
const tok = { go: {}, nest: {} };
const ids = { go: {}, nest: {} };
const auth = (who) => ({ Authorization: 'Bearer ${' + who + '}' });
const vars = () => ({ go: { ...tok.go, ...ids.go }, nest: { ...tok.nest, ...ids.nest } });

async function same(method, path, opts = {}) {
  return p.same(method, path, { ...opts, vars: vars(), ignore: [...IDS, ...(opts.ignore ?? [])] });
}

/** Signs in on both servers and stores each server's token under `name`. */
async function login(name, email, password, label) {
  const r = await same('POST', '/v1/admin/auth/login', { body: { email, password }, label: label ?? `login ${name}` });
  if (r.go.status === 200) tok.go[name] = r.go.json.data.token;
  if (r.nest.status === 200) tok.nest[name] = r.nest.json.data.token;
  return r;
}

async function changePassword(name, current, next, label) {
  const r = await same('POST', '/v1/admin/auth/password', {
    headers: auth(name), body: { currentPassword: current, newPassword: next }, label: label ?? `password ${name}`,
  });
  if (r.go.status === 200) tok.go[name] = r.go.json.data.token;
  if (r.nest.status === 200) tok.nest[name] = r.nest.json.data.token;
  return r;
}

async function createStaff(key, body, label) {
  const r = await same('POST', '/v1/admin/staff', { headers: auth('owner'), body, label: label ?? `create ${key}` });
  if (r.go.status === 201) ids.go[key] = r.go.json.data.id;
  if (r.nest.status === 201) ids.nest[key] = r.nest.json.data.id;
  return r;
}

// ---- Sign in ----
await same('POST', '/v1/admin/auth/login', { body: { email: 'nobody@parity.local', password: 'whatever-123' }, label: 'login unknown email' });
await same('POST', '/v1/admin/auth/login', { body: { email: OWNER, password: 'wrong-password' }, label: 'login wrong password' });
await same('POST', '/v1/admin/auth/login', { raw: '', label: 'login empty body' });
await login('owner', '  OWNER@parity.local ', 'ChangeMe-2026!', 'login owner (trim + case)');
await same('GET', '/v1/admin/auth/me', { headers: auth('owner'), label: 'me (must change password)' });
await same('GET', '/v1/admin/auth/me', { label: 'me without token' });
await same('GET', '/v1/admin/auth/me', { headers: { Authorization: 'Bearer nope' }, label: 'me bad token' });
await same('GET', '/v1/admin/staff', { headers: auth('owner'), label: 'staff list before password change' });
await same('GET', '/v1/admin/dashboard', { headers: auth('owner'), label: 'dashboard before password change' });

// ---- Password change ----
await changePassword('owner', 'not-it-at-all', 'Owner-Secret-1', 'password wrong current');
await changePassword('owner', 'ChangeMe-2026!', 'short', 'password too short');
await changePassword('owner', 'ChangeMe-2026!', 'ChangeMe-2026!', 'password same as current');
tok.go.ownerOld = tok.go.owner;
tok.nest.ownerOld = tok.nest.owner;
await changePassword('owner', 'ChangeMe-2026!', 'Owner-Secret-1', 'password change ok');
await same('GET', '/v1/admin/auth/me', { headers: auth('ownerOld'), label: 'old token after password change' });
await same('GET', '/v1/admin/auth/me', { headers: auth('owner'), label: 'me after password change' });

// ---- Staff ----
await same('GET', '/v1/admin/staff', { headers: auth('owner'), label: 'staff list' });
await createStaff('bad', { email: 'not an email', name: '  ', role: 'boss', password: 'short' }, 'create invalid');
await createStaff('bad2', { email: 'Ünïcode@Example.com', name: 'x'.repeat(61), role: 'viewer', password: 'é'.repeat(37) }, 'create unicode email, long name, 74-byte password');
await createStaff('bad3', { email: 'Name <a@b.c>', name: 'N', role: 'viewer', password: 'Password-123' }, 'create display-name email');
await createStaff('viewer', { email: 'Viewer@Parity.local', name: ' Vee ', role: 'viewer', password: 'Viewer-Temp-1' });
await createStaff('support', { email: 'support@parity.local', name: 'Sue', role: 'support', password: 'Support-Temp-1' });
await createStaff('cm', { email: 'cm@parity.local', name: 'Cat', role: 'catalog_manager', password: 'Catalog-Temp-1' });
await createStaff('owner2', { email: 'owner2@parity.local', name: 'Second Owner', role: 'owner', password: 'Owner2-Temp-1' });
await createStaff('dup', { email: 'viewer@parity.local', name: 'Dup', role: 'viewer', password: 'Viewer-Temp-1' }, 'create duplicate email');
await same('POST', '/v1/admin/staff', { headers: auth('owner'), raw: '[1]', label: 'create array body', ignore: ['error.message'] });
await same('GET', '/v1/admin/staff', { headers: auth('owner'), label: 'staff list after creates' });

// Sign in as each new account and set a real password.
for (const [k, email, temp] of [['viewer', 'viewer@parity.local', 'Viewer-Temp-1'], ['support', 'support@parity.local', 'Support-Temp-1'], ['cm', 'cm@parity.local', 'Catalog-Temp-1'], ['owner2', 'owner2@parity.local', 'Owner2-Temp-1']]) {
  await login(k, email, temp);
  await same('GET', '/v1/admin/auth/me', { headers: auth(k), label: `me ${k}` });
  await changePassword(k, temp, `${k}-Real-Pass-1`);
}

// ---- Permissions ----
for (const k of ['viewer', 'support', 'cm']) {
  await same('GET', '/v1/admin/staff', { headers: auth(k), label: `staff list as ${k}` });
  await same('GET', '/v1/admin/audit', { headers: auth(k), label: `audit as ${k}` });
  await same('GET', '/v1/admin/dashboard', { headers: auth(k), label: `dashboard as ${k}` });
  await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth(k), body: { name: 'x' }, label: `patch as ${k}` });
}

// ---- Updates ----
await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth('owner'), body: { name: '  Victor  ' }, label: 'rename viewer' });
await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth('owner'), body: { name: '' }, label: 'rename empty' });
await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth('owner'), body: { role: 'god' }, label: 'bad role' });
await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth('owner'), body: { role: 'support', name: 'Vic' }, label: 'viewer -> support' });
await same('PATCH', '/v1/admin/staff/nope', { headers: auth('owner'), body: { name: 'x' }, label: 'patch unknown id' });
await same('PATCH', '/v1/admin/staff/:viewer', { headers: auth('owner'), body: { disabled: 'yes' }, label: 'patch disabled wrong type', ignore: ['error.message'] });
ids.go.me = JSON.parse(Buffer.from(tok.go.owner.split('.')[1], 'base64url')).sub;
ids.nest.me = JSON.parse(Buffer.from(tok.nest.owner.split('.')[1], 'base64url')).sub;
await same('PATCH', '/v1/admin/staff/:me', { headers: auth('owner'), body: { role: 'viewer' }, label: 'self demote' });
await same('PATCH', '/v1/admin/staff/:me', { headers: auth('owner'), body: { disabled: true }, label: 'self disable' });
await same('PATCH', '/v1/admin/staff/:me', { headers: auth('owner'), body: { name: 'Main Owner' }, label: 'self rename' });
await same('PATCH', '/v1/admin/staff/:owner2', { headers: auth('owner'), body: { role: 'catalog_manager' }, label: 'demote owner2' });
await same('GET', '/v1/admin/staff', { headers: auth('owner2'), label: 'owner2 after demotion (staff list)' });
await same('PATCH', '/v1/admin/staff/:owner2', { headers: auth('owner'), body: { role: 'owner' }, label: 'promote owner2 back' });
await same('PATCH', '/v1/admin/staff/:cm', { headers: auth('owner'), body: { disabled: true }, label: 'disable cm' });
await same('GET', '/v1/admin/auth/me', { headers: auth('cm'), label: 'disabled cm token' });
await login('cmDisabled', 'cm@parity.local', 'cm-Real-Pass-1', 'login disabled account');
await same('PATCH', '/v1/admin/staff/:cm', { headers: auth('owner'), body: { disabled: false }, label: 'enable cm' });

// ---- Lockout ----
for (let i = 1; i <= 5; i++) {
  await same('POST', '/v1/admin/auth/login', { body: { email: 'support@parity.local', password: `bad-${i}` }, label: `support bad login ${i}` });
}
await same('POST', '/v1/admin/auth/login', { body: { email: 'support@parity.local', password: 'support-Real-Pass-1' }, label: 'support locked (right password)' });

// ---- Reset password ----
await same('POST', '/v1/admin/staff/:support/reset-password', { headers: auth('owner'), body: { password: 'short' }, label: 'reset too short' });
await same('POST', '/v1/admin/staff/nope/reset-password', { headers: auth('owner'), body: { password: 'Long-Enough-1' }, label: 'reset unknown' });
await same('POST', '/v1/admin/staff/:support/reset-password', { headers: auth('owner'), body: { password: 'Support-Reset-1' }, label: 'reset support (clears lock)' });
await same('GET', '/v1/admin/auth/me', { headers: auth('support'), label: 'support old token after reset' });
await login('support', 'support@parity.local', 'Support-Reset-1', 'support login after reset');
await same('GET', '/v1/admin/dashboard', { headers: auth('support'), label: 'support must change after reset' });

// ---- Logout ----
await same('POST', '/v1/admin/auth/logout', { headers: auth('owner2'), label: 'logout owner2' });
await same('GET', '/v1/admin/auth/me', { headers: auth('owner2'), label: 'owner2 token after logout' });
await same('POST', '/v1/admin/auth/logout', { headers: auth('owner2'), label: 'logout again' });

// ---- Dashboard ----
for (const qs of ['', '?days=7', '?days=6', '?days=365', '?days=366', '?days=abc', '?days=14']) {
  await same('GET', `/v1/admin/dashboard${qs}`, { headers: auth('owner'), label: `dashboard${qs}` });
}

// ---- Audit ----
for (const qs of ['', '?pageSize=3', '?pageSize=3&page=2', '?page=0&pageSize=0', '?pageSize=500', '?action=auth.', '?action=auth.login',
  '?action=staff', '?actor=owner@parity.local', '?targetType=staff', '?action=a.b(', '?targetType=none']) {
  await same('GET', `/v1/admin/audit${qs}`, { headers: auth('owner'), label: `audit${qs}` });
}
await same('GET', '/v1/admin/audit?targetId=:viewer', { headers: auth('owner'), label: 'audit by targetId' });

p.report();
