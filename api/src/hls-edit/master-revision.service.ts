import { ConflictException, Injectable } from '@nestjs/common';
import { posix } from 'node:path';
import {
    masterRevisionName,
    nextMasterRevisionName,
    parseMasterRevision,
} from '@luminary-media-converter/hls-core';
import { S3EtagService } from './s3-etag.service.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';

/**
 * For everything an edit writes under a name of its own: a master revision, a
 * chapter file, a subtitle playlist, a thumbnail strip. Nothing is written
 * twice under one name, so a cache may keep any of them for as long as it
 * likes.
 */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/**
 * Another encoder already wrote the revision this save was going to write:
 * the video moved on while this one was looking at an older version.
 */
export class MasterRevisionConflict extends ConflictException {
    constructor(readonly attemptedKey: string) {
        super({
            message:
                'This video was changed somewhere else since it was opened. It now shows that version; save your change again.',
            code: 'CHANGED_ELSEWHERE',
        });
    }
}

/**
 * Master playlists as numbered revisions of a video.
 *
 * The encode writes `master.m3u8`, revision 0. Every edit writes the next
 * revision beside it — `master_r1.m3u8`, `master_r2.m3u8`, … — and never
 * touches an older one, so a viewer whose CMS document still names an older
 * master keeps a whole, consistent older version, and a cache can never hand
 * out a master from before an edit under the name of one after it.
 *
 * A revision is written with `If-None-Match: *`, so two encoders saving the
 * same video at once cannot both write revision N+1: the second write fails,
 * and that is the conflict check. The number comes from the revision the save
 * branched from, not from a clock, so a machine with its clock wrong cannot
 * write a revision that sorts out of turn.
 */
@Injectable()
export class MasterRevisionService {
    /** Per video (folder + stem): the tail of the chain of saves waiting their turn. */
    private readonly locks = new Map<string, Promise<void>>();

    constructor(private readonly s3EtagService: S3EtagService) {}

    /**
     * Runs `fn` alone among saves to the same video in this process, whichever
     * session they come from. Saves queue rather than collide; saves from
     * another machine are caught by the conditional write instead.
     */
    async withVideoLock<T>(
        masterKey: string,
        fn: () => Promise<T>
    ): Promise<T> {
        const key = videoOf(masterKey);
        const previous = this.locks.get(key) ?? Promise.resolve();
        let release!: () => void;
        const turn = new Promise<void>((resolve) => (release = resolve));
        const tail = previous.then(() => turn);
        this.locks.set(key, tail);
        await previous;
        try {
            return await fn();
        } finally {
            release();
            if (this.locks.get(key) === tail) this.locks.delete(key);
        }
    }

    /**
     * Writes `body` as the revision after `currentKey` and returns its key and
     * ETag. Throws {@link MasterRevisionConflict} when that revision already
     * exists.
     */
    async writeNext(
        s3: S3ConfigDto,
        currentKey: string,
        body: Buffer | string,
        contentType: string
    ): Promise<{ masterKey: string; etag: string }> {
        const nextKey = siblingKey(
            currentKey,
            nextMasterRevisionName(posix.basename(currentKey))
        );
        // Looked for first as well as written conditionally: a provider that
        // ignores If-None-Match would otherwise let a second writer replace a
        // revision a viewer may already hold, under a name cached for a year.
        if (await this.s3EtagService.objectExists(s3, nextKey)) {
            throw new MasterRevisionConflict(nextKey);
        }
        const etag = await this.s3EtagService.putObjectIfAbsent(
            s3,
            nextKey,
            body,
            contentType,
            { cacheControl: IMMUTABLE_CACHE_CONTROL }
        );
        if (etag === undefined) throw new MasterRevisionConflict(nextKey);
        return { masterKey: nextKey, etag };
    }

    /**
     * The newest revision of the video `masterKey` belongs to: the highest
     * number beside it, or `masterKey`'s revision 0 when no edit was ever saved.
     */
    async latestRevision(s3: S3ConfigDto, masterKey: string): Promise<string> {
        const revision = parseMasterRevision(posix.basename(masterKey));
        if (!revision) return masterKey;
        const folder = folderOf(masterKey);
        // Prefixed by the stem, so the listing is the master's own revisions
        // and not every segment of every rendition in the folder.
        const keys = await this.s3EtagService.listKeys(
            s3,
            `${folder}${revision.stem}`
        );
        let newest = { key: masterKey, n: revision.n };
        for (const key of keys) {
            const name = key.slice(folder.length);
            if (name.includes('/')) continue;
            const found = parseMasterRevision(name);
            if (
                found &&
                found.stem === revision.stem &&
                name === masterRevisionName(found.stem, found.n) &&
                found.n > newest.n
            ) {
                newest = { key, n: found.n };
            }
        }
        return newest.key;
    }
}

/** The video a master belongs to: its folder and its revision-free stem. */
export function videoOf(masterKey: string): string {
    const name = posix.basename(masterKey);
    const stem = parseMasterRevision(name)?.stem ?? name;
    return `${folderOf(masterKey)}${stem}`;
}

/** `key` with its file name replaced by `name`. */
export function siblingKey(key: string, name: string): string {
    return `${folderOf(key)}${name}`;
}

function folderOf(key: string): string {
    const lastSlash = key.lastIndexOf('/');
    return lastSlash >= 0 ? key.slice(0, lastSlash + 1) : '';
}
