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

    // Synth: run in infra/cdk, install, build, synth
    const synth = new pipelines.ShellStep('Synth', {
      input: source,
      env: { CDK_NEW_BOOTSTRAP: '1' },
      installCommands: [
        'echo "SRC=$CODEBUILD_SRC_DIR"; pwd; ls -la',
        // pick correct folder even if CodePipeline checks out into a top-level dir
        'WORKDIR="infra/cdk"; [ -d "$WORKDIR" ] || WORKDIR="cloud-lambda-challenge/infra/cdk"',
        'echo "Using WORKDIR=$WORKDIR"',
        // Prefer Node 20 if nvm present (CodeBuild STANDARD_7_0 already supports Node 20)
        'if [ -s /usr/local/nvm/nvm.sh ]; then . /usr/local/nvm/nvm.sh && nvm install 20 && nvm use 20; fi',
        'cd "$WORKDIR"',
        'node -v && npm -v',
        '[ -f package-lock.json ] && npm ci || npm install',
      ],
      commands: [
        'cd "$WORKDIR"',
        'npm run build',
        // make sure dist/bin/entrix-challenge-cdk.js exists after build
        'test -f dist/bin/entrix-challenge-cdk.js || { echo "CDK app entry missing"; ls -la dist/bin; exit 1; }',
        'npx cdk synth --app "node dist/bin/entrix-challenge-cdk.js" -o cdk.out',
      ],
      primaryOutputDirectory: 'infra/cdk/cdk.out', // CDK Pipelines handles the path mapping
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
