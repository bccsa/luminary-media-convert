import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { createDecipheriv, randomBytes } from 'crypto';
import { open, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises';
import { join, posix } from 'path';
import {
    parseMasterPlaylist,
    parseMediaPlaylist,
    type HlsParsedMediaPlaylist,
    type HlsVariant,
} from '@luminary-media-converter/hls-core';
import { S3EtagService } from '../../hls-edit/s3-etag.service.js';
import { HlsEditService } from '../../hls-edit/hls-edit.service.js';
import { IMMUTABLE_CACHE_CONTROL } from '../../hls-edit/master-revision.service.js';
import { VideoRevisionService } from './video-revision.service.js';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from './lmcenc.js';
import { SessionService } from './session.service.js';
import { ThumbnailService } from './thumbnail.service.js';

/** Where a regenerate on an existing video has got to. */
export interface ExistingThumbnailsJob {
    state: 'running' | 'done' | 'failed';
    error?: string;
}

/** The storyboard's frames are 160px wide: any rendition at least that wide will do. */
const MIN_SOURCE_WIDTH = 160;

/** Segment reads in flight at once. */
const FETCH_CONCURRENCY = 8;

const SPRITE_RE = /^sprite_(\d+)\.(\w+)$/;

const IMAGE_TYPES: Record<string, string> = {
    webp: 'image/webp',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
};

/**
 * Makes the storyboard of a post's existing video again, in an edit session,
 * where the source is long gone: the video's smallest rendition wide enough
 * for the frames is fetched, decrypted and sampled, and the new sprites and VTT
 * go beside the video under names of their own, named by a new revision of
 * its master. The video itself is never written, and the strip it replaces
 * stays: the revision before still names it.
 */
@Injectable()
export class ExistingThumbnailsService {
    private readonly logger = new Logger(ExistingThumbnailsService.name);
    private readonly jobs = new Map<string, ExistingThumbnailsJob>();

    constructor(
        private readonly sessionService: SessionService,
        private readonly s3EtagService: S3EtagService,
        private readonly thumbnailService: ThumbnailService,
        private readonly hlsEditService: HlsEditService,
        private readonly videoRevisions: VideoRevisionService
    ) {}

    /** The job on this session, while it runs and after it ended. */
    job(sessionId: string): ExistingThumbnailsJob | undefined {
        return this.jobs.get(sessionId);
    }

    /** Starts the regenerate; its outcome is read back through {@link job}. */
    start(
        sessionId: string,
        video: { s3: S3ConfigDto; masterKey: string; keyHex?: string }
    ): ExistingThumbnailsJob {
        if (this.jobs.get(sessionId)?.state === 'running') {
            throw new ConflictException(
                "This video's thumbnails are already being made again"
            );
        }
        const job: ExistingThumbnailsJob = { state: 'running' };
        this.jobs.set(sessionId, job);
        void this.run(sessionId, video).then(
            () => {
                job.state = 'done';
            },
            (err: Error) => {
                this.logger.warn(
                    `Regenerating the thumbnails of ${sessionId} failed: ${err.message}`
                );
                job.state = 'failed';
                job.error = err.message;
            }
        );
        return job;
    }

    private async run(
        sessionId: string,
        {
            s3,
            masterKey,
            keyHex,
        }: { s3: S3ConfigDto; masterKey: string; keyHex?: string }
    ): Promise<void> {
        const key = keyHex ? keyFromHex(keyHex) : undefined;
        const folder = posix.dirname(masterKey);
        const masterBody = (
            await this.s3EtagService.getObjectWithEtag(s3, masterKey)
        ).body;
        const variant = pickVariant(
            parseMasterPlaylist(readMaybeEncrypted(masterBody, key)).variants
        );
        if (!variant?.uri || !variant.resolutionParsed) {
            throw new Error(
                'This video has no video rendition to take thumbnails from'
            );
        }
        const playlistKey = posix.join(folder, variant.uri);
        const playlist = parseMediaPlaylist(
            readMaybeEncrypted(
                (await this.s3EtagService.getObjectWithEtag(s3, playlistKey))
                    .body,
                key
            )
        );
        const duration = playlist.segments.reduce(
            (sum, s) => sum + s.duration,
            0
        );
        if (playlist.segments.length === 0 || duration <= 0) {
            throw new Error(
                'This video has no segments to take thumbnails from'
            );
        }

        const workDir = join(
            process.env.WORK_DIR || join(process.cwd(), 'work'),
            sessionId,
            `thumbnails-${randomBytes(3).toString('hex')}`
        );
        await mkdir(workDir, { recursive: true });
        try {
            const videoPath = join(workDir, 'video.mp4');
            await this.download(
                s3,
                posix.dirname(playlistKey),
                playlist,
                key,
                videoPath
            );

            // Empty, so the pack samples the download rather than reusing frames
            // from some earlier pass.
            await this.thumbnailService.removePreview(sessionId);
            const outputDir = join(workDir, 'out');
            const packed = await this.thumbnailService.packForDelivery({
                sessionId,
                inputPath: videoPath,
                outputDir,
                sourceDuration: duration,
                videoTracks: [
                    {
                        index: 0,
                        width: variant.resolutionParsed.width,
                        height: variant.resolutionParsed.height,
                    },
                ],
            });
            if (!packed) {
                throw new Error('No thumbnails could be made from this video');
            }

            const vttPath = await this.publish(
                s3,
                folder,
                join(outputDir, 'thumbnails'),
                key && isLmcencPayload(masterBody) ? key : undefined
            );
            // The video's one strip, labelled with the angle it was sampled
            // from; a video without angles has one strip for all of it. Written
            // onto the master as it is now, not as the job read it, so a save
            // made while the job ran is kept. Not gated on the CMS: the job was
            // checked when it started, and if the CMS has gone since, the
            // version waits for it.
            await this.videoRevisions.save(
                sessionId,
                (currentKey) =>
                    this.hlsEditService.publishThumbnails(
                        s3,
                        currentKey,
                        vttPath,
                        variant.videoGroup,
                        keyHex
                    ),
                { gate: false, awaitAck: false }
            );
            const session = this.sessionService.get(sessionId);
            // In the form the session already holds its master's name: a key for
            // a finished encode, relative to the folder for an edit session.
            this.sessionService.setThumbnailsVtt(
                sessionId,
                session?.masterPlaylist?.includes('/')
                    ? posix.join(folder, vttPath)
                    : vttPath
            );
        } finally {
            await this.thumbnailService.removePreview(sessionId);
            await rm(workDir, { recursive: true, force: true });
        }
    }

    /**
     * The rendition as one fMP4 file: its init segment, then every media segment
     * in order, each decrypted on its own as the encoder encrypted it.
     */
    private async download(
        s3: S3ConfigDto,
        playlistDir: string,
        playlist: HlsParsedMediaPlaylist,
        key: Buffer | undefined,
        outPath: string
    ): Promise<void> {
        const aes = playlist.keys.find((k) => k.method === 'AES-128');
        if (aes && !key) {
            throw new Error(
                'This video is encrypted, and its key is not in this session'
            );
        }
        const read = (
            uri: string,
            range?: { offset?: number; length: number }
        ) =>
            range
                ? this.s3EtagService.getObjectRange(
                      s3,
                      posix.join(playlistDir, uri),
                      range.offset ?? 0,
                      range.length
                  )
                : this.s3EtagService
                      .getObjectWithEtag(s3, posix.join(playlistDir, uri))
                      .then((o) => o.body);

        const file = await open(outPath, 'w');
        try {
            const map = playlist.maps[0];
            if (map) await file.write(await read(map.uri, map.byteRange));

            const segments = playlist.segments;
            for (
                let start = 0;
                start < segments.length;
                start += FETCH_CONCURRENCY
            ) {
                const batch = segments.slice(start, start + FETCH_CONCURRENCY);
                const bodies = await Promise.all(
                    batch.map((seg) => read(seg.uri, seg.byteRange))
                );
                for (let i = 0; i < bodies.length; i++) {
                    const sequence = (playlist.mediaSequence ?? 0) + start + i;
                    await file.write(
                        aes
                            ? decryptSegment(
                                  bodies[i],
                                  key!,
                                  ivFor(aes.iv, sequence)
                              )
                            : bodies[i]
                    );
                }
            }
        } finally {
            await file.close();
        }
    }

    /**
     * Upload the new storyboard, sprites and VTT alike under names of their own,
     * and return the VTT's path relative to the video's folder. Nothing points
     * at it until a master revision names it, and the sprites it replaces stay:
     * the revision before names them.
     */
    private async publish(
        s3: S3ConfigDto,
        folder: string,
        thumbnailDir: string,
        textKey: Buffer | undefined
    ): Promise<string> {
        const tag = Date.now().toString(36);
        const sprites = (await readdir(thumbnailDir)).filter((f) =>
            SPRITE_RE.test(f)
        );
        const renamed = new Map(
            sprites.map((f) => [f, f.replace(SPRITE_RE, `sprite_${tag}_$1.$2`)])
        );
        const prefix = posix.join(folder, 'thumbnails');

        for (const [from, to] of renamed) {
            const ext = from.slice(from.lastIndexOf('.') + 1).toLowerCase();
            await this.s3EtagService.putObject(
                s3,
                posix.join(prefix, to),
                await readFile(join(thumbnailDir, from)),
                IMAGE_TYPES[ext] ?? 'application/octet-stream',
                { cacheControl: IMMUTABLE_CACHE_CONTROL }
            );
        }

        let vtt = await readFile(join(thumbnailDir, 'thumbnails.vtt'), 'utf-8');
        vtt = vtt.replace(
            /^(sprite_\d+\.\w+)(?=#|$)/gm,
            (name) => renamed.get(name) ?? name
        );
        const vttPath = `thumbnails/thumbnails_${randomBytes(4).toString('hex')}.vtt`;
        await this.s3EtagService.putObject(
            s3,
            posix.join(folder, vttPath),
            textKey ? encryptTextAsset(vtt, textKey) : vtt,
            textKey ? 'application/octet-stream' : 'text/vtt',
            { cacheControl: IMMUTABLE_CACHE_CONTROL }
        );
        return vttPath;
    }
}

/**
 * The rendition to sample: the smallest at least as wide as a frame, from the
 * first angle; the widest there is when none is.
 */
export function pickVariant(variants: HlsVariant[]): HlsVariant | undefined {
    const angle = variants.find((v) => v.resolutionParsed)?.videoGroup;
    const sized = variants.filter(
        (v) => v.uri && v.resolutionParsed && v.videoGroup === angle
    );
    const wide = sized
        .filter((v) => v.resolutionParsed!.width >= MIN_SOURCE_WIDTH)
        .sort((a, b) => a.resolutionParsed!.width - b.resolutionParsed!.width);
    if (wide.length > 0) return wide[0];
    return sized.sort(
        (a, b) => b.resolutionParsed!.width - a.resolutionParsed!.width
    )[0];
}

/** The IV a segment was encrypted under: the key tag's own, else its sequence number. */
export function ivFor(ivText: string | undefined, sequence: number): Buffer {
    if (ivText)
        return Buffer.from(ivText.replace(/^0x/i, '').padStart(32, '0'), 'hex');
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(sequence), 8);
    return iv;
}

export function decryptSegment(body: Buffer, key: Buffer, iv: Buffer): Buffer {
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    return Buffer.concat([decipher.update(body), decipher.final()]);
}
