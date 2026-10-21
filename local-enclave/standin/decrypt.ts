import { constants, createDecipheriv, createHash, createPublicKey, privateDecrypt } from 'node:crypto'
import { TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js'
import type { Entry, FileEntry } from '@zip.js/zip.js'

// Node has no Worker global; tell zip.js instead of letting it probe for one.
configure({ useWebWorkers: false })

/**
 * manifest.json as written by si-encryption's ResultsWriter at the commit the trusted-output-app pins:
 * one AES-256-CBC key per file, wrapped with RSA-OAEP(SHA-256) for every recipient fingerprint.
 */
export type ResultsManifest = {
    files: Record<string, { path: string; bytes: number; iv: string; keys: Record<string, { crypt: string }> }>
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
            const decipher = createDecipheriv('aes-256-cbc', rawAesKey, Buffer.from(info.iv, 'base64'))
            const body = await entry.getData(new Uint8ArrayWriter())
            const contents = Buffer.concat([decipher.update(body), decipher.final()])
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

function isFileEntry(entry: Entry): entry is FileEntry {
    return !entry.directory
}
