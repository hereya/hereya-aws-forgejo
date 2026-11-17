import * as cdk from "aws-cdk-lib";
import { ForgejoStack } from "../lib/forgejo-stack.ts";

const app = new cdk.App();
new ForgejoStack(app, process.env.STACK_NAME ?? "hereya-aws-forgejo-dev", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
