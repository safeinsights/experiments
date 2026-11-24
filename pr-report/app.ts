import * as cdk from 'aws-cdk-lib'
import { PrReportStack } from './stack'

const app = new cdk.App()
new PrReportStack(app, 'PrReportStack', {
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
})
app.synth()
