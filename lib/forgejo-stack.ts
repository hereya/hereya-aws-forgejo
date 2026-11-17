import * as cdk from "aws-cdk-lib";
import type { Construct } from "constructs";
import { input, readConfig } from "./config.ts";
import { createNetwork, createStorage } from "./storage.ts";
import { createCompute } from "./compute.ts";
import { createMonitoring } from "./monitoring.ts";

/**
 * dilaya/aws-forgejo: one Forgejo VM (ARM, AL2023) behind Caddy (TLS + body
 * cap) with its state on a separate encrypted EBS volume, daily dumps to S3,
 * daily EBS snapshots, four alarms and an admin token in SSM for the connector.
 */
export class ForgejoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    // OFF unless the consumer says `forgejoEnabled=true`. The connector deploys the same
    // package list in every region; only the pod that should host the git server
    // turns it on. Off = no server, no output (nothing reaches the consumer's
    // env), one free placeholder so CloudFormation accepts the template.
    if (input("forgejoEnabled", "false") !== "true") {
      new cdk.CfnWaitConditionHandle(this, "Disabled");
      return;
    }
    const cfg = readConfig(this.stackName);
    const net = createNetwork(this);
    const store = createStorage(this, cfg, net);
    const compute = createCompute(this, cfg, net, store);
    createMonitoring(this, cfg, compute);

    // --- Package outputs (consumer env contract) -----------------------------
    new cdk.CfnOutput(this, "forgejoUrl", { value: `https://${cfg.hostname}` });
    new cdk.CfnOutput(this, "forgejoAdminTokenParam", { value: cfg.adminTokenParamName });
    // ONLY what the consumer needs: every output lands in the consumer's Lambda env, and the
    // connector's sits near the 4 KB cap. The bucket and the instance are found by the stack's tags.
    // Auto-attached to the consumer's role by Hereya (iamPolicy* convention):
    // read the token, nothing else.
    new cdk.CfnOutput(this, "iamPolicyForgejoToken", {
      value: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["ssm:GetParameter"], Resource: [compute.tokenParamArn] }],
      }),
    });
  }
}
