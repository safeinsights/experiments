import * as cdk from 'aws-cdk-lib'
import { PrCadenceStack } from './stack'

const app = new cdk.App()
new PrCadenceStack(app, 'PrCadenceStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
})
app.synth()
