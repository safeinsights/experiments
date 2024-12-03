import { ZipReader, BlobWriter, BlobReader, TextWriter, type Entry } from '@zip.js/zip.js';
import type { ResultsManifest, ResultsFile } from './types.js';


class Results {
    zip: ZipReader
    privateKey: CryptoKey
    publicKey: CryptoKey
    entries: Entry[]
    files: Record<string, string> = {}

    async initialize(zipBlob: Blob, pkey: string) {
        this.zip = new ZipReader(new BlobReader(zipBlob))
        this.privateKey = await crypto.subtle.importKey(
            "pkcs8",
            this.pemToDer(pkey),
            { name: "RSA-OAEP", hash: { name: "SHA-256" } },
            true, // must be extractable, we need to export public key later
            ["decrypt"]
        );
        const jwk = await crypto.subtle.exportKey("jwk", this.privateKey);
        this.publicKey = await crypto.subtle.importKey(
            "jwk",
            {
                kty: jwk.kty,
                n: jwk.n,
                e: jwk.e,
                alg: "RS256", // Algorithm identifier for RSASSA-PKCS1-v1_5 with SHA-256
                ext: true,
            },
            { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
            true, // Extractable
            ["verify"] // Key usages
        );        
        this.entries = await this.zip.getEntries();
        return this
    }

    async extractManifest() {
        for (const entry of this.entries) {
            if (entry.getData && entry.filename == "manifest.json") {
                const manifestText = await entry.getData(new TextWriter())
                const manifest = JSON.parse(manifestText) as ResultsManifest

                for (const [signature, entry] of Object.entries(manifest.audit)) {
                    const isValid = await crypto.subtle.verify(
                        "RSASSA-PKCS1-v1_5",
                        this.publicKey,
                        Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
                        new TextEncoder().encode(JSON.stringify(entry))
                    );
                    if (!isValid) {
                        throw new Error(`Invalid signature for entry: ${JSON.stringify(entry, null, 2)}`)
                    }
                }
                
                
                this.manifest = manifest
            }
        }
        return this
    }

    async extractFiles() {
        for (const entry of this.entries) {
            // skip directories and manifest because we already processed it
            if (!entry.getData || entry.filename == 'manifest.json') {
                continue
            }
            const file = this.manifest.files[entry.filename]
            if (!file) {
                throw new Error(`No metadata found for file: ${entry.filename}`)
            }
            await this.extractFileEntry(entry, file)
            //            displayFile(entry.filename, contents)
        }
    }

    async extractFileEntry(entry: Entry, file: ResultsFile) {
        const aesKeyBuffer = await crypto.subtle.decrypt(
            { name: "RSA-OAEP" },
            this.privateKey,
            this.decodeBase64(file.key)
        );

        const aesKey = await crypto.subtle.importKey(
            "raw",
            aesKeyBuffer,
            { name: "AES-CBC" },
            false,
            ["decrypt"]
        );

        const contentsBlob = await entry.getData(new BlobWriter())
        const decryptedDataBuffer = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv: this.decodeBase64(file.iv) },
            aesKey,
            await contentsBlob.arrayBuffer(),
        );

        // TODO:  check mime and use binary decoder if it's an image or somethig
        const decoder = new TextDecoder();
        const contents = decoder.decode(decryptedDataBuffer);
        this.files[entry.filename] = contents
    }
    
    
    decodeBase64(base64String: string) {
        return Uint8Array.from(atob(base64String), char => char.charCodeAt(0)).buffer;
    }

    pemToDer(pem: string) {
        const pemContents = pem
            .replace(/-+BEGIN (PUBLIC|PRIVATE) KEY-+/, '')
            .replace(/-+END (PUBLIC|PRIVATE) KEY-+/, '')
            .replace(/\s/g, "");

        return this.decodeBase64(pemContents)
    }

}


function displayFile(fileName: string, contents: string) {
    document.getElementById('files-panel')!.innerHTML += `<div>
       <h3>${fileName}</h3>
       <pre>${contents}</pre>
     </div>`
}



document.getElementById('decrypt-btn')!.addEventListener('click', async () => {

    document.getElementById('key-panel')!.style.display = 'none';
    
    fetch('/results').then(async (res) => {
        document.getElementById('files-panel')!.style.display = 'flex';
        
        const privateKeyPEM = document.getElementById('privateKeyPEM')!.value

        const results = new Results()
        await results.initialize(await res.blob(), privateKeyPEM)
        await results.extractManifest()
        displayFile('manifest.json', JSON.stringify(results.manifest, null, 4))
        await results.extractFiles()
        for (const [fileName, contents] of Object.entries(results.files)) {
            displayFile(fileName, contents)
        }
        
    })

})

// document.getElementById('decrypt-btn').click()
