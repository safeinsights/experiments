export type AuditRole = 'admin' | 'researcher' | 'member'

type ResultsFileKey = string

export type ResultsFile = {
    path: string
    bytes: number            // size of the file in bytes BEFORE encryption
    key: string              // this could potentially be stored in AuditEntry?
    iv: string               // initialization vector for encryption, should be unique for each file
    contentType: string      // mime type
}

export type ResultsManifest = {
    files: Record<ResultsFileKey, ResultsFile> // key is the path of the file
}
