import { ConflictException, Injectable } from '@nestjs/common';
import {
    MasterRevisionConflict,
    MasterRevisionService,
} from '../../hls-edit/master-revision.service.js';
import { SessionService } from './session.service.js';
import { CmsAckService } from './cms-ack.service.js';

/** Where a save left the video, and whether the CMS has stored it. */
export interface PublishedRevision {
    /** Public URL of the revision the save wrote. */
    hlsUrl?: string;
    /** Its object key. */
    masterPlaylist: string;
    /**
     * The CMS confirmed it stored the new version within the wait. False when
     * the save landed but the CMS has not caught up; absent for a session with
     * no CMS behind it.
     */
    published?: boolean;
}

export interface SaveOptions {
    /** Refuse unless the CMS has stored the current version. Default true. */
    gate?: boolean;
    /** Wait for the CMS to store the new version before answering. Default true. */
    awaitAck?: boolean;
}

/**
 * The one way an edit becomes a new version of a session's video.
 *
 * Checks the CMS first (see {@link CmsAckService}), then runs the save alone
 * among saves to the same video in this process, moves the session to the
 * revision it wrote — which announces the new URL — and finally waits for the
 * CMS to confirm it stored it. When another machine got to the next revision
 * first, the session moves to the newest one instead and the save is refused
 * with `CHANGED_ELSEWHERE`, so the editor sees that version and saves again.
 */
@Injectable()
export class VideoRevisionService {
    constructor(
        private readonly sessionService: SessionService,
        private readonly masterRevisions: MasterRevisionService,
        private readonly cmsAck: CmsAckService
    ) {}

    /** Refuses with `CMS_NOT_ACKNOWLEDGED` unless the CMS has stored the current version. */
    assertCmsReady(sessionId: string): Promise<void> {
        return this.cmsAck.assertReady(sessionId);
    }

    /**
     * Runs `write` against the session's current master and publishes the
     * revision it returns. `write` gets the current master's key and must
     * write the next revision through {@link MasterRevisionService.writeNext}
     * (directly or through the HLS edit service), returning its key.
     */
    async save<T extends { masterKey: string }>(
        sessionId: string,
        write: (masterKey: string) => Promise<T>,
        options: SaveOptions = {}
    ): Promise<T & PublishedRevision> {
        if (options.gate ?? true) await this.cmsAck.assertReady(sessionId);
        const startKey = this.currentMasterKey(sessionId);

        const result = await this.masterRevisions.withVideoLock(
            startKey,
            async () => {
                // Read again inside the lock: a save queued behind another
                // writes after the revision that one wrote.
                const masterKey = this.currentMasterKey(sessionId);
                try {
                    const written = await write(masterKey);
                    this.sessionService.setMasterRevision(
                        sessionId,
                        written.masterKey
                    );
                    return written;
                } catch (err) {
                    if (err instanceof MasterRevisionConflict) {
                        await this.moveToNewest(sessionId, masterKey);
                        throw new ConflictException({
                            ...(err.getResponse() as object),
                            hlsUrl: this.sessionService.get(sessionId)?.hlsUrl,
                        });
                    }
                    throw err;
                }
            }
        );

        const hlsUrl = this.sessionService.get(sessionId)?.hlsUrl;
        const published =
            (options.awaitAck ?? true)
                ? await this.cmsAck.awaitAck(sessionId, hlsUrl)
                : undefined;
        return {
            ...result,
            hlsUrl,
            masterPlaylist: result.masterKey,
            ...(published === undefined ? {} : { published }),
        };
    }

    /** The newest revision in the bucket wins: the session moves to it. */
    private async moveToNewest(
        sessionId: string,
        masterKey: string
    ): Promise<void> {
        const session = this.sessionService.get(sessionId);
        if (!session) return;
        const newest = await this.masterRevisions.latestRevision(
            session.config.s3,
            masterKey
        );
        if (newest !== masterKey) {
            this.sessionService.setMasterRevision(sessionId, newest);
        }
    }

    private currentMasterKey(sessionId: string): string {
        const session = this.sessionService.get(sessionId);
        if (!session?.edit) {
            throw new ConflictException(
                'This video has not been published yet: there is no master to edit'
            );
        }
        return session.edit.masterKey;
    }
}
