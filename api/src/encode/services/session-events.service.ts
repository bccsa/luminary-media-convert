import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { PipelineProgress } from './segment-pipeline.service.js';

export interface SessionEvent {
    sessionId: string;
    status: string;
    progress?: number;
    pipelineProgress?: PipelineProgress;
    queuePosition?: number;
    error?: string;
    files?: string[];
    masterPlaylist?: string;
    thumbnailsVtt?: string;
    encryptionKeyHex?: string;
    /**
     * Where the output will be playable from. Present from the moment encoding
     * starts — the destination key is settled long before the first segment
     * exists, and the CMS wants to store the URL alongside the key it is handed
     * in the same event.
     */
    hlsUrl?: string;
    segmentFormat?: string;
    encoder?: string;
    probeResult?: unknown;
    ingestTotalBytes?: number;
}

@Injectable()
export class SessionEventsService {
    private readonly subject = new Subject<SessionEvent>();

    emit(event: SessionEvent): void {
        this.subject.next(event);
    }

    forSession(sessionId: string): Observable<SessionEvent> {
        return this.subject.asObservable().pipe(
            filter((e) => e.sessionId === sessionId),
        );
    }
}
