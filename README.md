# dilaya/aws-forgejo

Hereya package (`iac: cdk`, `infra: aws`) that runs **one Forgejo git server** for Dilaya:

```
internet ──443──► EIP ─► EC2 t4g (AL2023 arm64, IMDSv2, no SSH)
                          ├─ Caddy 2.11.9  : Let's Encrypt (TLS-ALPN-01), request body cap (413)
                          │                   only /api/* + git smart-HTTP proxied (default)
                          └─ Forgejo 17.0.1 : 127.0.0.1:3000, SQLite (WAL)
                               └─ /data  = separate encrypted gp3 volume (repos, DB, secrets, certificate)
daily 02:30 UTC  forgejo dump ──stream──► S3 (versioned, SSE-S3, TLS-only, 30-day lifecycle)
first boot       Forgejo + Caddy from the stack's own S3 mirror (filled by the deploy), official URL as fallback
daily 03:30 UTC  DLM snapshot of /data (7 kept)
every 5 min      box metrics (DiskUsedPercent, BackupAgeHours) + in-region HTTPS probe (HealthOk)
alarms (4)  ───► SNS topic ──(optional)──► Telegram relay (same as dilaya/aws-sqlite-data)
```

Parameters: see `hereyarc.yaml`. Nothing is created unless `forgejoEnabled=true`; then `forgejoHostname` and `forgejoHostedZoneId` are required. The three are prefixed on purpose: Hereya hands a consumer's `-p` parameters to EVERY package of that consumer under their own name, so a generic name would reach the others.

Outputs (consumer env): `forgejoUrl`, `forgejoAdminTokenParam` (the SSM **name**, never the token),
`iamPolicyForgejoToken` (ssm:GetParameter on that one parameter — auto-attached to the consumer's role by
Hereya). Nothing else on purpose: every output lands in the consumer's Lambda env (4 KB cap). The instance
and the backup bucket carry the stack's tags: `aws ec2 describe-instances --filters
Name=tag:aws:cloudformation:stack-name,Values=<stack>` and `aws s3api list-buckets` (name starts with the stack).

## Design choices

- **The data volume is its own resource**, attached by the instance at boot (`ec2:AttachVolume`,
  restricted by the `forgejo-stack` tag). An instance replacement (new pin, new parameter, new
  user data) boots a new VM that waits until CloudFormation has terminated the old one, then
  re-attaches the same volume: same repos, DB, secrets and certificate. Expect **2–5 min of
  downtime** per replacement. The volume is `Retain` unless `autoDelete=true`.
- **Any config change replaces the instance** (`userDataCausesReplacement`): cloud-init runs user
  data once per instance, so an in-place stop/start would silently keep the old config.
- **AMI pinned** in `lib/pins.ts` (as in aws-sqlite-data): a deploy never replaces the VM because
  AWS published an image. Forgejo and Caddy are pinned to an exact version AND a checksum, and
  a replacement VM installs them from the stack's own S3 copy (see "Binary mirror").
- **Secrets** (`SECRET_KEY`, `INTERNAL_TOKEN`, JWT secrets) are generated once on the data volume
  and referenced by `*_URI = file:` in `app.ini`, so app.ini is rewritten safely at every launch.
- **Body cap in Caddy**: Forgejo itself has no API body limit and uses ~5x the body in memory.
- **Health check = a tiny Lambda**, not Route 53 (its metrics live only in us-east-1, out of reach
  of this region's SNS topic) nor Synthetics (~10 $/month at 5 min).
- **Admin token**: minted at first boot by `forgejo-box-token`, written to SSM SecureString through
  a 0600 temp file (never in argv, logs, or outputs). Deleted from SSM with the stack. Scoped
  `write:admin,write:organization,write:repository` (never `all`, see "Admin token scopes").
- **Hardened app.ini** (0.1.3, on top of: registration off, sign-in required to view, everything
  private, SSH/mail/OpenID/OAuth2/Actions/packages/federation/swagger off): `DISABLE_FORKS` (a
  per-repo account must not copy its repo out of its fence), `DISABLE_MIGRATIONS` and
  `DISABLE_WEBHOOKS` (both make the server fetch a URL a user chose — SSRF), the users page off,
  `DISABLE_REGULAR_ORG_CREATION` (only the admin creates orgs).

## Admin token scopes

Every call the connector's Forgejo forge makes, and the scope Forgejo checks for it (each
of the three was shown necessary on 17.0.1: dropping it turns its calls into 403):

| Connector call | Endpoint | Scope |
|---|---|---|
| repo accounts: create, delete; their tokens: list, mint, delete; list users (token sweep) | `POST/DELETE /admin/users[/{u}]`, `GET/POST/DELETE /admin/users/{u}/tokens[/{id}]`, `GET /admin/users` | `write:admin` |
| create the org; create a repo in it; list its repos (templates) | `POST /orgs`, `POST /orgs/{org}/repos`, `GET /orgs/{org}/repos` | `write:organization` |
| a repo by id; rename + archive; collaborator; file read; archive zip; generate from template | `GET /repositories/{id}`, `PATCH /repos/{o}/{r}`, `PUT /repos/{o}/{r}/collaborators/{u}`, `GET …/contents/…`, `GET …/archive/…`, `POST /repos/{o}/{t}/generate` | `write:repository` |

The tokens the connector hands an agent are a different thing: minted for a per-repo account,
`write:repository` or `read:repository` only, limited to that one repo.

**A running server gets the new scopes by itself**: `forgejo-box-token` keeps the stored
token only if a marker on the data volume (`/data/forgejo-box/token-scopes`) names the current
scopes. A box upgraded from 0.1.2 has no marker, so the boot of its replacement instance mints a
scoped token, overwrites the parameter and deletes the old `all` token. Without a deploy, the same
on the box: `sudo /usr/local/sbin/forgejo-box-token --rotate`.

## Operations (all over SSM Session Manager — there is no SSH)

```sh
aws ssm start-session --target <instance id — see Outputs above>
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

**Token rotation**: on the box `sudo /usr/local/sbin/forgejo-box-token --rotate`, or from the laptop
`aws ssm send-command --instance-ids <id> --document-name AWS-RunShellScript --parameters 'commands=["/usr/local/sbin/forgejo-box-token --rotate"]'`.
It mints a new token, overwrites the parameter, then deletes every OTHER `connector-*` token of
the admin (through the local API, the token in a 0600 header file). Idempotent. The connector
re-reads the parameter on its next 401 (and every 15 min).

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
5. Re-mint the connector token afterwards: `sudo /usr/local/sbin/forgejo-box-token --rotate`.
   (In the 17/11 trial the restored instance answered 401 to the pre-restore token; in the 18/11
   restore test, tokens minted before the backup — admin and repo-limited — still worked after the
   restore, fence included. Re-minting stays the rule: it costs nothing.)

**Restore test** (local, read-only on AWS): `scripts/restore-test.sh --bucket <backup bucket>`
fetches the newest dump, restores it into a throwaway local Forgejo of the pinned version in a
container (this package's app.ini), checks DB integrity, users, every repo (on disk, `git fsck`,
served by the API, one cloned over smart-HTTP at the same HEAD) and the token rows, prints names
and counts only, then deletes the container and the local copy. `--from-dir` takes a backup on
disk instead; `--forgejo-binary` a local binary when the release host is unreachable.

From an EBS snapshot instead: create a volume from the snapshot in the instance's AZ, stop the
stack's instance, swap it in (detach old / attach new as `/dev/sdf`), start. Or restore the snapshot
over the stack's volume id by passing it through a new stack (follow-up: a `snapshotId` parameter).

## Binary mirror

Why: on 2026-11-18 codeberg.org stopped resolving. A replacement instance downloads Forgejo at
first boot; it could not, and never served. Any third-party site (code.forgejo.org for Forgejo,
GitHub for Caddy) can do the same, so the box no longer needs one at boot.

- **Where**: a dedicated bucket of the stack (`MirrorBucket`: SSE-S3, private, TLS-only, no
  lifecycle), objects under `mirror/<file name of the official URL>` — e.g.
  `mirror/forgejo-17.0.1-linux-arm64.xz`. Not a prefix of the backup bucket: its 30-day dump
  lifecycle covers the whole bucket and would expire the binaries. Same removal policy as the
  backup bucket (`autoDelete`).
- **Who writes**: the deploy, never a human. `Custom::ForgejoBinaryMirror` (Lambda
  `lib/mirror/index.js`, behind the CDK provider framework) gets the list of
  `MIRROR_ARTEFACTS` (`lib/mirror.ts`, one per artefact of `lib/pins.ts`). For each one it keeps
  the object if its metadata already carries the pinned checksum (idempotent: a deploy that
  changes nothing downloads nothing); otherwise it downloads the official URL, checks the
  checksum, and only then writes. Its role: `s3:GetObject` + `s3:PutObject` on `mirror/*` only.
- **Fails early**: the instance depends on that resource. An official URL that is down, or a
  checksum that no longer matches, fails the deploy BEFORE the instance is replaced; CloudFormation
  rolls back and the old box keeps serving.
- **Who reads**: the box, `s3:GetObject` on `mirror/*` of that bucket and nothing else
  (through the VPC's S3 gateway endpoint). `forgejo-box-bootstrap` tries the mirror first and
  falls back to the official URL only on a miss (logged `mirror miss for …`). The checksum check
  after the download is unchanged and applies to both sources: a tampered copy stops the boot.
- **Checksums**: Forgejo's pinned `sha256` is of the DECOMPRESSED binary (what the box checks);
  the mirror checks `xzSha256`, the published checksum of the `.xz` itself (`…xz.sha256` on the
  release page), so it never has to decompress. Caddy: the tarball's `sha512` serves both.
- **Synth stays offline** (no BucketDeployment of synth-time downloads: that needs the network
  at synth, ships ~50 MB of CDK assets per pin change, and checks nothing on the AWS side).

**How a pin change flows**: bump version, URL and checksum(s) in `lib/pins.ts` (for Forgejo both
`sha256` and `xzSha256`) → `npm test` (fails if an artefact has no mirror entry) → publish →
consumer release. During that deploy: the mirror resource is UPDATED (its properties carry the new
URLs and checksums) and writes the new objects next to the old ones (old keys are kept, so a
rollback to the previous pins still finds its binaries) → only then CloudFormation creates the
replacement instance, which installs from the mirror. Older objects are never deleted
automatically; they are small (~50 MB per pin pair) and can be removed by hand.

## Upgrades

Bump the pin in `lib/pins.ts` (version, URL, checksum(s) from the release page — see "Binary mirror"), `npm test`, publish,
roll out through a consumer release. The deploy replaces the instance (downtime 2–5 min); Forgejo
migrates the DB on start. **Take a manual backup first.** Read the Forgejo release notes for
breaking changes before a MAJOR bump. OS: bump `PINNED_AMI_IDS` the same way.

## Teardown

With `autoDelete=false` (default) a stack delete **keeps** the data volume, the backup bucket and the
binary mirror bucket (the latter holds nothing that cannot be downloaded again: delete it by hand).
DLM snapshots are never deleted by CloudFormation: list them with
`aws ec2 describe-snapshots --owner-ids self --filters Name=tag:forgejo-stack,Values=<stack>`.
The log groups of the three CDK-provided custom-resource Lambdas (`/aws/lambda/<stack>-AWS679f…`,
`-CustomS3AutoDeleteObject…`, `-CustomVpcRestrictDefault…`) are also left behind. Both were
observed and deleted by hand after the 17/11 trial.

## Develop

```sh
npm install
npm run typecheck && npm test
forgejoEnabled=true forgejoHostname=git.example.test forgejoHostedZoneId=ZEXAMPLE12345 npx cdk synth
```

`.ts` files stay ≤ 220 lines (CI guard).
