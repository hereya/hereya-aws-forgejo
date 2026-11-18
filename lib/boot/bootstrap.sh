#!/bin/bash
# First boot of a Forgejo box (runs ONCE per instance, from cloud-init).
# Everything durable lives on the data volume; this script is idempotent with
# respect to it, so a replacement instance re-attaches the same volume and
# comes back with the same repos, DB, secrets and certificate.
# NEVER add `set -x`: the admin token passes through this machine.
set -euo pipefail
. /etc/forgejo-box/env
log() { echo "forgejo-box: $(date -u +%FT%TZ) $*"; }
export AWS_DEFAULT_REGION="$FG_REGION"

log "packages"
dnf install -y -q git xz tar sqlite >/dev/null

log "swap (1 GiB safety net for large commits)"
if [ ! -f /swapfile ]; then
  dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
  chmod 600 /swapfile && mkswap /swapfile >/dev/null
  echo '/swapfile none swap defaults 0 0' >> /etc/fstab
fi
swapon -a || true

log "binaries (pinned + checksummed)"
# fetch <official url> <file>: the stack's S3 mirror first (filled by the deploy, same
# bytes), the official URL only if the mirror has no copy. Either way the checksum
# below decides.
fetch() {
  aws s3 cp --only-show-errors "$FG_MIRROR/${1##*/}" "$2" && return
  log "mirror miss for ${1##*/}: official URL"
  curl -fsSL --retry 5 -o "$2" "$1"
}
work=$(mktemp -d)
fetch "$FG_FORGEJO_URL" "$work/forgejo.xz"
xz -d "$work/forgejo.xz"
echo "$FG_FORGEJO_SHA256  $work/forgejo" | sha256sum -c --quiet
install -m 0755 "$work/forgejo" /usr/local/bin/forgejo
fetch "$FG_CADDY_URL" "$work/caddy.tgz"
echo "$FG_CADDY_SHA512  $work/caddy.tgz" | sha512sum -c --quiet
tar -xzf "$work/caddy.tgz" -C "$work" caddy
install -m 0755 "$work/caddy" /usr/local/bin/caddy
rm -rf "$work"

log "data volume $FG_VOLUME_ID"
imds=$(curl -fsS -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 300' http://169.254.169.254/latest/api/token)
me=$(curl -fsS -H "X-aws-ec2-metadata-token: $imds" http://169.254.169.254/latest/meta-data/instance-id)
dev="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_${FG_VOLUME_ID//-/}"
# A replacement instance boots while its predecessor still holds the volume
# (CloudFormation deletes the old instance only at cleanup): wait for it.
for i in $(seq 1 180); do
  read -r state owner < <(aws ec2 describe-volumes --volume-ids "$FG_VOLUME_ID" \
    --query 'Volumes[0].[State,Attachments[0].InstanceId]' --output text)
  if [ "$owner" = "$me" ] && [ -e "$dev" ]; then break; fi
  if [ "$state" = "available" ]; then
    aws ec2 attach-volume --volume-id "$FG_VOLUME_ID" --instance-id "$me" --device /dev/sdf >/dev/null || true
  fi
  [ "$i" = 180 ] && { log "FATAL: volume never became attachable"; exit 1; }
  sleep 10
done
udevadm settle
if ! blkid "$dev" >/dev/null 2>&1; then
  log "formatting EMPTY data volume (first launch)"
  mkfs.xfs -q -L forgejo-data "$dev"
fi
uuid=$(blkid -s UUID -o value "$dev")
mkdir -p /data
grep -q "$uuid" /etc/fstab || echo "UUID=$uuid /data xfs defaults,nofail 0 2" >> /etc/fstab
mountpoint -q /data || mount /data

log "users + directories"
id git >/dev/null 2>&1 || useradd --system --home-dir /home/git --create-home --shell /bin/bash git
id caddy >/dev/null 2>&1 || useradd --system --home-dir /var/lib/caddy --create-home --shell /sbin/nologin caddy
mkdir -p "$FG_WORK"/{custom/secrets,data,log,repositories} /data/caddy /data/forgejo-box /etc/forgejo
chown -R git:git "$FG_WORK" && chown -R caddy:caddy /data/caddy
chmod 0700 "$FG_WORK/custom/secrets"
for s in secret_key:SECRET_KEY internal_token:INTERNAL_TOKEN oauth2_jwt_secret:JWT_SECRET lfs_jwt_secret:JWT_SECRET; do
  f="$FG_WORK/custom/secrets/${s%%:*}"
  if [ ! -s "$f" ]; then
    (umask 077; /usr/local/bin/forgejo generate secret "${s##*:}" > "$f")
    chown git:git "$f"
  fi
done
install -o git -g git -m 0640 /etc/forgejo-box/app.ini /etc/forgejo/app.ini
install -o root -g caddy -m 0640 /etc/forgejo-box/Caddyfile /etc/forgejo/Caddyfile

log "services"
systemctl daemon-reload
systemctl enable --now forgejo.service caddy.service forgejo-metrics.timer forgejo-backup.timer
for i in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$FG_PORT/api/healthz" && break
  [ "$i" = 60 ] && { log "FATAL: forgejo never became healthy"; exit 1; }
  sleep 2
done

log "admin user + connector token"
fj() { sudo -u git /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path "$FG_WORK" "$@"; }
if ! fj admin user list --admin | awk 'NR>1{print $2}' | grep -qx "$FG_ADMIN_USER"; then
  # Random password, discarded (never printed): the account is used through its
  # token; an admin who needs the web UI resets it over SSM (README).
  fj admin user create --admin --username "$FG_ADMIN_USER" --email "$FG_ADMIN_USER@localhost.invalid" \
    --random-password --must-change-password=false >/dev/null
fi
/usr/local/sbin/forgejo-box-token

log "first backup"
systemctl start forgejo-backup.service || log "WARNING: first backup failed"
log "ready"
