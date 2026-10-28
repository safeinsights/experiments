import { describe, expect, it } from 'vitest'
import { TextReader, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from '@zip.js/zip.js'
import {
    DecryptError,
    decryptResultsZip,
    fingerprintSpki,
    spkiDerFromPrivateKey,
    type ResultsManifest,
} from './decrypt'
import { encryptLikeToa, keyPair, spkiOf } from './testing'

/** Copy a results zip with manifest.json passed through `change`; every other entry is left as is. */
async function rewriteManifest(
    zip: Uint8Array,
    change: (manifest: ResultsManifest) => ResultsManifest,
): Promise<Uint8Array> {
    const reader = new ZipReader(new Uint8ArrayReader(zip))
    const writer = new ZipWriter(new Uint8ArrayWriter())
    for (const entry of await reader.getEntries()) {
        if (entry.directory) continue
        if (entry.filename === 'manifest.json') {
            const manifest = JSON.parse(await entry.getData(new TextWriter())) as ResultsManifest
            await writer.add(entry.filename, new TextReader(JSON.stringify(change(manifest))))
        } else {
            await writer.add(entry.filename, new Uint8ArrayReader(await entry.getData(new Uint8ArrayWriter())))
        }
    }
    await reader.close()
    return writer.close()
}

describe('decryptResultsZip', () => {
    const reviewer = keyPair()
    const other = keyPair()

    it('recovers every file encrypted for the reviewer key, among several recipients', async () => {
        const files = {
            'results.csv': Buffer.from('group,count\nA,42\n'),
            'blob.bin': Buffer.from([0, 255, 1, 254, 7]),
        }
        const zip = await encryptLikeToa(files, [spkiOf(other.publicKey), spkiOf(reviewer.publicKey)])

        const decrypted = await decryptResultsZip(zip, reviewer.privateKey)

        expect(decrypted.map((f) => f.path).sort()).toEqual(['blob.bin', 'results.csv'])
        for (const file of decrypted) {
            expect(file.contents.equals(files[file.path as keyof typeof files])).toBe(true)
            expect(file.bytes).toBe(file.contents.length)
        }
    })

    it('names the missing fingerprint when the zip was encrypted for someone else', async () => {
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('x') }, [spkiOf(other.publicKey)])
        const mine = fingerprintSpki(spkiDerFromPrivateKey(reviewer.privateKey)).slice(0, 12)

        await expect(decryptResultsZip(zip, reviewer.privateKey)).rejects.toThrow(DecryptError)
        await expect(decryptResultsZip(zip, reviewer.privateKey)).rejects.toThrow(mine)
    })

    it('decrypts the AES-GCM format with the job id bound in', async () => {
        const jobId = '2b0c8f9e-1d2a-4e5f-9a7b-3c4d5e6f7a8b'
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('group,count\nA,42\n') }, [
            spkiOf(reviewer.publicKey),
        ])
        const bound = await encryptLikeToa({ 'results.csv': Buffer.from('a,b\n1,2\n') }, [spkiOf(reviewer.publicKey)], {
            jobId,
        })

        expect((await decryptResultsZip(zip, reviewer.privateKey))[0]!.contents.toString()).toBe('group,count\nA,42\n')
        expect((await decryptResultsZip(bound, reviewer.privateKey))[0]!.contents.toString()).toBe('a,b\n1,2\n')
    })

    it('still decrypts the legacy AES-CBC format', async () => {
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('legacy\n') }, [spkiOf(reviewer.publicKey)], {
            cipher: 'AES-CBC',
        })

        expect((await decryptResultsZip(zip, reviewer.privateKey))[0]!.contents.toString()).toBe('legacy\n')
    })

    it('fails AES-GCM authentication when the manifest job id was changed', async () => {
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('x') }, [spkiOf(reviewer.publicKey)], {
            jobId: '2b0c8f9e-1d2a-4e5f-9a7b-3c4d5e6f7a8b',
        })
        const tampered = await rewriteManifest(zip, (m) => ({ ...m, jobId: '00000000-0000-4000-8000-000000000000' }))

        await expect(decryptResultsZip(tampered, reviewer.privateKey)).rejects.toThrow(DecryptError)
        await expect(decryptResultsZip(tampered, reviewer.privateKey)).rejects.toThrow('authentication failed')
    })

    it('rejects a manifest version it does not know', async () => {
        const zip = await encryptLikeToa({ 'results.csv': Buffer.from('x') }, [spkiOf(reviewer.publicKey)])
        const future = await rewriteManifest(zip, (m) => ({ ...m, version: 3 }))

        await expect(decryptResultsZip(future, reviewer.privateKey)).rejects.toThrow('unsupported manifest version 3')
    })

    it('rejects a zip without a manifest', async () => {
        const writer = new ZipWriter(new Uint8ArrayWriter())
        await writer.add('results.csv', new TextReader('not encrypted at all'))
        const zip = await writer.close()

        await expect(decryptResultsZip(zip, reviewer.privateKey)).rejects.toThrow('manifest.json')
    })
})
