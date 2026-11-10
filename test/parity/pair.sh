#!/bin/sh
# Starts the Go API and this NestJS API side by side for parity tests, each with its own
# freshly seeded database on the local test MongoDB.
#
#   test/parity/pair.sh <name> <goPort> <nestPort>     e.g. pair.sh public 9101 9201
#   test/parity/pair.sh stop <name>
#
# Needs: GOAPI (path to the built Go binary), MongoDB at PARITY_MONGO (default mongodb://localhost:27018),
# and a build: NEST_DIST (default dist) is the compiled output to run, e.g. .build-public when
# several people build at once (npx tsc -p tsconfig.build.json --outDir .build-public).
# Logs go to /tmp/parity-<name>-{go,nest}.log.
set -e
cd "$(dirname "$0")/../.."
MONGO=${PARITY_MONGO:-mongodb://localhost:27018}
if [ "$1" = stop ]; then
  for f in /tmp/parity-$2-go.pid /tmp/parity-$2-nest.pid; do [ -f $f ] && kill $(cat $f) 2>/dev/null || true; rm -f $f; done
  # Also free the ports recorded at start, in case an older script version left servers behind.
  [ -f /tmp/parity-$2.ports ] && for p in $(cat /tmp/parity-$2.ports); do lsof -ti tcp:$p -sTCP:LISTEN | xargs kill 2>/dev/null || true; done
  exit 0
fi
NAME=$1; GOPORT=$2; NESTPORT=$3
: "${GOAPI:?set GOAPI to the Go API binary}"
"$0" stop "$NAME"
for p in $GOPORT $NESTPORT; do lsof -ti tcp:$p -sTCP:LISTEN | xargs kill 2>/dev/null || true; done
echo "$GOPORT $NESTPORT" > /tmp/parity-$NAME.ports
docker exec rc-parity-mongo mongosh --quiet --eval "db.getSiblingDB('parity_${NAME}_go').dropDatabase(); db.getSiblingDB('parity_${NAME}_nest').dropDatabase()" >/dev/null

common() {
  exec env -i PATH="$PATH" HOME="$HOME" \
    MONGO_URI="$MONGO" AUTH_DEV=true JWT_SECRET=parity-jwt-secret \
    ADMIN_JWT_SECRET=parity-admin-secret-0123456789abcdef ADMIN_EMAIL=owner@parity.local ADMIN_PASSWORD='ChangeMe-2026!' \
    WRITES_PER_MINUTE=100000 SEED_ON_START=true SHARE_BASE_URL=https://example.test \
    CORS_ORIGINS=http://localhost:3000 "$@"
}
common PORT=$GOPORT MONGO_DB=parity_${NAME}_go "$GOAPI" > /tmp/parity-$NAME-go.log 2>&1 &
echo $! > /tmp/parity-$NAME-go.pid
common PORT=$NESTPORT MONGO_DB=parity_${NAME}_nest node ${NEST_DIST:-dist}/main.js > /tmp/parity-$NAME-nest.log 2>&1 &
echo $! > /tmp/parity-$NAME-nest.pid
for p in $GOPORT $NESTPORT; do
  i=0; until curl -sf -o /dev/null localhost:$p/health; do i=$((i+1)); [ $i -gt 60 ] && { echo "port $p did not start; see /tmp/parity-$NAME-*.log"; exit 1; }; sleep 0.5; done
done
echo "go :$GOPORT (parity_${NAME}_go)  nest :$NESTPORT (parity_${NAME}_nest)  ready"
