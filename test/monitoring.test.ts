import { test } from "node:test";
import assert from "node:assert/strict";
import { Match } from "aws-cdk-lib/assertions";
import { createRequire } from "node:module";
import { synth } from "./helpers.ts";

const { template } = synth();
const require = createRequire(import.meta.url);

test("four alarms, each to the topic on ALARM and OK", () => {
  const alarms = Object.values(template.findResources("AWS::CloudWatch::Alarm")) as any[];
  assert.deepEqual(
    alarms.map((a) => a.Properties.AlarmName).sort(),
    ["TestStack-backup-stale", "TestStack-disk", "TestStack-https", "TestStack-status-check"],
  );
  for (const a of alarms) {
    assert.equal(a.Properties.AlarmActions.length, 1);
    assert.equal(a.Properties.OKActions.length, 1);
  }
});

test("thresholds: disk > 80 %, backup >= 26 h, https < 1", () => {
  template.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "DiskUsedPercent", Threshold: 80, ComparisonOperator: "GreaterThanThreshold" });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "BackupAgeHours", Threshold: 26 });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "HealthOk", Threshold: 1, TreatMissingData: "breaching" });
  template.hasResourceProperties("AWS::CloudWatch::Alarm", { MetricName: "StatusCheckFailed", Namespace: "AWS/EC2" });
});

test("health probe hits the public HTTPS hostname on a schedule", () => {
  template.hasResourceProperties("AWS::Lambda::Function", {
    Environment: { Variables: { URL: "https://git.example.test/api/healthz", STACK: "TestStack" } },
  });
  template.hasResourceProperties("AWS::Events::Rule", { ScheduleExpression: "rate(5 minutes)" });
});

test("relay wording knows every alarm suffix", () => {
  const { explain } = require("../lib/alert-relay/format.js");
  for (const s of ["status-check", "disk", "backup-stale", "https"]) assert.notEqual(explain(`TestStack-${s}`), "", s);
});

test("outputs: URL, token PARAMETER NAME (never the token), bucket, instance id, read-only policy", () => {
  const out = template.toJSON().Outputs;
  assert.deepEqual(out.forgejoUrl.Value, "https://git.example.test");
  assert.equal(out.forgejoAdminTokenParam.Value, "/dilaya/forgejo/TestStack/admin-token");
  assert.ok(out.forgejoBackupBucketName && out.forgejoInstanceId);
  const policy = JSON.stringify(out.iamPolicyForgejoToken.Value);
  assert.match(policy, /ssm:GetParameter/);
  assert.doesNotMatch(policy, /PutParameter|\*"/);
});

test("the token parameter is deleted with the stack", () => {
  template.hasResourceProperties("Custom::AWS", { Delete: Match.stringLikeRegexp("deleteParameter") });
});
