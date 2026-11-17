#!/bin/bash
# Mints the connector's admin token and stores it in SSM (SecureString).
#   forgejo-box-token            only if the parameter does not exist yet
#   forgejo-box-token --rotate   new token, parameter overwritten, old token deleted
# The token never reaches stdout, a log, a process argument or the CFN outputs.
set -euo pipefail
. /etc/forgejo-box/env
export AWS_DEFAULT_REGION="$FG_REGION"
fj() { sudo -u git /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path "$FG_WORK" "$@"; }

if [ "${1:-}" != "--rotate" ] && aws ssm get-parameter --name "$FG_TOKEN_PARAM" --query Parameter.Name --output text >/dev/null 2>&1; then
  echo "forgejo-box-token: $FG_TOKEN_PARAM already exists, kept"
  exit 0
fi
name="connector-$(date -u +%Y%m%dT%H%M%SZ)"
tok=$(fj admin user generate-access-token --username "$FG_ADMIN_USER" --token-name "$name" --scopes all --raw)
[[ "$tok" =~ ^[0-9a-f]{40}$ ]] || { echo "forgejo-box-token: unexpected token format" >&2; exit 1; }
req=$(umask 077; mktemp)
printf '{"Name":"%s","Type":"SecureString","Overwrite":true,"Value":"%s","Description":"Forgejo admin token (%s)"}' \
  "$FG_TOKEN_PARAM" "$tok" "$name" > "$req"
aws ssm put-parameter --cli-input-json "file://$req" >/dev/null
shred -u "$req"
unset tok
echo "forgejo-box-token: stored token $name in $FG_TOKEN_PARAM"
if [ "${1:-}" = "--rotate" ]; then
  # Delete every OTHER connector-* token of the admin, through the API with the new one.
  echo "forgejo-box-token: old tokens must be deleted in the UI or API (README 'Token rotation')"
fi
