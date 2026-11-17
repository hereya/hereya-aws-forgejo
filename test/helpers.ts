import * as cdk from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { ForgejoStack } from "../lib/forgejo-stack.ts";

export const BASE_INPUTS: Record<string, string> = {
  forgejoEnabled: "true",
  forgejoHostname: "git.example.test",
  forgejoHostedZoneId: "ZEXAMPLE12345",
};

/** Synthesizes the stack with the given package inputs (env vars), then restores the env. */
export function synth(inputs: Record<string, string> = {}): { template: Template; stack: ForgejoStack } {
  const all = { ...BASE_INPUTS, ...inputs };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(all)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const app = new cdk.App();
    const stack = new ForgejoStack(app, "TestStack", { env: { account: "111111111111", region: "eu-west-1" } });
    return { template: Template.fromStack(stack), stack };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The instance user data with every CloudFormation token replaced by a placeholder. */
export function userDataText(template: Template): string {
  const inst = Object.values(template.findResources("AWS::EC2::Instance"))[0] as any;
  const parts = inst.Properties.UserData["Fn::Base64"]["Fn::Join"][1] as unknown[];
  return parts.map((p) => (typeof p === "string" ? p : "<TOKEN>")).join("");
}
