import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EntrixCoreStack } from './lib/entrix-core-stack';

test('DynamoDB table with TTL exists', () => {
  const app = new App();
  const stack = new EntrixCoreStack(app, 'TestStack', {});
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true }
  });
});
