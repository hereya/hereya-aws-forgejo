import { test } from "node:test";
import assert from "node:assert/strict";
import { synth } from "./helpers.ts";

// The connector deploys the same package list in every region: a pod that does
// not say enabled=true must create nothing and hand nothing to the consumer.
for (const enabled of ["", "false", "no", "TRUE"]) {
  test(`enabled=${JSON.stringify(enabled)} creates nothing and needs no hostname`, () => {
    const { template } = synth({ enabled, hostname: "", hostedZoneId: "" });
    const types = Object.values(template.toJSON().Resources ?? {}).map((r: any) => r.Type);
    assert.deepEqual(types, ["AWS::CloudFormation::WaitConditionHandle"]);
    assert.deepEqual(template.toJSON().Outputs ?? {}, {});
  });
}

test("enabled=true builds the server and still demands hostname and zone", () => {
  synth({ enabled: "true" }).template.resourceCountIs("AWS::EC2::Instance", 1);
  assert.throws(() => synth({ enabled: "true", hostname: "" }), /hostname/);
  assert.throws(() => synth({ enabled: "true", hostedZoneId: "" }), /hostedZoneId/);
});
