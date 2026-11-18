import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { synth } from "./helpers.ts";

const retained = synth().template;
const throwaway = synth({ autoDelete: "true" }).template;

test("data volume: encrypted gp3, separate from root, RETAINED by default", () => {
  retained.hasResource("AWS::EC2::Volume", {
    Properties: Match.objectLike({ Encrypted: true, VolumeType: "gp3", Size: 20 }),
    DeletionPolicy: "Retain",
    UpdateReplacePolicy: "Retain",
  });
  retained.hasResource("AWS::S3::Bucket", { DeletionPolicy: "Retain" });
  assert.equal(Object.keys(retained.findResources("Custom::S3AutoDeleteObjects")).length, 0);
});

test("autoDelete=true deletes the volume and empties + deletes both buckets (backups, binary mirror)", () => {
  throwaway.hasResource("AWS::EC2::Volume", { DeletionPolicy: "Delete" });
  const buckets = Object.values(throwaway.findResources("AWS::S3::Bucket")) as any[];
  assert.equal(buckets.length, 2);
  for (const b of buckets) assert.equal(b.DeletionPolicy, "Delete");
  assert.equal(Object.keys(throwaway.findResources("Custom::S3AutoDeleteObjects")).length, 2);
});

test("backup bucket: versioned, encrypted, private, TLS-only, 30-day lifecycle", () => {
  retained.hasResourceProperties("AWS::S3::Bucket", {
    VersioningConfiguration: { Status: "Enabled" },
    BucketEncryption: { ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
    PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
    LifecycleConfiguration: {
      Rules: [Match.objectLike({ ExpirationInDays: 30, NoncurrentVersionExpiration: { NoncurrentDays: 30 }, Status: "Enabled" })],
    },
  });
  retained.hasResourceProperties("AWS::S3::BucketPolicy", {
    PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: "Deny", Condition: { Bool: { "aws:SecureTransport": "false" } } })]) },
  });
  const custom = synth({ backupRetentionDays: "90" }).template;
  custom.hasResourceProperties("AWS::S3::Bucket", {
    LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 90 })] },
  });
});

test("DLM: daily snapshot of the tagged data volume, 7 kept", () => {
  retained.hasResourceProperties("AWS::DLM::LifecyclePolicy", {
    State: "ENABLED",
    PolicyDetails: {
      ResourceTypes: ["VOLUME"],
      TargetTags: [{ Key: "forgejo-snapshot", Value: "TestStack" }],
      Schedules: [Match.objectLike({ CreateRule: { Interval: 24, IntervalUnit: "HOURS", Times: ["03:30"] }, RetainRule: { Count: 7 } })],
    },
  });
  retained.hasResourceProperties("AWS::EC2::Volume", {
    Tags: Match.arrayWith([{ Key: "forgejo-snapshot", Value: "TestStack" }]),
  });
});

test("the instance may attach only volumes/instances tagged with its own stack", () => {
  retained.hasResourceProperties("AWS::IAM::Policy", {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({ Action: "ec2:AttachVolume", Condition: { StringEquals: { "aws:ResourceTag/forgejo-stack": "TestStack" } } }),
      ]),
    },
  });
});
