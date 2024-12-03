import { ZipReader, BlobWriter, BlobReader, TextWriter, type Entry } from '@zip.js/zip.js';
import type { ResultsManifest, ResultsFile } from './types.js';


// IN REALITY, this would be stored with the member or researcher's profile
const publicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAs4G6qWTMu9cSiYraFLiE
HDX1aKVqyLqMl5ulMk9PHpynTPbY8edjxBKyFsbFt10TE2K+GxmwCl6cFfrXtZYR
kxcJT75pL/w93jm2KPs3rxyCIh5cpd9oXF03TJ32fklppS440SQjP1YPBUzaYGha
Dobmar7a/jOMZPvY30mfvLHLhFNOUlwlo/ztZ6i9cu/AO7UkwAhkKT/KIdVX/iOi
KgjnvO2KmW0IVQp1N4yREWFZTiTl3VnCxRTqcE9P49e2pQIIJ/uAMhBWokP5v5bt
zoZD1dgoyoq8hDGnAovsbXmHE/UkVVAwZu428Y1WTpxumBndugopDglzYWdCR8Nt
imzfA0RVb7s5kIcFAQ2v7lcu7EW5cn6jyOSpDWaQxTd/w+vYuUtNp2MGP5ecSAHe
UN5UaZ1WH7W3JoTnvTbd5em7Y4mhC3XhrKFKiXc6XBMZL71NyoiQcuEFZ76QiR2p
/X8RCbcuqxAzR2hcVFvEqYMZGguOIN/TzXKKvDefG9ajLLYSYwvGMU+2u3ZPgnme
gbDoM0P9lCJxDzKLBpSW/B/2NqsNsZva7T2NrJDvjCmWOarAmHnEtJdl6TMkdzsM
+zXXEqdir7jGcbrOg0u2Dve4Rvt1UxxWEWZtXl3+2qUstjzv8Ven06XlJp3IN4Dv
Z++j6KixG43Cmi2uws8lIM8CAwEAAQ==
-----END PUBLIC KEY-----`


function decodeBase64(base64String: string) {
    return Uint8Array.from(atob(base64String), char => char.charCodeAt(0)).buffer;
}

function pemToDer(pem: string) {
    const pemContents = pem
        .replace(/-+BEGIN (PUBLIC|PRIVATE) KEY-+/, '')
        .replace(/-+END (PUBLIC|PRIVATE) KEY-+/, '')
        .replace(/\s/g, "");

    return decodeBase64(pemContents) 
}


async function validateEntry(signature: string, data: string) {
    const publicKey = await crypto.subtle.importKey(
        "spki",
        pemToDer(publicKeyPEM),
        {
            name: "RSASSA-PKCS1-v1_5",
            hash: "SHA-256",
        },
        true,
        ["verify"]
    );

    return await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        publicKey,
        Uint8Array.from(atob(signature), (c) => c.charCodeAt(0)),
        new TextEncoder().encode(data)
    );
}


async function validateManifestOrThrow(manifest: ResultsManifest) {
    for (const [signature, entry] of Object.entries(manifest.audit)) {
        if (!validateEntry(signature, JSON.stringify(entry))) {
            throw new Error(`Invalid signature for entry: ${JSON.stringify(entry, null,2 )}`)
        }
    }
}


async function decryptFileEntry(privateKeyPEM, entry: Entry, file: ResultsFile) { 
    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pemToDer(privateKeyPEM),
        {
            name: "RSA-OAEP",
            hash: { name: "SHA-256" },
        },
        false,
        ["decrypt"]
    );

    const aesKeyBuffer = await crypto.subtle.decrypt(
        { name: "RSA-OAEP" },
        privateKey,
        decodeBase64(file.key)  
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
        { name: "AES-CBC", iv: decodeBase64(file.iv) },
        aesKey,
        await contentsBlob.arrayBuffer(), 
    );

    // TODO:  check mime and use binary decoder if it's an image or somethig
    const decoder = new TextDecoder();
    const contents =  decoder.decode(decryptedDataBuffer);
    
    return contents
}

async function extractManifest(entries: Entry[]) {
    for (const entry of entries) {
        if (entry.getData && entry.filename == "manifest.json") {
            const manifestText = await entry.getData(new TextWriter())
            const manifest = JSON.parse(manifestText) as ResultsManifest
            validateManifestOrThrow(manifest)
            displayFile('manifest.json', JSON.stringify(manifest, null, 4))
            return manifest
        }
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
        
        const zip = new ZipReader(new BlobReader(await res.blob()))
        const entries = await zip.getEntries();
        const manifest = await extractManifest(entries)
        if (!manifest) {
            throw new Error('Manifest not found')
        }

        for (const entry of entries) {
            // skip directories and manifest because we already processed it
            if (!entry.getData || entry.filename == 'manifest.json') {
                continue
            }

            const file = await entry.getData(new BlobWriter())
            const url = URL.createObjectURL(file)
            const data = manifest.files[entry.filename]
            if (!data) {
                throw new Error(`No metadata found for file: ${entry.filename}`)
            }
            const contents = await decryptFileEntry(privateKeyPEM, entry, data)
            displayFile(entry.filename, contents)
        }
        
    })

})
