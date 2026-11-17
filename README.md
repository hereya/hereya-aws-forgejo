# dilaya/aws-forgejo

Hereya package (`iac: cdk`, `infra: aws`) that runs **one Forgejo git server** for Dilaya:

```
internet ──443──► EIP ─► EC2 t4g (AL2023 arm64, IMDSv2, no SSH)
                          ├─ Caddy 2.11.9  : Let's Encrypt (TLS-ALPN-01), request body cap (413)
                          │                   only /api/* + git smart-HTTP proxied (default)
                          └─ Forgejo 17.0.1 : 127.0.0.1:3000, SQLite (WAL)
                               └─ /data  = separate encrypted gp3 volume (repos, DB, secrets, certificate)
daily 02:30 UTC  forgejo dump ──stream──► S3 (versioned, SSE-S3, TLS-only, 30-day lifecycle)
daily 03:30 UTC  DLM snapshot of /data (7 kept)
every 5 min      box metrics (DiskUsedPercent, BackupAgeHours) + in-region HTTPS probe (HealthOk)
alarms (4)  ───► SNS topic ──(optional)──► Telegram relay (same as dilaya/aws-sqlite-data)
```

Parameters: see `hereyarc.yaml` (only `hostname` and `hostedZoneId` are mandatory).

Outputs (consumer env): `forgejoUrl`, `forgejoAdminTokenParam` (the SSM **name**, never the token),
`forgejoBackupBucketName`, `forgejoInstanceId`, `iamPolicyForgejoToken` (ssm:GetParameter on that
one parameter — auto-attached to the consumer's role by Hereya).

## Design choices

- **The data volume is its own resource**, attached by the instance at boot (`ec2:AttachVolume`,
  restricted by the `forgejo-stack` tag). An instance replacement (new pin, new parameter, new
  user data) boots a new VM that waits until CloudFormation has terminated the old one, then
  re-attaches the same volume: same repos, DB, secrets and certificate. Expect **2–5 min of
  downtime** per replacement. The volume is `Retain` unless `autoDelete=true`.
- **Any config change replaces the instance** (`userDataCausesReplacement`): cloud-init runs user
  data once per instance, so an in-place stop/start would silently keep the old config.
- **AMI pinned** in `lib/pins.ts` (as in aws-sqlite-data): a deploy never replaces the VM because
  AWS published an image. Forgejo and Caddy are pinned to an exact version AND a checksum.
- **Secrets** (`SECRET_KEY`, `INTERNAL_TOKEN`, JWT secrets) are generated once on the data volume
  and referenced by `*_URI = file:` in `app.ini`, so app.ini is rewritten safely at every launch.
- **Body cap in Caddy**: Forgejo itself has no API body limit and uses ~5x the body in memory.
- **Health check = a tiny Lambda**, not Route 53 (its metrics live only in us-east-1, out of reach
  of this region's SNS topic) nor Synthetics (~10 $/month at 5 min).
- **Admin token**: minted at first boot by `forgejo-box-token`, written to SSM SecureString through
  a 0600 temp file (never in argv, logs, or outputs). Deleted from SSM with the stack.

## Operations (all over SSM Session Manager — there is no SSH)

```sh
aws ssm start-session --target <forgejoInstanceId>
sudo journalctl -u forgejo -u caddy --since -1h
sudo cat /var/log/forgejo-box-bootstrap.log
```

**Web UI for an admin** (not public by default):

```sh
# on the box, once: give the admin a password (prompted, never in a log)
sudo -u git forgejo --config /etc/forgejo/app.ini --work-path /data/forgejo \
  admin user change-password --username dilaya-admin --password "$(read -rsp 'pw: ' p; echo "$p")"
# from the laptop
aws ssm start-session --target <id> --document-name AWS-StartPortForwardingSession \
  --parameters portNumber=3000,localPortNumber=3000
# then http://localhost:3000
```

**Token rotation**: on the box `sudo /usr/local/sbin/forgejo-box-token --rotate` (new token,
parameter overwritten), then delete the old `connector-*` token:
`DELETE /api/v1/users/dilaya-admin/tokens/<name>` with the new token. The connector must re-read
the parameter (cold start or cache expiry).

**Manual backup**: `sudo systemctl start forgejo-backup.service`.

**Grow the data disk**: `aws ec2 modify-volume --volume-id <id> --size <GB>`, then on the box
`sudo xfs_growfs /data`. Update `dataVolumeGb` to match (otherwise the next deploy tries to shrink
it and fails).

## Restore runbook

Each daily backup is a folder `s3://<bucket>/dumps/<UTC>/` with two objects:

- `forgejo.db.gz` — a consistent copy of the SQLite DB (`VACUUM INTO`, integrity-checked before
  upload). **This is what a restore uses.**
- `forgejo-dump.tar.gz` — `forgejo dump`: `repos/`, `custom/` (incl. `custom/secrets/`),
  `data/`, `app.ini`, and `forgejo-db.sql`. ⚠️ That SQL is **not** replayable with the OS sqlite
  (AL2023 ships 3.40; Forgejo 17 writes `unistr()`, SQLite ≥ 3.50) — found in the 17/11 trial. It
  stays for portability (a later move to PostgreSQL).

Tested on the trial stack (17/11/2026): the newest backup restored into a second Forgejo on the
same box — DB integrity ok, same repos and users, same `main` commit per repo, `git fsck` clean,
the restored server healthy.

1. On the target box (a fresh stack, or the same one): `sudo systemctl stop forgejo`.
2. Fetch and unpack:
   ```sh
   B=s3://<bucket>/dumps/<UTC>; R=/data/restore; sudo mkdir -p $R/x
   sudo aws s3 cp $B/forgejo-dump.tar.gz $R/ && sudo aws s3 cp $B/forgejo.db.gz $R/
   sudo tar -xzf $R/forgejo-dump.tar.gz -C $R/x
   ```
3. Replace the state (the current one is moved aside, not deleted):
   ```sh
   old=/data/pre-restore-$(date +%s); sudo mkdir $old
   cd /data/forgejo && sudo mv repositories data custom $old/
   sudo cp -a $R/x/repos /data/forgejo/repositories
   sudo cp -a $R/x/data /data/forgejo/data
   sudo cp -a $R/x/custom /data/forgejo/custom
   sudo rm -f /data/forgejo/data/forgejo.db*
   gunzip -c $R/forgejo.db.gz | sudo tee /data/forgejo/data/forgejo.db >/dev/null
   sudo chown -R git:git /data/forgejo
   ```
4. `sudo systemctl start forgejo`, then
   `sudo -u git forgejo --config /etc/forgejo/app.ini --work-path /data/forgejo admin regenerate hooks`.
5. **Always** re-mint the connector token afterwards: `sudo /usr/local/sbin/forgejo-box-token --rotate`.
   (In the trial the restored instance answered 401 to the pre-restore token; the cause was not
   established — treat the old token as invalid after any restore.)

From an EBS snapshot instead: create a volume from the snapshot in the instance's AZ, stop the
stack's instance, swap it in (detach old / attach new as `/dev/sdf`), start. Or restore the snapshot
over the stack's volume id by passing it through a new stack (follow-up: a `snapshotId` parameter).

## Upgrades

Bump the pin in `lib/pins.ts` (version, URL, checksum from the release page), `npm test`, publish,
roll out through a consumer release. The deploy replaces the instance (downtime 2–5 min); Forgejo
migrates the DB on start. **Take a manual backup first.** Read the Forgejo release notes for
breaking changes before a MAJOR bump. OS: bump `PINNED_AMI_IDS` the same way.

## Teardown

With `autoDelete=false` (default) a stack delete **keeps** the data volume and the backup bucket.
DLM snapshots are never deleted by CloudFormation: list them with
`aws ec2 describe-snapshots --owner-ids self --filters Name=tag:forgejo-stack,Values=<stack>`.
The log groups of the three CDK-provided custom-resource Lambdas (`/aws/lambda/<stack>-AWS679f…`,
`-CustomS3AutoDeleteObject…`, `-CustomVpcRestrictDefault…`) are also left behind. Both were
observed and deleted by hand after the 17/11 trial.

## Develop

```sh
npm install
npm run typecheck && npm test
hostname=git.example.test hostedZoneId=ZEXAMPLE12345 npx cdk synth
```

`.ts` files stay ≤ 220 lines (CI guard).
