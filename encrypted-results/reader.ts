import { ZipReader, Entry, BlobReader, TextReader, TextWriter, BlobWriter } from '@zip.js/zip.js';
import type { ResultsManifest, ResultsFile, PublicKey } from './types';
import { pemToArrayBuffer, arrayBufferToHex } from './util'

export class ResultsReader {
    manifest: ResultsManifest = {
        files: {},
    };

    private zipReader: ZipReader<Blob>;
    publicKeyFingerPrint: string
    privateKey: CryptoKey

    constructor(private privateKeyString: string) {
        this.parseKeys()
    }


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

        const encptionKey = fileEntry.keys[this.publicKeyFingerPrint];
        if (!encptionKey) throw new Error(`file was not encypted with key signature ${this.publicKeyFingerPrint}`)

        const aesKey  = await this.decryptKeyWithPrivateKey(encptionKey.crypt);

        const iv = Uint8Array.from(Buffer.from(fileEntry.iv, 'base64'));
        return this.decryptData(encryptedData, aesKey, iv);
    }

    private async decryptKeyWithPrivateKey(encryptedKeyBase64: string): Promise<CryptoKey> {
        const encryptedKey = Buffer.from(encryptedKeyBase64, 'base64');

        const rawKey = await crypto.subtle.decrypt(
            {
                name: 'RSA-OAEP',
            },
            this.privateKey,
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

    private async parseKeys() {
        const privateKeyBuffer = pemToArrayBuffer(this.privateKeyString)

        // Import the RSA private key.
        // Adjust the algorithm (e.g., "RSA-PSS", "RSA-OAEP") and usages as needed.
        this.privateKey = await crypto.subtle.importKey(
            "pkcs8",
            privateKeyBuffer,
            {
                name: "RSA-PSS", // or "RSA-OAEP" depending on your key usage
                hash: "SHA-256"
            },
            true,
            ["sign"]
        );

        // Export the private key as JWK to extract the public key parameters (n and e)
        const jwk = await crypto.subtle.exportKey("jwk", this.privateKey);

        // Create a JWK object for the public key using modulus (n) and exponent (e)
        const publicJwk = {
            kty: jwk.kty,
            n: jwk.n,
            e: jwk.e,
            alg: jwk.alg,
            ext: true,
        };

        // Import the public key
        const publicKey = await crypto.subtle.importKey(
            "jwk",
            publicJwk,
            {
                name: "RSA-PSS", // ensure this matches the private key's algorithm
                hash: "SHA-256"
            },
            true,
            ["verify"]
        );

        // Export the public key as SPKI (DER encoded)
        const spki = await crypto.subtle.exportKey("spki", publicKey);

        // Compute the SHA‑256 digest (fingerprint) of the SPKI data
        const fingerprintBuffer = await crypto.subtle.digest("SHA-256", spki);

        // Convert the ArrayBuffer fingerprint into a hexadecimal string (colon-delimited)
        this.publicKeyFingerPrint = arrayBufferToHex(fingerprintBuffer)
    }
}
