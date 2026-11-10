// Local / container server: `npm start`.
//
// Like the Go API, it creates indexes and the first owner at start-up, and adds the seed
// data when SEED_ON_START=true. On Vercel none of this runs per request; use `npm run seed`.

import { createServer } from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { closeDB, db, ensureIndexes } from './db/mongo';
import { bootstrapOwner, seed } from './db/store';
import { checkPassword, hashPassword } from './auth/staff';
import { newStaffID } from './core/ids';

const log = (level: string, msg: string, extra: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

/** Indexes, first owner and (optionally) seed data. Shared with scripts/seed.ts. */
export async function prepare(withSeed: boolean): Promise<void> {
  const cfg = config();
  const s = await db();
  await ensureIndexes(s);
  if (cfg.adminEmail && cfg.adminPassword) {
    try {
      checkPassword('ADMIN_PASSWORD', cfg.adminPassword);
    } catch {
      throw new Error('ADMIN_PASSWORD must be 10–72 characters');
    }
    if (await bootstrapOwner(s, cfg.adminEmail, await hashPassword(cfg.adminPassword), newStaffID())) {
      log('INFO', 'created the first back office owner; the password must be changed at first sign-in', { email: cfg.adminEmail });
    }
  }
  if (withSeed) {
    const rep = await seed(s);
    log('INFO', 'seed', { ...rep });
  }
}

async function main() {
  const cfg = config();
  await prepare(cfg.seedOnStart);
  const app = await createApp();
  const server = createServer(app);
  server.headersTimeout = 5_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 60_000;
  server.listen(Number(cfg.port), () => log('INFO', 'listening', { addr: `:${cfg.port}`, authDev: cfg.authDev }));

  const shutdown = () => {
    log('INFO', 'shutting down');
    server.close(() => void closeDB().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    log('ERROR', 'fatal', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
