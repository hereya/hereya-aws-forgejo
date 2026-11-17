import { test } from "node:test";
import assert from "node:assert/strict";
import { synth } from "./helpers.ts";

test("forgejoHostname and forgejoHostedZoneId are mandatory and validated", () => {
  assert.throws(() => synth({ forgejoHostname: "" }), /forgejoHostname/);
  assert.throws(() => synth({ forgejoHostname: "not a host" }), /forgejoHostname/);
  assert.throws(() => synth({ forgejoHostedZoneId: "nope" }), /forgejoHostedZoneId/);
});

test("telegram inputs go together", () => {
  assert.throws(() => synth({ telegramChatId: "123" }), /together/);
  const { template } = synth({ telegramBotTokenParam: "/x/bot", telegramChatId: "123" });
  template.resourceCountIs("AWS::SNS::Subscription", 1);
  synth().template.resourceCountIs("AWS::SNS::Subscription", 0);
});

test("time and integer inputs are validated", () => {
  assert.throws(() => synth({ backupTimeUtc: "25:00" }), /backupTimeUtc/);
  assert.throws(() => synth({ dataVolumeGb: "abc" }), /dataVolumeGb/);
});

test("instanceType override", () => {
  synth({ instanceType: "t4g.medium" }).template.hasResourceProperties("AWS::EC2::Instance", { InstanceType: "t4g.medium" });
});
