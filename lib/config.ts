// Package parameters. Hereya hands them to the CDK app as plain env vars
// (camelCase), exactly like dilaya/aws-sqlite-data. Everything is validated at
// SYNTH time: a bad value fails the deploy before anything is touched.

export function input(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export interface ForgejoConfig {
  hostname: string;
  hostedZoneId: string;
  instanceType: string;
  amiId: string;
  dataVolumeGb: number;
  rootVolumeGb: number;
  maxBodyMb: number;
  backupRetentionDays: number;
  backupTimeUtc: string;
  snapshotTimeUtc: string;
  snapshotRetentionCount: number;
  webUiPublic: boolean;
  adminUsername: string;
  adminTokenParamName: string;
  autoDelete: boolean;
  telegramBotTokenParam: string;
  telegramChatId: string;
  healthProbeMinutes: number;
}

function int(name: string, fallback: string, min: number, max: number): number {
  const raw = input(name, fallback);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer in ${min}..${max}, got ${JSON.stringify(raw)}`);
  }
  return n;
}

function hhmm(name: string, fallback: string): string {
  const v = input(name, fallback);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`${name} must be HH:MM (UTC), got ${JSON.stringify(v)}`);
  return v;
}

export function readConfig(stackName: string): ForgejoConfig {
  const hostname = input("hostname", "").toLowerCase();
  // The hostname is load-bearing (DNS record, certificate, ROOT_URL): no default.
  if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new Error(`hostname must be a fully-qualified DNS name, got ${JSON.stringify(hostname)}`);
  }
  const hostedZoneId = input("hostedZoneId", "");
  if (!/^Z[A-Z0-9]{5,40}$/.test(hostedZoneId)) {
    throw new Error(`hostedZoneId must be a Route 53 hosted zone id (Z...), got ${JSON.stringify(hostedZoneId)}`);
  }
  const telegramBotTokenParam = input("telegramBotTokenParam", "");
  const telegramChatId = input("telegramChatId", "");
  if ((telegramBotTokenParam === "") !== (telegramChatId === "")) {
    throw new Error("telegramBotTokenParam and telegramChatId must be given together (or neither)");
  }
  const adminUsername = input("adminUsername", "dilaya-admin");
  if (!/^[a-z][a-z0-9-]{2,38}$/.test(adminUsername)) throw new Error(`invalid adminUsername ${JSON.stringify(adminUsername)}`);
  return {
    hostname,
    hostedZoneId,
    instanceType: input("instanceType", "t4g.small"),
    amiId: input("amiId", ""),
    dataVolumeGb: int("dataVolumeGb", "20", 8, 16384),
    rootVolumeGb: int("rootVolumeGb", "10", 8, 100),
    maxBodyMb: int("maxBodyMb", "64", 1, 1024),
    backupRetentionDays: int("backupRetentionDays", "30", 1, 3650),
    backupTimeUtc: hhmm("backupTimeUtc", "02:30"),
    snapshotTimeUtc: hhmm("snapshotTimeUtc", "03:30"),
    snapshotRetentionCount: int("snapshotRetentionCount", "7", 1, 1000),
    webUiPublic: input("webUiPublic", "false") === "true",
    adminUsername,
    adminTokenParamName: input("adminTokenParamName", `/dilaya/forgejo/${stackName}/admin-token`),
    autoDelete: input("autoDelete", "false") === "true",
    telegramBotTokenParam,
    telegramChatId,
    healthProbeMinutes: int("healthProbeMinutes", "5", 1, 60),
  };
}
