export type AuditRole = 'admin' | 'researcher' | 'member'

type ResultsFileKey = string

export type PublicKey = {
    fingerprint: string // sha 256 fingerprint of members public key
    publicKey: string         // rsa public key
}

export type FileKeyMap = { // map between key fingerprint and
    [fingerprint: string]:  {
        crypt: string // encypted version of the AES symetric key used to encrypt file
    }
}

export type ResultsFile = {
    path: string
    bytes: number            // size of the file in bytes BEFORE encryption
    iv: string               // initialization vector for encryption, should be unique for each file
    contentType: string      // mime type
    keys: FileKeyMap         // mapping of key fingerprint <-> cypted AES key
}


export type ResultsManifest = {
    files: Record<ResultsFileKey, ResultsFile> // key is the path of the file
}
