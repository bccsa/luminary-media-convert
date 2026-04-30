import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
    TusdServerConfig,
    TusdHookPayload,
    TusdHookResponse,
    RequestInfo,
    UploadInfo,
    HookType,
} from './types.js';

/**
 * Internal HTTP server that receives hook callbacks from the tusd Go binary.
 * tusd POSTs hook events to this server, which dispatches them to the
 * user-registered callbacks in TusdServerConfig.
 */
export class HookServer {
    private server: Server | null = null;
    private port = 0;

    constructor(private readonly config: TusdServerConfig) {}

    /** Start the hook server on an ephemeral port. Returns the port number. */
    async start(): Promise<number> {
        return new Promise((resolve, reject) => {
            this.server = createServer((req, res) => {
                this.handleRequest(req, res);
            });

            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server!.address();
                if (typeof addr === 'object' && addr) {
                    this.port = addr.port;
                    resolve(this.port);
                } else {
                    reject(new Error('Failed to bind hook server'));
                }
            });

            this.server.on('error', reject);
        });
    }

    /** Stop the hook server. */
    async stop(): Promise<void> {
        if (!this.server) return;
        return new Promise((resolve) => {
            this.server!.close(() => resolve());
        });
    }

    getPort(): number {
        return this.port;
    }

    private handleRequest(req: IncomingMessage, res: ServerResponse): void {
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf-8');
            this.dispatch(body, res).catch((err) => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(
                    JSON.stringify({
                        HttpResponse: {
                            StatusCode: 500,
                            Body: String(err?.message || err),
                        },
                    }),
                );
            });
        });
    }

    private async dispatch(
        body: string,
        res: ServerResponse,
    ): Promise<void> {
        let payload: TusdHookPayload;
        try {
            payload = JSON.parse(body);
        } catch {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid JSON');
            return;
        }

        if (!payload?.Type || !payload?.Event?.Upload || !payload?.Event?.HTTPRequest) {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('Invalid hook payload: missing required fields');
            return;
        }

        const hookType = payload.Type as HookType;
        const upload = this.mapUploadInfo(payload);
        const requestInfo = this.mapRequestInfo(payload);

        switch (hookType) {
            case 'pre-create': {
                if (this.config.onUploadCreate) {
                    try {
                        await this.config.onUploadCreate(requestInfo, upload);
                    } catch (err: unknown) {
                        const hookErr = err as {
                            status_code?: number;
                            body?: string;
                        };
                        const response: TusdHookResponse = {
                            RejectUpload: true,
                            HttpResponse: {
                                StatusCode: hookErr.status_code || 400,
                                Body: hookErr.body || 'Upload rejected',
                            },
                        };
                        res.writeHead(200, {
                            'Content-Type': 'application/json',
                        });
                        res.end(JSON.stringify(response));
                        return;
                    }
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                break;
            }

            case 'post-finish': {
                if (this.config.onUploadFinish) {
                    await this.config.onUploadFinish(requestInfo, upload);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                break;
            }

            case 'post-receive': {
                if (this.config.onProgress) {
                    await this.config.onProgress(upload);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                break;
            }

            case 'post-terminate': {
                if (this.config.onTerminate) {
                    await this.config.onTerminate(upload);
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                break;
            }

            default: {
                // post-create, pre-finish, or unknown — acknowledge without action
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                break;
            }
        }
    }

    private mapUploadInfo(payload: TusdHookPayload): UploadInfo {
        const u = payload.Event.Upload;
        return {
            id: u.ID,
            size: u.SizeIsDeferred ? null : u.Size,
            offset: u.Offset,
            metadata: u.MetaData || {},
            isPartial: u.IsPartial,
            isFinal: u.IsFinal,
            partialUploads: u.PartialUploads || undefined,
            storage: u.Storage?.Path
                ? { path: u.Storage.Path }
                : undefined,
        };
    }

    private mapRequestInfo(payload: TusdHookPayload): RequestInfo {
        const httpReq = payload.Event.HTTPRequest;
        // Flatten tusd's multi-value headers to single values
        const headers: Record<string, string> = {};
        for (const [key, values] of Object.entries(httpReq.Header || {})) {
            if (values && values.length > 0) {
                headers[key.toLowerCase()] = values[0];
            }
        }
        return {
            method: httpReq.Method,
            url: httpReq.URI,
            headers,
        };
    }
}
