#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { EntrixCoreStack } from '../lib/entrix-core-stack';
const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'eu-west-1' };
new EntrixCoreStack(app, 'EntrixCoreStack', { env });


/**
 * Optional: enable CodePipeline-based deployment by supplying env vars:
 *   REPO_OWNER, REPO_NAME, BRANCH (default: main), CONNECTION_ARN
 */
import { EntrixCicdStack } from '../lib/entrix-cicd-stack';

const repoOwner = process.env.REPO_OWNER ?? 'wasimakram777';
const repoName = process.env.REPO_NAME  ?? 'cloud-lambda-challenge';
const branch = process.env.BRANCH     ?? 'main';
const connectionArn = process.env.CONNECTION_ARN ?? 'arn:aws:codestar-connections:eu-west-1:079036477129:connection/f9815251-c019-4361-8f10-74e01b944c43';

if (repoOwner && repoName && connectionArn) {
  new EntrixCicdStack(app, 'EntrixCicdStack', {
    repoOwner,
    repoName,
    branch,
    connectionArn,
    env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION,
    },
  });
}
