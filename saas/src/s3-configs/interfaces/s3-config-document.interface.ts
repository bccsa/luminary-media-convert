import type { EncryptedField } from '../../crypto/crypto.service.js';

export interface S3ConfigDocument {
    _id: string;
    _rev?: string;
    docType: 's3config';
    userId: string;
    name: string;
    endPoint: string;
    port?: number;
    useSSL?: boolean;
    bucket: string;
    region?: string;
    publicUrl?: string;
    accessKey: EncryptedField;
    secretKey: EncryptedField;
    createdAt: string;
    updatedAt: string;
}
