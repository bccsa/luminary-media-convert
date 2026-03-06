import type { IncomingMessage, ServerResponse } from 'node:http';

export interface TusdServerConfig {
    /** Base path for TUS endpoint (e.g., '/api/tus') */
    path: string;

    /** Directory for upload storage */
    directory: string;

    /** Maximum upload size in bytes */
    maxSize?: number;

    /** Upload expiration in milliseconds (for cleanup of incomplete uploads) */
    expirationMs?: number;

    /** CORS allowed origins */
    allowedOrigins?: string[];

    /** Additional allowed headers for CORS */
    allowedHeaders?: string[];

    /** Hook: fires on EVERY inbound request before proxying to tusd (auth validation). Throw to reject. */
    onIncomingRequest?: (req: RequestInfo) => Promise<void>;

    /** Hook: fires when a new upload is created (maps to tusd pre-create). Throw to reject. */
    onUploadCreate?: (req: RequestInfo, upload: UploadInfo) => Promise<void>;

    /** Hook: fires when an upload is fully completed, including concatenation (maps to tusd post-finish). */
    onUploadFinish?: (req: RequestInfo, upload: UploadInfo) => Promise<void>;

    /** Hook: fires periodically during upload with progress (maps to tusd post-receive). */
    onProgress?: (upload: UploadInfo) => Promise<void>;

    /** Hook: fires when an upload is terminated/deleted (maps to tusd post-terminate). */
    onTerminate?: (upload: UploadInfo) => Promise<void>;
}

export interface RequestInfo {
    headers: Record<string, string>;
    method: string;
    url: string;
}

export interface UploadInfo {
    id: string;
    size: number | null;
    offset: number;
    metadata: Record<string, string>;
    isPartial: boolean;
    isFinal: boolean;
    partialUploads?: string[];
    storage?: { path: string };
}

/** tusd hook event payload (JSON from HTTP hooks) */
export interface TusdHookPayload {
    Type: string;
    Event: {
        Upload: {
            ID: string;
            Size: number;
            SizeIsDeferred: boolean;
            Offset: number;
            MetaData: Record<string, string>;
            IsPartial: boolean;
            IsFinal: boolean;
            PartialUploads: string[] | null;
            Storage?: {
                Type: string;
                Path: string;
                Bucket?: string;
                Key?: string;
            } | null;
        };
        HTTPRequest: {
            Method: string;
            URI: string;
            RemoteAddr: string;
            Header: Record<string, string[]>;
        };
    };
}

export interface TusdHookResponse {
    HttpResponse?: {
        StatusCode: number;
        Body?: string;
        Header?: Record<string, string>;
    };
    RejectUpload?: boolean;
    ChangeFileInfo?: {
        ID?: string;
        MetaData?: Record<string, string>;
    };
}

export type HookType =
    | 'pre-create'
    | 'post-create'
    | 'pre-finish'
    | 'post-finish'
    | 'post-receive'
    | 'post-terminate';
