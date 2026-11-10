// `npm run seed`: creates indexes, the first owner (ADMIN_EMAIL / ADMIN_PASSWORD) and adds
// the starting catalog, plans and showrooms. Only missing records are added.
// Run it once against a new database before deploying to Vercel.

import { prepare } from '../main';
import { closeDB } from '../db/mongo';

prepare(true)
  .then(() => closeDB())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
