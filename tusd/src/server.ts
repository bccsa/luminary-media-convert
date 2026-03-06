import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, unlinkSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TusdServerConfig } from './types.js';
import { findTusdBinary } from './binary.js';
import { HookServer } from './hook-server.js';
import { proxyToTusd } from './proxy.js';

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_POLL_INTERVAL_MS = 100;

export class TusdServer {
    private tusdProcess: ChildProcess | null = null;
    private hookServer: HookServer;
    private tusdPort = 0;
    private started = false;

    constructor(private readonly config: TusdServerConfig) {
        this.hookServer = new HookServer(config);
    }

    /** Spawn the tusd binary and hook server. Resolves when tusd is ready. */
    async start(): Promise<void> {
        if (this.started) return;

        mkdirSync(this.config.directory, { recursive: true });

        // 1. Start the hook server on an ephemeral port
        const hookPort = await this.hookServer.start();

        // 2. Find an ephemeral port for tusd
        this.tusdPort = await this.findEphemeralPort();

        // 3. Build tusd CLI args
        const tusdBinary = findTusdBinary();
        const args = this.buildTusdArgs(hookPort);

        // 4. Spawn tusd
        this.tusdProcess = spawn(tusdBinary, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        this.tusdProcess.stdout?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                process.stderr.write(`[tusd] ${msg}\n`);
            }
        });

        this.tusdProcess.stderr?.on('data', (data: Buffer) => {
            const msg = data.toString().trim();
            if (msg) {
                process.stderr.write(`[tusd] ${msg}\n`);
            }
        });

        this.tusdProcess.on('exit', (code, signal) => {
            if (this.started) {
                process.stderr.write(
                    `[tusd] Process exited (code=${code}, signal=${signal})\n`,
                );
            }
        });

        // 5. Wait for tusd to be ready
        await this.waitForReady();
        this.started = true;
    }

    /** Stop the tusd process and hook server gracefully. */
    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;

        if (this.tusdProcess && !this.tusdProcess.killed) {
            await new Promise<void>((resolve) => {
                this.tusdProcess!.on('exit', () => resolve());
                this.tusdProcess!.kill('SIGTERM');

                // Force kill after 5s if tusd doesn't stop
                setTimeout(() => {
                    if (this.tusdProcess && !this.tusdProcess.killed) {
                        this.tusdProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 5000);
            });
        }

        await this.hookServer.stop();
    }

    /**
     * Handle an incoming HTTP request. Runs onIncomingRequest for auth,
     * then proxies to tusd.
     */
    handle(req: IncomingMessage, res: ServerResponse): void {
        if (!this.started) {
            res.writeHead(503, { 'Content-Type': 'text/plain' });
            res.end('TUS server not started');
            return;
        }

        // Run auth check before proxying
        if (this.config.onIncomingRequest) {
            const headers: Record<string, string> = {};
            for (const [key, value] of Object.entries(req.headers)) {
                if (typeof value === 'string') {
                    headers[key] = value;
                } else if (Array.isArray(value)) {
                    headers[key] = value[0];
                }
            }

            this.config
                .onIncomingRequest({
                    headers,
                    method: req.method || 'GET',
                    url: req.url || '/',
                })
                .then(() => {
                    proxyToTusd(req, res, this.tusdPort, this.config.path);
                })
                .catch((err: { status_code?: number; body?: string }) => {
                    const status = err.status_code || 401;
                    const body = err.body || 'Unauthorized';
                    if (!res.headersSent) {
                        res.writeHead(status, {
                            'Content-Type': 'text/plain',
                        });
                        res.end(body);
                    }
                });
        } else {
            proxyToTusd(req, res, this.tusdPort, this.config.path);
        }
    }

    /**
     * Clean up expired uploads by scanning the upload directory
     * for .info files older than expirationMs.
     */
    async cleanUpExpiredUploads(): Promise<number> {
        const expirationMs = this.config.expirationMs || 10 * 60 * 1000;
        const now = Date.now();
        let cleaned = 0;

        let files: string[];
        try {
            files = readdirSync(this.config.directory);
        } catch {
            return 0;
        }

        for (const file of files) {
            if (!file.endsWith('.info')) continue;

            const infoPath = join(this.config.directory, file);
            try {
                const stat = statSync(infoPath);
                if (now - stat.mtimeMs > expirationMs) {
                    // Delete the .info file and the corresponding data file
                    const dataPath = infoPath.replace(/\.info$/, '');
                    try {
                        unlinkSync(dataPath);
                    } catch {
                        // Data file may not exist
                    }
                    unlinkSync(infoPath);
                    cleaned++;
                }
            } catch {
                // Skip files we can't stat
            }
        }

        return cleaned;
    }

    private buildTusdArgs(hookPort: number): string[] {
        const args = [
            '-host',
            '127.0.0.1',
            '-port',
            String(this.tusdPort),
            '-upload-dir',
            this.config.directory,
            '-base-path',
            this.config.path,
            '-hooks-http',
            `http://127.0.0.1:${hookPort}/hooks`,
            '-hooks-http-forward-headers',
            'Authorization',
            '-hooks-enabled-events',
            'pre-create,post-create,post-finish,post-receive,post-terminate',
            '-behind-proxy',
        ];

        if (this.config.maxSize) {
            args.push('-max-size', String(this.config.maxSize));
        }

        if (this.config.allowedOrigins?.length) {
            // tusd uses a regex for cors-allow-origin
            const origins = this.config.allowedOrigins
                .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
                .join('|');
            args.push('-cors-allow-origin', `^(${origins})$`);
        }

        if (this.config.allowedHeaders?.length) {
            args.push(
                '-cors-allow-headers',
                this.config.allowedHeaders.join(','),
            );
        }

        return args;
    }

    private async findEphemeralPort(): Promise<number> {
        const { createServer } = await import('node:net');
        return new Promise((resolve, reject) => {
            const srv = createServer();
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (typeof addr === 'object' && addr) {
                    const port = addr.port;
                    srv.close(() => resolve(port));
                } else {
                    srv.close(() =>
                        reject(new Error('Failed to find ephemeral port')),
                    );
                }
            });
            srv.on('error', reject);
        });
    }

    private async waitForReady(): Promise<void> {
        const deadline = Date.now() + DEFAULT_HEALTH_TIMEOUT_MS;

        while (Date.now() < deadline) {
            try {
                await this.healthCheck();
                return;
            } catch {
                // Check if process exited
                if (this.tusdProcess?.exitCode !== null) {
                    throw new Error(
                        `tusd process exited with code ${this.tusdProcess?.exitCode}`,
                    );
                }
                await new Promise((r) =>
                    setTimeout(r, HEALTH_POLL_INTERVAL_MS),
                );
            }
        }

        throw new Error(
            `tusd failed to become ready within ${DEFAULT_HEALTH_TIMEOUT_MS}ms`,
        );
    }

    private healthCheck(): Promise<void> {
        return new Promise((resolve, reject) => {
            const req = httpRequest(
                {
                    hostname: '127.0.0.1',
                    port: this.tusdPort,
                    path: this.config.path,
                    method: 'HEAD',
                    timeout: 1000,
                },
                (res) => {
                    // Any response means tusd is up — TUS endpoints
                    // return 405 for HEAD at base path, which is fine
                    res.resume();
                    resolve();
                },
            );
            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Health check timeout'));
            });
            req.end();
        });
    }
}
