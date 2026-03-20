import { Injectable } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';

export interface SessionEvent {
    sessionId: string;
    userId: string;
    status: string;
    progress?: number;
    queuePosition?: number;
    error?: string;
    updatedAt: string;
    completedAt?: string;
}

@Injectable()
export class SessionEventsService {
    private readonly subject = new Subject<SessionEvent>();

    emit(event: SessionEvent): void {
        this.subject.next(event);
    }

    get events$(): Observable<SessionEvent> {
        return this.subject.asObservable();
    }
}
