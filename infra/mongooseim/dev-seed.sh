#!/usr/bin/env bash
# Phase 1 dev seed: two test users and one MUC room, created via mongooseimctl (admin GraphQL CLI).
# Run from the repo root once the stack is healthy:
#   bash infra/mongooseim/dev-seed.sh
# Safe to re-run: "already registered" results are tolerated; any other failure stops the script.
set -euo pipefail

cd "$(dirname "$0")/../.."
# Note: this sources .env with bash rules, which differ slightly from Docker Compose's .env parsing
# ($, quotes, spaces). Keep .env values to plain [A-Za-z0-9._-] and both agree.
set -a; [ -f .env ] && . ./.env; set +a

: "${XMPP_DOMAIN:?set XMPP_DOMAIN in .env}"
: "${DEV_USER_PASSWORD:?set DEV_USER_PASSWORD in .env}"
MUC="muc.${XMPP_DOMAIN}"

ctl() { docker compose exec -T mongooseim mongooseimctl "$@"; }

# Run a mongooseimctl command; succeed on success or "already exists", fail on anything else.
run_tolerant() {
  local out rc=0
  out=$(ctl "$@" 2>&1) || rc=$?
  if [ $rc -eq 0 ] && ! grep -q '"errors"' <<<"$out"; then
    echo "  ok"
  # MongooseIM 6.2.1 says "User ... already registered at node ..." for duplicates.
  # (createInstantRoom on an existing room just succeeds, so it needs no special case.)
  elif grep -qi 'already registered' <<<"$out"; then
    echo "  (already exists — skipped)"
  else
    echo "$out" >&2
    return 1
  fi
}

echo "== checking MongooseIM is up"
if ! ctl status >/dev/null 2>&1; then
  echo "MongooseIM is not running or not ready. Start it with: docker compose up -d" >&2
  exit 1
fi

for u in alice bob; do
  echo "== registering $u@$XMPP_DOMAIN"
  run_tolerant account registerUser --domain "$XMPP_DOMAIN" --username "$u" --password "$DEV_USER_PASSWORD"
done

echo "== creating room lobby@$MUC"
run_tolerant muc createInstantRoom --room "lobby@$MUC" --owner "alice@$XMPP_DOMAIN" --nick alice

echo "Done. Log in as alice or bob with DEV_USER_PASSWORD and join lobby@$MUC"
