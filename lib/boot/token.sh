#!/bin/bash
# Mints the connector's admin token and stores it in SSM (SecureString).
#   forgejo-box-token            mints only when needed: the parameter is missing, OR the
#                                token it holds was minted with other scopes than
#                                FG_TOKEN_SCOPES (marker on the data volume) — so a box
#                                upgraded from a package that minted `all` re-mints at boot
#   forgejo-box-token --rotate   always mints
# After a mint: the parameter is overwritten, then every OTHER connector-* token of the
# admin is deleted (through the local API, with the new token). The connector re-reads
# the parameter on its next 401, so the old token can go at once. Idempotent.
# The token never reaches stdout, a log, a process argument or the CFN outputs.
set -euo pipefail
. /etc/forgejo-box/env
export AWS_DEFAULT_REGION="$FG_REGION"
fj() { sudo -u git /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path "$FG_WORK" "$@"; }
marker=/data/forgejo-box/token-scopes

if [ "${1:-}" != "--rotate" ] && [ "$(cat "$marker" 2>/dev/null)" = "$FG_TOKEN_SCOPES" ] &&
  aws ssm get-parameter --name "$FG_TOKEN_PARAM" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "forgejo-box-token: $FG_TOKEN_PARAM already holds a token scoped $FG_TOKEN_SCOPES, kept"
  exit 0
fi
name="connector-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d " \n")"
tok=$(fj admin user generate-access-token --username "$FG_ADMIN_USER" --token-name "$name" --scopes "$FG_TOKEN_SCOPES" --raw)
[[ "$tok" =~ ^[0-9a-f]{40}$ ]] || { echo "forgejo-box-token: unexpected token format" >&2; exit 1; }
req=$(umask 077; mktemp)
printf '{"Name":"%s","Type":"SecureString","Overwrite":true,"Value":"%s","Description":"Forgejo admin token (%s)"}' \
  "$FG_TOKEN_PARAM" "$tok" "$name" > "$req"
aws ssm put-parameter --cli-input-json "file://$req" >/dev/null
shred -u "$req"
mkdir -p "$(dirname "$marker")" && echo "$FG_TOKEN_SCOPES" > "$marker"
echo "forgejo-box-token: stored token $name ($FG_TOKEN_SCOPES) in $FG_TOKEN_PARAM"

# The header lives in a 0600 file (curl -H @file): the token is never an argument.
hdr=$(umask 077; mktemp)
printf 'Authorization: token %s\n' "$tok" > "$hdr"
unset tok
api() { curl -fsS -H @"$hdr" "http://127.0.0.1:$FG_PORT/api/v1/admin/users/$FG_ADMIN_USER/tokens$1" "${@:2}"; }
old=$(api "?limit=50" | python3 -c 'import json,sys
for t in json.load(sys.stdin):
    if t["name"].startswith("connector-") and t["name"] != sys.argv[1]: print(t["id"], t["name"])' "$name") ||
  { echo "forgejo-box-token: WARNING could not list the old tokens; delete them by hand (README)" >&2; old=""; }
while read -r id oldname; do
  [ -n "$id" ] || continue
  if api "/$id" -X DELETE -o /dev/null; then echo "forgejo-box-token: deleted old token $oldname"
  else echo "forgejo-box-token: WARNING could not delete old token $oldname" >&2; fi
done <<< "$old"
shred -u "$hdr"
