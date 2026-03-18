import {
    Injectable,
    Logger,
    ForbiddenException,
    NotFoundException,
    BadGatewayException,
    OnModuleInit,
} from '@nestjs/common';
import { CreateSaasSessionDto } from './dto/create-session.dto.js';
import { SaasSessionResponseDto } from './dto/session-response.dto.js';

interface SessionRecord {
    sessionId: string;
    userId: string;
    sessionToken: string;
}

@Injectable()
export class SessionsService implements OnModuleInit {
    private readonly logger = new Logger(SessionsService.name);
    private readonly sessions = new Map<string, SessionRecord>();
    private encodingApiUrl: string;
    private encodingApiMasterKey: string;

    onModuleInit() {
        this.encodingApiUrl = process.env.ENCODING_API_URL ?? '';
        this.encodingApiMasterKey = process.env.ENCODING_API_MASTER_KEY ?? '';

        if (!this.encodingApiUrl || !this.encodingApiMasterKey) {
            this.logger.warn(
                'ENCODING_API_URL and/or ENCODING_API_MASTER_KEY not set — session creation will fail',
            );
        }
    }

    async createSession(
        userId: string,
        dto: CreateSaasSessionDto,
    ): Promise<SaasSessionResponseDto> {
        const res = await fetch(`${this.encodingApiUrl}/api/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-Key': this.encodingApiMasterKey,
            },
            body: JSON.stringify(dto),
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

        this.sessions.set(data.sessionId, {
            sessionId: data.sessionId,
            userId,
            sessionToken: data.sessionToken,
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
}
