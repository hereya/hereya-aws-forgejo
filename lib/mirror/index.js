// Deploy-time binary mirror (custom resource, behind the CDK provider framework:
// return = SUCCESS, throw = FAILED). Plain committed JS, like lib/alert-relay.
//
// Create/Update: for each pinned artefact, keep the S3 object if its metadata
// already carries the pinned checksum; otherwise download the official URL,
// check the checksum, and only then write it. A mismatch or an unreachable URL
// throws, so the deploy fails BEFORE the instance is replaced.
// Delete: nothing (the bucket's removal policy decides; old objects also keep a
// rollback to the previous pins working).
const { createHash } = require("node:crypto");

const ALGORITHMS = { sha256: 64, sha512: 128 };
const PREFIX = "mirror/";

function validate(a) {
  const len = ALGORITHMS[a && a.algorithm];
  if (!len) throw new Error(`unsupported algorithm ${JSON.stringify(a && a.algorithm)}`);
  if (typeof a.digest !== "string" || !new RegExp(`^[0-9a-f]{${len}}$`).test(a.digest)) {
    throw new Error(`${a.key}: digest is not a ${a.algorithm} hex string`);
  }
  if (typeof a.key !== "string" || !a.key.startsWith(PREFIX) || a.key.includes("..")) {
    throw new Error(`key ${JSON.stringify(a.key)} is outside ${PREFIX}`);
  }
  if (typeof a.url !== "string" || !a.url.startsWith("https://")) throw new Error(`${a.key}: url must be https`);
}

async function mirrorOne(bucket, a, deps) {
  validate(a);
  const meta = await deps.head(bucket, a.key);
  if (meta && meta[a.algorithm] === a.digest) return "kept";
  const body = await deps.download(a.url);
  const got = createHash(a.algorithm).update(body).digest("hex");
  if (got !== a.digest) {
    throw new Error(`${a.url}: ${a.algorithm} mismatch (got ${got}, pinned ${a.digest}) - nothing written`);
  }
  await deps.put(bucket, a.key, body, { [a.algorithm]: a.digest });
  return "written";
}

/** The handler's logic with its I/O injected (the tests pass fakes). */
async function mirror(event, deps) {
  const physicalId = event.PhysicalResourceId || "forgejo-binary-mirror";
  if (event.RequestType === "Delete") return { PhysicalResourceId: physicalId };
  const { Bucket: bucket, Artefacts: artefacts } = event.ResourceProperties || {};
  if (!bucket || !Array.isArray(artefacts) || artefacts.length === 0) throw new Error("Bucket and Artefacts are required");
  for (const a of artefacts) {
    const outcome = await mirrorOne(bucket, a, deps);
    console.log(`${outcome}: s3://${bucket}/${a.key} (${a.algorithm} ${a.digest.slice(0, 16)}...)`);
  }
  return { PhysicalResourceId: physicalId };
}

async function download(url) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) });
      if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      console.log(`attempt ${attempt} failed: ${err.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000 * attempt));
    }
  }
  throw last;
}

function awsDeps() {
  // Required lazily: the Lambda runtime ships the SDK, the tests never load it.
  const { S3Client, HeadObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
  const s3 = new S3Client({});
  return {
    download,
    async head(bucket, key) {
      try {
        return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).Metadata || {};
      } catch (err) {
        // No s3:ListBucket on purpose, so an absent object answers 403, not 404.
        const status = err.$metadata && err.$metadata.httpStatusCode;
        if (status === 404 || status === 403) return null;
        throw err;
      }
    },
    async put(bucket, key, body, metadata) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, Metadata: metadata }));
    },
  };
}

exports.mirror = mirror;
exports.handler = (event) => mirror(event, awsDeps());
