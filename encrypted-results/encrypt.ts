import fs from 'fs'
import mime from 'mime-types'
import { ZipWriter, BlobWriter, TextReader, BlobReader } from '@zip.js/zip.js';
import crypto from 'crypto';
import { readPublicKey, localPath } from '../support/index';
import { readPrivateKey } from '../support/index';

import type { AuditEntry, ResultsManifest } from './types';


export async function encryptResults(files: string[]) {
    const zipBlobWriter = new BlobWriter("application/zip");
    const zipWriter = new ZipWriter(zipBlobWriter);

    const auditEntry: AuditEntry = {
        role: 'member',
        action: 'created',
        entityId: 'openstax',
        timestamp: new Date().toISOString(),
    }

    const sign = crypto.createSign('SHA256');
    sign.update(JSON.stringify(auditEntry))
    sign.end();
    const signature = sign.sign(readPrivateKey(), 'base64');

    const manifest: ResultsManifest = {
        files: {},
        audit: {
            [signature]: auditEntry,
        },
    }

    for (const fileName of files) {
        const aesKey = crypto.randomBytes(32) // 32 == 256 bit key
        const iv = crypto.randomBytes(16)
        const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, iv)

        const content = Buffer.from(fs.readFileSync(`${localPath(import.meta.url)}/${fileName}`, 'utf8'))
        const encryptedData = Buffer.concat([cipher.update(content), cipher.final()])

        const encryptedKey = crypto.publicEncrypt({
            key: readPublicKey(),
            padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
        }, aesKey).toString('base64');

        await zipWriter.add(fileName, new BlobReader(new Blob([encryptedData])))

        manifest.files[fileName] = {
            path: fileName,
            bytes: content.byteLength, // n.b. size BEFORE encyption
            createdBy: signature,
            key: encryptedKey,
            iv: iv.toString('base64'),
            contentType: mime.lookup(fileName) || 'application/octet-stream',
        }
    }

    await zipWriter.add('manifest.json', new TextReader(JSON.stringify(manifest)))

    await zipWriter.close();

    return zipBlobWriter.getData()
}
