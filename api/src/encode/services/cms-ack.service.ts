import {
    ConflictException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { SessionService, isCmsPending } from './session.service.js';

/** How long a save waits for the CMS: to come back, or to store the last version. */
export const CMS_ACK_WAIT_MS = 10_000;

/**
 * Whether the CMS has stored the version of a video the encoder last wrote.
 *
 * Every edit of a published video writes a new master under a new name, and
 * viewers get it only once the CMS document names it. An edit the CMS never
 * hears about is an edit nobody sees, so the encoder refuses to write a new
 * version unless the CMS page for the post is following the session and has
 * confirmed it stored the current one — and after writing, waits for it to
 * confirm the new one, so a save never reports "published" to a CMS that has
 * stopped listening.
 *
 * Only CMS sessions are gated: one made directly through `POST /api/sessions`
 * has no CMS to wait for.
 */
@Injectable()
export class CmsAckService {
    /** Open read-token event streams per session: the CMS pages following it. */
    private readonly listeners = new Map<string, number>();
    /** Conditions waiting to be re-checked when a session is acked or followed. */
    private readonly waiters = new Map<string, Set<() => void>>();

    constructor(private readonly sessionService: SessionService) {}

    /** A CMS page started following the session's events. */
    opened(sessionId: string): void {
        this.listeners.set(sessionId, (this.listeners.get(sessionId) ?? 0) + 1);
        this.notify(sessionId);
    }

    /** A CMS page stopped following the session's events. */
    closed(sessionId: string): void {
        const left = (this.listeners.get(sessionId) ?? 1) - 1;
        if (left > 0) this.listeners.set(sessionId, left);
        else this.listeners.delete(sessionId);
        // A save waiting on this page for an ack has nobody left to wait for.
        this.notify(sessionId);
    }

    /**
     * The CMS stored `hlsUrl`. Only the session's current URL counts: an ack
     * for an older one says nothing about the version viewers would get.
     */
    ack(sessionId: string, hlsUrl: string): void {
        const session = this.sessionService.get(sessionId);
        if (!session)
            throw new NotFoundException(`Session ${sessionId} not found`);
        if (!session.hlsUrl || hlsUrl !== session.hlsUrl) return;
        if (session.ackedHlsUrl !== hlsUrl) {
            this.sessionService.setAckedHlsUrl(sessionId, hlsUrl);
        }
        this.notify(sessionId);
    }

    /**
     * Refuses (409 `CMS_NOT_ACKNOWLEDGED`) unless the CMS is following the
     * session and has stored its current version.
     *
     * With no CMS page following, it refuses at once: nobody is there to send
     * the ack a wait would be for, and the editor is better told now than
     * after ten seconds of a spinner. With one following, it waits up to
     * {@link CMS_ACK_WAIT_MS} for the ack of a save made a moment ago, which
     * is usually still on its way — and gives up early if the page goes.
     */
    async assertReady(sessionId: string): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session?.readToken) return;
        const followed = () => this.followed(sessionId);
        if (followed()) {
            await this.waitFor(
                sessionId,
                () => this.isReady(sessionId) || !followed(),
                CMS_ACK_WAIT_MS
            );
        }
        if (this.isReady(sessionId)) return;
        throw new ConflictException({
            message:
                "Luminary CMS hasn't confirmed the current version of this video. Open the post in Luminary CMS and keep it open, save it there if it has unsaved changes, then save again here.",
            code: 'CMS_NOT_ACKNOWLEDGED',
        });
    }

    /**
     * Waits up to {@link CMS_ACK_WAIT_MS} for the CMS to store `hlsUrl`, and
     * gives up early when no CMS page is following the session. Undefined for
     * a session with no CMS behind it.
     */
    async awaitAck(
        sessionId: string,
        hlsUrl: string | undefined
    ): Promise<boolean | undefined> {
        const session = this.sessionService.get(sessionId);
        if (!session?.readToken || !hlsUrl) return undefined;
        const acked = () =>
            this.sessionService.get(sessionId)?.ackedHlsUrl === hlsUrl;
        await this.waitFor(
            sessionId,
            () => acked() || !this.followed(sessionId),
            CMS_ACK_WAIT_MS
        );
        return acked();
    }

    private followed(sessionId: string): boolean {
        return (this.listeners.get(sessionId) ?? 0) > 0;
    }

    private isReady(sessionId: string): boolean {
        const session = this.sessionService.get(sessionId);
        if (!session) return false;
        return this.followed(sessionId) && !isCmsPending(session);
    }

    private waitFor(
        sessionId: string,
        condition: () => boolean,
        timeoutMs: number
    ): Promise<boolean> {
        if (condition()) return Promise.resolve(true);
        return new Promise((resolve) => {
            let waiting = this.waiters.get(sessionId);
            if (!waiting) {
                waiting = new Set();
                this.waiters.set(sessionId, waiting);
            }
            const set = waiting;
            const done = (result: boolean) => {
                clearTimeout(timer);
                set.delete(check);
                if (set.size === 0) this.waiters.delete(sessionId);
                resolve(result);
            };
            const check = () => {
                if (condition()) done(true);
            };
            const timer = setTimeout(() => done(false), timeoutMs);
            set.add(check);
        });
    }

    private notify(sessionId: string): void {
        for (const check of [...(this.waiters.get(sessionId) ?? [])]) check();
    }
}
