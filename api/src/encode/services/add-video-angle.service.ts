import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { mkdir, readFile, rm } from 'fs/promises';
import { join, posix } from 'path';
import {
    parseMasterPlaylist,
    parseMediaPlaylist,
    LUMINARY_KEY_PLACEHOLDER_URI,
    type HlsParsedMaster,
    type HlsParsedMediaPlaylist,
    type HlsVariant,
} from '@luminary-media-converter/hls-core';
import { S3EtagService } from '../../hls-edit/s3-etag.service.js';
import { EDITED_CACHE_CONTROL } from '../../hls-edit/hls-edit.service.js';
import {
    addVideoAngleLines,
    assertAngleName,
    listVideoAngles,
} from '../../hls-edit/video-angles.js';
import type { S3ConfigDto } from '../dto/s3-config.dto.js';
import { EncryptionService } from './encryption.service.js';
import { ffmpegBin, ffprobeBin } from './ffbin.js';
import { FfmpegService, isHardwareEncoderFailure } from './ffmpeg.service.js';
import type { AccelMode } from './encoder-selection.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from './lmcenc.js';
import { S3Service } from './s3.service.js';
import { SegmentPipelineService } from './segment-pipeline.service.js';
import { SessionService, type Session } from './session.service.js';
import {
    angleCodecs,
    angleRenditionDir,
    buildAddAngleArgs,
    estimateVideoBitrateKbps,
    type AngleRenditionTarget,
} from './add-video-angle.plan.js';
import {
    assertReadableSource,
    isHlsLink,
    isLink,
    runEncode,
    runProcess,
} from './edit-source.js';

/** A video stream in a source, as the editor chooses between them. */
export interface SourceVideoTrack {
    /** Among the source's video streams (`0:v:<n>`). */
    index: number;
    codec?: string;
    width?: number;
    height?: number;
    frameRate?: number;
    name?: string;
}

/** A file or link the editor gave to take a new angle from. */
export interface VideoSource {
    durationSec: number;
    videoTracks: SourceVideoTrack[];
}

export interface AddVideoAngleRequest {
    path: string;
    sourceTrackIndex: number;
    name: string;
    /** What to call the video's own picture when it has no angles yet. */
    mainName?: string;
    offsetSec: number;
    /** The master's ETag the editor read: a video changed since is not added to. */
    ifMatch: string;
}

/** Where an angle being added has got to. */
export interface AddVideoAngleJob {
    state: 'running' | 'done' | 'failed';
    phase: 'reading' | 'encoding' | 'uploading' | 'saving' | 'done';
    /** 0–100 within the phase. */
    progress: number;
    name: string;
    error?: string;
}

/** One size of the existing angle, measured. */
interface ExistingRendition {
    referenceUri: string;
    width: number;
    height: number;
    videoBitrateKbps: number;
    frameRate?: number;
    codecs?: string;
    audioGroup?: string;
}

/** What the new angle has to match, read from the video's own picture. */
interface ExistingVideo {
    durationSec: number;
    segmentDurationSec: number;
    byteRange: boolean;
    segmentsEncrypted: boolean;
    keyUri: string;
    playlistsEncrypted: boolean;
    renditions: ExistingRendition[];
    /** Each audio group's measured bitrate, in bits per second, for BANDWIDTH. */
    audioBps: Map<string, number>;
}

/** Cap for the new angle's byte-range chunks, as the encode's default. */
const CHUNK_CAP_BYTES = 500 * 1024 * 1024;
/** FFmpeg's master for the new renditions: read, then removed before anything is uploaded. */
const FFMPEG_MASTER = 'angle-master.m3u8';

/**
 * Adds a camera angle to a post's existing video, in an edit session: the
 * picked file's picture is encoded to the sizes, bitrates, frame rate and
 * segment grid of the video's main angle — byte ranges and encryption too —
 * uploaded beside it in folders of its own, and named in the master, sharing
 * the video's audio. A video with a single picture gains angles: its picture
 * becomes the main one. The video's own files are never written; the master
 * only changes over the version the editor read, its original kept at
 * `master.m3u8.orig`.
 */
@Injectable()
export class AddVideoAngleService {
    private readonly logger = new Logger(AddVideoAngleService.name);
    private readonly jobs = new Map<string, AddVideoAngleJob>();

    constructor(
        private readonly sessionService: SessionService,
        private readonly s3EtagService: S3EtagService,
        private readonly segmentPipelineService: SegmentPipelineService,
        private readonly encryptionService: EncryptionService,
        private readonly ffmpegService: FfmpegService
    ) {}

    /** The job on this session, while it runs and after it ended. */
    job(sessionId: string): AddVideoAngleJob | undefined {
        return this.jobs.get(sessionId);
    }

    /** An angle is being added: nothing else may rewrite the master meanwhile. */
    isBusy(sessionId: string): boolean {
        return this.jobs.get(sessionId)?.state === 'running';
    }

    /** The video streams of a picked file or a pasted link, for the editor to choose one. */
    async probeSource(sessionId: string, path: string): Promise<VideoSource> {
        this.editSession(sessionId);
        assertReadableSource(path);
        const { durationSec, videoTracks } = await this.resolveSource(path);
        return { durationSec, videoTracks };
    }

    /** Starts adding the angle; its progress is read with {@link job}. */
    async start(
        sessionId: string,
        req: AddVideoAngleRequest
    ): Promise<AddVideoAngleJob> {
        const session = this.editSession(sessionId);
        if (this.isBusy(sessionId)) {
            throw new ConflictException(
                'An angle is already being added to this video'
            );
        }
        assertReadableSource(req.path);
        const name = assertAngleName(req.name);
        const mainName =
            req.mainName !== undefined
                ? assertAngleName(req.mainName)
                : undefined;
        if (
            !Number.isFinite(req.offsetSec) ||
            Math.abs(req.offsetSec) > 24 * 3600
        ) {
            throw new BadRequestException(
                'The offset must be a number of seconds'
            );
        }
        const source = await this.resolveSource(req.path);
        if (!source.videoTracks.some((t) => t.index === req.sourceTrackIndex)) {
            throw new BadRequestException(
                'That source has no such video track'
            );
        }
        // Checked now, on the master as it is, rather than after the encode and
        // the upload: a name the video already has, a video without audio
        // groups, or a master changed since the editor read it, is refused
        // before any work is done.
        const master = await this.s3EtagService.getObjectWithEtag(
            session.config.s3,
            session.edit!.masterKey
        );
        if (master.etag !== req.ifMatch) {
            throw new ConflictException(
                'The video was changed since it was opened'
            );
        }
        const text = readMaybeEncrypted(
            master.body,
            session.encryptionKeyHex
                ? keyFromHex(session.encryptionKeyHex)
                : undefined
        );
        const parsed = parseMasterPlaylist(text);
        this.assertAudioGroups(parsed);
        const reference = this.referenceVariants(parsed)[0];
        addVideoAngleLines(text, { name, mainName }, [
            {
                referenceUri: reference.uri,
                uri: 'check/playlist.m3u8',
                bandwidth: 1,
                resolution: '2x2',
                codecs: 'avc1.640028',
            },
        ]);

        const job: AddVideoAngleJob = {
            state: 'running',
            phase: 'reading',
            progress: 0,
            name,
        };
        this.jobs.set(sessionId, job);
        void this.run(
            session,
            { ...req, name, mainName },
            source.input,
            source.videoTracks.find((t) => t.index === req.sourceTrackIndex)!,
            job
        ).catch((err: Error) => {
            job.state = 'failed';
            job.error = err.message;
            this.logger.warn(
                `Adding an angle to session ${sessionId} failed: ${err.message}`
            );
        });
        return job;
    }

    private async run(
        session: Session,
        req: AddVideoAngleRequest,
        input: string,
        track: SourceVideoTrack,
        job: AddVideoAngleJob
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
        const existing = await this.readExistingVideo(
            s3,
            folder,
            masterText,
            key
        );

        const token = randomBytes(3).toString('hex');
        const workDir = join(
            process.env.WORK_DIR || join(process.cwd(), 'work'),
            session.id,
            `add-angle-${token}`
        );
        await mkdir(workDir, { recursive: true });
        try {
            const targets: AngleRenditionTarget[] = existing.renditions.map(
                (r, i) => ({
                    dir: angleRenditionDir(token, i, req.name, r.height),
                    width: r.width,
                    height: r.height,
                    videoBitrateKbps: r.videoBitrateKbps,
                    referenceUri: r.referenceUri,
                })
            );
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
                // One chain for the angle, as the encoder packs each of its own.
                streamChains: Object.fromEntries(
                    targets.map((t) => [t.dir, `v${token}`])
                ),
                segmentDurationSeconds: existing.segmentDurationSec,
                estimatedTotalSegments: segmentCount * targets.length,
                onProgress: (p) => {
                    if (job.phase === 'uploading' && p.uploading != null)
                        job.progress = p.uploading;
                },
            });

            job.phase = 'encoding';
            pipeline.start();
            const frameRate =
                existing.renditions[0].frameRate ?? track.frameRate ?? 25;
            const encodeWith = (accelMode: AccelMode) =>
                runEncode(
                    ffmpegBin(),
                    buildAddAngleArgs({
                        inputPath: input,
                        sourceTrackIndex: track.index,
                        offsetSec: req.offsetSec,
                        durationSec: existing.durationSec,
                        segmentDurationSec: existing.segmentDurationSec,
                        frameRate,
                        accelMode,
                        renditions: targets,
                        outputDir: workDir,
                        masterName: FFMPEG_MASTER,
                    }),
                    existing.durationSec,
                    (pct) => (job.progress = pct),
                    'The angle could not be encoded'
                );
            const accel = this.ffmpegService.getAccelMode();
            try {
                await encodeWith(accel);
            } catch (err) {
                // A GPU that will not open an encoder now is no reason to fail:
                // the CPU does the same job, slower. Only before any output,
                // so nothing half-uploaded is mixed with a second run.
                const stderr = (err as { stderr?: string }).stderr ?? '';
                if (
                    accel === 'cpu' ||
                    !isHardwareEncoderFailure(new Error(stderr)) ||
                    pipeline.error
                ) {
                    throw err;
                }
                this.logger.warn(
                    `The ${accel} encoder failed adding an angle; encoding on the CPU instead`
                );
                job.progress = 0;
                await encodeWith('cpu');
            }
            if (pipeline.error) throw pipeline.error;

            // FFmpeg's own master gives each rendition's CODECS and BANDWIDTH;
            // it must not be uploaded beside the video's.
            const ffmpegMaster = parseMasterPlaylist(
                await readFile(join(workDir, FFMPEG_MASTER), 'utf-8')
            );
            await rm(join(workDir, FFMPEG_MASTER), { force: true });

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
            const updated = addVideoAngleLines(
                masterText,
                req,
                targets.map((t, i) => {
                    const uri = `${t.dir}/playlist.m3u8`;
                    const made = ffmpegMaster.variants.find(
                        (v) => v.uri === uri
                    );
                    const ref = existing.renditions[i];
                    const audio = ref.audioGroup
                        ? (existing.audioBps.get(ref.audioGroup) ?? 0)
                        : 0;
                    const videoBps =
                        made?.bandwidth ?? t.videoBitrateKbps * 1000;
                    return {
                        referenceUri: t.referenceUri,
                        uri,
                        bandwidth: videoBps + audio,
                        ...(made?.averageBandwidth
                            ? {
                                  averageBandwidth:
                                      made.averageBandwidth + audio,
                              }
                            : {}),
                        resolution: `${t.width}x${t.height}`,
                        frameRate,
                        codecs: angleCodecs(
                            made?.codecs ?? 'avc1.640028',
                            ref.codecs
                        ),
                    };
                })
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
                `Added angle "${req.name}" to session ${session.id}`
            );
        } finally {
            await rm(workDir, { recursive: true, force: true }).catch(
                () => undefined
            );
        }
    }

    /** The variants a new angle copies: the default angle's, or every pictured one of a single picture. */
    private referenceVariants(master: HlsParsedMaster): HlsVariant[] {
        const angles = listVideoAngles(master);
        if (angles.length === 0) {
            throw new BadRequestException(
                'This video has no picture to add an angle beside'
            );
        }
        const main = angles.find((a) => a.default) ?? angles[0];
        const variants = master.variants.filter(
            (v) =>
                v.resolutionParsed &&
                (main.id === '' || v.videoGroup === main.id)
        );
        if (variants.length === 0) {
            throw new BadRequestException(
                "This video's renditions do not state their size, which adding an angle needs"
            );
        }
        // Largest first, as the encoder writes its ladder.
        return [...variants].sort(
            (a, b) =>
                (b.resolutionParsed?.height ?? 0) -
                (a.resolutionParsed?.height ?? 0)
        );
    }

    private assertAudioGroups(master: HlsParsedMaster): void {
        if (!master.media.some((m) => m.type === 'AUDIO' && m.uri)) {
            throw new BadRequestException(
                'This video carries its sound inside its picture: a new angle would have no sound'
            );
        }
    }

    /** Each size of the main angle, and how the video is laid out and protected. */
    private async readExistingVideo(
        s3: S3ConfigDto,
        folder: string,
        masterText: string,
        key: Buffer | undefined
    ): Promise<ExistingVideo> {
        const master = parseMasterPlaylist(masterText);
        this.assertAudioGroups(master);
        const references = this.referenceVariants(master);

        let shared: Omit<ExistingVideo, 'renditions' | 'audioBps'> | undefined;
        const renditions: ExistingRendition[] = [];
        for (const variant of references) {
            const playlistKey = posix.join(folder, variant.uri);
            const { body } = await this.s3EtagService.getObjectWithEtag(
                s3,
                playlistKey
            );
            const playlist = parseMediaPlaylist(readMaybeEncrypted(body, key));
            if (!playlist.maps[0] || playlist.segments.length === 0) {
                throw new BadRequestException(
                    "This video's picture is not in fMP4 segments, which adding an angle needs"
                );
            }
            const durationSec = sumDurations(playlist);
            renditions.push({
                referenceUri: variant.uri,
                width: even(variant.resolutionParsed!.width),
                height: even(variant.resolutionParsed!.height),
                videoBitrateKbps: estimateVideoBitrateKbps(
                    await this.mediaBytes(
                        s3,
                        posix.dirname(playlistKey),
                        playlist
                    ),
                    durationSec
                ),
                ...(variant.frameRate ? { frameRate: variant.frameRate } : {}),
                ...(variant.codecs ? { codecs: variant.codecs } : {}),
                ...(variant.audioGroup
                    ? { audioGroup: variant.audioGroup }
                    : {}),
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
                'This video is encrypted: its key is needed to add an angle to it'
            );
        }

        const audioBps = new Map<string, number>();
        for (const groupId of new Set(
            renditions.map((r) => r.audioGroup).filter((g): g is string => !!g)
        )) {
            const rendition =
                master.media.find(
                    (m) =>
                        m.type === 'AUDIO' &&
                        m.groupId === groupId &&
                        m.uri &&
                        m.default
                ) ??
                master.media.find(
                    (m) => m.type === 'AUDIO' && m.groupId === groupId && m.uri
                );
            if (!rendition) continue;
            const playlistKey = posix.join(folder, rendition.uri!);
            const { body } = await this.s3EtagService.getObjectWithEtag(
                s3,
                playlistKey
            );
            const playlist = parseMediaPlaylist(readMaybeEncrypted(body, key));
            const seconds = sumDurations(playlist);
            const bytes = await this.mediaBytes(
                s3,
                posix.dirname(playlistKey),
                playlist
            );
            audioBps.set(
                groupId,
                seconds > 0 ? Math.round((bytes * 8) / seconds) : 128_000
            );
        }
        return { ...shared!, renditions, audioBps };
    }

    /** A rendition's media bytes: its ranges' lengths, or a sample of its segment files scaled up. */
    private async mediaBytes(
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
        return sampled > 0
            ? (sizes.reduce((a, b) => a + b, 0) / sampled) *
                  sumDurations(playlist)
            : 0;
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

    /**
     * A source's video streams, and what the encode reads. An HLS master link
     * is read from its largest variant; anything else is read as it is.
     */
    private async resolveSource(
        source: string
    ): Promise<VideoSource & { input: string }> {
        let input = source;
        if (isHlsLink(source)) {
            let body: Buffer;
            try {
                const res = await fetch(source, {
                    signal: AbortSignal.timeout(20_000),
                });
                if (!res.ok) throw new Error(`it answered ${res.status}`);
                body = Buffer.from(await res.arrayBuffer());
            } catch (err) {
                throw new BadRequestException(
                    `The link could not be read: ${(err as Error).message}`
                );
            }
            if (isLmcencPayload(body)) {
                throw new BadRequestException(
                    'This link is a video encrypted by Luminary Media Convert. Adding an angle from one ' +
                        'needs its key, which is not supported yet: use a file, or an unencrypted link.'
                );
            }
            const text = body.toString('utf-8');
            if (text.includes('#EXT-X-STREAM-INF')) {
                const largest = [...parseMasterPlaylist(text).variants].sort(
                    (a, b) =>
                        (b.resolutionParsed?.height ?? 0) -
                            (a.resolutionParsed?.height ?? 0) ||
                        b.bandwidth - a.bandwidth
                )[0];
                if (!largest)
                    throw new BadRequestException('This link lists no streams');
                input = new URL(largest.uri, source).href;
            }
        }
        const probe = await this.probeVideo(input);
        if (probe.videoTracks.length === 0) {
            throw new BadRequestException(
                isLink(source)
                    ? 'This link has no picture'
                    : 'This file has no picture'
            );
        }
        return { ...probe, input };
    }

    /** A source's video streams and length from its header alone; cover art is left out. */
    private async probeVideo(input: string): Promise<VideoSource> {
        let out: string;
        try {
            out = await runProcess(ffprobeBin(), [
                '-v',
                'error',
                ...(isLink(input) ? ['-rw_timeout', '20000000'] : []),
                '-select_streams',
                'v',
                '-show_entries',
                'stream=codec_name,width,height,avg_frame_rate,r_frame_rate:stream_disposition=attached_pic:stream_tags=title:format=duration',
                '-of',
                'json',
                input,
            ]);
        } catch {
            throw new BadRequestException(
                isLink(input)
                    ? 'The link could not be read as a video'
                    : 'The file could not be read as a video'
            );
        }
        const data = JSON.parse(out) as {
            format?: { duration?: string };
            streams?: {
                codec_name?: string;
                width?: number;
                height?: number;
                avg_frame_rate?: string;
                r_frame_rate?: string;
                disposition?: { attached_pic?: number };
                tags?: { title?: string };
            }[];
        };
        const tracks: SourceVideoTrack[] = [];
        (data.streams ?? []).forEach((st, index) => {
            if (st.disposition?.attached_pic) return;
            const frameRate = rate(st.avg_frame_rate) ?? rate(st.r_frame_rate);
            tracks.push({
                index,
                ...(st.codec_name ? { codec: st.codec_name } : {}),
                ...(st.width ? { width: st.width } : {}),
                ...(st.height ? { height: st.height } : {}),
                ...(frameRate ? { frameRate } : {}),
                ...(st.tags?.title ? { name: st.tags.title } : {}),
            });
        });
        return {
            durationSec: Number(data.format?.duration) || 0,
            videoTracks: tracks,
        };
    }
}

function sumDurations(playlist: HlsParsedMediaPlaylist): number {
    return playlist.segments.reduce((sum, seg) => sum + seg.duration, 0);
}

/** H.264 in 4:2:0 needs even sides. */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** `30000/1001` as a number; undefined for FFmpeg's `0/0`. */
function rate(text: string | undefined): number | undefined {
    if (!text) return undefined;
    const [num, den] = text.split('/').map(Number);
    const value = den ? num / den : num;
    return Number.isFinite(value) && value > 0 && value < 1000
        ? Math.round(value * 1000) / 1000
        : undefined;
}
