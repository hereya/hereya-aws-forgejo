import * as cdk from "aws-cdk-lib";
import * as dlm from "aws-cdk-lib/aws-dlm";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import type { ForgejoConfig } from "./config.ts";

export const STACK_TAG = "forgejo-stack";
export const SNAPSHOT_TAG = "forgejo-snapshot";

export interface Network {
  vpc: ec2.Vpc;
  subnet: ec2.ISubnet;
  sg: ec2.SecurityGroup;
}

/**
 * One public subnet (the data volume and the instance must share an AZ), no
 * NAT, a free S3 gateway endpoint for the backups. Inbound: 443 only. No SSH —
 * administration goes through SSM Session Manager, which is agent-initiated.
 */
export function createNetwork(stack: cdk.Stack): Network {
  const vpc = new ec2.Vpc(stack, "Vpc", {
    maxAzs: 1,
    natGateways: 0,
    subnetConfiguration: [{ name: "public", subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
  });
  vpc.addGatewayEndpoint("S3Endpoint", { service: ec2.GatewayVpcEndpointAwsService.S3 });
  const sg = new ec2.SecurityGroup(stack, "InstanceSg", {
    vpc,
    description: "Forgejo box - HTTPS only, no SSH",
    allowAllOutbound: true,
  });
  sg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), "HTTPS to Caddy");
  return { vpc, subnet: vpc.publicSubnets[0]!, sg };
}

export interface Storage {
  volume: ec2.CfnVolume;
  bucket: s3.Bucket;
}

export function createStorage(stack: cdk.Stack, cfg: ForgejoConfig, net: Network): Storage {
  const removal = cfg.autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN;

  // The data volume holds EVERYTHING durable (repos, SQLite DB, secrets, TLS
  // certificate). Its own resource, not a block device of the instance, so an
  // instance replacement re-attaches it instead of starting empty.
  const volume = new ec2.CfnVolume(stack, "DataVolume", {
    availabilityZone: net.subnet.availabilityZone,
    size: cfg.dataVolumeGb,
    volumeType: "gp3",
    encrypted: true,
    tags: [
      { key: "Name", value: `${stack.stackName}-data` },
      { key: STACK_TAG, value: stack.stackName },
      { key: SNAPSHOT_TAG, value: stack.stackName },
    ],
  });
  volume.applyRemovalPolicy(removal);

  const bucket = new s3.Bucket(stack, "BackupBucket", {
    versioned: true,
    encryption: s3.BucketEncryption.S3_MANAGED,
    blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    enforceSSL: true,
    objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
    lifecycleRules: [
      {
        id: "expire-dumps",
        expiration: cdk.Duration.days(cfg.backupRetentionDays),
        noncurrentVersionExpiration: cdk.Duration.days(cfg.backupRetentionDays),
        abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
      },
    ],
    removalPolicy: removal,
    autoDeleteObjects: cfg.autoDelete,
  });

  // Daily crash-consistent EBS snapshot, on top of the logical dump. DLM keeps
  // the last N and deletes older ones; snapshots it made survive a stack delete
  // (README "Teardown").
  const dlmRole = new iam.Role(stack, "SnapshotRole", {
    assumedBy: new iam.ServicePrincipal("dlm.amazonaws.com"),
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSDataLifecycleManagerServiceRole"),
    ],
  });
  new dlm.CfnLifecyclePolicy(stack, "SnapshotPolicy", {
    description: `Daily snapshot of the Forgejo data volume of ${stack.stackName}`,
    state: "ENABLED",
    executionRoleArn: dlmRole.roleArn,
    policyDetails: {
      resourceTypes: ["VOLUME"],
      targetTags: [{ key: SNAPSHOT_TAG, value: stack.stackName }],
      schedules: [
        {
          name: "daily",
          createRule: { interval: 24, intervalUnit: "HOURS", times: [cfg.snapshotTimeUtc] },
          retainRule: { count: cfg.snapshotRetentionCount },
          copyTags: true,
          tagsToAdd: [{ key: STACK_TAG, value: stack.stackName }],
        },
      ],
    },
  });

  return { volume, bucket };
}
