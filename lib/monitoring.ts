import * as cdk from "aws-cdk-lib";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as sns from "aws-cdk-lib/aws-sns";
import * as snsSubs from "aws-cdk-lib/aws-sns-subscriptions";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ForgejoConfig } from "./config.ts";
import type { Compute } from "./compute.ts";

const NS = "Dilaya/Forgejo";

// In-region HTTPS probe. Route 53 health checks publish their metric in
// us-east-1 only (an alarm there cannot reach this region's topic), and a
// Synthetics canary every 5 min costs ~10 $/month; this Lambda costs cents.
// It emits HealthOk through the embedded metric format (a log line, no IAM).
const PROBE = `exports.handler = async () => {
  let ok = 0;
  try {
    const r = await fetch(process.env.URL, { signal: AbortSignal.timeout(10000) });
    ok = r.status === 200 ? 1 : 0;
    if (!ok) console.error("status " + r.status);
  } catch (e) { console.error(String(e && e.cause || e)); }
  console.log(JSON.stringify({ _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: "${NS}",
    Dimensions: [["stack"]], Metrics: [{ Name: "HealthOk" }] }] }, stack: process.env.STACK, HealthOk: ok }));
};`;

function logGroup(stack: cdk.Stack, id: string, cfg: ForgejoConfig): logs.LogGroup {
  return new logs.LogGroup(stack, id, {
    retention: logs.RetentionDays.ONE_MONTH,
    removalPolicy: cfg.autoDelete ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN,
  });
}

export function createMonitoring(stack: cdk.Stack, cfg: ForgejoConfig, compute: Compute): sns.Topic {
  const topic = new sns.Topic(stack, "AlertTopic");
  const dims = { stack: stack.stackName };
  const alarm = (id: string, suffix: string, description: string, props: Omit<cloudwatch.AlarmProps, "alarmName" | "alarmDescription">) => {
    const a = new cloudwatch.Alarm(stack, id, { alarmName: `${stack.stackName}-${suffix}`, alarmDescription: description, ...props });
    a.addAlarmAction(new cwActions.SnsAction(topic));
    a.addOkAction(new cwActions.SnsAction(topic));
    return a;
  };

  alarm("StatusCheckAlarm", "status-check", "Forgejo VM failed an EC2 status check", {
    metric: new cloudwatch.Metric({ namespace: "AWS/EC2", metricName: "StatusCheckFailed", dimensionsMap: { InstanceId: compute.instance.instanceId }, statistic: "Maximum", period: cdk.Duration.minutes(1) }),
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    threshold: 1, evaluationPeriods: 3, datapointsToAlarm: 2,
    treatMissingData: cloudwatch.TreatMissingData.MISSING,
  });
  alarm("DiskAlarm", "disk", "Forgejo VM disk (root or data) above 80 %", {
    metric: new cloudwatch.Metric({ namespace: NS, metricName: "DiskUsedPercent", dimensionsMap: dims, statistic: "Maximum", period: cdk.Duration.minutes(5) }),
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    threshold: 80, evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.MISSING,
  });
  alarm("BackupAlarm", "backup-stale", "No successful Forgejo dump to S3 for 26 hours", {
    metric: new cloudwatch.Metric({ namespace: NS, metricName: "BackupAgeHours", dimensionsMap: dims, statistic: "Maximum", period: cdk.Duration.minutes(15) }),
    comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
    threshold: 26, evaluationPeriods: 2,
    treatMissingData: cloudwatch.TreatMissingData.MISSING,
  });
  // The catch-all: the probe always emits (0 on any failure), so a dead box,
  // an expired certificate or a stopped Caddy all land here.
  alarm("HttpsAlarm", "https", "Forgejo HTTPS health check failing", {
    metric: new cloudwatch.Metric({ namespace: NS, metricName: "HealthOk", dimensionsMap: dims, statistic: "Minimum", period: cdk.Duration.minutes(cfg.healthProbeMinutes) }),
    comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
    threshold: 1, evaluationPeriods: 3, datapointsToAlarm: 2,
    treatMissingData: cloudwatch.TreatMissingData.BREACHING,
  });

  const probe = new lambda.Function(stack, "HealthProbe", {
    runtime: lambda.Runtime.NODEJS_24_X,
    architecture: lambda.Architecture.ARM_64,
    handler: "index.handler",
    code: lambda.Code.fromInline(PROBE),
    timeout: cdk.Duration.seconds(20),
    memorySize: 128,
    environment: { URL: `https://${cfg.hostname}/api/healthz`, STACK: stack.stackName },
    logGroup: logGroup(stack, "HealthProbeLogs", cfg),
  });
  new events.Rule(stack, "HealthProbeSchedule", {
    schedule: events.Schedule.rate(cdk.Duration.minutes(cfg.healthProbeMinutes)),
    targets: [new targets.LambdaFunction(probe)],
  });

  // Same SNS -> Telegram relay as dilaya/aws-sqlite-data, wired only when both
  // inputs are given; the alarms exist regardless.
  if (cfg.telegramBotTokenParam !== "") {
    const relay = new lambda.Function(stack, "AlertRelay", {
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: "index.handler",
      code: lambda.Code.fromAsset(join(dirname(fileURLToPath(import.meta.url)), "alert-relay")),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: { TELEGRAM_TOKEN_PARAM: cfg.telegramBotTokenParam, TELEGRAM_CHAT_ID: cfg.telegramChatId },
      logGroup: logGroup(stack, "AlertRelayLogs", cfg),
    });
    relay.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [cdk.Arn.format({ service: "ssm", resource: "parameter", resourceName: cfg.telegramBotTokenParam.replace(/^\//, "") }, stack)],
      }),
    );
    topic.addSubscription(new snsSubs.LambdaSubscription(relay));
  }
  return topic;
}
