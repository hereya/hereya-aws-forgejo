#!/bin/bash
# Restore test: the newest daily backup of a Forgejo stack, restored into a
# THROWAWAY local Forgejo (same pinned binary, same paths, this package's
# app.ini) in a local container, then checked: DB integrity, users, repos
# (on disk, `git fsck`, served over the API and git smart-HTTP), tokens.
# Read-only on AWS (two S3 GETs). Everything local is deleted at the end.
#
#   AWS_PROFILE=<profile> scripts/restore-test.sh --bucket <backup bucket> [--prefix dumps/<UTC>/] [--port 3300] [--keep]
#                        [--forgejo-binary <file>]
#   scripts/restore-test.sh --from-dir <dir holding forgejo-dump.tar.gz + forgejo.db.gz> [...]
#
# The bucket is the stack's `BackupBucket` (name starts with the stack name):
#   aws cloudformation describe-stack-resources --stack-name <stack> \
#     --query "StackResources[?LogicalResourceId.starts_with(@,'BackupBucket')].PhysicalResourceId"
# Needs: aws, docker (a local engine — e.g. Colima), node + this repo's npm install.
# --forgejo-binary: a local linux binary of the PINNED version instead of the release download
#   (when the release host is unreachable) — e.g. copied out of the official image:
#   docker cp -L "$(docker create codeberg.org/forgejo/forgejo:<version>-rootless)":/app/gitea/gitea ./forgejo
#   Its version is checked against lib/pins.ts; its checksum cannot be (an image build ≠ the release file).
# --keep leaves the container running (http://127.0.0.1:<port>) and the files; delete them yourself.
# Nothing secret is printed: token NAMES and counts only; the check token lives
# inside the container and dies with it.
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
bucket="" prefix="" port=3300 keep=0 binary="" from=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bucket) bucket=$2; shift 2 ;;
    --prefix) prefix=$2; shift 2 ;;
    --port) port=$2; shift 2 ;;
    --keep) keep=1; shift ;;
    --forgejo-binary) binary=$2; shift 2 ;;
    --from-dir) from=$2; shift 2 ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$bucket$from" ] || { sed -n '8,10p' "$0" >&2; exit 2; }
name=forgejo-restore-test
work=$(mktemp -d)
chmod 700 "$work"
cleanup() {
  if [ "$keep" = 1 ]; then echo "kept: container $name, files $work"; return; fi
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$work"
  echo "cleaned up: container removed, local copy deleted"
}
trap cleanup EXIT

if [ -n "$from" ]; then
  echo "backup: $from"
  cp "$from/forgejo-dump.tar.gz" "$from/forgejo.db.gz" "$work/"
else
if [ -z "$prefix" ]; then
  prefix=$(aws s3api list-objects-v2 --bucket "$bucket" --prefix dumps/ --delimiter / \
    --query 'CommonPrefixes[].Prefix' --output text | tr '\t' '\n' | grep -v '^None$' | sort | tail -1)
fi
[ -n "$prefix" ] || { echo "no backup under s3://$bucket/dumps/" >&2; exit 1; }
echo "backup: $prefix"
aws s3 cp "s3://$bucket/${prefix%/}/forgejo-dump.tar.gz" "$work/" --only-show-errors
aws s3 cp "s3://$bucket/${prefix%/}/forgejo.db.gz" "$work/" --only-show-errors
fi

# This package's app.ini for the dump's own hostname; listening on all
# interfaces of the container (the box listens on 127.0.0.1 behind Caddy).
tar -xzf "$work/forgejo-dump.tar.gz" -C "$work" app.ini
host=$(sed -n 's/^DOMAIN *= *//p' "$work/app.ini" | head -1)
(cd "$here" && node --import tsx --input-type=module -e '
  const { renderAppIni } = await import("./lib/render.ts");
  process.stdout.write(renderAppIni({ hostname: process.argv[1] }).replace("HTTP_ADDR = 127.0.0.1", "HTTP_ADDR = 0.0.0.0"));
' "$host") > "$work/app.ini"
pin=$(cd "$here" && node --import tsx --input-type=module -e '
  const { FORGEJO } = await import("./lib/pins.ts");
  console.log(FORGEJO.url.replace("linux-arm64", "linux-" + process.argv[1]), FORGEJO.sha256, FORGEJO.version);
' "$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')")

[ -z "$binary" ] || install -m 0755 "$binary" "$work/forgejo-bin"
docker rm -f "$name" >/dev/null 2>&1 || true
# Copied in, not bind-mounted: a VM-backed engine (Colima) shares only $HOME, not the temp dir.
docker run -d --name "$name" -p "127.0.0.1:$port:3000" debian:bookworm-slim sleep infinity >/dev/null
docker cp -q "$work/." "$name:/restore"
docker exec -i -e PIN="$pin" "$name" bash -s <<'INNER'
set -euo pipefail
read -r url sha version <<< "$PIN"
apt-get update -qq && apt-get install -y -qq --no-install-recommends git sqlite3 curl xz-utils ca-certificates sudo >/dev/null
if [ -f /restore/forgejo-bin ]; then
  cp /restore/forgejo-bin /tmp/forgejo
  /tmp/forgejo --version | grep -q "version $version" || { echo "the given binary is not Forgejo $version" >&2; exit 1; }
  echo "(local binary of $version: checksum not verifiable)"
else
  curl -fsSL --retry 5 -o /tmp/forgejo.xz "$url" && xz -d /tmp/forgejo.xz
  case "$url" in *linux-arm64*) echo "$sha  /tmp/forgejo" | sha256sum -c --quiet ;; *) echo "(checksum pinned for arm64 only: not verified on this arch)" ;; esac
fi
install -m 0755 /tmp/forgejo /usr/local/bin/forgejo
useradd --system --create-home --shell /bin/bash git
W=/data/forgejo; X=/tmp/x; mkdir -p $W $X /etc/forgejo
tar -xzf /restore/forgejo-dump.tar.gz -C $X
# a server without any repo dumps no repos/ folder
if [ -d $X/repos ]; then cp -a $X/repos $W/repositories; else mkdir -p $W/repositories; fi
cp -a $X/data $W/data; cp -a $X/custom $W/custom
rm -f $W/data/forgejo.db*; gunzip -c /restore/forgejo.db.gz > $W/data/forgejo.db
install -m 0640 /restore/app.ini /etc/forgejo/app.ini
chown -R git:git $W /etc/forgejo
q() { sudo -u git sqlite3 "$W/data/forgejo.db" "$1"; }
fj() { sudo -u git /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path $W "$@"; }
fail=0; check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fail=1; fi; }

echo "forgejo $version, restored DB:"
check "DB integrity_check" '[ "$(q "PRAGMA integrity_check")" = ok ]'
sudo -u git nohup /usr/local/bin/forgejo web --config /etc/forgejo/app.ini --work-path $W >/tmp/forgejo.log 2>&1 &
for i in $(seq 1 60); do curl -fs -o /dev/null http://127.0.0.1:3000/api/healthz 2>/dev/null && break; sleep 1; done
check "server healthy on the restored state (hardened app.ini)" 'curl -fsS -o /dev/null http://127.0.0.1:3000/api/healthz'
fj admin regenerate hooks >/dev/null

users=$(q "SELECT count(*) FROM user WHERE type=0"); orgs=$(q "SELECT count(*) FROM user WHERE type=1")
admin=$(q "SELECT lower_name FROM user WHERE is_admin=1 AND type=0 ORDER BY id LIMIT 1")
echo "users: $users (admin: $admin), orgs: $orgs"
check "the CLI lists the same $users users" '[ "$(fj admin user list | tail -n +2 | wc -l)" = "$users" ]'

repos=$(q "SELECT count(*) FROM repository")
echo "repos: $repos"
tok=$(fj admin user generate-access-token --username "$admin" --token-name restore-check --scopes read:admin,read:organization,read:repository --raw)
H="Authorization: token $tok"
served=0 ondisk=0 fsck=0
while IFS='|' read -r id owner rname; do
  d="$W/repositories/$owner/$rname.git"
  [ -d "$d" ] && ondisk=$((ondisk+1))
  sudo -u git git -c safe.directory='*' -C "$d" fsck --no-progress >/dev/null 2>&1 && fsck=$((fsck+1))
  [ "$(curl -s -o /dev/null -w '%{http_code}' -H "$H" "http://127.0.0.1:3000/api/v1/repositories/$id")" = 200 ] && served=$((served+1))
done < <(q "SELECT id, lower(owner_name), lower_name FROM repository")
check "every repo on disk ($ondisk/$repos)" '[ "$ondisk" = "$repos" ]'
check "git fsck clean ($fsck/$repos)" '[ "$fsck" = "$repos" ]'
check "every repo served by the API ($served/$repos)" '[ "$served" = "$repos" ]'
one=$(q "SELECT lower(owner_name) || '/' || lower_name FROM repository WHERE is_empty=0 ORDER BY id LIMIT 1")
if [ -n "$one" ]; then
  want=$(sudo -u git git -c safe.directory='*' -C "$W/repositories/$one.git" rev-parse HEAD)
  got=$(git -c credential.helper= ls-remote "http://x:$tok@127.0.0.1:3000/$one.git" HEAD | cut -f1)
  check "git smart-HTTP serves $one at the same HEAD" '[ -n "$got" ] && [ "$got" = "$want" ]'
fi
unset tok H

echo "tokens (names only):"
q "SELECT u.lower_name, t.name FROM access_token t JOIN user u ON u.id=t.uid WHERE t.name<>'restore-check' ORDER BY u.lower_name, t.id" | sed 's/^/  /'
ntok=$(q "SELECT count(*) FROM access_token WHERE name<>'restore-check'")
echo "  total: $ntok"
check "the admin's connector token row is present" '[ "$(q "SELECT count(*) FROM access_token t JOIN user u ON u.id=t.uid WHERE u.lower_name='"'"'$admin'"'"' AND t.name LIKE '"'"'connector-%'"'"'")" -ge 1 ]'
[ "$fail" = 0 ] && echo "RESULT: restore OK" || { echo "RESULT: restore FAILED"; tail -20 /tmp/forgejo.log; exit 1; }
INNER
