import {
    Injectable,
    Logger,
    ForbiddenException,
    NotFoundException,
    BadRequestException,
    BadGatewayException,
    OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DatabaseService } from '../database/database.service.js';
import { S3ConfigsService } from '../s3-configs/s3-configs.service.js';
import { HlsParserService } from './hls-parser.service.js';
import { S3ClientService } from './s3-client.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { ImportSessionDto } from './dto/import-session.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';
import { SessionDocument } from './interfaces/session-document.interface.js';

export interface SessionRecord {
    sessionId: string;
    userId: string;
    sessionToken: string;
    s3Config?: SessionDocument['s3Config'];
    s3ConfigId?: string;
    encrypted?: boolean;
}

@Injectable()
export class SessionsService implements OnModuleInit {
    private readonly logger = new Logger(SessionsService.name);
    private readonly sessions = new Map<string, SessionRecord>();
    private encodingApiUrl: string;
    private encodingApiMasterKey: string;

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly s3ConfigsService: S3ConfigsService,
        private readonly hlsParserService: HlsParserService,
        private readonly s3ClientService: S3ClientService,
    ) {}

    onModuleInit() {
        this.encodingApiUrl = process.env.ENCODING_API_URL ?? '';
        this.encodingApiMasterKey = process.env.ENCODING_API_MASTER_KEY ?? '';

        if (!this.encodingApiUrl || !this.encodingApiMasterKey) {
            this.logger.warn(
                'ENCODING_API_URL and/or ENCODING_API_MASTER_KEY not set — session creation will fail',
            );
        }
    }

    getSessionRecord(sessionId: string): SessionRecord | undefined {
        return this.sessions.get(sessionId);
    }

    async createSession(
        userId: string,
        dto: CreateSaasSessionDto,
    ): Promise<SaasSessionResponseDto> {
        // Build webhook config so the Encoding API sends status updates back
        const saasUrl = process.env.SAAS_SERVICE_URL || `http://localhost:${process.env.PORT || 3001}`;
        const webhookSecret = process.env.WEBHOOK_SECRET || '';

        const { s3ConfigId: _, ...encodingApiDto } = dto as any;
        const payload: Record<string, unknown> = {
            ...encodingApiDto,
            webhook: {
                url: `${saasUrl}/saas/webhooks/encoding`,
                sessionToken: webhookSecret,
            },
        };

        const res = await fetch(`${this.encodingApiUrl}/api/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': this.encodingApiMasterKey,
            },
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            this.logger.error(
                `Encoding API session creation failed (${res.status}): ${body.message ?? JSON.stringify(body)}`,
            );
            throw new BadGatewayException(
                body.message ?? `Encoding API returned ${res.status}`,
            );
        }

        const data = await res.json();

        // Store non-secret S3 config for session history
        const s3Config: SessionDocument['s3Config'] = {
            endPoint: dto.s3.endPoint,
            bucket: dto.s3.bucket,
            pathPrefix: dto.s3.pathPrefix,
            port: dto.s3.port,
            useSSL: dto.s3.useSSL,
        };

        this.sessions.set(data.sessionId, {
            sessionId: data.sessionId,
            userId,
            sessionToken: data.sessionToken,
            s3Config,
            s3ConfigId: dto.s3ConfigId,
            encrypted: dto.encryption?.enabled === true,
        });

        // Create CouchDB document immediately so the session is visible in history
        const now = new Date().toISOString();
        const sessionDoc: SessionDocument = {
            _id: `session:${data.sessionId}`,
            docType: 'session',
            userId,
            sessionId: data.sessionId,
            status: 'created',
            s3Config,
            s3ConfigId: dto.s3ConfigId,
            encrypted: dto.encryption?.enabled === true || undefined,
            createdAt: now,
            updatedAt: now,
        };
        if (!sessionDoc.encrypted) delete sessionDoc.encrypted;
        await this.databaseService.insert(sessionDoc).catch((err) => {
            this.logger.warn(
                `Failed to create CouchDB doc for session ${data.sessionId}: ${err}`,
            );
        });

        this.logger.log(
            `Session ${data.sessionId} created for user ${userId}`,
        );

        return {
            sessionId: data.sessionId,
            encodingApiUrl: this.encodingApiUrl,
            sessionToken: data.sessionToken,
            maxUploadSize: data.maxUploadSize,
        };
    }

    async deleteSession(userId: string, sessionId: string): Promise<void> {
        const record = this.sessions.get(sessionId);

        if (!record) {
            throw new NotFoundException(`Session '${sessionId}' not found`);
        }

        if (record.userId !== userId) {
            throw new ForbiddenException('Not authorized to delete this session');
        }

        const res = await fetch(
            `${this.encodingApiUrl}/api/sessions/${sessionId}`,
            {
                method: 'DELETE',
                headers: { 'X-API-Key': this.encodingApiMasterKey },
            },
        );

        if (!res.ok && res.status !== 404) {
            const body = await res.json().catch(() => ({}));
            this.logger.error(
                `Encoding API session delete failed (${res.status}): ${body.message ?? ''}`,
            );
            throw new BadGatewayException(
                body.message ?? `Encoding API returned ${res.status}`,
            );
        }

        this.sessions.delete(sessionId);

        // Remove CouchDB document
        try {
            const doc = await this.databaseService.get<SessionDocument>(
                `session:${sessionId}`,
            );
            await this.databaseService.destroy(doc._id, doc._rev!);
        } catch {
            // Ignore — document may not exist yet
        }

        this.logger.log(`Session ${sessionId} deleted by user ${userId}`);
    }

    async importSession(
        userId: string,
        dto: ImportSessionDto,
    ): Promise<SessionDocument> {
        // Resolve S3 config (ownership check included)
        const s3Config = await this.s3ConfigsService.getById(
            userId,
            dto.s3ConfigId,
        );

        let masterPlaylistKey = dto.masterPlaylistKey;
        let folderPrefix = dto.folderPrefix ?? '';

        // If folderPrefix but no masterPlaylistKey: auto-discover master playlist
        if (folderPrefix && !masterPlaylistKey) {
            const keys = await this.s3ClientService.listObjects(
                userId,
                dto.s3ConfigId,
                folderPrefix,
            );

            const m3u8Keys = keys.filter((k) => k.endsWith('.m3u8'));

            // Prefer master.m3u8
            masterPlaylistKey = m3u8Keys.find((k) =>
                k.endsWith('master.m3u8'),
            );

            // If no master.m3u8, check each .m3u8 for #EXT-X-STREAM-INF
            if (!masterPlaylistKey) {
                for (const key of m3u8Keys) {
                    const buf = await this.s3ClientService.getObject(
                        userId,
                        dto.s3ConfigId,
                        key,
                    );
                    if (buf.toString('utf-8').includes('#EXT-X-STREAM-INF')) {
                        masterPlaylistKey = key;
                        break;
                    }
                }
            }

            if (!masterPlaylistKey) {
                throw new BadRequestException(
                    'No master playlist found under the given prefix',
                );
            }
        }

        if (!masterPlaylistKey) {
            throw new BadRequestException(
                'Either masterPlaylistKey or folderPrefix must be provided',
            );
        }

        // Derive folder prefix from master playlist key if not provided
        if (!folderPrefix) {
            const lastSlash = masterPlaylistKey.lastIndexOf('/');
            folderPrefix =
                lastSlash >= 0
                    ? masterPlaylistKey.substring(0, lastSlash + 1)
                    : '';
        }

        // Fetch and parse master playlist
        const playlistBuf = await this.s3ClientService.getObject(
            userId,
            dto.s3ConfigId,
            masterPlaylistKey,
        );
        const playlistContent = playlistBuf.toString('utf-8');
        const parsed =
            this.hlsParserService.parseMasterPlaylist(playlistContent);

        // List all files under the prefix
        const files = await this.s3ClientService.listObjects(
            userId,
            dto.s3ConfigId,
            folderPrefix,
        );

        // Build angle playlists from variants
        const anglePlaylists =
            parsed.variants.length > 1
                ? parsed.variants.map((v, i) => ({
                      name: `Angle ${i + 1}`,
                      key: folderPrefix + v.uri,
                  }))
                : undefined;

        const now = new Date().toISOString();
        const sessionId = randomUUID();

        const doc: SessionDocument = {
            _id: `session:${sessionId}`,
            docType: 'session',
            userId,
            sessionId,
            status: 'completed',
            progress: 100,
            files,
            masterPlaylist: masterPlaylistKey,
            ...(anglePlaylists ? { anglePlaylists } : {}),
            s3Config: {
                endPoint: s3Config.endPoint,
                bucket: s3Config.bucket,
                port: s3Config.port,
                useSSL: s3Config.useSSL,
            },
            s3ConfigId: dto.s3ConfigId,
            imported: true,
            encrypted: dto.encryptionKey ? true : undefined,
            createdAt: now,
            updatedAt: now,
            completedAt: now,
        };

        // Remove undefined fields
        if (doc.encrypted === undefined) delete doc.encrypted;
        if (!doc.anglePlaylists) delete doc.anglePlaylists;

        await this.databaseService.insert(doc);

        this.logger.log(
            `Session ${sessionId} imported for user ${userId} (${files.length} files, ${parsed.variants.length} variants)`,
        );

        return doc;
    }

    // --- CouchDB session history queries ---

    async listSessions(
        userId: string,
        opts: { limit?: number; skip?: number; status?: string },
    ): Promise<{ sessions: SessionDocument[]; total: number }> {
        const selector: Record<string, any> = {
            docType: 'session',
            userId,
        };
        if (opts.status) {
            selector.status = opts.status;
        }

        const result = await this.databaseService.find<SessionDocument>({
            selector,
            use_index: opts.status ? 'sessions-by-user-status' : 'sessions-by-user',
            sort: [{ createdAt: 'desc' as const }],
            limit: opts.limit || 25,
            skip: opts.skip || 0,
        });

        return { sessions: result.docs, total: result.docs.length };
    }

    async getSession(
        userId: string,
        sessionId: string,
    ): Promise<SessionDocument & { sessionToken?: string; encodingApiUrl?: string }> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to view this session');
        }

        // Augment with active session data if available in memory
        const record = this.sessions.get(sessionId);
        if (record) {
            return {
                ...doc,
                sessionToken: record.sessionToken,
                encodingApiUrl: this.encodingApiUrl,
            };
        }

        return doc;
    }

    async updateSessionName(
        userId: string,
        sessionId: string,
        name: string,
    ): Promise<SessionDocument> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to update this session');
        }
        doc.name = name.trim() || undefined;
        doc.updatedAt = new Date().toISOString();
        await this.databaseService.upsert(doc);
        return doc;
    }

    async listAllSessions(
        opts: { limit?: number; skip?: number; status?: string; userId?: string },
    ): Promise<{ sessions: Partial<SessionDocument>[]; total: number }> {
        const selector: Record<string, any> = { docType: 'session' };
        if (opts.status) selector.status = opts.status;
        if (opts.userId) selector.userId = opts.userId;

        const result = await this.databaseService.find<SessionDocument>({
            selector,
            use_index: 'sessions-by-created',
            sort: [{ docType: 'desc' as const }, { createdAt: 'desc' as const }],
            limit: opts.limit || 25,
            skip: opts.skip || 0,
        });

        return {
            sessions: result.docs.map((s) => this.stripSensitiveFields(s)),
            total: result.docs.length,
        };
    }

    async getSessionAdmin(sessionId: string): Promise<Partial<SessionDocument>> {
        const doc = await this.getSessionDoc(sessionId);
        return this.stripSensitiveFields(doc);
    }

    /** Strip fields containing personal data, file locations, and credentials from admin responses. */
    private stripSensitiveFields(session: SessionDocument): Partial<SessionDocument> {
        const {
            s3Config,
            s3ConfigId,
            files,
            masterPlaylist,
            anglePlaylists,
            thumbnailsVtt,
            probeResult,
            encryptionKeyHex,
            ...safe
        } = session;
        return safe;
    }

    private async getSessionDoc(sessionId: string): Promise<SessionDocument> {
        try {
            return await this.databaseService.get<SessionDocument>(
                `session:${sessionId}`,
            );
        } catch (err: any) {
            if (err.statusCode === 404) {
                throw new NotFoundException(`Session '${sessionId}' not found`);
            }
            throw err;
        }
    }
}
