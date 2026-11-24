#!/usr/bin/env bash
# Dev seed: two test users, the room-owner account and one members-only MUC room (lobby), created via
# mongooseimctl (admin GraphQL CLI). Re-run after restarting MongooseIM (ADR-020).
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

OWNER="${XMPP_ROOM_OWNER:-nearby-rooms}"
# Same constant as geo_xmpp_admin:room_config/0 (ADR-020): members-only, hidden, hardened.
ROOM_CONFIG='{"public":false,"publicList":false,"persistent":true,"membersOnly":true,"anonymous":true,"allowPrivateMessages":false,"allowQueryUsers":false,"allowChangeSubject":false,"allowUserInvites":false,"mayGetMemberList":[]}'

# Only the room-owner account may create rooms (access_create). Its password is random, never printed
# and never needed again: geo_service creates rooms through the admin API, not by logging in.
echo "== registering room owner $OWNER@$XMPP_DOMAIN"
OWNER_PASSWORD=$(head -c 24 /dev/urandom | base64 | tr -d '/+=')
run_tolerant account registerUser --domain "$XMPP_DOMAIN" --username "$OWNER" --password "$OWNER_PASSWORD"
unset OWNER_PASSWORD

echo "== creating room lobby@$MUC (members-only, owned by $OWNER)"
run_tolerant muc createInstantRoom --room "lobby@$MUC" --owner "$OWNER@$XMPP_DOMAIN/geo_service" --nick Nearby
echo "== applying the room configuration"
run_tolerant muc changeRoomConfiguration --room "lobby@$MUC" --config "$ROOM_CONFIG"
# The owner joined as a ghost occupant (no session); let it leave.
run_tolerant muc exitRoom --room "lobby@$MUC" --user "$OWNER@$XMPP_DOMAIN/geo_service" --nick Nearby

for u in alice bob; do
  echo "== making $u a member of lobby@$MUC"
  run_tolerant muc setUserAffiliation --room "lobby@$MUC" --user "$u@$XMPP_DOMAIN" --affiliation MEMBER
done

echo "Done. Log in as alice or bob with DEV_USER_PASSWORD and join lobby@$MUC"
echo "Re-run this script after restarting MongooseIM: it reloads the lobby room (members-only rooms are"
echo "not loaded at startup, and only the room owner may load them)."
