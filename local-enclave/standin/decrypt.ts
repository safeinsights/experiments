import { constants, createDecipheriv, createHash, createPublicKey, privateDecrypt } from 'node:crypto'
import { TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js'
import type { Entry, FileEntry } from '@zip.js/zip.js'

// Node has no Worker global; tell zip.js instead of letting it probe for one.
configure({ useWebWorkers: false })

/** File-body ciphers si-encryption manifests declare. An absent `cipher` is the legacy AES-CBC format. */
export type CipherName = 'AES-CBC' | 'AES-GCM'

/**
 * manifest.json as written by si-encryption's ResultsWriter: one AES-256 key per file, wrapped with
 * RSA-OAEP(SHA-256) for every recipient fingerprint. Version 2 (si-encryption v1.1.6 onwards) uses
 * AES-GCM with the tag appended to each body and the job and path bound in as AAD; version 1 has no
 * `version`, `cipher` or `jobId` and uses AES-CBC.
 */
export type ResultsManifest = {
    version?: number
    cipher?: CipherName
    jobId?: string
    files: Record<string, { path: string; bytes: number; iv: string; keys: Record<string, { crypt: string }> }>
}

/** si-encryption's GCM_TAG_BITS (128). */
const GCM_TAG_BYTES = 16

/** si-encryption's fileAdditionalData: the AAD that ties a GCM body to its job and zip entry name. */
export function fileAdditionalData(jobId: string | undefined, path: string): Buffer {
    return Buffer.from(JSON.stringify(['si-encryption/job-results', 1, jobId ?? null, path]))
}

export type DecryptedFile = { path: string; bytes: number; contents: Buffer }

export class DecryptError extends Error {}

/** Lowercase hex SHA-256 of the SPKI DER, which is what si-encryption's fingerprintKeyData computes. */
export function fingerprintSpki(spkiDer: Buffer): string {
    return createHash('sha256').update(spkiDer).digest('hex')
}

export function spkiDerFromPrivateKey(privateKeyPem: string): Buffer {
    return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' })
}

export function spkiDerFromPublicKey(publicKeyPem: string): Buffer {
    return createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' })
}

const short = (fingerprint: string) => fingerprint.slice(0, 12)

/**
 * Read side of the si-encryption results format, on node:crypto + zip.js so this harness does not
 * have to compile si-encryption's TypeScript sources. The raw zip is kept by the caller, so a format
 * change upstream shows up here as a clear error rather than a silently empty results panel.
 */
export async function decryptResultsZip(zip: Uint8Array, privateKeyPem: string): Promise<DecryptedFile[]> {
    const fingerprint = fingerprintSpki(spkiDerFromPrivateKey(privateKeyPem))
    const reader = new ZipReader(new Uint8ArrayReader(zip))
    try {
        const entries = (await reader.getEntries()).filter(isFileEntry)
        const manifestEntry = entries.find((entry) => entry.filename === 'manifest.json')
        if (!manifestEntry) throw new DecryptError('manifest.json not found in the zip')
        const manifest = JSON.parse(await manifestEntry.getData(new TextWriter())) as ResultsManifest
        const { version = 1, cipher = 'AES-CBC' } = manifest
        if (version !== 1 && version !== 2) throw new DecryptError(`unsupported manifest version ${version}`)
        if (cipher !== 'AES-CBC' && cipher !== 'AES-GCM') throw new DecryptError(`unsupported cipher ${cipher}`)

        const files: DecryptedFile[] = []
        for (const entry of entries) {
            const info = manifest.files[entry.filename]
            if (!info) continue
            const wrapped = info.keys[fingerprint]?.crypt
            if (!wrapped) {
                const known = Object.keys(info.keys).map(short).join(', ') || 'none'
                throw new DecryptError(
                    `${entry.filename} was not encrypted for reviewer key ${short(fingerprint)}… (manifest keys: ${known})`,
                )
            }
            const rawAesKey = privateDecrypt(
                { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
                Buffer.from(wrapped, 'base64'),
            )
            const iv = Buffer.from(info.iv, 'base64')
            const body = await entry.getData(new Uint8ArrayWriter())
            const contents =
                cipher === 'AES-GCM'
                    ? decryptGcm(entry.filename, body, rawAesKey, iv, manifest.jobId)
                    : decryptCbc(body, rawAesKey, iv)
            if (contents.length !== info.bytes) {
                throw new DecryptError(
                    `${entry.filename}: decrypted ${contents.length} bytes but the manifest says ${info.bytes}`,
                )
            }
            files.push({ path: entry.filename, bytes: contents.length, contents })
        }
        return files
    } finally {
        await reader.close()
    }
}

function decryptCbc(body: Uint8Array, key: Buffer, iv: Buffer): Buffer {
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    return Buffer.concat([decipher.update(body), decipher.final()])
}

/** WebCrypto, which si-encryption uses, appends the tag to the ciphertext; node:crypto wants it apart. */
function decryptGcm(name: string, body: Uint8Array, key: Buffer, iv: Buffer, jobId: string | undefined): Buffer {
    if (body.length < GCM_TAG_BYTES) throw new DecryptError(`${name}: body is shorter than the GCM tag`)
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: GCM_TAG_BYTES })
    decipher.setAAD(fileAdditionalData(jobId, name))
    decipher.setAuthTag(body.subarray(body.length - GCM_TAG_BYTES))
    const plain = decipher.update(body.subarray(0, body.length - GCM_TAG_BYTES))
    try {
        return Buffer.concat([plain, decipher.final()])
    } catch {
        throw new DecryptError(`${name}: AES-GCM authentication failed (tampered body, or a job id or path mismatch)`)
    }
}

function isFileEntry(entry: Entry): entry is FileEntry {
    return !entry.directory
}
