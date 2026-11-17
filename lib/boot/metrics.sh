#!/bin/bash
# Every 5 min: the fuller of the two disks, and the age of the last good backup.
set -euo pipefail
. /etc/forgejo-box/env
export AWS_DEFAULT_REGION="$FG_REGION"
disk=$(df --output=pcent / /data | tail -n +2 | tr -dc '0-9\n' | sort -n | tail -1)
if [ -s /data/forgejo-box/last-backup ]; then
  age=$(( ($(date -u +%s) - $(cat /data/forgejo-box/last-backup)) / 3600 ))
else
  age=999
fi
aws cloudwatch put-metric-data --namespace Dilaya/Forgejo --metric-data \
  "MetricName=DiskUsedPercent,Dimensions=[{Name=stack,Value=$FG_STACK}],Value=$disk,Unit=Percent" \
  "MetricName=BackupAgeHours,Dimensions=[{Name=stack,Value=$FG_STACK}],Value=$age,Unit=None"
