import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as cr from "aws-cdk-lib/custom-resources";
import type { ForgejoConfig } from "./config.ts";
import { MIRROR_PREFIX, mirrorReadStatement, type Mirror } from "./mirror.ts";
import { PINNED_AMI_IDS } from "./pins.ts";
import { STACK_TAG, type Network, type Storage } from "./storage.ts";
import { buildUserData } from "./user-data.ts";

export interface Compute {
  instance: ec2.Instance;
  eip: ec2.CfnEIP;
  tokenParamArn: string;
}

function machineImage(stack: cdk.Stack, cfg: ForgejoConfig): ec2.IMachineImage {
  if (cfg.amiId === "latest") return ec2.MachineImage.latestAmazonLinux2023({ cpuType: ec2.AmazonLinuxCpuType.ARM_64 });
  const region = cdk.Token.isUnresolved(stack.region) ? "eu-west-1" : stack.region;
  const id = cfg.amiId || PINNED_AMI_IDS[region];
  if (!id) throw new Error(`no pinned AMI for ${region}: pass amiId (an AL2023 arm64 image id) or add one to lib/pins.ts`);
  return ec2.MachineImage.genericLinux({ [region]: id });
}

export function createCompute(stack: cdk.Stack, cfg: ForgejoConfig, net: Network, store: Storage, mirror: Mirror): Compute {
  const tokenParamArn = cdk.Arn.format(
    { service: "ssm", resource: "parameter", resourceName: cfg.adminTokenParamName.replace(/^\//, "") },
    stack,
  );

  const role = new iam.Role(stack, "InstanceRole", {
    assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
    managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")],
  });
  // Attach-at-boot: only the stack's own volume, only to the stack's own instance.
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["ec2:AttachVolume"],
      resources: [
        cdk.Arn.format({ service: "ec2", resource: "volume", resourceName: store.volume.ref }, stack),
        cdk.Arn.format({ service: "ec2", resource: "instance", resourceName: "*" }, stack),
      ],
      conditions: { StringEquals: { [`aws:ResourceTag/${STACK_TAG}`]: stack.stackName } },
    }),
  );
  role.addToPolicy(new iam.PolicyStatement({ actions: ["ec2:DescribeVolumes"], resources: ["*"] }));
  role.addToPolicy(
    new iam.PolicyStatement({ actions: ["ssm:GetParameter", "ssm:PutParameter"], resources: [tokenParamArn] }),
  );
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["s3:PutObject", "s3:AbortMultipartUpload", "s3:GetObject", "s3:ListBucket"],
      resources: [store.bucket.bucketArn, store.bucket.arnForObjects("*")],
    }),
  );
  // The binary mirror: read-only, its prefix only.
  role.addToPolicy(mirrorReadStatement(mirror));
  role.addToPolicy(
    new iam.PolicyStatement({
      actions: ["cloudwatch:PutMetricData"],
      resources: ["*"],
      conditions: { StringEquals: { "cloudwatch:namespace": "Dilaya/Forgejo" } },
    }),
  );

  const instance = new ec2.Instance(stack, "Instance", {
    vpc: net.vpc,
    vpcSubnets: { subnets: [net.subnet] },
    securityGroup: net.sg,
    instanceType: new ec2.InstanceType(cfg.instanceType),
    machineImage: machineImage(stack, cfg),
    role,
    requireImdsv2: true,
    // A config change must reach the box: cloud-init runs user data once per
    // instance, so a new user data means a new instance (it re-attaches the volume).
    userDataCausesReplacement: true,
    userData: buildUserData(cfg, {
      region: stack.region,
      stackName: stack.stackName,
      volumeId: store.volume.ref,
      bucketName: store.bucket.bucketName,
      mirrorUri: `s3://${mirror.bucket.bucketName}/${MIRROR_PREFIX}`,
    }),
    blockDevices: [
      {
        deviceName: "/dev/xvda",
        volume: ec2.BlockDeviceVolume.ebs(cfg.rootVolumeGb, {
          encrypted: true,
          volumeType: ec2.EbsDeviceVolumeType.GP3,
          deleteOnTermination: true,
        }),
      },
    ],
  });
  // The mirror is filled (and the pinned checksums checked) BEFORE a replacement instance is created:
  // an official URL that is down fails the deploy while the old instance still serves.
  instance.node.addDependency(mirror.resource);
  cdk.Tags.of(instance).add(STACK_TAG, stack.stackName);
  cdk.Tags.of(instance).add("Name", `${stack.stackName}-forgejo`);

  // A stable public IP: the DNS record and the certificate survive a replacement.
  const eip = new ec2.CfnEIP(stack, "Eip", { domain: "vpc", instanceId: instance.instanceId });
  new route53.CfnRecordSet(stack, "DnsRecord", {
    hostedZoneId: cfg.hostedZoneId,
    name: cfg.hostname,
    type: "A",
    ttl: "300",
    resourceRecords: [eip.ref],
  });

  // The token parameter is written by the BOX (CloudFormation cannot create a
  // SecureString); this resource only deletes it when the stack goes away.
  // The instance depends on it, so on delete the instance goes first.
  const tokenCleanup = new cr.AwsCustomResource(stack, "TokenParamCleanup", {
    onDelete: {
      service: "SSM",
      action: "deleteParameter",
      parameters: { Name: cfg.adminTokenParamName },
      ignoreErrorCodesMatching: "ParameterNotFound",
    },
    policy: cr.AwsCustomResourcePolicy.fromSdkCalls({ resources: [tokenParamArn] }),
    installLatestAwsSdk: false,
  });
  instance.node.addDependency(tokenCleanup);

  return { instance, eip, tokenParamArn };
}
