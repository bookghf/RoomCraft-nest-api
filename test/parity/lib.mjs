// Parity test helpers: send the same request to the Go API and this NestJS API and check
// that status, important headers and JSON body match.
//
//   import { Pair } from './lib.mjs';
//   const p = new Pair(9101, 9201);
//   await p.same('GET', '/v1/catalog');
//   await p.same('PUT', '/v1/designs/d1', { headers: { 'X-Dev-User': 'alice' }, body: {...} });
//   const { go, nest } = await p.both('POST', '/v1/shares', { body });   // when you need the values
//   p.report();   // prints the summary, exits 1 on any mismatch
//
// Values that legitimately differ between the two servers are normalised before comparing:
// RFC 3339 timestamps -> "<time>", JWTs -> "<jwt>". Pass `ignore: ['data.code', 'data.items[].id']`
// for random ids, and `vars` per server when a path differs (see both()).

const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;
const HEADERS = ['content-type', 'etag', 'cache-control', 'content-disposition', 'retry-after',
  'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers',
  'access-control-expose-headers', 'access-control-max-age'];

function normalise(v, ignore, path = '') {
  if (typeof v === 'string') {
    if (TIME.test(v)) return '<time>';
    if (JWT.test(v)) return '<jwt>';
    return v;
  }
  if (Array.isArray(v)) return v.map((x) => normalise(x, ignore, `${path}[]`));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      const p = path ? `${path}.${k}` : k;
      o[k] = ignore.includes(p) ? '<ignored>' : normalise(v[k], ignore, p);
    }
    return o;
  }
  return v;
}

/** Deep compare that also checks key order (Go struct field order). Returns a list of differences. */
function diff(a, b, path = '$', out = []) {
  if (out.length > 20) return out;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${path}: go=${JSON.stringify(a)?.slice(0, 200)} nest=${JSON.stringify(b)?.slice(0, 200)}`);
    return out;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${path}: length go=${a.length} nest=${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diff(a[i], b[i], `${path}[${i}]`, out);
    return out;
  }
  if (a && typeof a === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.join(',') !== kb.join(',')) out.push(`${path}: keys go=[${ka}] nest=[${kb}]`);
    for (const k of ka) if (k in b) diff(a[k], b[k], `${path}.${k}`, out);
    return out;
  }
  if (a !== b) out.push(`${path}: go=${JSON.stringify(a)} nest=${JSON.stringify(b)}`);
  return out;
}

export class Pair {
  constructor(goPort, nestPort) {
    this.go = `http://localhost:${goPort}`;
    this.nest = `http://localhost:${nestPort}`;
    this.passed = 0;
    this.failures = [];
  }

  async send(base, method, path, { headers = {}, body, raw } = {}) {
    const init = { method, headers: { ...headers }, redirect: 'manual' };
    if (raw !== undefined) init.body = raw;
    else if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] ??= 'application/json';
    }
    const res = await fetch(base + path, init);
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = { __text: text }; }
    const h = {};
    for (const k of HEADERS) { const v = res.headers.get(k); if (v !== null) h[k] = v; }
    return { status: res.status, headers: h, json };
  }

  /**
   * Sends to both. opts.vars = { go: {...}, nest: {...} } replaces ":name" in the path and
   * "${name}" in header values per server (e.g. tokens or ids that differ).
   */
  async both(method, path, opts = {}) {
    const sub = (s, vars) => s.replace(/:(\w+)|\$\{(\w+)\}/g, (m, a, b) => (vars && (a ?? b) in vars ? vars[a ?? b] : m));
    const one = (base, vars) => {
      const headers = Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k, sub(String(v), vars)]));
      const body = opts.bodies ? opts.bodies[base === this.go ? 'go' : 'nest'] : opts.body;
      return this.send(base, method, sub(path, vars), { ...opts, headers, body });
    };
    const [go, nest] = await Promise.all([one(this.go, opts.vars?.go), one(this.nest, opts.vars?.nest)]);
    return { go, nest };
  }

  /** Sends to both and records whether status, headers and normalised body match. */
  async same(method, path, opts = {}) {
    const { go, nest } = await this.both(method, path, opts);
    const ignore = opts.ignore ?? [];
    const ignoreHeaders = opts.ignoreHeaders ?? [];
    const problems = [];
    if (go.status !== nest.status) problems.push(`status go=${go.status} nest=${nest.status}`);
    for (const k of HEADERS) {
      if (ignoreHeaders.includes(k)) continue;
      const a = go.headers[k], b = nest.headers[k];
      const na = a && JWT.test(a) ? '<jwt>' : a, nb = b && JWT.test(b) ? '<jwt>' : b;
      if (na !== nb) problems.push(`header ${k}: go=${a} nest=${b}`);
    }
    problems.push(...diff(normalise(go.json, ignore), normalise(nest.json, ignore)));
    const label = opts.label ?? `${method} ${path}`;
    if (problems.length) this.failures.push({ label, problems });
    else this.passed++;
    return { go, nest, ok: problems.length === 0 };
  }

  report() {
    for (const f of this.failures) {
      console.log(`✗ ${f.label}`);
      for (const p of f.problems) console.log(`    ${p}`);
    }
    console.log(`\n${this.passed} passed, ${this.failures.length} failed`);
    if (this.failures.length) process.exitCode = 1;
  }
}

/** A signed resident token for JWT_SECRET=parity-jwt-secret (HS256). */
export async function residentToken(sub, { secret = 'parity-jwt-secret', expSeconds = 3600, extra = {} } = {}) {
  const { createHmac } = await import('node:crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub, exp: Math.floor(Date.now() / 1000) + expSeconds, ...extra });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/**
 * A back office token as the API issues it (ADMIN_JWT_SECRET of pair.sh). sub is the staff _id,
 * ver its tokenVersion. Read both from the test database, e.g.
 *   docker exec rc-parity-mongo mongosh --quiet --eval 'db.getSiblingDB("parity_x_nest").staff.findOne()'
 */
export async function staffToken(sub, ver = 0, { secret = 'parity-admin-secret-0123456789abcdef', expSeconds = 3600 } = {}) {
  const { createHmac } = await import('node:crypto');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ ver, iss: 'roomcraft-api', sub, aud: ['roomcraft-backoffice'], exp: now + expSeconds, iat: now });
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
