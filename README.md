# RoomCraft API (NestJS)

The RoomCraft designer API in TypeScript (NestJS + MongoDB). It replaces the Go API
(`../roomcraft-api`) with the **same 69 routes, responses and database**: both APIs read and
write the same MongoDB documents, staff tokens from one work on the other, and the web app
and back office need no changes. It runs on **Vercel** (serverless) or as a container.

Every route was checked against the Go API by sending both the same requests (486 checks
in `test/parity/`, 0 differences apart from the few listed under *Known differences*).

## Run it locally

```bash
npm install
cp .env.example .env        # point MONGO_URI at a MongoDB
npm run dev                 # build + start on http://localhost:8080
curl http://localhost:8080/health
curl http://localhost:8080/v1/catalog
```

`npm start` (and `npm run dev`) creates indexes and the first owner at start-up, and adds the
seed data when `SEED_ON_START=true`, like the Go API.

## Deploy to Vercel

1. Import this repo in Vercel. `vercel.json` sets everything: `npm run build` compiles to
   `dist/`, and every path goes to one function (`api/index.js`).
2. Set the environment variables (below) in **Project Settings → Environment Variables**.
3. MongoDB Atlas → **Network Access**: allow `0.0.0.0/0` (Vercel has no fixed IPs on Hobby/Pro).
4. For a **new, empty database**, run the seed once from your machine with the production
   values in `.env`: `npm run build && npm run seed`. It creates the indexes, the first owner
   and the starting catalog. An existing RoomCraft database needs nothing.
5. Point the web app and back office at the new URL (`API_URL`).

On Vercel nothing heavy runs per request: the app and the MongoDB connection are created once
per warm function instance and reused.

## Run as a container

```bash
docker build -t roomcraft-api-nest .
docker run -p 8080:8080 --env-file .env roomcraft-api-nest
```

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `8080` | Local / container only |
| `MONGO_URI` | `mongodb://localhost:27017` | |
| `MONGO_DB` | `roomcraft` | |
| `JWT_SECRET` | — | HS256 secret for SmartWorld tokens. Required unless `AUTH_DEV=true` |
| `JWT_ISSUER` | — | Checked when set |
| `AUTH_DEV` | `false` | **Local only.** Accepts `X-Dev-User: <id>` instead of a resident token |
| `ADMIN_JWT_SECRET` | — | **Required**, 32+ characters. Signs back office staff tokens |
| `ADMIN_TOKEN_TTL_HOURS` | `8` | Staff session length |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | — | First owner, created when there are no staff yet |
| `SEED_ON_START` | `false` | `npm start` only; on Vercel use `npm run seed` |
| `CORS_ORIGINS` | localhost:3000, the Vercel site | Comma-separated |
| `SHARE_BASE_URL` | `https://roomcraft-sable.vercel.app` | Share links point here |
| `SHARE_TTL_DAYS` | `0` | `0` = links never expire |
| `WRITES_PER_MINUTE` | `60` | Per user (or IP), **per instance** |

## API

Same as the Go API; see `../roomcraft-api/README.md` for every route, body and error code.
Responses use `{"success": true, "data": …}` / `{"success": false, "error": {code, message, details}}`.

## Layout

```
api/index.js            Vercel function entry (loads dist/vercel.js)
src/main.ts             local / container server
src/vercel.ts           serverless handler
src/app.ts              Express middleware (logging, CORS, auth, rate limit, body) + Nest
src/core/               envelope, Go-compatible body decoding, validation, quotes, catalog cache, admin helpers
src/auth/               resident JWTs and staff tokens, roles, permissions
src/db/                 MongoDB connection, indexes, documents and serializers, publishing, seed
src/modules/public/     catalog, plans, room types, designs, drafts, /me, shares
src/modules/admin-*/    back office: auth & staff, catalog, plans & support
src/scripts/seed.ts     npm run seed
seed/                   starting data (same as the Go API)
test/parity/            Go vs NestJS comparison tests
```

## Parity tests

They start the Go API and this API side by side, each with its own seeded database on a local
MongoDB, and compare status, headers and JSON for the same requests.

```bash
docker run -d --name rc-parity-mongo -p 27018:27017 mongo:8.0
(cd ../roomcraft-api && go build -o /tmp/goapi ./cmd/api)
npm run build
GOAPI=/tmp/goapi test/parity/pair.sh public 9101 9201 && node test/parity/public.mjs; test/parity/pair.sh stop public
# also: admin-auth 9102 9202, admin-catalog 9103 9203, admin-support 9104 9204
```

## Known differences from the Go API

- **Serverless state.** The rate limit and the 30-second catalog cache are per function
  instance. A catalog publish reaches every instance within 30 seconds, as before.
- **`INVALID_JSON` messages.** Same status and code; the wording of the message differs (Go's
  named its internal struct types).
- **Staff `expiresAt`.** Always UTC with milliseconds; Go used the server's local time zone.
- **Stored numbers.** Prices are stored as plain numbers instead of 64-bit integers. Both APIs
  read either.
