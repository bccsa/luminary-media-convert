export interface ValidatedKeyMetadata {
    userId?: string;
    webhookUrl?: string;
    authorizationUrl?: string;
    metadata?: Record<string, unknown>;
    [key: string]: unknown;
}
