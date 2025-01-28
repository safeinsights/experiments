import { ZipReader, Entry, BlobReader, TextReader, TextWriter, BlobWriter } from '@zip.js/zip.js';
import type { ResultsManifest, ResultsFile } from './types';
// import { ZipReader, BlobWriter, BlobReader, TextWriter, type Entry } from '@zip.js/zip.js';

export class ResultsReader {
    manifest: ResultsManifest = {
        files: {},
    };

    private zipReader: ZipReader<Blob>;

    constructor(private privateKey: string) { }


    async initialize(zipBlob: Blob) {
        this.zipReader = new ZipReader(new BlobReader(zipBlob));

        const entries = await this.zipReader.getEntries();
        for (const entry of entries) {
            if (entry.getData && entry.filename == "manifest.json") {

                const manifestText = await entry.getData(new TextWriter())
                this.manifest = JSON.parse(manifestText) as ResultsManifest
            }
        }
        if (!this.manifest) {
            throw new Error('Manifest not found in zip archive.');
        }

        return this
    }


    async *entries(): AsyncGenerator<ResultsFile & { contents: ArrayBuffer }, void, void> {
        const entries = await this.zipReader.getEntries();
        for (const entry of entries) {
            const file = this.manifest.files[entry.filename]
            if (entry.getData && file) {
                const contents = await this.readFile(file, entry)
                yield { ...file, contents }
            }
        }
    }

    async readFile(fileEntry: ResultsFile, entry: Entry): Promise<ArrayBuffer> {
        if (!entry.getData) { throw new Error('Entry does not have data') }

        const encryptedData = await entry.getData(new BlobWriter());

        const key = await this.decryptKeyWithPrivateKey(fileEntry.key);
        const iv = Uint8Array.from(Buffer.from(fileEntry.iv, 'base64'));
        return this.decryptData(encryptedData, key, iv);
    }

    private async decryptKeyWithPrivateKey(encryptedKeyBase64: string): Promise<CryptoKey> {
        const encryptedKey = Buffer.from(encryptedKeyBase64, 'base64');
        const privateKeyBuffer = Buffer.from(this.privateKey, 'base64');

        const privateKey = await crypto.subtle.importKey(
            'pkcs8',
            privateKeyBuffer,
            {
                name: 'RSA-OAEP',
                hash: 'SHA-256',
            },
            false,
            ['decrypt']
        );

        const rawKey = await crypto.subtle.decrypt(
            {
                name: 'RSA-OAEP',
            },
            privateKey,
            encryptedKey
        );

        return await crypto.subtle.importKey(
            'raw',
            rawKey,
            { name: 'AES-CBC' },
            false,
            ['decrypt']
        );
    }

    private async decryptData(encryptedData: Blob, aesKey: CryptoKey, iv: Uint8Array): Promise<ArrayBuffer> {
        const arrayBuffer = await encryptedData.arrayBuffer();
        return crypto.subtle.decrypt(
            {
                name: 'AES-CBC',
                iv,
            },
            aesKey,
            arrayBuffer
        );
    }
}
