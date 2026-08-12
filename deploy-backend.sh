#!/usr/bin/env bash
# ============================================================
#  Leo Tracker — deploy the backend half
# ============================================================
#  The frontend deploys itself on push to main (GitHub Pages + Netlify).
#  The database schema and the two edge functions do NOT — they need a
#  Supabase personal access token, and ours is revoked.
#
#  ONE-TIME: generate a new token at
#      https://supabase.com/dashboard/account/tokens
#  then put it in ~/.config/visitcozumel/secrets.env as a line reading
#      SUPABASE_ACCESS_TOKEN=sbp_...
#  (nothing else on that line — the current one has a stray shell command
#  appended to it, which is why sourcing the file gives a broken value).
#
#  THEN:  bash deploy-backend.sh
# ============================================================
set -uo pipefail

REF="tgyhsbefshvnxqxgkcqx"
SECRETS="$HOME/.config/visitcozumel/secrets.env"
HERE="$(cd "$(dirname "$0")" && pwd)"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
ok()  { printf "  \033[32m✓\033[0m %s\n" "$1"; }
bad() { printf "  \033[31m✗\033[0m %s\n" "$1"; }

# ---- 1. Token ------------------------------------------------
say "1/4  Reading the Supabase token"
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [ -z "$TOKEN" ] && [ -f "$SECRETS" ]; then
  # First whitespace-delimited word after the "=" — tolerates the corrupted line.
  TOKEN=$(grep -m1 '^SUPABASE_ACCESS_TOKEN=' "$SECRETS" | cut -d= -f2- | awk '{print $1}' | tr -d '"'"'")
fi
if [ -z "$TOKEN" ]; then
  bad "No SUPABASE_ACCESS_TOKEN found in $SECRETS"
  echo "     Generate one: https://supabase.com/dashboard/account/tokens"
  exit 1
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" "https://api.supabase.com/v1/projects" \
         -H "Authorization: Bearer $TOKEN")
if [ "$CODE" != "200" ]; then
  bad "Token rejected (HTTP $CODE) — it's expired or revoked."
  echo "     Generate a new one: https://supabase.com/dashboard/account/tokens"
  echo "     Then replace the SUPABASE_ACCESS_TOKEN line in $SECRETS"
  echo "     (make sure the line contains ONLY the token)."
  exit 1
fi
ok "Token valid"

# ---- 2. Schema -----------------------------------------------
say "2/4  Applying schema-settings.sql"
PAYLOAD=$(python3 -c "import json,sys;print(json.dumps({'query':open('$HERE/schema-settings.sql').read()}))")
RESP=$(curl -s -X POST "https://api.supabase.com/v1/projects/$REF/database/query" \
        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
        --data-binary "$PAYLOAD")
if echo "$RESP" | grep -qi '"message"'; then
  bad "Schema failed: $(echo "$RESP" | head -c 300)"
  exit 1
fi
ok "settings + alert_sent created and seeded (safe to re-run)"

# ---- 3. Edge functions ---------------------------------------
say "3/4  Deploying edge functions"
export SUPABASE_ACCESS_TOKEN="$TOKEN"
for FN in wake-watch ask-leo; do
  EXTRA=""; [ "$FN" = "wake-watch" ] && EXTRA="--no-verify-jwt"
  if (cd "$HERE" && npx --yes supabase@latest functions deploy "$FN" --project-ref "$REF" $EXTRA >/tmp/leo-$FN.log 2>&1); then
    ok "$FN deployed"
  else
    bad "$FN failed — see /tmp/leo-$FN.log"
    tail -8 "/tmp/leo-$FN.log"
  fi
done

# ---- 4. Prove it ---------------------------------------------
say "4/4  Checking the push sender (sends nothing, writes nothing)"
curl -s "https://$REF.functions.supabase.co/wake-watch?dry=1" | python3 -m json.tool 2>/dev/null | head -30 \
  || echo "  (no JSON back — check the function logs in the dashboard)"

say "Done."
echo "  Expected above: localTime in Cozumel time (not UTC), stale:false,"
echo "  and cfg.ww showing 150–180. If month/expectedMonth disagree, open the"
echo "  app once on a phone — it writes the current month back on login."
