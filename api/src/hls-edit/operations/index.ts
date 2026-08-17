import { BadRequestException, NotImplementedException } from '@nestjs/common';
import type { HlsParsedMaster } from '@luminary-media-converter/hls';
import type { HlsOperationDto } from '../dto/mutate.dto.js';
import type { S3ConfigDto } from '../../encode/dto/s3-config.dto.js';
import type { S3EtagService } from '../s3-etag.service.js';

/**
 * Context handed to each operation handler. Handlers may mutate the
 * master in place and/or upload sidecar files via the S3 service.
 * Any keys written should be pushed into `writtenKeys` for the response.
 */
export interface OperationContext {
    s3: S3ConfigDto;
    masterKey: string;
    master: HlsParsedMaster;
    s3EtagService: S3EtagService;
    writtenKeys: string[];
    /**
     * AES-128 session key hex, when the session's text assets are LMCENC01
     * encrypted. Handlers that write sidecars of their own (subtitle VTTs)
     * must encrypt them with it — the master they are being referenced from
     * is already encrypted, and a plaintext sidecar beside it undoes the point.
     */
    keyHex?: string;
}

export type OperationHandler = (
    op: HlsOperationDto,
    ctx: OperationContext
) => Promise<void>;

/**
 * Registry of supported mutation types. Each handler is a stub in this
 * foundation pass — subtitle and chapter implementations ship as follow-up
 * PRs. Keeping the dispatcher in place means the read → apply → write
 * round-trip is fully exercised end-to-end by an empty operations[] array.
 */
export const OPERATION_HANDLERS: Record<string, OperationHandler> = {
    upsertSubtitle: async () => {
        throw new NotImplementedException(
            'upsertSubtitle is not yet implemented'
        );
    },
    removeSubtitle: async () => {
        throw new NotImplementedException(
            'removeSubtitle is not yet implemented'
        );
    },
    upsertChapters: async () => {
        throw new NotImplementedException(
            'upsertChapters is not yet implemented'
        );
    },
    removeChapters: async () => {
        throw new NotImplementedException(
            'removeChapters is not yet implemented'
        );
    },
};

export async function applyOperation(
    op: HlsOperationDto,
    ctx: OperationContext
): Promise<void> {
    const handler = OPERATION_HANDLERS[op.type];
    if (!handler) {
        throw new BadRequestException(`Unknown HLS operation type: ${op.type}`);
    }
    await handler(op, ctx);
}
