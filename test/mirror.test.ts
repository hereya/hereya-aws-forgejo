import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Match } from "aws-cdk-lib/assertions";
import { synth, userDataText } from "./helpers.ts";
import * as pins from "../lib/pins.ts";
import { MIRROR_ARTEFACTS, MIRROR_PREFIX } from "../lib/mirror.ts";

const require = createRequire(import.meta.url);
const { mirror } = require("../lib/mirror/index.js");
const { template } = synth();
const ud = userDataText(template);

test("every pinned artefact of pins.ts has a mirror entry with the same URL and a published checksum", () => {
  const pinned = Object.values(pins).filter((v): v is { url: string } => typeof (v as any)?.url === "string");
  assert.ok(pinned.length >= 2);
  const mirrored = Object.values(MIRROR_ARTEFACTS);
  for (const p of pinned) assert.ok(mirrored.some((m) => m.url === p.url), `no mirror entry for ${p.url}`);
  assert.equal(mirrored.length, pinned.length);
  assert.equal(MIRROR_ARTEFACTS.forgejo!.digest, pins.FORGEJO.xzSha256);
  assert.equal(MIRROR_ARTEFACTS.caddy!.digest, pins.CADDY.sha512);
  for (const m of mirrored) assert.ok(m.key.startsWith(`${MIRROR_PREFIX}/`) && m.url.endsWith(m.key.slice(MIRROR_PREFIX.length)));
});

test("the deploy copies exactly those artefacts, and the instance waits for it", () => {
  template.hasResourceProperties("Custom::ForgejoBinaryMirror", {
    Artefacts: Object.values(MIRROR_ARTEFACTS).map((a) => ({ ...a })),
  });
  const mirrorId = Object.keys(template.findResources("Custom::ForgejoBinaryMirror"))[0]!;
  const inst = Object.values(template.findResources("AWS::EC2::Instance"))[0] as any;
  assert.ok((inst.DependsOn as string[]).includes(mirrorId), "instance must depend on the mirror");
});

test("the box tries the S3 mirror first, then the official URL, and verifies the checksum either way", () => {
  assert.match(ud, /\nFG_MIRROR=s3:\/\/<TOKEN>\/mirror\n/);
  assert.match(ud, /fetch\(\) \{\n {2}aws s3 cp --only-show-errors "\$FG_MIRROR\/\$\{1##\*\/\}" "\$2" && return\n {2}log "mirror miss[^\n]*\n {2}curl -fsSL --retry 5 -o "\$2" "\$1"\n\}/);
  assert.match(ud, /fetch "\$FG_FORGEJO_URL" "\$work\/forgejo\.xz"\nxz -d "\$work\/forgejo\.xz"\necho "\$FG_FORGEJO_SHA256 {2}\$work\/forgejo" \| sha256sum -c --quiet/);
  assert.match(ud, /fetch "\$FG_CADDY_URL" "\$work\/caddy\.tgz"\necho "\$FG_CADDY_SHA512 {2}\$work\/caddy\.tgz" \| sha512sum -c --quiet/);
  // no direct download of a binary outside fetch()
  assert.equal(ud.match(/curl -fsSL --retry 5/g)?.length, 1);
});

test("instance role: read-only on the mirror prefix, nothing else of the mirror bucket", () => {
  const bucketId = Object.keys(template.findResources("AWS::S3::Bucket")).find((id) => id.startsWith("MirrorBucket"))!;
  const statements = (Object.values(template.findResources("AWS::IAM::Policy")) as any[])
    .filter((p) => p.Properties.Roles.some((r: any) => r.Ref?.startsWith("InstanceRole")))
    .flatMap((p) => p.Properties.PolicyDocument.Statement);
  const onMirror = statements.filter((s) => JSON.stringify(s.Resource).includes(bucketId));
  assert.equal(onMirror.length, 1);
  assert.equal(onMirror[0].Action, "s3:GetObject");
  assert.deepEqual(onMirror[0].Resource, { "Fn::Join": ["", [{ "Fn::GetAtt": [bucketId, "Arn"] }, "/mirror/*"]] });
});

test("mirror function: get + put on the prefix only (no delete, no list); bucket private and TLS-only", () => {
  template.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: ["s3:GetObject", "s3:PutObject"], Resource: Match.objectLike({ "Fn::Join": ["", [Match.anyValue(), "/mirror/*"]] }) })]) },
  });
  template.hasResourceProperties("AWS::S3::Bucket", {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    LifecycleConfiguration: Match.absent(),
  });
});

// --- the custom resource handler, with fake I/O ------------------------------
const bytes = Buffer.from("pretend forgejo binary");
const good = { url: "https://example.test/dl/forgejo.xz", key: "mirror/forgejo.xz", algorithm: "sha256", digest: createHash("sha256").update(bytes).digest("hex") };
const event = (artefacts: unknown[], type = "Create") => ({ RequestType: type, ResourceProperties: { Bucket: "b", Artefacts: artefacts } });

function fakes(existing: Record<string, Record<string, string>> = {}, body = bytes) {
  const puts: { key: string; metadata: Record<string, string> }[] = [];
  let downloads = 0;
  return {
    puts,
    downloads: () => downloads,
    deps: {
      head: async (_b: string, key: string) => existing[key] ?? null,
      download: async () => (downloads++, body),
      put: async (_b: string, key: string, _body: Buffer, metadata: Record<string, string>) => void puts.push({ key, metadata }),
    },
  };
}

test("custom resource: downloads, checks, writes with the checksum as metadata", async () => {
  const f = fakes();
  await mirror(event([good]), f.deps);
  assert.deepEqual(f.puts, [{ key: "mirror/forgejo.xz", metadata: { sha256: good.digest } }]);
});

test("custom resource: REFUSES a checksum mismatch and writes nothing", async () => {
  const f = fakes({}, Buffer.from("tampered"));
  await assert.rejects(mirror(event([good]), f.deps), /sha256 mismatch .* nothing written/);
  assert.equal(f.puts.length, 0);
});

test("custom resource: idempotent — an object already carrying the pinned checksum is not re-downloaded", async () => {
  const f = fakes({ "mirror/forgejo.xz": { sha256: good.digest } });
  await mirror(event([good], "Update"), f.deps);
  assert.equal(f.downloads(), 0);
  assert.equal(f.puts.length, 0);
  const stale = fakes({ "mirror/forgejo.xz": { sha256: "0".repeat(64) } });
  await mirror(event([good], "Update"), stale.deps);
  assert.equal(stale.puts.length, 1);
});

test("custom resource: a failed download fails the deploy; Delete touches nothing", async () => {
  const f = fakes();
  f.deps.download = async () => { throw new Error("GET: HTTP 503"); };
  await assert.rejects(mirror(event([good]), f.deps), /503/);
  assert.equal(f.puts.length, 0);
  const d = fakes();
  assert.deepEqual(await mirror({ RequestType: "Delete", PhysicalResourceId: "x" }, d.deps), { PhysicalResourceId: "x" });
});

test("custom resource: refuses keys outside the prefix, non-https URLs and malformed digests", async () => {
  for (const bad of [{ ...good, key: "dumps/x" }, { ...good, key: "mirror/../dumps/x" }, { ...good, url: "http://example.test/x" }, { ...good, digest: "abc" }, { ...good, algorithm: "md5" }]) {
    await assert.rejects(mirror(event([bad]), fakes().deps), Error, JSON.stringify(bad));
  }
});
