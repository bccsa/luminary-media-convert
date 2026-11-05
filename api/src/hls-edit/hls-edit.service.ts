import { randomBytes } from 'node:crypto';
import {
    BadRequestException,
    ConflictException,
    Injectable,
    Logger,
    PayloadTooLargeException,
} from '@nestjs/common';
import {
    S3Client,
    ListObjectsV2Command,
    type _Object as S3Object,
} from '@aws-sdk/client-s3';
import {
    parseMasterPlaylist,
    buildMasterPlaylist,
    normalizeS3Key,
    deriveAngleName,
    type HlsParsedMaster,
} from '@luminary-media-converter/hls-core';
import { S3EtagService, type PutOptions } from './s3-etag.service.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from '../encode/services/lmcenc.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';
import type { HlsReadRequestDto } from './dto/read.dto.js';
import type { HlsMutateRequestDto } from './dto/mutate.dto.js';
import type { HlsDiscoverRequestDto } from './dto/discover.dto.js';
import { applyOperation, type OperationContext } from './operations/index.js';
import {
    listAudioTracks,
    rewriteAudioTracks,
    type AudioTrack,
    type AudioTrackEdit,
} from './audio-tracks.js';
import {
    MAX_SUBTITLE_VTT_BYTES,
    listSubtitleTracks,
    removeSubtitleLines,
    segmentUriOf,
    subtitleFileNames,
    subtitlePlaylist,
    upsertSubtitleLines,
    type SubtitleTrack,
} from './subtitle-tracks.js';
import {
    listVideoAngles,
    rewriteVideoAngles,
    type VideoAngle,
    type VideoAngleEdit,
} from './video-angles.js';

export interface HlsReadResult {
    master: HlsParsedMaster;
    etag: string;
    folderPrefix: string;
    masterPlaylistKey: string;
}

export interface HlsMutateResult {
    master: HlsParsedMaster;
    etag: string;
    writtenKeys: string[];
}

export interface HlsDiscoverResult {
    masterPlaylistKey: string;
    folderPrefix: string;
    anglePlaylists?: Array<{ name: string; key: string }>;
    /** BCP-47 language codes detected as chapters/<lang>.vtt sidecar files. */
    chaptersLanguages?: string[];
}

/** What an existing video offers to edit, and the version of its master that was read. */
export interface EncodedMedia {
    tracks: AudioTrack[];
    /** The camera angles; one unnamed angle for a video with a single picture. */
    angles: VideoAngle[];
    /** The subtitles in the master, one language each. */
    subtitles: SubtitleTrack[];
    /** Languages with a chapters/<lang>.vtt beside the master. */
    chapterLanguages: string[];
    /** The master's ETag: a save is refused once the master has changed since. */
    etag: string;
    /** The master is LMCENC-wrapped, so whatever is written beside it has to be too. */
    encrypted: boolean;
    /** The scrub thumbnails' VTT beside the master, relative to its folder, when there is one. */
    thumbnailsVtt?: string;
}

/**
 * For the text files an edit rewrites. A CDN may otherwise keep serving the
 * copy from before the edit for as long as it likes, since the encode sets no
 * caching of its own; `no-cache` lets it keep a copy but check it first.
 */
export const EDITED_CACHE_CONTROL = 'no-cache';

/** Validate a relaxed BCP-47 form: 2–3 char primary subtag, optional region. */
const LANG_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const MAX_VTT_BYTES = 1024 * 1024;

const OCTET_STREAM = 'application/octet-stream';
/** Where an encode leaves its scrub thumbnails' VTT, relative to the master's folder. */
const THUMBNAIL_VTTS = ['thumbnails/thumbnails.vtt', 'thumbnails.vtt'];
const M3U8_CONTENT_TYPE = 'application/vnd.apple.mpegurl';
const VTT_CONTENT_TYPE = 'text/vtt';

@Injectable()
export class HlsEditService {
    private readonly logger = new Logger(HlsEditService.name);

    constructor(private readonly s3EtagService: S3EtagService) {}

    async read(dto: HlsReadRequestDto): Promise<HlsReadResult> {
        const masterPlaylistKey = normalizeS3Key(
            dto.masterPlaylistKey,
            dto.s3.bucket
        );
        const folderPrefix = folderOf(masterPlaylistKey);

        const { body, etag } = await this.s3EtagService.getObjectWithEtag(
            dto.s3,
            masterPlaylistKey
        );
        const master = parseMasterPlaylist(this.decode(body, dto.keyHex));

        return { master, etag, folderPrefix, masterPlaylistKey };
    }

    async mutate(dto: HlsMutateRequestDto): Promise<HlsMutateResult> {
        const masterPlaylistKey = normalizeS3Key(
            dto.masterPlaylistKey,
            dto.s3.bucket
        );

        // Read with an independent round-trip so we can both parse and carry the ETag.
        // Caller supplies `ifMatch` — we do NOT require it to match what we read here,
        // the conditional write enforces the real invariant.
        const { body } = await this.s3EtagService.getObjectWithEtag(
            dto.s3,
            masterPlaylistKey
        );
        const master = parseMasterPlaylist(this.decode(body, dto.keyHex));

        const ctx: OperationContext = {
            s3: dto.s3,
            masterKey: masterPlaylistKey,
            master,
            s3EtagService: this.s3EtagService,
            writtenKeys: [],
            keyHex: dto.keyHex,
        };

        for (const op of dto.operations) {
            await applyOperation(op, ctx);
        }

        // Always rewrite master.m3u8 — even on a no-op — so the ETag rotates
        // and the caller can observe plumbing. Conditional on the client's
        // `ifMatch` so stale writes fail with 409.
        //
        // An encrypted session goes back encrypted, with a new IV, and the
        // plaintext only ever exists in this process's memory: writing the
        // rebuilt master in the clear — even for the instant before a second
        // request re-encrypted it — would publish the whole stream layout.
        const rebuilt = buildMasterPlaylist(master);
        const put = await this.s3EtagService.putObjectIfMatch(
            dto.s3,
            masterPlaylistKey,
            this.encode(rebuilt, dto.keyHex),
            dto.ifMatch,
            dto.keyHex ? OCTET_STREAM : M3U8_CONTENT_TYPE
        );
        ctx.writtenKeys.push(masterPlaylistKey);

        return {
            master: parseMasterPlaylist(rebuilt),
            etag: put.etag,
            writtenKeys: ctx.writtenKeys,
        };
    }

    async discover(dto: HlsDiscoverRequestDto): Promise<HlsDiscoverResult> {
        const raw = dto.masterPlaylistKey ?? dto.folderPrefix;
        if (!raw) {
            throw new BadRequestException(
                'Either masterPlaylistKey or folderPrefix must be provided'
            );
        }
        const normalized = normalizeS3Key(raw, dto.s3.bucket);

        let folderPrefix: string;
        if (normalized.endsWith('.m3u8')) {
            folderPrefix = folderOf(normalized);
        } else {
            folderPrefix = normalized.endsWith('/')
                ? normalized
                : normalized + '/';
        }

        const keys = await this.listObjects(dto.s3, folderPrefix);
        const m3u8Keys = keys.filter((k) => k.endsWith('.m3u8')).sort();
        if (m3u8Keys.length === 0) {
            throw new BadRequestException(
                'No HLS playlist found under the given prefix'
            );
        }

        // Only master playlists — identified by presence of #EXT-X-STREAM-INF
        const playlists: string[] = [];
        for (const key of m3u8Keys) {
            const { body } = await this.s3EtagService.getObjectWithEtag(
                dto.s3,
                key
            );
            if (this.decode(body, dto.keyHex).includes('#EXT-X-STREAM-INF')) {
                playlists.push(key);
            }
        }
        if (playlists.length === 0) {
            throw new BadRequestException(
                'No HLS master playlist found under the given prefix'
            );
        }

        const primaryIdx = playlists.findIndex(
            (k) => k === 'master.m3u8' || k.endsWith('/master.m3u8')
        );
        if (primaryIdx > 0) {
            const [primary] = playlists.splice(primaryIdx, 1);
            playlists.unshift(primary);
        }

        const result: HlsDiscoverResult = {
            masterPlaylistKey: playlists[0],
            folderPrefix,
        };
        if (playlists.length > 1) {
            result.anglePlaylists = playlists.map((key, i) => ({
                name: deriveAngleName(key, folderPrefix, i),
                key,
            }));
        }

        const chaptersLanguages = collectChaptersLanguages(keys, folderPrefix);
        if (chaptersLanguages.length > 0) {
            result.chaptersLanguages = chaptersLanguages;
        }
        return result;
    }

    /**
     * An existing video's audio tracks and chapter languages, read from its
     * master at `masterKey`. `keyHex` decrypts a master that is LMCENC-wrapped;
     * a plaintext one reads the same with or without it.
     */
    async readEncodedMedia(
        s3: S3ConfigDto,
        masterKey: string,
        keyHex?: string
    ): Promise<EncodedMedia> {
        const { body, etag } = await this.s3EtagService.getObjectWithEtag(
            s3,
            masterKey
        );
        const master = parseMasterPlaylist(this.decode(body, keyHex));
        const folderPrefix = folderOf(masterKey);
        const keys = await this.listObjects(s3, folderPrefix);
        const thumbnailsVtt = THUMBNAIL_VTTS.find((name) =>
            keys.includes(folderPrefix + name)
        );
        return {
            tracks: listAudioTracks(master),
            angles: listVideoAngles(master),
            subtitles: listSubtitleTracks(master),
            chapterLanguages: collectChaptersLanguages(keys, folderPrefix),
            etag,
            encrypted: isLmcencPayload(body),
            ...(thumbnailsVtt ? { thumbnailsVtt } : {}),
        };
    }

    /**
     * Changes audio tracks' languages and names in an existing video's master,
     * and takes the `removed` ones out of it.
     *
     * Nothing else changes, byte for byte: segments, folders and the key stay
     * as they are, and so does the rest of the master; a removed track's files
     * stay in storage. The master goes back encrypted exactly when it was
     * read encrypted, and only if it is still the version `ifMatch` names, so
     * an edit never lands on top of one it has not seen. The first edit keeps
     * the master as the encode wrote it at `master.m3u8.orig`, to undo by hand.
     */
    async saveAudioTracks(
        s3: S3ConfigDto,
        masterKey: string,
        ifMatch: string,
        edits: AudioTrackEdit[],
        keyHex?: string,
        removed: { language: string; name: string }[] = []
    ): Promise<EncodedMedia> {
        const { body, etag } = await this.s3EtagService.getObjectWithEtag(
            s3,
            masterKey
        );
        if (etag !== ifMatch) {
            throw new ConflictException({
                message: 'The video was changed since it was opened',
                code: 'ETAG_MISMATCH',
                currentEtag: etag,
            });
        }
        const encrypted = isLmcencPayload(body);
        if (encrypted && !keyHex) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to edit it'
            );
        }
        const rewritten = rewriteAudioTracks(
            this.decode(body, keyHex),
            edits,
            removed
        );

        const contentType = encrypted ? OCTET_STREAM : M3U8_CONTENT_TYPE;
        await this.s3EtagService.putObjectIfAbsent(
            s3,
            `${masterKey}.orig`,
            body,
            contentType
        );
        await this.s3EtagService.putObjectIfMatch(
            s3,
            masterKey,
            this.encode(rewritten, encrypted ? keyHex : undefined),
            ifMatch,
            contentType,
            { cacheControl: EDITED_CACHE_CONTROL }
        );
        return this.readEncodedMedia(s3, masterKey, keyHex);
    }

    /** A language's subtitles as WebVTT text, decrypted; a 404-worthy error when the video has none in it. */
    async readSubtitles(
        s3: S3ConfigDto,
        masterKey: string,
        language: string,
        keyHex?: string
    ): Promise<{ language: string; name: string; vtt: string }> {
        const { body } = await this.s3EtagService.getObjectWithEtag(s3, masterKey);
        const track = listSubtitleTracks(
            parseMasterPlaylist(this.decode(body, keyHex))
        ).find((t) => t.language === language);
        if (!track) {
            throw new BadRequestException(`This video has no "${language}" subtitles`);
        }
        const playlistKey = resolveKey(masterKey, track.uri);
        const playlist = this.decode(
            (await this.s3EtagService.getObjectWithEtag(s3, playlistKey)).body,
            keyHex
        );
        const segment = segmentUriOf(playlist);
        if (!segment) {
            throw new BadRequestException(`The "${language}" subtitles list no file`);
        }
        const vtt = this.decode(
            (await this.s3EtagService.getObjectWithEtag(s3, resolveKey(playlistKey, segment))).body,
            keyHex
        );
        return { language: track.language, name: track.name, vtt };
    }

    /**
     * Writes a language's subtitles and points the master at them, adding the
     * language when the video has none in it yet.
     *
     * Every save writes new file names, so no cache hands out the words from
     * before it, and the master moves to them only over the version `ifMatch`
     * names, encrypted when it was read encrypted, the first edit keeping the
     * original at `master.m3u8.orig`. The files a save replaces go once the
     * master no longer names them.
     */
    async saveSubtitles(
        s3: S3ConfigDto,
        masterKey: string,
        ifMatch: string,
        subtitles: { language: string; name: string; vtt: string },
        keyHex?: string
    ): Promise<EncodedMedia> {
        const { body, etag } = await this.s3EtagService.getObjectWithEtag(s3, masterKey);
        this.assertSameVersion(etag, ifMatch);
        const encrypted = isLmcencPayload(body);
        if (encrypted && !keyHex) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to edit it'
            );
        }
        const vtt = subtitles.vtt;
        if (!/^\uFEFF?WEBVTT(\b|$)/.test(vtt.slice(0, 16).trimStart())) {
            throw new BadRequestException('Subtitles must be a WebVTT document (start with WEBVTT)');
        }
        if (Buffer.byteLength(vtt, 'utf-8') > MAX_SUBTITLE_VTT_BYTES) {
            throw new PayloadTooLargeException(
                `Subtitles exceed ${MAX_SUBTITLE_VTT_BYTES} bytes`
            );
        }

        const text = this.decode(body, keyHex);
        const master = parseMasterPlaylist(text);
        const before = listSubtitleTracks(master).find(
            (t) => t.language === subtitles.language
        );
        const names = subtitleFileNames(subtitles.language, randomBytes(4).toString('hex'));
        // Checked before anything is written: a bad language or name leaves storage as it was.
        const rewritten = upsertSubtitleLines(text, {
            language: subtitles.language,
            name: subtitles.name,
            uri: names.playlist,
        });

        const key = encrypted ? keyHex : undefined;
        const playlistKey = resolveKey(masterKey, names.playlist);
        const duration = await this.videoDuration(s3, masterKey, master, keyHex);
        await this.s3EtagService.putObject(
            s3,
            resolveKey(playlistKey, names.vtt),
            this.encode(vtt, key),
            key ? OCTET_STREAM : VTT_CONTENT_TYPE
        );
        await this.s3EtagService.putObject(
            s3,
            playlistKey,
            this.encode(subtitlePlaylist(names.vtt, duration), key),
            key ? OCTET_STREAM : M3U8_CONTENT_TYPE
        );
        await this.writeEditedMaster(s3, masterKey, body, rewritten, ifMatch, key);
        if (before) await this.dropSubtitleFiles(s3, masterKey, before.uri, keyHex);
        return this.readEncodedMedia(s3, masterKey, keyHex);
    }

    /** Takes a language's subtitles out of the master, as {@link saveSubtitles} writes it; then their files. */
    async removeSubtitles(
        s3: S3ConfigDto,
        masterKey: string,
        ifMatch: string,
        language: string,
        keyHex?: string
    ): Promise<EncodedMedia> {
        const { body, etag } = await this.s3EtagService.getObjectWithEtag(s3, masterKey);
        this.assertSameVersion(etag, ifMatch);
        const encrypted = isLmcencPayload(body);
        if (encrypted && !keyHex) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to edit it'
            );
        }
        const { text, uri } = removeSubtitleLines(this.decode(body, keyHex), language);
        await this.writeEditedMaster(s3, masterKey, body, text, ifMatch, encrypted ? keyHex : undefined);
        await this.dropSubtitleFiles(s3, masterKey, uri, keyHex);
        return this.readEncodedMedia(s3, masterKey, keyHex);
    }

    private assertSameVersion(etag: string, ifMatch: string): void {
        if (etag !== ifMatch) {
            throw new ConflictException({
                message: 'The video was changed since it was opened',
                code: 'ETAG_MISMATCH',
                currentEtag: etag,
            });
        }
    }

    /** The master as edited, over the version read; the first edit keeps the original at `.orig`. */
    private async writeEditedMaster(
        s3: S3ConfigDto,
        masterKey: string,
        original: Buffer,
        text: string,
        ifMatch: string,
        keyHex?: string
    ): Promise<void> {
        const contentType = keyHex ? OCTET_STREAM : M3U8_CONTENT_TYPE;
        await this.s3EtagService.putObjectIfAbsent(s3, `${masterKey}.orig`, original, contentType);
        await this.s3EtagService.putObjectIfMatch(
            s3,
            masterKey,
            this.encode(text, keyHex),
            ifMatch,
            contentType,
            { cacheControl: EDITED_CACHE_CONTROL }
        );
    }

    /**
     * A language's files the master no longer names. Only ones under
     * `subtitles/` go: a rendition the encoder did not write is left where it
     * is. Best effort: a file left behind is only space.
     */
    private async dropSubtitleFiles(
        s3: S3ConfigDto,
        masterKey: string,
        playlistUri: string,
        keyHex?: string
    ): Promise<void> {
        if (!playlistUri.startsWith('subtitles/')) return;
        const playlistKey = resolveKey(masterKey, playlistUri);
        try {
            const playlist = this.decode(
                (await this.s3EtagService.getObjectWithEtag(s3, playlistKey)).body,
                keyHex
            );
            const segment = segmentUriOf(playlist);
            await this.s3EtagService.deleteObjects(s3, [
                playlistKey,
                ...(segment ? [resolveKey(playlistKey, segment)] : []),
            ]);
        } catch (err) {
            this.logger.warn(`Left ${playlistKey} behind: ${(err as Error).message}`);
        }
    }

    /** The video's length: its first variant's segments added up. */
    private async videoDuration(
        s3: S3ConfigDto,
        masterKey: string,
        master: HlsParsedMaster,
        keyHex?: string
    ): Promise<number> {
        const variant = master.variants[0];
        if (!variant) throw new BadRequestException('The video lists no variants');
        const playlist = this.decode(
            (await this.s3EtagService.getObjectWithEtag(s3, resolveKey(masterKey, variant.uri))).body,
            keyHex
        );
        let total = 0;
        for (const match of playlist.matchAll(/^#EXTINF:([\d.]+)/gm)) total += Number(match[1]);
        if (!(total > 0)) throw new BadRequestException("The video's length could not be read");
        return total;
    }

    /**
     * Renames camera angles in an existing video's master and takes the
     * `removed` ones out of it, as {@link saveAudioTracks} does for tracks: only
     * over the version `ifMatch` names, encrypted when it was read encrypted,
     * the first edit keeping the original at `master.m3u8.orig`. A removed
     * angle's files stay in storage.
     */
    async saveVideoAngles(
        s3: S3ConfigDto,
        masterKey: string,
        ifMatch: string,
        edits: VideoAngleEdit[],
        keyHex?: string,
        removed: string[] = []
    ): Promise<EncodedMedia> {
        const { body, etag } = await this.s3EtagService.getObjectWithEtag(
            s3,
            masterKey
        );
        if (etag !== ifMatch) {
            throw new ConflictException({
                message: 'The video was changed since it was opened',
                code: 'ETAG_MISMATCH',
                currentEtag: etag,
            });
        }
        const encrypted = isLmcencPayload(body);
        if (encrypted && !keyHex) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to edit it'
            );
        }
        const rewritten = rewriteVideoAngles(
            this.decode(body, keyHex),
            edits,
            removed
        );

        const contentType = encrypted ? OCTET_STREAM : M3U8_CONTENT_TYPE;
        await this.s3EtagService.putObjectIfAbsent(
            s3,
            `${masterKey}.orig`,
            body,
            contentType
        );
        await this.s3EtagService.putObjectIfMatch(
            s3,
            masterKey,
            this.encode(rewritten, encrypted ? keyHex : undefined),
            ifMatch,
            contentType,
            { cacheControl: EDITED_CACHE_CONTROL }
        );
        return this.readEncodedMedia(s3, masterKey, keyHex);
    }

    /**
     * Read the chapter sidecar at `{folderPrefix}chapters/{lang}.vtt`.
     * Returns null when the object does not exist.
     */
    async readChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        keyHex?: string
    ): Promise<{ vtt: string } | null> {
        if (!LANG_PATTERN.test(lang)) {
            throw new BadRequestException(
                'lang must be a BCP-47 language code'
            );
        }
        const key = chaptersKey(folderPrefix, lang);
        try {
            const { body } = await this.s3EtagService.getObjectWithEtag(
                s3,
                key
            );
            return { vtt: this.decode(body, keyHex) };
        } catch (err) {
            if (isNoSuchKey(err)) return null;
            throw err;
        }
    }

    /**
     * Fetch the waveform sidecar at `{folderPrefix}waveform.json`.
     * Returns null when the object does not exist (e.g. imported sessions
     * never had one written) — caller surfaces 404, client skips render.
     */
    async readWaveform(
        s3: S3ConfigDto,
        folderPrefix: string
    ): Promise<{
        version: number;
        sampleRate: number;
        numPeaks: number;
        peaks: number[];
    } | null> {
        const key = waveformKey(folderPrefix);
        try {
            const { body } = await this.s3EtagService.getObjectWithEtag(
                s3,
                key
            );
            const parsed = JSON.parse(body.toString('utf-8'));
            // Trust the sidecar shape — the encode pipeline is the only writer.
            return parsed;
        } catch (err) {
            if (isNoSuchKey(err)) return null;
            throw err;
        }
    }

    /**
     * Write a WebVTT chapter sidecar to `{folderPrefix}chapters/{lang}.vtt`.
     * Validates language code, body size, and `WEBVTT` magic before uploading.
     *
     * `keyHex` is the caller stating that this session's text assets are
     * encrypted — the body is wrapped in LMCENC01 with a fresh IV on the way
     * out. There is nothing in the bucket to mirror on a first write, and
     * chapter titles left in the clear beside an encrypted playlist would give
     * away exactly what the encryption was for.
     */
    async writeChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        vtt: string,
        keyHex?: string,
        options: PutOptions = {}
    ): Promise<void> {
        lang = lang.toLowerCase();
        if (!LANG_PATTERN.test(lang)) {
            throw new BadRequestException(
                'lang must be a BCP-47 language code'
            );
        }
        const trimmedHead = vtt.slice(0, 16).trimStart();
        if (!/^WEBVTT(\b|$)/.test(trimmedHead)) {
            throw new BadRequestException(
                'Body must be a WebVTT document (start with WEBVTT)'
            );
        }
        const byteLength = Buffer.byteLength(vtt, 'utf-8');
        if (byteLength > MAX_VTT_BYTES) {
            throw new PayloadTooLargeException(
                `Chapter VTT body exceeds ${MAX_VTT_BYTES} bytes`
            );
        }
        const key = chaptersKey(folderPrefix, lang);
        await this.s3EtagService.putObject(
            s3,
            key,
            this.encode(vtt, keyHex),
            keyHex ? OCTET_STREAM : VTT_CONTENT_TYPE,
            options
        );
    }

    /**
     * Bytes from S3 as text, decrypting when they carry the LMCENC01 magic.
     *
     * Detection is by content, not by request: a session that was never
     * encrypted reads the same whether or not a key was supplied, and an
     * encrypted object without a key fails loudly rather than being parsed as
     * whatever the ciphertext happens to look like.
     */
    private decode(body: Buffer, keyHex?: string): string {
        try {
            return readMaybeEncrypted(
                body,
                keyHex ? keyFromHex(keyHex) : undefined
            );
        } catch (err) {
            throw new BadRequestException((err as Error).message);
        }
    }

    /** Text on its way to S3, encrypted when the session holds a key. */
    private encode(text: string, keyHex?: string): Buffer | string {
        if (!keyHex) return text;
        return encryptTextAsset(text, keyFromHex(keyHex));
    }

    private async listObjects(
        config: S3ConfigDto,
        prefix: string
    ): Promise<string[]> {
        const client: S3Client = this.s3EtagService.createClient(config);
        const out: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await client.send(
                new ListObjectsV2Command({
                    Bucket: config.bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                })
            );
            for (const obj of (resp.Contents ?? []) as S3Object[]) {
                if (obj.Key) out.push(obj.Key);
            }
            continuationToken = resp.IsTruncated
                ? resp.NextContinuationToken
                : undefined;
        } while (continuationToken);
        return out;
    }
}

/** `uri` as a storage key, relative to the playlist at `fromKey`. */
function resolveKey(fromKey: string, uri: string): string {
    const parts = folderOf(fromKey).split('/').filter(Boolean);
    for (const part of uri.split('/')) {
        if (part === '..') parts.pop();
        else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
}

function folderOf(key: string): string {
    const lastSlash = key.lastIndexOf('/');
    return lastSlash >= 0 ? key.slice(0, lastSlash + 1) : '';
}

function chaptersKey(folderPrefix: string, lang: string): string {
    // An empty prefix means the bucket root, not a folder called "". Appending
    // the separator regardless produced "/chapters/en.vtt" — a key with a
    // leading slash, which S3 stores happily and nothing ever finds again.
    const prefix =
        !folderPrefix || folderPrefix.endsWith('/')
            ? folderPrefix
            : folderPrefix + '/';
    return `${prefix}chapters/${lang}.vtt`;
}

function waveformKey(folderPrefix: string): string {
    const prefix = folderPrefix.endsWith('/')
        ? folderPrefix
        : folderPrefix + '/';
    return `${prefix}waveform.json`;
}

function collectChaptersLanguages(
    keys: string[],
    folderPrefix: string
): string[] {
    const prefix = folderPrefix.endsWith('/')
        ? folderPrefix
        : folderPrefix + '/';
    const matcher = new RegExp(
        `^${escapeRegExp(prefix)}chapters/([a-z]{2,3}(?:-[A-Z]{2})?)\\.vtt$`
    );
    const langs = new Set<string>();
    for (const key of keys) {
        const m = matcher.exec(key);
        if (m) langs.add(m[1]);
    }
    return Array.from(langs).sort();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNoSuchKey(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const e = err as {
        name?: string;
        Code?: string;
        $metadata?: { httpStatusCode?: number };
    };
    return (
        e.name === 'NoSuchKey' ||
        e.Code === 'NoSuchKey' ||
        e.$metadata?.httpStatusCode === 404
    );
}
