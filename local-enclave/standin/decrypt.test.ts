import { describe, expect, it } from 'vitest'
import { TextReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js'
import { DecryptError, decryptResultsZip, fingerprintSpki, spkiDerFromPrivateKey } from './decrypt'
import { encryptLikeToa, keyPair, spkiOf } from './testing'

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

    it('rejects a zip without a manifest', async () => {
        const writer = new ZipWriter(new Uint8ArrayWriter())
        await writer.add('results.csv', new TextReader('not encrypted at all'))
        const zip = await writer.close()

        await expect(decryptResultsZip(zip, reviewer.privateKey)).rejects.toThrow('manifest.json')
    })
})
