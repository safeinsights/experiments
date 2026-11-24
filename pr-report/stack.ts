import path from 'node:path'
import * as cdk from 'aws-cdk-lib'

// A daily Lambda that rebuilds the PR report and commits it to the experiments wiki. The GitHub
// token in the secret is the only credential; the stack creates the secret with a placeholder value.
export class PrReportStack extends cdk.Stack {
    constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
        super(scope, id, props)

        const token = new cdk.aws_secretsmanager.Secret(this, 'GithubToken', {
            secretName: 'pr-report/github-token',
            description: 'GitHub token (repo, read:org) that counts PRs and writes the PR report wiki page',
        })

        const report = new cdk.aws_lambda_nodejs.NodejsFunction(this, 'Report', {
            entry: path.join(import.meta.dirname, 'pr-report.ts'),
            handler: 'handler',
            // The repo root also carries an older package-lock.json; pnpm's lock is the one in use
            depsLockFilePath: path.join(import.meta.dirname, '..', 'pnpm-lock.yaml'),
            runtime: cdk.aws_lambda.Runtime.NODEJS_24_X,
            timeout: cdk.Duration.minutes(5),
            memorySize: 512,
            environment: { SECRET_ID: token.secretName },
        })
        token.grantRead(report)

        new cdk.aws_scheduler.Schedule(this, 'Daily', {
            description: 'Update the PR report page on the experiments wiki',
            schedule: cdk.aws_scheduler.ScheduleExpression.cron({
                minute: '0',
                hour: '7',
                timeZone: cdk.TimeZone.AMERICA_CHICAGO,
            }),
            target: new cdk.aws_scheduler_targets.LambdaInvoke(report, { retryAttempts: 2 }),
        })

        // The tag set iac's stacks carry (iac/lib/definitions.ts)
        const tags = {
            Project: 'SafeInsights',
            Name: 'pr-report',
            Application: 'PrReport',
            Owner: 'SI Team Shrimp',
            Environment: 'DevOps',
            AssetClassification: 'Core',
            DataClassification: 'Internal',
            MissionCriticality: 'Development',
            AccessLevel: 'InternalOnly',
        }
        for (const [key, value] of Object.entries(tags)) cdk.Tags.of(this).add(key, value)
    }
}
