import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { synth } from "./helpers.ts";

const { template } = synth();

test("security group admits 443 only — no SSH, no other port", () => {
  const sgs = Object.values(template.findResources("AWS::EC2::SecurityGroup")) as any[];
  assert.equal(sgs.length, 1);
  const ingress = sgs[0].Properties.SecurityGroupIngress;
  assert.deepEqual(
    ingress.map((r: any) => [r.IpProtocol, r.FromPort, r.ToPort, r.CidrIp]),
    [["tcp", 443, 443, "0.0.0.0/0"]],
  );
  assert.equal(Object.keys(template.findResources("AWS::EC2::SecurityGroupIngress")).length, 0);
});

test("no key pair: administration is SSM Session Manager only", () => {
  template.hasResourceProperties("AWS::EC2::Instance", { KeyName: Match.absent() });
  template.hasResourceProperties("AWS::IAM::Role", {
    ManagedPolicyArns: Match.arrayWith([
      Match.objectLike({ "Fn::Join": Match.arrayWith([Match.arrayWith([":iam::aws:policy/AmazonSSMManagedInstanceCore"])]) }),
    ]),
  });
});

test("IMDSv2 required", () => {
  template.hasResourceProperties("AWS::EC2::LaunchTemplate", {
    LaunchTemplateData: { MetadataOptions: { HttpTokens: "required" } },
  });
});

test("ARM instance, t4g.small by default, pinned AMI (no SSM 'latest' lookup)", () => {
  template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.small", ImageId: Match.stringLikeRegexp("^ami-") });
  assert.equal(JSON.stringify(template.toJSON().Parameters ?? {}).includes("ami-amazon-linux-latest"), false);
});

test("root volume encrypted gp3", () => {
  template.hasResourceProperties("AWS::EC2::Instance", {
    BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: Match.objectLike({ Encrypted: true, VolumeType: "gp3" }) }],
  });
});

test("DNS record points the hostname at the Elastic IP", () => {
  template.hasResourceProperties("AWS::Route53::RecordSet", {
    HostedZoneId: "ZEXAMPLE12345",
    Name: "git.example.test",
    Type: "A",
    ResourceRecords: [{ Ref: Match.stringLikeRegexp("^Eip") }],
  });
});

test("security group descriptions use only the characters EC2 accepts", () => {
  const ok = /^[a-zA-Z0-9. _\-:/()#,@[\]+=&;{}!$*]*$/;
  for (const sg of Object.values(template.findResources("AWS::EC2::SecurityGroup")) as any[]) {
    assert.match(sg.Properties.GroupDescription, ok);
    for (const r of sg.Properties.SecurityGroupIngress ?? []) assert.match(r.Description, ok);
  }
});
