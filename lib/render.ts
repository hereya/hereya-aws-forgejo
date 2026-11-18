// The two config files of the box, rendered at SYNTH time from the package
// parameters (all plain strings — no CloudFormation token can reach them), so
// the tests read exactly what the VM will run.
import type { ForgejoConfig } from "./config.ts";

export const DATA_DIR = "/data";
export const FORGEJO_WORK = "/data/forgejo";
export const FORGEJO_PORT = 3000;

/**
 * Scopes of the connector's admin token — the least that covers every call the
 * connector's Forgejo forge makes (README "Admin token scopes" maps each one):
 * repo accounts and their tokens (admin), the org and its repos (organization),
 * repo reads, renames/archives, collaborators, template generation (repository).
 * Never `all`: that adds user, issue, notification, package, activitypub and misc.
 */
export const ADMIN_TOKEN_SCOPES = "write:admin,write:organization,write:repository";

/**
 * Forgejo app.ini. No secret is inline: SECRET_KEY, INTERNAL_TOKEN and the JWT
 * secrets are read from files generated ONCE on the data volume (custom/secrets),
 * so the file can be rewritten at every instance launch and still match the DB.
 * Hardening (0.1.3): no forks (a repo account could otherwise copy its repo out
 * of its fence), no migrations and no webhooks (both make the server fetch a
 * URL a user chose), no users page, no org created by a non-admin.
 */
export function renderAppIni(cfg: ForgejoConfig): string {
  const s = `${FORGEJO_WORK}/custom/secrets`;
  return `APP_NAME = Dilaya Git
RUN_USER = git
RUN_MODE = prod
WORK_PATH = ${FORGEJO_WORK}

[server]
PROTOCOL = http
HTTP_ADDR = 127.0.0.1
HTTP_PORT = ${FORGEJO_PORT}
DOMAIN = ${cfg.hostname}
ROOT_URL = https://${cfg.hostname}/
DISABLE_SSH = true
START_SSH_SERVER = false
OFFLINE_MODE = true
LFS_START_SERVER = false
LFS_JWT_SECRET_URI = file:${s}/lfs_jwt_secret

[database]
DB_TYPE = sqlite3
PATH = ${FORGEJO_WORK}/data/forgejo.db
SQLITE_JOURNAL_MODE = WAL

[repository]
ROOT = ${FORGEJO_WORK}/repositories
DEFAULT_PRIVATE = private
FORCE_PRIVATE = true
DEFAULT_BRANCH = main
DISABLE_DOWNLOAD_SOURCE_ARCHIVES = true
DISABLE_FORKS = true
DISABLE_MIGRATIONS = true

[security]
INSTALL_LOCK = true
SECRET_KEY_URI = file:${s}/secret_key
INTERNAL_TOKEN_URI = file:${s}/internal_token
MIN_PASSWORD_LENGTH = 16
DISABLE_WEBHOOKS = true

[oauth2]
ENABLED = false
JWT_SECRET_URI = file:${s}/oauth2_jwt_secret

[service]
DISABLE_REGISTRATION = true
REQUIRE_SIGNIN_VIEW = true
DEFAULT_KEEP_EMAIL_PRIVATE = true
DEFAULT_ALLOW_CREATE_ORGANIZATION = false
ENABLE_NOTIFY_MAIL = false

[service.explore]
REQUIRE_SIGNIN_VIEW = true
DISABLE_USERS_PAGE = true

[admin]
DISABLE_REGULAR_ORG_CREATION = true

[openid]
ENABLE_OPENID_SIGNIN = false
ENABLE_OPENID_SIGNUP = false

[mailer]
ENABLED = false

[api]
ENABLE_SWAGGER = false

[actions]
ENABLED = false

[packages]
ENABLED = false

[federation]
ENABLED = false

[picture]
DISABLE_GRAVATAR = true
ENABLE_FEDERATED_AVATAR = false

[cron.update_checker]
ENABLED = false

[session]
PROVIDER = file

[log]
MODE = console
LEVEL = Info
`;
}

/**
 * Caddy: automatic certificate over TLS-ALPN-01 (port 443 only — port 80 stays
 * closed, so the HTTP-01 challenge is disabled), the request body cap, and —
 * unless webUiPublic=true — only the API and git smart-HTTP paths proxied.
 * Admins reach the full web UI through an SSM port forward to 127.0.0.1:3000.
 */
export function renderCaddyfile(cfg: ForgejoConfig): string {
  const upstream = `reverse_proxy 127.0.0.1:${FORGEJO_PORT}`;
  const routes = cfg.webUiPublic
    ? `\thandle {\n\t\t${upstream}\n\t}\n`
    : // Two matchers, two handles: inside ONE named matcher Caddy ANDs the
      // conditions, so `path` + `path_regexp` together would match nothing.
      `\t@api path /api/*\n` +
      `\t@git path_regexp ^/[^/]+/[^/]+/(info/refs|git-upload-pack|git-receive-pack)$\n` +
      `\thandle @api {\n\t\t${upstream}\n\t}\n` +
      `\thandle @git {\n\t\t${upstream}\n\t}\n` +
      `\thandle {\n\t\trespond 404\n\t}\n`;
  return `{
\tadmin off
\tstorage file_system ${DATA_DIR}/caddy
}

${cfg.hostname} {
\ttls {
\t\tissuer acme {
\t\t\tdisable_http_challenge
\t\t}
\t}
\trequest_body {
\t\tmax_size ${cfg.maxBodyMb}MB
\t}
${routes}}
`;
}
