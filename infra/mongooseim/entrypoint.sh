#!/usr/bin/env bash
# Renders mongooseim.toml from the template using environment variables, then hands over to the
# image's own /start.sh (which picks up /member/mongooseim.toml).
set -euo pipefail

TEMPLATE=/templates/mongooseim.toml.tmpl
OUT=/member/mongooseim.toml

VARS=(XMPP_DOMAIN POSTGRES_HOST POSTGRES_DB POSTGRES_USER POSTGRES_PASSWORD
      MONGOOSEIM_ADMIN_USER MONGOOSEIM_ADMIN_PASSWORD)

# Escape characters that are special in a sed replacement (we use | as the delimiter).
escape() { printf '%s' "$1" | sed -e 's/[\\|&]/\\&/g'; }

args=()
for v in "${VARS[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "entrypoint: required environment variable $v is not set" >&2
    exit 1
  fi
  # Values land inside TOML basic strings ("..."), where " and \ are special, and must not be
  # re-substituted or confused with placeholders. Reject rather than escape: simpler and safer.
  case "${!v}" in
    *\"* | *\\* | *[[:cntrl:]]* | *'{{'* | *'}}'*)
      echo "entrypoint: $v contains a forbidden character (\", \\, {{, }} or a control character)" >&2
      exit 1 ;;
  esac
  args+=(-e "s|{{$v}}|$(escape "${!v}")|g")
done

mkdir -p /member
sed "${args[@]}" "$TEMPLATE" > "$OUT"

# Check non-comment lines only (comments may mention {{PLACEHOLDERS}}).
if grep -nv '^[[:space:]]*#' "$OUT" | grep -q '{{'; then
  # Print placeholder names only — never whole lines, which could contain secrets.
  echo "entrypoint: unreplaced placeholders remain in $OUT:" >&2
  grep -v '^[[:space:]]*#' "$OUT" | grep -o '{{[A-Za-z_]*}}' | sort -u >&2
  exit 1
fi

exec /start.sh
