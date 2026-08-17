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
    // No encryptionKeyHex: the key is fetched from
    // GET /api/sessions/:sessionId/key, masked, rather than broadcast on every
    // frame of a stream that ends up in logs and consoles.
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
    /**
     * Count of source-storyboard thumbnails sampled so far. Grows while the
     * ingest-time generation pass runs, and is what tells a client watching the
     * trim timeline that there is more storyboard to fetch.
     */
    storyboardThumbCount?: number;
    /**
     * True once the storyboard's final VTT is written. Its own flag because the
     * last in-progress report usually already carries the full count, and a
     * repeated number is not a change a client watcher can react to.
     */
    storyboardComplete?: boolean;
}

@Injectable()
export class SessionEventsService {
    private readonly subject = new Subject<SessionEvent>();

    emit(event: SessionEvent): void {
        this.subject.next(event);
    }

    forSession(sessionId: string): Observable<SessionEvent> {
        return this.subject
            .asObservable()
            .pipe(filter((e) => e.sessionId === sessionId));
    }
}
