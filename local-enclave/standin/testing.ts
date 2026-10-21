/** Test-only helpers: a key pair and an encryptor that writes what the trusted-output-app writes. */
import {
    constants,
    createCipheriv,
    createPublicKey,
    generateKeyPairSync,
    publicEncrypt,
    randomBytes,
} from 'node:crypto'
import { TextReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { fingerprintSpki, spkiDerFromPublicKey, type ResultsManifest } from './decrypt'

export function keyPair(): { publicKey: string; privateKey: string } {
    return generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
}

/**
 * The same zip si-encryption's ResultsWriter produces: one random AES-256-CBC key and IV per file,
 * the key wrapped with RSA-OAEP(SHA-256) for every recipient, and a manifest.json describing it all.
 */
export async function encryptLikeToa(
    files: Record<string, Buffer>,
    recipientSpkiDers: Buffer[],
): Promise<Uint8Array<ArrayBuffer>> {
    const writer = new ZipWriter(new Uint8ArrayWriter())
    const manifest: ResultsManifest = { files: {} }
    for (const [name, content] of Object.entries(files)) {
        const aesKey = randomBytes(32)
        const iv = randomBytes(16)
        const cipher = createCipheriv('aes-256-cbc', aesKey, iv)
        const body = Buffer.concat([cipher.update(content), cipher.final()])
        const keys: ResultsManifest['files'][string]['keys'] = {}
        for (const spki of recipientSpkiDers) {
            const wrapped = publicEncrypt(
                {
                    key: createPublicKey({ key: spki, format: 'der', type: 'spki' }),
                    padding: constants.RSA_PKCS1_OAEP_PADDING,
                    oaepHash: 'sha256',
                },
                aesKey,
            )
            keys[fingerprintSpki(spki)] = { crypt: wrapped.toString('base64') }
        }
        await writer.add(name, new Uint8ArrayReader(new Uint8Array(body)))
        manifest.files[name] = { path: name, bytes: content.length, iv: iv.toString('base64'), keys }
    }
    await writer.add('manifest.json', new TextReader(JSON.stringify(manifest)))
    return writer.close()
}

export const spkiOf = (publicKeyPem: string): Buffer => spkiDerFromPublicKey(publicKeyPem)
