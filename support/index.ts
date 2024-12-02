import fs from 'fs'
import path from 'path';
import { fileURLToPath } from 'url'


export const localPath = (url: string) => path.dirname(fileURLToPath(url))

export const supportingFilesDirname = localPath(import.meta.url)


export const readPrivateKey = () =>  fs.readFileSync(`${supportingFilesDirname}/private_key.pem`, 'utf8')
export const readPublicKey = () =>  fs.readFileSync(`${supportingFilesDirname}/public_key.pem`, 'utf8')
