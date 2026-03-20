export interface ApiKeyDocument {
    _id: string; // "apikey:<uuid>"
    _rev?: string;
    docType: 'apikey';
    userId: string;
    name: string;
    prefix: string; // first 12 chars of key for display
    keyHash: string; // SHA-256 hex
    status: 'active' | 'revoked';
    revokedAt?: string;
    lastUsedAt?: string;
    createdAt: string;
    updatedAt: string;
}
