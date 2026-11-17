// Assembles the instance user data: one env file (the only place deploy-time
// tokens such as the volume id or the bucket name appear), the two rendered
// configs, the box scripts and their systemd units, then runs bootstrap.sh.
import * as ec2 from "aws-cdk-lib/aws-ec2";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgejoConfig } from "./config.ts";
import { CADDY, FORGEJO } from "./pins.ts";
import { FORGEJO_PORT, FORGEJO_WORK, renderAppIni, renderCaddyfile } from "./render.ts";

const bootDir = join(dirname(fileURLToPath(import.meta.url)), "boot");
const script = (name: string): string => readFileSync(join(bootDir, name), "utf8");

export interface UserDataRefs {
  region: string;
  stackName: string;
  volumeId: string;
  bucketName: string;
}

/** A file written verbatim: the quoted heredoc delimiter disables all expansion. */
function file(path: string, mode: string, body: string): string {
  const tag = "FORGEJO_BOX_EOF";
  if (body.includes(tag)) throw new Error(`${path} contains the heredoc delimiter`);
  return `install -d "$(dirname ${path})"\ncat > ${path} <<'${tag}'\n${body.replace(/\n$/, "")}\n${tag}\nchmod ${mode} ${path}`;
}

function unit(description: string, body: string): string {
  return `[Unit]\nDescription=${description}\n${body}`;
}

export const UNITS: Record<string, string> = {
  "forgejo.service": unit(
    "Forgejo git server",
    `After=network-online.target data.mount\nWants=network-online.target\nRequiresMountsFor=/data\n\n[Service]\nUser=git\nGroup=git\nWorkingDirectory=${FORGEJO_WORK}\nEnvironment=USER=git HOME=/home/git GITEA_WORK_DIR=${FORGEJO_WORK}\nExecStart=/usr/local/bin/forgejo web --config /etc/forgejo/app.ini\nRestart=always\nRestartSec=3\nLimitNOFILE=65536\n\n[Install]\nWantedBy=multi-user.target\n`,
  ),
  "caddy.service": unit(
    "Caddy TLS front for Forgejo",
    `After=network-online.target forgejo.service\nWants=network-online.target\nRequiresMountsFor=/data\n\n[Service]\nUser=caddy\nGroup=caddy\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nEnvironment=HOME=/var/lib/caddy\nExecStart=/usr/local/bin/caddy run --config /etc/forgejo/Caddyfile --adapter caddyfile\nRestart=always\nRestartSec=3\nLimitNOFILE=65536\n\n[Install]\nWantedBy=multi-user.target\n`,
  ),
  "forgejo-backup.service": unit(
    "Forgejo dump to S3",
    `RequiresMountsFor=/data\n\n[Service]\nType=oneshot\nExecStart=/usr/local/sbin/forgejo-box-backup\n`,
  ),
  "forgejo-metrics.service": unit(
    "Forgejo box metrics",
    `[Service]\nType=oneshot\nExecStart=/usr/local/sbin/forgejo-box-metrics\n`,
  ),
  "forgejo-metrics.timer": unit(
    "Forgejo box metrics every 5 min",
    `\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=5min\n\n[Install]\nWantedBy=timers.target\n`,
  ),
};

export function backupTimer(cfg: ForgejoConfig): string {
  return unit(
    "Daily Forgejo dump",
    `\n[Timer]\nOnCalendar=*-*-* ${cfg.backupTimeUtc}:00 UTC\nPersistent=true\n\n[Install]\nWantedBy=timers.target\n`,
  );
}

export function envFile(cfg: ForgejoConfig, refs: UserDataRefs): string {
  return [
    `FG_REGION=${refs.region}`,
    `FG_STACK=${refs.stackName}`,
    `FG_VOLUME_ID=${refs.volumeId}`,
    `FG_BUCKET=${refs.bucketName}`,
    `FG_TOKEN_PARAM=${cfg.adminTokenParamName}`,
    `FG_ADMIN_USER=${cfg.adminUsername}`,
    `FG_WORK=${FORGEJO_WORK}`,
    `FG_PORT=${FORGEJO_PORT}`,
    `FG_FORGEJO_URL=${FORGEJO.url}`,
    `FG_FORGEJO_SHA256=${FORGEJO.sha256}`,
    `FG_CADDY_URL=${CADDY.url}`,
    `FG_CADDY_SHA512=${CADDY.sha512}`,
  ].join("\n");
}

export function buildUserData(cfg: ForgejoConfig, refs: UserDataRefs): ec2.UserData {
  const ud = ec2.UserData.forLinux();
  const parts = [
    "set -euo pipefail",
    file("/etc/forgejo-box/env", "0644", envFile(cfg, refs)),
    file("/etc/forgejo-box/app.ini", "0644", renderAppIni(cfg)),
    file("/etc/forgejo-box/Caddyfile", "0644", renderCaddyfile(cfg)),
    file("/usr/local/sbin/forgejo-box-bootstrap", "0755", script("bootstrap.sh")),
    file("/usr/local/sbin/forgejo-box-token", "0755", script("token.sh")),
    file("/usr/local/sbin/forgejo-box-backup", "0755", script("backup.sh")),
    file("/usr/local/sbin/forgejo-box-metrics", "0755", script("metrics.sh")),
    ...Object.entries({ ...UNITS, "forgejo-backup.timer": backupTimer(cfg) }).map(([name, body]) =>
      file(`/etc/systemd/system/${name}`, "0644", body),
    ),
    "/usr/local/sbin/forgejo-box-bootstrap 2>&1 | tee -a /var/log/forgejo-box-bootstrap.log",
  ];
  ud.addCommands(...parts);
  return ud;
}
