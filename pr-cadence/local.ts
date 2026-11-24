// Prints the PR cadence report to the terminal; --publish also commits it to the experiments wiki.
// Uses GITHUB_TOKEN, or the gh CLI's token when that is unset.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { run } from './pr-cadence'

const { values } = parseArgs({ options: { publish: { type: 'boolean', default: false } } })
const token = process.env.GITHUB_TOKEN || execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim()
process.stdout.write(await run({ token, publish: values.publish }))
