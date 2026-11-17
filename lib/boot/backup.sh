#!/bin/bash
# Daily backup, two objects under dumps/<UTC>/ :
#  - forgejo.db.gz : a CONSISTENT copy of the SQLite DB (VACUUM INTO) — what a restore uses.
#    The SQL in the dump is NOT replayable on this OS: Forgejo writes unistr(), which
#    needs SQLite >= 3.50 (AL2023 ships 3.40) — found in the 17/11 trial.
#  - forgejo-dump.tar.gz : `forgejo dump` (repos, custom dir incl. secrets, data, SQL),
#    streamed straight to S3, no local copy.
# Success is a timestamp on the data volume; forgejo-metrics turns it into BackupAgeHours.
set -euo pipefail
. /etc/forgejo-box/env
export AWS_DEFAULT_REGION="$FG_REGION"
ts=$(date -u +%Y%m%dT%H%M%SZ)
prefix="dumps/$ts"
tmp="$FG_WORK/dump-tmp"
rm -rf "$tmp" && install -d -o git -g git -m 0700 "$tmp"
cd "$FG_WORK"
sudo -u git sqlite3 "$FG_WORK/data/forgejo.db" "VACUUM INTO '$tmp/forgejo.db'"
sudo -u git sqlite3 "$tmp/forgejo.db" "PRAGMA integrity_check" | grep -qx ok
gzip -c "$tmp/forgejo.db" | aws s3 cp - "s3://$FG_BUCKET/$prefix/forgejo.db.gz" --only-show-errors
rm -f "$tmp/forgejo.db"
sudo -u git /usr/local/bin/forgejo --config /etc/forgejo/app.ini --work-path "$FG_WORK" \
  dump --type tar.gz --file - --tempdir "$tmp" --skip-log 2>/var/log/forgejo-dump.log \
  | aws s3 cp - "s3://$FG_BUCKET/$prefix/forgejo-dump.tar.gz" --only-show-errors
rm -rf "$tmp"
size=$(aws s3api head-object --bucket "$FG_BUCKET" --key "$prefix/forgejo-dump.tar.gz" --query ContentLength --output text)
# A dump of an empty instance is a few KB; anything under 1 KB is a broken pipe.
[ "$size" -gt 1024 ] || { echo "forgejo-backup: $prefix dump is only $size bytes" >&2; exit 1; }
date -u +%s > /data/forgejo-box/last-backup
echo "forgejo-backup: s3://$FG_BUCKET/$prefix/ (dump $size bytes)"
/usr/local/sbin/forgejo-box-metrics
