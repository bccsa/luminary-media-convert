import {
    Injectable,
    Logger,
    UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { DatabaseService } from '../database/database.service.js';
import { UsersService } from '../users/users.service.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { SessionEventsService } from '../sessions/session-events.service.js';
import { KeysService } from '../keys/keys.service.js';
import { SessionDocument } from '../sessions/interfaces/session-document.interface.js';
import { EncodingWebhookDto } from './dto/encoding-webhook.dto.js';

const TERMINAL_STATUSES = ['completed', 'failed'];
const DEFAULT_RETENTION_DAYS = 30;

// Status ordering — higher index = later in pipeline; reject stale updates
const STATUS_ORDER: Record<string, number> = {
    created: 0,
    uploading: 1,
    uploaded: 2,
    queued: 3,
    encoding: 4,
    encrypting: 5,
    uploading_to_s3: 6,
    completed: 7,
    failed: 7,
};

@Injectable()
export class WebhooksService {
    private readonly logger = new Logger(WebhooksService.name);

    constructor(
        private readonly databaseService: DatabaseService,
        private readonly usersService: UsersService,
        private readonly sessionsService: SessionsService,
        private readonly sessionEvents: SessionEventsService,
        private readonly keysService: KeysService,
    ) {}

    validateWebhookToken(token: string | undefined): void {
        const secret = process.env.WEBHOOK_SECRET;
        if (!secret) {
            this.logger.error('WEBHOOK_SECRET not configured — rejecting all webhooks');
            throw new UnauthorizedException('Webhook authentication not configured');
        }
        if (
            !token ||
            token.length !== secret.length ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(secret))
        ) {
            throw new UnauthorizedException('Invalid webhook token');
        }
    }

    async processEncodingWebhook(dto: EncodingWebhookDto): Promise<void> {
        const docId = `session:${dto.sessionId}`;
        const now = new Date().toISOString();

        // Resolve userId from in-memory session map or existing CouchDB doc
        let userId: string | undefined;
        const memRecord = this.sessionsService.getSessionRecord(dto.sessionId);
        if (memRecord) {
            userId = memRecord.userId;
        } else {
            // Session may have been created before a restart — check CouchDB
            try {
                const existing = await this.databaseService.get<SessionDocument>(docId);
                userId = existing.userId;
            } catch {
                this.logger.warn(
                    `Cannot resolve userId for session ${dto.sessionId} — skipping webhook`,
                );
                return;
            }
        }

        // Upsert session document
        let doc: SessionDocument;
        try {
            const existing = await this.databaseService.get<SessionDocument>(docId);
            doc = { ...existing };
        } catch {
            // First webhook for this session — create new doc
            const s3Config = memRecord?.s3Config;
            doc = {
                _id: docId,
                docType: 'session',
                userId,
                sessionId: dto.sessionId,
                status: dto.status,
                createdAt: now,
                updatedAt: now,
                ...(s3Config ? { s3Config } : {}),
                ...(memRecord?.s3ConfigId ? { s3ConfigId: memRecord.s3ConfigId } : {}),
                ...(memRecord?.encrypted ? { encrypted: true } : {}),
            };
        }

        // Reject stale status updates (e.g. late encoding progress after encrypting)
        // Allow same-status updates (progress within a phase) but reject
        // same-order different-status (e.g. encoding after encrypting during race)
        const currentOrder = STATUS_ORDER[doc.status] ?? 0;
        const incomingOrder = STATUS_ORDER[dto.status] ?? 0;
        const isStale = incomingOrder < currentOrder
            || (incomingOrder === currentOrder && dto.status !== doc.status);
        if (isStale) {
            this.logger.debug(
                `Ignoring stale webhook for ${dto.sessionId}: ${dto.status} (${incomingOrder}) vs current ${doc.status} (${currentOrder})`,
            );
            return;
        }

        // Update fields from webhook
        doc.status = dto.status;
        doc.updatedAt = now;
        doc.progress = dto.progress;
        doc.queuePosition = dto.queuePosition;
        doc.error = dto.error;

        if (dto.files) doc.files = dto.files;
        if (dto.masterPlaylist) doc.masterPlaylist = dto.masterPlaylist;
        if (dto.anglePlaylists) doc.anglePlaylists = dto.anglePlaylists;
        if (dto.thumbnailsVtt) doc.thumbnailsVtt = dto.thumbnailsVtt;
        if (dto.encryptionKeyHex) {
            doc.encrypted = true;
            doc.encryptionKeyHex = dto.encryptionKeyHex;
        }

        // Compact on terminal status
        if (TERMINAL_STATUSES.includes(dto.status)) {
            doc.completedAt = now;
            delete doc.progress;
            delete doc.queuePosition;

            const retentionDays = parseInt(process.env.SESSION_RETENTION_DAYS || '', 10) || DEFAULT_RETENTION_DAYS;
            const expiresAt = new Date(Date.now() + retentionDays * 86400000);
            doc.expiresAt = expiresAt.toISOString();
        }

        await this.databaseService.upsert(doc);
        this.logger.debug(`Session ${dto.sessionId} updated to ${dto.status}`);

        this.sessionEvents.emit({
            sessionId: dto.sessionId,
            userId: userId!,
            status: dto.status,
            progress: dto.progress,
            queuePosition: dto.queuePosition,
            error: dto.error,
            updatedAt: doc.updatedAt,
            completedAt: doc.completedAt,
        });
    }

    async checkAuthorization(body: {
        action: string;
        userId?: string;
        sessionId?: string;
        metadata?: unknown;
    }): Promise<{ allowed: boolean; reason?: string }> {
        if (!body.userId) {
            return { allowed: true };
        }

        try {
            const user = await this.usersService.findById(body.userId);
            if (user.status === 'disabled') {
                return { allowed: false, reason: 'Account disabled' };
            }
        } catch {
            // User not found — could be master key session, allow
            return { allowed: true };
        }

        // Permissive defaults — plan limit checks deferred to Phase 7
        return { allowed: true };
    }

    async validateApiKey(
        apiKey: string,
    ): Promise<{ valid: boolean; metadata?: Record<string, unknown> }> {
        const keyHash = createHash('sha256').update(apiKey).digest('hex');
        const keyDoc = await this.keysService.findByHash(keyHash);

        if (!keyDoc || keyDoc.status === 'revoked') {
            return { valid: false };
        }

        // Check user status
        try {
            const user = await this.usersService.findById(keyDoc.userId);
            if (user.status === 'disabled') {
                return { valid: false };
            }
        } catch {
            return { valid: false };
        }

        // Fire-and-forget: update lastUsedAt on key and lastApiAccessAt on user
        this.keysService.updateLastUsed(keyDoc._id);
        this.usersService
            .update(keyDoc.userId, {
                lastApiAccessAt: new Date().toISOString(),
            } as any)
            .catch(() => {});

        const saasUrl = process.env.SAAS_SERVICE_URL || 'http://localhost:3001';
        return {
            valid: true,
            metadata: {
                userId: keyDoc.userId,
                webhookUrl: `${saasUrl}/saas/webhooks/encoding`,
                authorizationUrl: `${saasUrl}/saas/webhooks/authorize`,
            },
        };
    }
}
