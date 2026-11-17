import { test } from "node:test";
import assert from "node:assert/strict";
import { synth } from "./helpers.ts";

// The connector deploys the same package list in every region: a pod that does
// not say forgejoEnabled=true must create nothing and hand nothing to the consumer.
for (const enabled of ["", "false", "no", "TRUE"]) {
  test(`forgejoEnabled=${JSON.stringify(enabled)} creates nothing and needs no hostname`, () => {
    const { template } = synth({ forgejoEnabled: enabled, forgejoHostname: "", forgejoHostedZoneId: "" });
    const types = Object.values(template.toJSON().Resources ?? {}).map((r: any) => r.Type);
    assert.deepEqual(types, ["AWS::CloudFormation::WaitConditionHandle"]);
    assert.deepEqual(template.toJSON().Outputs ?? {}, {});
  });
}

test("forgejoEnabled=true builds the server and still demands hostname and zone", () => {
  synth({ forgejoEnabled: "true" }).template.resourceCountIs("AWS::EC2::Instance", 1);
  assert.throws(() => synth({ forgejoEnabled: "true", forgejoHostname: "" }), /forgejoHostname/);
  assert.throws(() => synth({ forgejoEnabled: "true", forgejoHostedZoneId: "" }), /forgejoHostedZoneId/);
});
