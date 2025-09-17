import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cp from 'aws-cdk-lib/aws-codepipeline';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { EntrixCoreStack } from './entrix-core-stack';

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

    // Alerts (optional)
    const alertsTopic = new sns.Topic(this, 'CicdAlertsTopic', {
      displayName: 'cicd-alerts',
    });

    // Source via CodeStar Connection
    const source = pipelines.CodePipelineSource.connection(
      `${props.repoOwner}/${props.repoName}`,
      branch,
      { connectionArn: props.connectionArn }
    );

    const synth = new pipelines.ShellStep('Synth', {
      input: source,
      env: { CDK_NEW_BOOTSTRAP: '1' },
    
      // Install deps for the CDK project without changing directories
      installCommands: [
        'echo "SRC=$CODEBUILD_SRC_DIR"; pwd; ls -la',
        // Try both layouts: with and without a top-level folder
        'CDK_DIR="infra/cdk"; [ -f "$CDK_DIR/package.json" ] || CDK_DIR="cloud-lambda-challenge/infra/cdk"',
        'echo "Using CDK_DIR=$CDK_DIR"',
        // Optional: use Node 20 if available via nvm (image may default to Node 18)
        'if [ -s /usr/local/nvm/nvm.sh ]; then . /usr/local/nvm/nvm.sh && nvm install 20 && nvm use 20; fi',
        'node -v && npm -v',
        // Install dependencies inside the CDK project
        '[ -f "$CDK_DIR/package-lock.json" ] && npm --prefix "$CDK_DIR" ci || npm --prefix "$CDK_DIR" install',
      ],
    
      commands: [
        // Build TypeScript (not strictly needed if we use ts-node, but keeps JS outputs if you want them)
        'npm --prefix "$CDK_DIR" run build || true',
      
        // Prefer running CDK via ts-node so we don’t depend on dist/bin
        // This works whether or not "dist/" exists.
        'APP_TS="$CDK_DIR/bin/entrix-challenge-cdk.ts"',
        'APP_JS1="$CDK_DIR/dist/bin/entrix-challenge-cdk.js"',
        'APP_JS2="$CDK_DIR/bin/entrix-challenge-cdk.js"',
      
        // Choose the best available entry (TS via ts-node first, then compiled JS fallbacks)
        'if [ -f "$APP_TS" ]; then APP_CMD="npx --prefix $CDK_DIR ts-node --transpile-only $APP_TS";',
        'elif [ -f "$APP_JS1" ]; then APP_CMD="node $APP_JS1";',
        'elif [ -f "$APP_JS2" ]; then APP_CMD="node $APP_JS2";',
        'else echo "No app entry found (neither $APP_TS nor $APP_JS1/$APP_JS2)"; ls -la "$CDK_DIR"; find "$CDK_DIR" -maxdepth 3 -name "entrix-challenge-cdk.*"; exit 1; fi',
      
        'echo "Synth with: $APP_CMD"',
        'npx --prefix "$CDK_DIR" cdk synth --app "$APP_CMD" -o "$CDK_DIR/cdk.out"',
      ],
    
      // Artifact path is always relative to the repo root
      primaryOutputDirectory: 'infra/cdk/cdk.out',
    });



    const pipeline = new pipelines.CodePipeline(this, 'EntrixPipeline', {
      pipelineName: 'EntrixPipeline',
      synth,
      crossAccountKeys: false,
      pipelineType: cp.PipelineType.V2,
      selfMutation: false,
      // Ensure modern CodeBuild image (Node 20), and allow easy env overrides later
      codeBuildDefaults: {
        buildEnvironment: {
          buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
          privileged: false,
        },
        partialBuildSpec: codebuild.BuildSpec.fromObject({
          version: '0.2',
        }),
      },
    });

    // Deploy Dev
    pipeline.addStage(new DevAppStage(this, 'Dev', { env: props.env }));
    pipeline.buildPipeline();

    // Notify on pipeline state changes
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
