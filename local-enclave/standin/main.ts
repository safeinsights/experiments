/* eslint-disable no-console */
/**
 * Entry point for the `bma` compose service: a stand-in for the management app's enclave API plus a
 * page to trigger jobs and read decrypted results. Keys come from state/keys (written by
 * dev-enclave.ts on the host); everything it records lands in state/ too.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { JobStore } from './jobs'
import type { Sample } from './page'
import { createStandin } from './server'

const stateDir = process.env.STATE_DIR ?? path.resolve(import.meta.dirname, '..', 'state')
const port = Number(process.env.BMA_PORT ?? 4000)
const memberId = process.env.MEMBER_ID ?? 'openstax'
const verifyJwt = process.env.VERIFY_JWT !== 'false'

const readKey = (name: string): string => {
    const file = path.join(stateDir, 'keys', name)
    if (!existsSync(file)) throw new Error(`missing ${file}; run \`dev-enclave.ts up\` on the host to generate keys`)
    return readFileSync(file, 'utf8')
}

const samplesFile = path.join(stateDir, 'samples.json')
const samples = (): Sample[] =>
    existsSync(samplesFile) ? (JSON.parse(readFileSync(samplesFile, 'utf8')) as Sample[]) : []

const store = new JobStore(path.join(stateDir, 'jobs.json'), path.join(stateDir, 'jobs'))
const server = createStandin({
    memberId,
    enclavePublicKeyPem: readKey('enclave.pub.pem'),
    reviewerPrivateKeyPem: readKey('reviewer.key.pem'),
    verifyJwt,
    store,
    samples,
    baseImages: (process.env.CODE_BASE_IMAGES ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
})

server.listen(port, '0.0.0.0', () => {
    console.log(
        `[bma] management app stand-in listening on ${port} (member ${memberId}, JWT ${verifyJwt ? 'verified' : 'NOT verified'})`,
    )
})
