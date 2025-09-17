import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { EntrixCoreStack } from './entrix-core-stack';
import * as cp from 'aws-cdk-lib/aws-codepipeline';

export interface EntrixCicdProps extends cdk.StackProps {
  readonly repoOwner: string;        // e.g. "wasimakram777"
  readonly repoName: string;         // e.g. "cloud-lambda-challenge"
  readonly branch?: string;          // default 'main'
  readonly connectionArn: string;    // CodeStar Connections ARN
}

class DevAppStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props?: cdk.StageProps) {
    super(scope, id, props);
    new EntrixCoreStack(this, 'EntrixCoreStack', { env: props?.env });
  }
}

export class EntrixCicdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: EntrixCicdProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'main';

    // SNS topic for pipeline notifications (plug into Chatbot later if desired)
    const alertsTopic = new sns.Topic(this, 'CicdAlertsTopic', {
      displayName: 'cicd-alerts',
    });

    // Source: GitHub via CodeStar Connection (✅ correct signature)
    const source = pipelines.CodePipelineSource.connection(
      `${props.repoOwner}/${props.repoName}`,
      branch,
      { connectionArn: props.connectionArn }
    );

    // Synth: build & synth the CDK app
    const synth = new pipelines.ShellStep('Synth', {
      input: source,
      env: { CDK_NEW_BOOTSTRAP: '1' },
      installCommands: [
        'if [ -f package-lock.json ]; then npm ci; else npm install; fi || npm install',
        'if [ -f infra/cdk/package-lock.json ]; then npm --prefix infra/cdk ci; else npm --prefix infra/cdk install; fi || npm --prefix infra/cdk install',
        ],
      commands: [
        'npm --prefix infra/cdk run build || true',
        'npx --prefix infra/cdk cdk synth',
      ],
      primaryOutputDirectory: 'infra/cdk/cdk.out',
    });

    // CDK Pipelines (no direct access to underlying CodePipeline needed)
    const pipeline = new pipelines.CodePipeline(this, 'EntrixPipeline', {
      pipelineName: 'EntrixPipeline',
      synth,
      crossAccountKeys: false,
      pipelineType: cp.PipelineType.V2, 
      selfMutation: false, 
    });

    // Dev stage (deploys EntrixCoreStack into this account/region)
    pipeline.addStage(new DevAppStage(this, 'Dev', { env: props.env }));
    pipeline.buildPipeline();

    // ---- Notifications via EventBridge → SNS (no need to touch pipeline.pipeline) ----
    new events.Rule(this, 'PipelineStateChange', {
      description: 'Notify on CodePipeline execution state changes',
      eventPattern: {
        source: ['aws.codepipeline'],
        detailType: ['CodePipeline Pipeline Execution State Change'],
        detail: { pipeline: ['EntrixPipeline'] },
      },
    }).addTarget(new targets.SnsTopic(alertsTopic));
  }
}
