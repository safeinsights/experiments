export type AuditRole = 'admin' | 'researcher' | 'member'
type AuditEntryKey = string
type ResultsFileKey = string

export type AuditEntry = {
    action: string    // e.g. "created", "reviewed"
    entityId: string  // most likely member slug or user id
    timestamp: string // ISO 8601
    role: AuditRole
}

export type ResultsFile = {
    path: string
    bytes: number            // size of the file in bytes BEFORE encryption
    createdBy: AuditEntryKey // id of audit entry
    key: string              // this could potentially be stored in AuditEntry?
    iv: string               // initialization vector for encryption, should be unique for each file
    contentType: string      // mime type
}

export type ResultsManifest = {
    audit: Record<AuditEntryKey, AuditEntry>   // key is the signature of the AuditEntry
    files: Record<ResultsFileKey, ResultsFile> // key is the path of the file
}
