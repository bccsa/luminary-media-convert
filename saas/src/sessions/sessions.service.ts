import {
    Injectable,
    Logger,
    ForbiddenException,
    NotFoundException,
    BadGatewayException,
    OnModuleInit,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';
import { SessionDocument } from './interfaces/session-document.interface.js';

export interface SessionRecord {
    sessionId: string;
    userId: string;
    sessionToken: string;
    s3Config?: SessionDocument['s3Config'];
}

@Injectable()
export class SessionsService implements OnModuleInit {
    private readonly logger = new Logger(SessionsService.name);
    private readonly sessions = new Map<string, SessionRecord>();
    private encodingApiUrl: string;
    private encodingApiMasterKey: string;

    constructor(private readonly databaseService: DatabaseService) {}

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

        const payload: Record<string, unknown> = {
            ...dto,
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
        this.logger.log(`Session ${sessionId} deleted by user ${userId}`);
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
    ): Promise<SessionDocument> {
        const doc = await this.getSessionDoc(sessionId);
        if (doc.userId !== userId) {
            throw new ForbiddenException('Not authorized to view this session');
        }
        return doc;
    }

    async listAllSessions(
        opts: { limit?: number; skip?: number; status?: string; userId?: string },
    ): Promise<{ sessions: SessionDocument[]; total: number }> {
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

        return { sessions: result.docs, total: result.docs.length };
    }

    async getSessionAdmin(sessionId: string): Promise<SessionDocument> {
        return this.getSessionDoc(sessionId);
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
