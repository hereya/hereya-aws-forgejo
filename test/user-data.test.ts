import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { synth, userDataText } from "./helpers.ts";
import { renderAppIni, renderCaddyfile } from "../lib/render.ts";
import { readConfig } from "../lib/config.ts";
import { CADDY, FORGEJO } from "../lib/pins.ts";

const ud = userDataText(synth().template);

test("request body cap: 64 MB by default, parameterised", () => {
  assert.match(ud, /request_body \{\n\t\tmax_size 64MB\n\t\}/);
  assert.match(userDataText(synth({ maxBodyMb: "10" }).template), /max_size 10MB/);
  assert.throws(() => synth({ maxBodyMb: "0" }), /maxBodyMb/);
});

test("TLS on 443 only: HTTP-01 disabled, hostname from the parameter", () => {
  assert.match(ud, /\ngit\.example\.test \{\n\ttls \{\n\t\tissuer acme \{\n\t\t\tdisable_http_challenge/);
});

test("web UI not public by default: only /api/* and git smart-HTTP are proxied", () => {
  assert.match(ud, /@api path \/api\/\*\n/);
  // each route its own matcher: a single matcher would AND them (trial 17/11: every path was 404)
  assert.doesNotMatch(ud, /@\w+ \{\n\t\tpath /);
  assert.match(ud, /@git path_regexp \^\/\[\^\/\]\+\/\[\^\/\]\+\/\(info\/refs\|git-upload-pack\|git-receive-pack\)\$/);
  assert.match(ud, /handle \{\n\t\trespond 404/);
  const open = userDataText(synth({ webUiPublic: "true" }).template);
  assert.doesNotMatch(open, /respond 404/);
});

test("Forgejo hardening settings", () => {
  for (const line of [
    "DISABLE_REGISTRATION = true",
    "REQUIRE_SIGNIN_VIEW = true",
    "DEFAULT_PRIVATE = private",
    "FORCE_PRIVATE = true",
    "INSTALL_LOCK = true",
    "DISABLE_SSH = true",
    "HTTP_ADDR = 127.0.0.1",
    "DB_TYPE = sqlite3",
    "PATH = /data/forgejo/data/forgejo.db",
  ]) assert.ok(ud.includes(line), line);
  assert.match(ud, /\[mailer\]\nENABLED = false/);
  assert.match(ud, /\[api\]\nENABLE_SWAGGER = false/);
});

test("no secret inline in app.ini: all four are *_URI files on the data volume", () => {
  const ini = renderAppIni(readConfigFor());
  assert.doesNotMatch(ini, /^(SECRET_KEY|INTERNAL_TOKEN|JWT_SECRET|LFS_JWT_SECRET)\s*=/m);
  assert.equal(ini.match(/_URI = file:\/data\/forgejo\/custom\/secrets\//g)?.length, 4);
});

test("pinned binaries are verified by checksum before install", () => {
  assert.ok(ud.includes(`FG_FORGEJO_URL=${FORGEJO.url}`) && ud.includes(`FG_FORGEJO_SHA256=${FORGEJO.sha256}`));
  assert.ok(ud.includes(`FG_CADDY_SHA512=${CADDY.sha512}`));
  assert.match(ud, /sha256sum -c --quiet[\s\S]*install -m 0755 "\$work\/forgejo"/);
  assert.match(ud, /sha512sum -c --quiet[\s\S]*install -m 0755 "\$work\/caddy"/);
});

test("box scripts never trace (the admin token passes through them)", () => {
  for (const f of readdirSync(new URL("../lib/boot/", import.meta.url))) {
    const body = readFileSync(new URL(`../lib/boot/${f}`, import.meta.url), "utf8");
    assert.doesNotMatch(body, /^\s*set -[a-z]*x/m, f);
    assert.doesNotMatch(body, /echo[^\n]*\$tok/, f);
  }
});

test("user data stays under the 16 KB EC2 limit with margin", () => {
  assert.ok(Buffer.byteLength(ud) < 15_500, `user data is ${Buffer.byteLength(ud)} bytes`);
});

test("a config change replaces the instance (user data is the logical-id hash)", () => {
  const a = Object.keys(synth().template.findResources("AWS::EC2::Instance"))[0];
  const b = Object.keys(synth({ maxBodyMb: "32" }).template.findResources("AWS::EC2::Instance"))[0];
  assert.notEqual(a, b);
});

test("Caddyfile render is stable", () => {
  assert.ok(renderCaddyfile(readConfigFor()).startsWith("{\n\tadmin off\n\tstorage file_system /data/caddy\n}"));
});

function readConfigFor() {
  process.env.hostname = "git.example.test";
  process.env.hostedZoneId = "ZEXAMPLE12345";
  try {
    return readConfig("TestStack");
  } finally {
    delete process.env.hostname;
    delete process.env.hostedZoneId;
  }
}
