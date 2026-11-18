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

test("outputs: URL, token PARAMETER NAME (never the token), read-only policy — and nothing else", () => {
  const out = template.toJSON().Outputs;
  assert.deepEqual(out.forgejoUrl.Value, "https://git.example.test");
  assert.equal(out.forgejoAdminTokenParam.Value, "/dilaya/forgejo/TestStack/admin-token");
  assert.deepEqual(Object.keys(out).sort(), ["forgejoAdminTokenParam", "forgejoUrl", "iamPolicyForgejoToken"]);
  const policy = JSON.stringify(out.iamPolicyForgejoToken.Value);
  assert.match(policy, /ssm:GetParameter/);
  assert.doesNotMatch(policy, /PutParameter|\*"/);
});

test("the token parameter is deleted with the stack", () => {
  template.hasResourceProperties("Custom::AWS", { Delete: Match.stringLikeRegexp("deleteParameter") });
});

// « 1 action ≠ alarme livrée »: an alarm action on a topic nobody listens to
// delivers nothing. With the relay inputs, the topic MUST have the relay as a
// subscriber, invokable by SNS — and the two alarms that say "the server is
// down" (EC2 status check, HTTPS probe) both reach that topic.
test("with the Telegram inputs: the topic has the relay as a Lambda subscriber, SNS may invoke it", () => {
  const t = synth({ telegramBotTokenParam: "/example/telegram-token", telegramChatId: "-100123" }).template;
  const topicId = Object.keys(t.findResources("AWS::SNS::Topic"))[0];
  const relayId = Object.keys(t.findResources("AWS::Lambda::Function", { Properties: { Environment: { Variables: { TELEGRAM_CHAT_ID: "-100123" } } } }))[0];
  assert.ok(topicId && relayId);
  t.hasResourceProperties("AWS::SNS::Subscription", { Protocol: "lambda", TopicArn: { Ref: topicId }, Endpoint: { "Fn::GetAtt": [relayId, "Arn"] } });
  t.hasResourceProperties("AWS::Lambda::Permission", { Action: "lambda:InvokeFunction", Principal: "sns.amazonaws.com", SourceArn: { Ref: topicId }, FunctionName: { "Fn::GetAtt": [relayId, "Arn"] } });
  for (const name of ["TestStack-status-check", "TestStack-https"]) {
    t.hasResourceProperties("AWS::CloudWatch::Alarm", { AlarmName: name, AlarmActions: [{ Ref: topicId }], OKActions: [{ Ref: topicId }] });
  }
});

test("without the Telegram inputs: no subscriber (the alarms still exist)", () => {
  template.resourceCountIs("AWS::SNS::Subscription", 0);
  template.resourceCountIs("AWS::CloudWatch::Alarm", 4);
});
