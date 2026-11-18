// The stack's own copy of every binary the box installs. A deploy-time custom
// resource downloads each pinned artefact from its official URL, checks the
// pinned checksum and only then writes it to S3; the box reads S3 first and
// falls back to the official URL. Why not a BucketDeployment of synth-time
// downloads: synth would need the network, every pin change would push ~50 MB
// of assets, and nothing would check the checksum on the AWS side. Here synth
// stays offline, and an official URL that is down (or a checksum that moved)
// fails the deploy BEFORE the instance is replaced (README "Binary mirror").
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cr from "aws-cdk-lib/custom-resources";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgejoConfig } from "./config.ts";
import { CADDY, FORGEJO } from "./pins.ts";

/** Every mirrored object lives under this prefix; the box may read nothing else. */
export const MIRROR_PREFIX = "mirror";

export interface MirrorArtefact {
  /** The official URL, also the fallback the box uses. */
  url: string;
  /** Object key: the prefix + the URL's file name (versioned, so a pin change never overwrites). */
  key: string;
  algorithm: "sha256" | "sha512";
  /** Checksum of the downloaded file itself, as published by the project. */
  digest: string;
}

const entry = (url: string, algorithm: MirrorArtefact["algorithm"], digest: string): MirrorArtefact => ({
  url,
  key: `${MIRROR_PREFIX}/${url.slice(url.lastIndexOf("/") + 1)}`,
  algorithm,
  digest,
});

/** One entry per artefact of lib/pins.ts (test/mirror.test.ts checks none is missing). */
export const MIRROR_ARTEFACTS: Readonly<Record<string, MirrorArtefact>> = {
  forgejo: entry(FORGEJO.url, "sha256", FORGEJO.xzSha256),
  caddy: entry(CADDY.url, "sha512", CADDY.sha512),
};

export interface Mirror {
  bucket: s3.Bucket;
  /** The deploy-time copy; the instance depends on it. */
  resource: cdk.CustomResource;
}

export function createMirror(stack: cdk.Stack, cfg: ForgejoConfig): Mirror {
  const removal = cfg.autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;
  // Its own bucket, not a prefix of the backup bucket: the dump lifecycle (30 days, whole
  // bucket) would expire the binaries, and the box's read grant there is broader.
  const bucket = new s3.Bucket(stack, "MirrorBucket", {
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    removalPolicy: removal,
    autoDeleteObjects: cfg.autoDelete,
  });

  // One log group for the handler and the provider framework, retained like the others.
  const logGroup = new logs.LogGroup(stack, "MirrorLogs", { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: removal });
  const fn = new lambda.Function(stack, "MirrorFn", {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: lambda.Code.fromAsset(join(dirname(fileURLToPath(import.meta.url)), "mirror")),
    // ~50 MB downloaded, hashed and uploaded from memory.
    timeout: cdk.Duration.minutes(5),
    memorySize: 1024,
    logGroup,
  });
  // Head + write under the prefix, nothing else (no delete, no list).
  fn.addToRolePolicy(
    new iam.PolicyStatement({ actions: ["s3:GetObject", "s3:PutObject"], resources: [bucket.arnForObjects(`${MIRROR_PREFIX}/*`)] }),
  );

  const provider = new cr.Provider(stack, "MirrorProvider", { onEventHandler: fn, logGroup });
  const resource = new cdk.CustomResource(stack, "BinaryMirror", {
    serviceToken: provider.serviceToken,
    resourceType: "Custom::ForgejoBinaryMirror",
    // A pin change changes these properties, hence an Update that copies the new artefacts.
    properties: { Bucket: bucket.bucketName, Artefacts: Object.values(MIRROR_ARTEFACTS) },
  });
  return { bucket, resource };
}

/** The box's grant: read the mirrored objects, nothing else. */
export function mirrorReadStatement(mirror: Mirror): iam.PolicyStatement {
  return new iam.PolicyStatement({ actions: ["s3:GetObject"], resources: [mirror.bucket.arnForObjects(`${MIRROR_PREFIX}/*`)] });
}
