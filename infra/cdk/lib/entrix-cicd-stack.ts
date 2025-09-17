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
    
      installCommands: [
        'echo "SRC=$CODEBUILD_SRC_DIR"; pwd; ls -la',
        // detect CDK project dir
        'CDK_DIR="infra/cdk"; [ -f "$CDK_DIR/package.json" ] || CDK_DIR="cloud-lambda-challenge/infra/cdk"',
        'echo "[install] Using CDK_DIR=$CDK_DIR"',
        // prefer Node 20 if nvm exists (image may default to Node 18)
        'if [ -s /usr/local/nvm/nvm.sh ]; then . /usr/local/nvm/nvm.sh && nvm install 20 && nvm use 20; fi',
        'node -v && npm -v',
        // install deps without changing global CWD
        '[ -f "$CDK_DIR/package-lock.json" ] && npm --prefix "$CDK_DIR" ci || npm --prefix "$CDK_DIR" install',
      ],
    
      commands: [
        'CDK_DIR="infra/cdk"; [ -f "$CDK_DIR/package.json" ] || CDK_DIR="cloud-lambda-challenge/infra/cdk"',
        'echo "[build] Using CDK_DIR=$CDK_DIR"',
      
        // show sources we actually have
        'echo "Tree snapshot:"',
        'find "$CDK_DIR" -maxdepth 2 -type f \\( -name "*.ts" -o -name "package.json" -o -name "tsconfig.json" \\) -print',
      
        // fail fast if entry is missing
        '[ -f "$CDK_DIR/bin/entrix-challenge-cdk.ts" ] || { echo "Missing $CDK_DIR/bin/entrix-challenge-cdk.ts"; exit 1; }',
      
        // optional compile; ts-node doesn’t require it
        'npm --prefix "$CDK_DIR" run build || true',
      
        // ensure ts-node in the project
        '(cd "$CDK_DIR" && [ -x node_modules/.bin/ts-node ] || npm i -D ts-node)',
      
        // synth from inside CDK_DIR so local node_modules/.bin is on PATH
        '(cd "$CDK_DIR" && npx cdk synth --app "npx ts-node --transpile-only bin/entrix-challenge-cdk.ts" -o cdk.out)',
      ],
    
      // artifact path relative to repo root
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
