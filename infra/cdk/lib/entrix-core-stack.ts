import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrationsv2 from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as codedeploy from 'aws-cdk-lib/aws-codedeploy';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';

export class EntrixCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const resultsBucket = new s3.Bucket(this, 'OrderResultsBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      lifecycleRules: [
        {
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
    });

    const table = new dynamodb.Table(this, 'RecordsTable', {
      partitionKey: { name: 'record_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const lambdaA = new lambda.Function(this, 'LambdaA', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.lambda_handler',
      code: lambda.Code.fromAsset('../../lambdas/lambda_a'),
      timeout: cdk.Duration.seconds(5),
      memorySize: 256,
    });

    const lambdaB = new lambda.Function(this, 'LambdaB', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.lambda_handler',
      code: lambda.Code.fromAsset('../../lambdas/lambda_b'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { LOG_BUCKET: resultsBucket.bucketName },
    });
    resultsBucket.grantPut(lambdaB);

    const postLambda = new lambda.Function(this, 'PostLambda', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'app.lambda_handler',
      code: lambda.Code.fromAsset('../../lambdas/post_lambda'),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: { TABLE_NAME: table.tableName },
    });
    table.grantWriteData(postLambda);

    const httpApi = new apigwv2.HttpApi(this, 'RecordsApi', { apiName: 'records-api' });
    httpApi.addRoutes({
      path: '/records',
      methods: [apigwv2.HttpMethod.POST],
      integration: new integrationsv2.HttpLambdaIntegration('PostIntegration', postLambda),
    });
    new cdk.CfnOutput(this, 'ApiUrl', { value: httpApi.apiEndpoint });

    const errorTopic = new sns.Topic(this, 'OrderErrorsTopic', { displayName: 'order-errors' });

    // ---------- Step Functions pipeline ----------
    // 1) Invoke A
    const invokeA = new tasks.LambdaInvoke(this, 'Invoke Lambda A', {
      lambdaFunction: lambdaA,
      outputPath: '$.Payload',
    });

    // 2) Wait (for backoff)
    const wait = new stepfunctions.Wait(this, 'Wait Before Retry', {
      time: stepfunctions.WaitTime.duration(cdk.Duration.seconds(10)),
    });

    // 3) A "proceed" pass state to continue the chain if results===true
    const proceed = new stepfunctions.Pass(this, 'Proceed');

    // 4) Choice to loop until results===true
    const checkResults = new stepfunctions.Choice(this, 'Results True?')
      .when(stepfunctions.Condition.booleanEquals('$.results', true), proceed)
      .otherwise(wait.next(invokeA));

    // Wire the loop: A -> Choice, false branch -> wait -> A
    invokeA.next(checkResults);

    // 5) Lambda B task and error notification
    const invokeB = new tasks.LambdaInvoke(this, 'Invoke Lambda B', {
      lambdaFunction: lambdaB,
      payload: stepfunctions.TaskInput.fromObject({
        'status.$': '$.status',
        'power.$': '$.power',
      }),
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    const notify = new tasks.SnsPublish(this, 'Notify Error', {
      topic: errorTopic,
      message: stepfunctions.TaskInput.fromJsonPathAt('$'),
      subject: 'Order Processing Error',
      resultPath: stepfunctions.JsonPath.DISCARD,
    });

    // 6) Map over orders using the new itemProcessor API (no deprecation warning)
    const mapOrders = new stepfunctions.Map(this, 'For each order', {
      itemsPath: stepfunctions.JsonPath.stringAt('$.orders'),
      maxConcurrency: 5,
      resultPath: stepfunctions.JsonPath.DISCARD,
    });
    mapOrders.itemProcessor(invokeB.addCatch(notify, { resultPath: '$.error' }));

    // Continue after "proceed" to fan-out
    proceed.next(mapOrders);

    // 7) Build the state machine from the starting task (invokeA)
    const sfn = new stepfunctions.StateMachine(this, 'OrdersPipeline', {
      definitionBody: stepfunctions.DefinitionBody.fromChainable(invokeA),
      stateMachineType: stepfunctions.StateMachineType.STANDARD,
      timeout: cdk.Duration.minutes(5),
      logs: {
        destination: new logs.LogGroup(this, 'SfnLogs', {
          retention: logs.RetentionDays.ONE_WEEK,
        }),
        level: stepfunctions.LogLevel.ALL,
      },
    });

    // 8) Schedule it
    new events.Rule(this, 'ScheduleRule', {
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
    }).addTarget(new targets.SfnStateMachine(sfn));

    // ---------- CodeDeploy: aliases, alarms, canary ----------
    const lambdaAAlias = new lambda.Alias(this, 'LambdaAProdAlias', {
      aliasName: 'prod',
      version: lambdaA.currentVersion,
    });
    const lambdaBAlias = new lambda.Alias(this, 'LambdaBProdAlias', {
      aliasName: 'prod',
      version: lambdaB.currentVersion,
    });
    const postLambdaAlias = new lambda.Alias(this, 'PostLambdaProdAlias', {
      aliasName: 'prod',
      version: postLambda.currentVersion,
    });

    const alarmA = new cloudwatch.Alarm(this, 'LambdaAErrorsAlarm', {
      metric: lambdaAAlias.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const alarmB = new cloudwatch.Alarm(this, 'LambdaBErrorsAlarm', {
      metric: lambdaBAlias.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });
    const alarmPost = new cloudwatch.Alarm(this, 'PostLambdaErrorsAlarm', {
      metric: postLambdaAlias.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
    });

    new codedeploy.LambdaDeploymentGroup(this, 'LambdaADeploymentGroup', {
      application: new codedeploy.LambdaApplication(this, 'LambdaAApp'),
      alias: lambdaAAlias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [alarmA],
      autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: true },
    });

    new codedeploy.LambdaDeploymentGroup(this, 'LambdaBDeploymentGroup', {
      application: new codedeploy.LambdaApplication(this, 'LambdaBApp'),
      alias: lambdaBAlias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [alarmB],
      autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: true },
    });

    new codedeploy.LambdaDeploymentGroup(this, 'PostLambdaDeploymentGroup', {
      application: new codedeploy.LambdaApplication(this, 'PostLambdaApp'),
      alias: postLambdaAlias,
      deploymentConfig: codedeploy.LambdaDeploymentConfig.CANARY_10PERCENT_5MINUTES,
      alarms: [alarmPost],
      autoRollback: { failedDeployment: true, stoppedDeployment: true, deploymentInAlarm: true },
    });
  }
}