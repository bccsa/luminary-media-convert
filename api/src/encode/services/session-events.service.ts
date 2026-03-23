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
    anglePlaylists?: { name: string; key: string }[];
    thumbnailsVtt?: string;
    segmentFormat?: string;
    encoder?: string;
    probeResult?: unknown;
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
