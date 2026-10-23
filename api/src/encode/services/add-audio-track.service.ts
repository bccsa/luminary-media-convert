import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { mkdir, rm, writeFile } from 'fs/promises';
import { isAbsolute, join, posix } from 'path';
import {
    parseMasterPlaylist,
    parseMediaPlaylist,
    LUMINARY_KEY_PLACEHOLDER_URI,
    type HlsParsedMediaPlaylist,
} from '@luminary-media-converter/hls-core';
import { S3EtagService } from '../../hls-edit/s3-etag.service.js';
import { EDITED_CACHE_CONTROL } from '../../hls-edit/hls-edit.service.js';
import {
    addAudioTrackLines,
    assertTrackLabel,
} from '../../hls-edit/audio-tracks.js';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import { EncryptionService } from './encryption.service.js';
import { ffmpegBin, ffprobeBin } from './ffbin.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from './lmcenc.js';
import { hasAllowedExtension } from './media-extensions.js';
import { ProbeService, type AudioTrackInfo } from './probe.service.js';
import { S3Service } from './s3.service.js';
import { SegmentPipelineService } from './segment-pipeline.service.js';
import { SessionService, type Session } from './session.service.js';
import {
    buildAddAudioArgs,
    estimateBitrateKbps,
    renditionDir,
    type RenditionTarget,
} from './add-audio-track.plan.js';

/** A file the editor picked to take a new audio track from. */
export interface AudioSource {
    durationSec: number;
    audioTracks: AudioTrackInfo[];
}

export interface AddAudioTrackRequest {
    path: string;
    sourceTrackIndex: number;
    language: string;
    name: string;
    offsetSec: number;
    /** The master's ETag the editor read: a video changed since is not added to. */
    ifMatch: string;
}

/** Where an audio track being added has got to. */
export interface AddAudioTrackJob {
    state: 'running' | 'done' | 'failed';
    phase: 'reading' | 'encoding' | 'uploading' | 'saving' | 'done';
    /** 0–100 within the phase. */
    progress: number;
    language: string;
    name: string;
    error?: string;
}

/** What the new track has to match, read from the video's own audio. */
interface ExistingAudio {
    durationSec: number;
    segmentDurationSec: number;
    byteRange: boolean;
    segmentsEncrypted: boolean;
    keyUri: string;
    playlistsEncrypted: boolean;
    groups: {
        groupId: string;
        bitrateKbps: number;
        channels: number;
        sampleRate: number;
    }[];
}

/** Cap for the new track's byte-range chunks, as for the encode's audio chain. */
const CHUNK_CAP_BYTES = 50 * 1024 * 1024;

/**
 * Adds an audio track to a post's existing video, in an edit session: the
 * picked file's audio is encoded to match each of the video's audio groups —
 * bitrate, channels, sample rate, segment length, byte ranges, encryption —
 * uploaded beside it in folders of its own, and named in the master. The
 * video's own files are never written; the master only gains lines, over the
 * version the editor read, its original kept at `master.m3u8.orig`.
 */
@Injectable()
export class AddAudioTrackService {
    private readonly logger = new Logger(AddAudioTrackService.name);
    private readonly jobs = new Map<string, AddAudioTrackJob>();

    constructor(
        private readonly sessionService: SessionService,
        private readonly s3EtagService: S3EtagService,
        private readonly segmentPipelineService: SegmentPipelineService,
        private readonly encryptionService: EncryptionService,
        private readonly probeService: ProbeService
    ) {}

    /** The job on this session, while it runs and after it ended. */
    job(sessionId: string): AddAudioTrackJob | undefined {
        return this.jobs.get(sessionId);
    }

    /** A track is being added: nothing else may rewrite the master meanwhile. */
    isBusy(sessionId: string): boolean {
        return this.jobs.get(sessionId)?.state === 'running';
    }

    /** The picked file's audio tracks, for the editor to choose one. */
    async probeSource(sessionId: string, path: string): Promise<AudioSource> {
        this.editSession(sessionId);
        this.assertReadableSource(path);
        const probe = await this.probeService.probe(path);
        if (probe.audioTracks.length === 0) {
            throw new BadRequestException('This file has no audio');
        }
        return {
            durationSec: probe.format?.duration ?? 0,
            audioTracks: probe.audioTracks,
        };
    }

    /** Starts adding the track; its progress is read with {@link job}. */
    async start(
        sessionId: string,
        req: AddAudioTrackRequest
    ): Promise<AddAudioTrackJob> {
        const session = this.editSession(sessionId);
        if (this.isBusy(sessionId)) {
            throw new ConflictException(
                'An audio track is already being added to this video'
            );
        }
        this.assertReadableSource(req.path);
        const label = assertTrackLabel(req.language, req.name);
        if (
            !Number.isFinite(req.offsetSec) ||
            Math.abs(req.offsetSec) > 24 * 3600
        ) {
            throw new BadRequestException(
                'The offset must be a number of seconds'
            );
        }
        const probe = await this.probeService.probe(req.path);
        if (!probe.audioTracks[req.sourceTrackIndex]) {
            throw new BadRequestException('That file has no such audio track');
        }
        // Checked now, on the master as it is, rather than after the encode and
        // the upload: a track the video already has, or a master changed since
        // the editor read it, is refused before any work is done.
        const master = await this.s3EtagService.getObjectWithEtag(
            session.config.s3,
            session.edit!.masterKey
        );
        if (master.etag !== req.ifMatch) {
            throw new ConflictException(
                'The video was changed since it was opened'
            );
        }
        const parsed = readMaybeEncrypted(
            master.body,
            session.encryptionKeyHex
                ? keyFromHex(session.encryptionKeyHex)
                : undefined
        );
        const groups = [
            ...new Set(
                parseMasterPlaylist(parsed)
                    .media.filter((m) => m.type === 'AUDIO' && m.uri)
                    .map((m) => m.groupId)
            ),
        ];
        if (groups.length === 0) {
            throw new BadRequestException(
                'This video carries its audio inside its video renditions: there is no audio group to add a track to'
            );
        }
        addAudioTrackLines(
            parsed,
            label,
            groups.map((groupId) => ({ groupId, uri: '', channels: 0 }))
        );

        const job: AddAudioTrackJob = {
            state: 'running',
            phase: 'reading',
            progress: 0,
            ...label,
        };
        this.jobs.set(sessionId, job);
        void this.run(session, { ...req, ...label }, job).catch(
            (err: Error) => {
                job.state = 'failed';
                job.error = err.message;
                this.logger.warn(
                    `Adding an audio track to session ${sessionId} failed: ${err.message}`
                );
            }
        );
        return job;
    }

    private async run(
        session: Session,
        req: AddAudioTrackRequest,
        job: AddAudioTrackJob
    ): Promise<void> {
        const s3 = session.config.s3;
        const masterKey = session.edit!.masterKey;
        const folder =
            posix.dirname(masterKey) === '.' ? '' : posix.dirname(masterKey);
        const key = session.encryptionKeyHex
            ? keyFromHex(session.encryptionKeyHex)
            : undefined;

        const master = await this.s3EtagService.getObjectWithEtag(
            s3,
            masterKey
        );
        if (master.etag !== req.ifMatch) {
            throw new ConflictException(
                'The video was changed since it was opened'
            );
        }
        const masterText = readMaybeEncrypted(master.body, key);
        const existing = await this.readExistingAudio(
            s3,
            folder,
            masterText,
            key
        );

        const token = randomBytes(3).toString('hex');
        const workDir = join(
            process.env.WORK_DIR || join(process.cwd(), 'work'),
            session.id,
            `add-audio-${token}`
        );
        await mkdir(workDir, { recursive: true });
        try {
            const targets: RenditionTarget[] = existing.groups.map((g, i) => ({
                ...g,
                dir: renditionDir(token, i, req.name),
            }));
            const iv = existing.segmentsEncrypted
                ? this.encryptionService.generateIV()
                : undefined;
            const segmentCount = Math.ceil(
                existing.durationSec / existing.segmentDurationSec
            );
            const pipeline = this.segmentPipelineService.createPipeline({
                outputDir: workDir,
                s3Config: s3,
                s3PathPrefix: S3Service.canonicalPrefix(folder),
                encryptionKey: existing.segmentsEncrypted ? key : undefined,
                encryptionIV: iv,
                byteRange: existing.byteRange,
                byteRangeMaxFileSizeBytes: CHUNK_CAP_BYTES,
                // One chain of its own: sharing the encode's would write over its chunks.
                streamChains: Object.fromEntries(
                    targets.map((t) => [t.dir, `a${token}`])
                ),
                audioByteRangeMaxFileSizeBytes: CHUNK_CAP_BYTES,
                segmentDurationSeconds: existing.segmentDurationSec,
                estimatedTotalSegments: segmentCount * targets.length,
                onProgress: (p) => {
                    if (job.phase === 'uploading' && p.uploading != null)
                        job.progress = p.uploading;
                },
            });

            job.phase = 'encoding';
            pipeline.start();
            await this.encode(
                buildAddAudioArgs({
                    inputPath: req.path,
                    sourceTrackIndex: req.sourceTrackIndex,
                    offsetSec: req.offsetSec,
                    durationSec: existing.durationSec,
                    segmentDurationSec: existing.segmentDurationSec,
                    renditions: targets,
                    outputDir: workDir,
                }),
                existing.durationSec,
                (pct) => (job.progress = pct)
            );
            if (pipeline.error) throw pipeline.error;

            job.phase = 'uploading';
            job.progress = 0;
            await pipeline.drain();
            if (existing.segmentsEncrypted) {
                await this.encryptionService.injectKeyTagsIntoPlaylists(
                    workDir,
                    existing.keyUri,
                    iv!
                );
            }
            if (existing.playlistsEncrypted) {
                await this.encryptionService.encryptTextAssets(workDir, key!);
            }
            await pipeline.uploadRemainingFiles(workDir, {
                onFileProgress: (done, total) => {
                    job.progress =
                        total > 0 ? Math.round((done / total) * 100) : 100;
                },
            });

            job.phase = 'saving';
            job.progress = 0;
            const updated = addAudioTrackLines(
                masterText,
                req,
                targets.map((t) => ({
                    groupId: t.groupId,
                    uri: `${t.dir}/playlist.m3u8`,
                    channels: t.channels,
                }))
            );
            const encrypted = isLmcencPayload(master.body);
            const contentType = encrypted
                ? 'application/octet-stream'
                : 'application/vnd.apple.mpegurl';
            await this.s3EtagService.putObjectIfAbsent(
                s3,
                `${masterKey}.orig`,
                master.body,
                contentType
            );
            await this.s3EtagService.putObjectIfMatch(
                s3,
                masterKey,
                encrypted ? encryptTextAsset(updated, key!) : updated,
                master.etag,
                contentType,
                { cacheControl: EDITED_CACHE_CONTROL }
            );
            job.state = 'done';
            job.phase = 'done';
            job.progress = 100;
            this.logger.log(
                `Added audio track "${req.name}" (${req.language}) to session ${session.id}`
            );
        } finally {
            await rm(workDir, { recursive: true, force: true }).catch(
                () => undefined
            );
        }
    }

    /** Each audio group's settings, and how the video's audio is laid out and protected. */
    private async readExistingAudio(
        s3: S3ConfigDto,
        folder: string,
        masterText: string,
        key: Buffer | undefined
    ): Promise<ExistingAudio> {
        const master = parseMasterPlaylist(masterText);
        const groupIds = [
            ...new Set(
                master.media
                    .filter((m) => m.type === 'AUDIO' && m.uri)
                    .map((m) => m.groupId)
            ),
        ];
        if (groupIds.length === 0) {
            throw new BadRequestException(
                'This video carries its audio inside its video renditions: there is no audio group to add a track to'
            );
        }

        let shared: Omit<ExistingAudio, 'groups'> | undefined;
        const groups: ExistingAudio['groups'] = [];
        for (const groupId of groupIds) {
            const reference = master.media.find(
                (m) => m.type === 'AUDIO' && m.groupId === groupId && m.uri
            )!;
            const playlistKey = posix.join(folder, reference.uri!);
            const { body } = await this.s3EtagService.getObjectWithEtag(
                s3,
                playlistKey
            );
            const playlist = parseMediaPlaylist(readMaybeEncrypted(body, key));
            const durationSec = playlist.segments.reduce(
                (sum, seg) => sum + seg.duration,
                0
            );
            const map = playlist.maps[0];
            if (!map || playlist.segments.length === 0) {
                throw new BadRequestException(
                    "This video's audio is not in fMP4 segments, which adding a track needs"
                );
            }
            const playlistDir = posix.dirname(playlistKey);
            const init = map.byteRange
                ? await this.s3EtagService.getObjectRange(
                      s3,
                      posix.join(playlistDir, map.uri),
                      map.byteRange.offset ?? 0,
                      map.byteRange.length
                  )
                : (
                      await this.s3EtagService.getObjectWithEtag(
                          s3,
                          posix.join(playlistDir, map.uri)
                      )
                  ).body;
            const { channels, sampleRate } = await this.probeInit(init);
            groups.push({
                groupId,
                channels,
                sampleRate,
                bitrateKbps: estimateBitrateKbps(
                    await this.audioBytes(s3, playlistDir, playlist),
                    durationSec
                ),
            });

            const aes = playlist.keys.find((k) => k.method === 'AES-128');
            shared ??= {
                durationSec,
                segmentDurationSec: Math.max(
                    1,
                    Math.round(playlist.segments[0].duration)
                ),
                byteRange: playlist.segments.some((seg) => seg.byteRange),
                segmentsEncrypted: !!aes,
                keyUri: aes?.uri ?? LUMINARY_KEY_PLACEHOLDER_URI,
                playlistsEncrypted: isLmcencPayload(body),
            };
        }
        if (shared!.segmentsEncrypted && !key) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to add a track to it'
            );
        }
        return { ...shared!, groups };
    }

    /** The rendition's media bytes: its ranges' lengths, or a sample of its segment files scaled up. */
    private async audioBytes(
        s3: S3ConfigDto,
        dir: string,
        playlist: HlsParsedMediaPlaylist
    ): Promise<number> {
        if (playlist.segments.every((seg) => seg.byteRange)) {
            return playlist.segments.reduce(
                (sum, seg) => sum + seg.byteRange!.length,
                0
            );
        }
        const sample = playlist.segments.slice(0, 6);
        const sizes = await Promise.all(
            sample.map((seg) =>
                this.s3EtagService.objectSize(s3, posix.join(dir, seg.uri))
            )
        );
        const sampled = sample.reduce((sum, seg) => sum + seg.duration, 0);
        const total = playlist.segments.reduce(
            (sum, seg) => sum + seg.duration,
            0
        );
        return sampled > 0
            ? (sizes.reduce((a, b) => a + b, 0) / sampled) * total
            : 0;
    }

    /** Channels and sample rate from a rendition's init segment, which is never encrypted. */
    private async probeInit(
        init: Buffer
    ): Promise<{ channels: number; sampleRate: number }> {
        const path = join(
            process.env.WORK_DIR || join(process.cwd(), 'work'),
            `init-${randomBytes(4).toString('hex')}.mp4`
        );
        await writeFile(path, init);
        try {
            const out = await run(ffprobeBin(), [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=channels,sample_rate',
                '-of',
                'json',
                path,
            ]);
            const stream = JSON.parse(out).streams?.[0] ?? {};
            return {
                channels: Number(stream.channels) || 2,
                sampleRate: Number(stream.sample_rate) || 48000,
            };
        } finally {
            await rm(path, { force: true });
        }
    }

    private async encode(
        args: string[],
        durationSec: number,
        onProgress: (pct: number) => void
    ): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            const child = spawn(ffmpegBin(), args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stderr = '';
            child.stdout.on('data', (chunk: Buffer) => {
                const match = /out_time_us=(\d+)/.exec(chunk.toString());
                if (match && durationSec > 0) {
                    onProgress(
                        Math.min(
                            100,
                            Math.round(
                                (Number(match[1]) / 1e6 / durationSec) * 100
                            )
                        )
                    );
                }
            });
            child.stderr.on(
                'data',
                (chunk: Buffer) =>
                    (stderr = (stderr + chunk.toString()).slice(-4000))
            );
            child.on('error', reject);
            child.on('close', (code) =>
                code === 0
                    ? resolve()
                    : reject(
                          new Error(
                              `The audio could not be encoded: ${stderr.trim().split('\n').pop()}`
                          )
                      )
            );
        });
    }

    private editSession(sessionId: string): Session {
        const session = this.sessionService.get(sessionId);
        if (!session)
            throw new NotFoundException(`Session ${sessionId} not found`);
        if (!session.edit) {
            throw new ConflictException(
                'This session encodes a new video; it has no existing one to add to'
            );
        }
        if (!this.sessionService.hasUsableCredentials(session)) {
            throw new BadRequestException(
                'The storage credentials for this session are no longer available — open the video again from the CMS'
            );
        }
        return session;
    }

    private assertReadableSource(path: string): void {
        if (!isAbsolute(path) || !existsSync(path)) {
            throw new BadRequestException('No file at that path');
        }
        if (!hasAllowedExtension(path)) {
            throw new BadRequestException(
                'That is not an audio or video file the encoder reads'
            );
        }
    }
}

function run(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        child.stdout.on('data', (c: Buffer) => (out += c.toString()));
        child.stderr.on('data', (c: Buffer) => (err += c.toString()));
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve(out)
                : reject(new Error(err.trim() || `${bin} failed`))
        );
    });
}
