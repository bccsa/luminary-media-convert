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
    normalizeS3Key,
    deriveAngleName,
    chaptersEntry,
    listChapterEntries,
    listThumbnailEntries,
    masterRevisionName,
    parseMasterRevision,
    removeSessionData,
    resolveThumbnails,
    thumbnailsDataId,
    upsertSessionData,
    type HlsParsedMaster,
    thumbnailsEntry,
} from '@luminary-media-converter/hls-core';
import { S3EtagService } from './s3-etag.service.js';
import {
    IMMUTABLE_CACHE_CONTROL,
    MasterRevisionService,
} from './master-revision.service.js';
import {
    encryptTextAsset,
    isLmcencPayload,
    keyFromHex,
    readMaybeEncrypted,
} from '../encode/services/lmcenc.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';
import type { HlsReadRequestDto } from './dto/read.dto.js';
import type { HlsDiscoverRequestDto } from './dto/discover.dto.js';
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

export interface HlsDiscoverResult {
    masterPlaylistKey: string;
    folderPrefix: string;
    anglePlaylists?: Array<{ name: string; key: string }>;
    /** BCP-47 language codes with a chapter file: named in the master, or at chapters/<lang>.vtt. */
    chaptersLanguages?: string[];
}

/** What an existing video offers to edit, and the version of its master that was read. */
export interface EncodedMedia {
    tracks: AudioTrack[];
    /** The camera angles; one unnamed angle for a video with a single picture. */
    angles: VideoAngle[];
    /** The subtitles in the master, one language each. */
    subtitles: SubtitleTrack[];
    /** Languages with a chapter file: named in the master, or at chapters/<lang>.vtt beside it. */
    chapterLanguages: string[];
    /** The master's ETag: a save is refused once the master has changed since. */
    etag: string;
    /** The master is LMCENC-wrapped, so whatever is written beside it has to be too. */
    encrypted: boolean;
    /** The scrub thumbnails' VTT beside the master, relative to its folder, when there is one. */
    thumbnailsVtt?: string;
    /** The master revision this was read from — after a save, the one the save wrote. */
    masterKey: string;
}

/**
 * For the one text file an edit still rewrites in place: the legacy
 * `chapters/<lang>.vtt` copy older viewers read. A CDN may otherwise keep
 * serving the copy from before the edit for as long as it likes; `no-cache`
 * lets it keep a copy but check it first. Everything else an edit writes has
 * a name of its own and carries {@link IMMUTABLE_CACHE_CONTROL}.
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

    constructor(
        private readonly s3EtagService: S3EtagService,
        private readonly masterRevisions: MasterRevisionService
    ) {}

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
        // A master's older revisions are history, not angles: only the newest
        // revision of each master counts.
        const m3u8Keys = newestRevisions(
            keys.filter((k) => k.endsWith('.m3u8'))
        ).sort();
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
            (k) => parseMasterRevision(k.slice(folderPrefix.length))?.stem === 'master'
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

        const { body: primary } = await this.s3EtagService.getObjectWithEtag(
            dto.s3,
            playlists[0]
        );
        const chaptersLanguages = chapterLanguagesOf(
            this.decode(primary, dto.keyHex),
            keys,
            folderPrefix
        );
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
        const text = this.decode(body, keyHex);
        const master = parseMasterPlaylist(text);
        const folderPrefix = folderOf(masterKey);
        const keys = await this.listObjects(s3, folderPrefix);
        const angles = listVideoAngles(master);
        // The strip the master names for the first angle — the one the app's
        // timeline shows — else whichever the encode left at a fixed name.
        const named = resolveThumbnails(
            listThumbnailEntries(text),
            angles[0]?.id || undefined
        );
        const thumbnailsVtt = named?.uri
            ? resolveKey(masterKey, named.uri).slice(folderPrefix.length)
            : THUMBNAIL_VTTS.find((name) => keys.includes(folderPrefix + name));
        return {
            masterKey,
            tracks: listAudioTracks(master),
            angles,
            subtitles: listSubtitleTracks(master),
            chapterLanguages: chapterLanguagesOf(text, keys, folderPrefix),
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
     * stay in storage. The edit is a new master revision, encrypted exactly
     * when the master was read encrypted, and written only from the version
     * `ifMatch` names, so an edit never builds on one it has not seen.
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
        const next = await this.writeEditedMaster(
            s3,
            masterKey,
            rewritten,
            encrypted ? keyHex : undefined
        );
        return this.readEncodedMedia(s3, next, keyHex);
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
     * before it, and a new master revision names them, written only from the
     * version `ifMatch` names, encrypted when it was read encrypted. The files
     * a save replaces stay: the revision before still names them, and a viewer
     * whose CMS document has not caught up still plays it.
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
            key ? OCTET_STREAM : VTT_CONTENT_TYPE,
            { cacheControl: IMMUTABLE_CACHE_CONTROL }
        );
        await this.s3EtagService.putObject(
            s3,
            playlistKey,
            this.encode(subtitlePlaylist(names.vtt, duration), key),
            key ? OCTET_STREAM : M3U8_CONTENT_TYPE,
            { cacheControl: IMMUTABLE_CACHE_CONTROL }
        );
        const next = await this.writeEditedMaster(s3, masterKey, rewritten, key);
        return this.readEncodedMedia(s3, next, keyHex);
    }

    /**
     * Takes a language's subtitles out of the master, as {@link saveSubtitles}
     * writes it. Its files stay: the revision before still names them.
     */
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
        const { text } = removeSubtitleLines(this.decode(body, keyHex), language);
        const next = await this.writeEditedMaster(
            s3,
            masterKey,
            text,
            encrypted ? keyHex : undefined
        );
        return this.readEncodedMedia(s3, next, keyHex);
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

    /**
     * The master as edited, as the revision after `masterKey`, encrypted when
     * `keyHex` is given. Returns the new revision's key. The revision read is
     * never written again, so there is no `.orig` copy: older revisions are
     * the history.
     */
    private async writeEditedMaster(
        s3: S3ConfigDto,
        masterKey: string,
        text: string,
        keyHex?: string
    ): Promise<string> {
        const { masterKey: next } = await this.masterRevisions.writeNext(
            s3,
            masterKey,
            this.encode(text, keyHex),
            keyHex ? OCTET_STREAM : M3U8_CONTENT_TYPE
        );
        return next;
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
     * `removed` ones out of it, as {@link saveAudioTracks} does for tracks: a
     * new master revision, written only from the version `ifMatch` names,
     * encrypted when it was read encrypted. A removed angle's files stay in
     * storage; the master stops naming its thumbnail strip too.
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
        let rewritten = rewriteVideoAngles(
            this.decode(body, keyHex),
            edits,
            removed
        );
        // A rename keeps the GROUP-ID, so only a removed angle's strip goes.
        for (const id of removed) {
            rewritten = removeSessionData(rewritten, thumbnailsDataId(id));
        }
        const next = await this.writeEditedMaster(
            s3,
            masterKey,
            rewritten,
            encrypted ? keyHex : undefined
        );
        return this.readEncodedMedia(s3, next, keyHex);
    }

    /**
     * A language's chapters, as WebVTT text, decrypted. Found, in order:
     *
     * 1. in the file the master at `opts.masterKey` names for the language;
     * 2. in `opts.draftUri`, a file saved during the encode, before any master
     *    existed to name it (relative to `folderPrefix`);
     * 3. at the fixed `chapters/<lang>.vtt`, where videos from before named
     *    chapter files kept them.
     *
     * Null when there are none. A master that is not there yet is no error:
     * it is simply step 1 finding nothing.
     */
    async readChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        keyHex?: string,
        opts: { masterKey?: string; draftUri?: string } = {}
    ): Promise<{ vtt: string } | null> {
        if (!LANG_PATTERN.test(lang)) {
            throw new BadRequestException(
                'lang must be a BCP-47 language code'
            );
        }
        let key: string | undefined;
        if (opts.masterKey) {
            try {
                const { body } = await this.s3EtagService.getObjectWithEtag(
                    s3,
                    opts.masterKey
                );
                const named = listChapterEntries(this.decode(body, keyHex)).find(
                    (e) => e.language === lang
                );
                if (named?.uri) key = resolveKey(opts.masterKey, named.uri);
            } catch (err) {
                if (!isNoSuchKey(err)) throw err;
            }
        }
        key ??= opts.draftUri
            ? `${withSlash(folderPrefix)}${opts.draftUri}`
            : chaptersKey(folderPrefix, lang);
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
     * Writes a language's chapters as a file of their own,
     * `chapters/<lang>_<8hex>.vtt` under `folderPrefix`, and returns its path
     * relative to the folder. Nothing points at it until a master names it —
     * see {@link publishChapters}. The legacy copy older viewers read is a
     * separate write, {@link writeLegacyChapters}, for the caller to make once
     * the save has landed.
     *
     * `keyHex` is the caller stating that this session's text assets are
     * encrypted — the body is wrapped in LMCENC01 with a fresh IV on the way
     * out. Chapter titles left in the clear beside an encrypted playlist would
     * give away exactly what the encryption was for.
     */
    async writeChapterFile(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        vtt: string,
        keyHex?: string
    ): Promise<{ lang: string; uri: string }> {
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
        const uri = `chapters/${lang}_${randomBytes(4).toString('hex')}.vtt`;
        const contentType = keyHex ? OCTET_STREAM : VTT_CONTENT_TYPE;
        await this.s3EtagService.putObject(
            s3,
            `${withSlash(folderPrefix)}${uri}`,
            this.encode(vtt, keyHex),
            contentType,
            { cacheControl: IMMUTABLE_CACHE_CONTROL }
        );
        return { lang, uri };
    }

    /**
     * LEGACY-CHAPTERS: overwrites `chapters/<lang>.vtt`, the one name viewers
     * from before named chapter files can find, with `no-cache` because it is
     * the one file still rewritten in place. Drop this write a month after the
     * Luminary viewer that reads the master's chapter lines has shipped
     * (tracked in #414).
     *
     * Written only once a save has landed, so a save that is refused leaves
     * older viewers on the chapters they had. Best effort: the save itself is
     * done by then, and newer viewers already have it.
     */
    async writeLegacyChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        vtt: string,
        keyHex?: string
    ): Promise<void> {
        try {
            await this.s3EtagService.putObject(
                s3,
                chaptersKey(folderPrefix, lang),
                this.encode(vtt, keyHex),
                keyHex ? OCTET_STREAM : VTT_CONTENT_TYPE,
                { cacheControl: EDITED_CACHE_CONTROL }
            );
        } catch (err) {
            this.logger.warn(
                `The legacy chapters/${lang}.vtt was not updated: ${(err as Error).message}`
            );
        }
    }

    /**
     * Names `files` (language → path relative to the master's folder) in a new
     * revision of the master at `masterKey`. The revision is encrypted when the
     * master was read encrypted. Returns the new revision's key and ETag.
     */
    async publishChapters(
        s3: S3ConfigDto,
        masterKey: string,
        files: Record<string, string>,
        keyHex?: string
    ): Promise<{ masterKey: string; etag: string }> {
        return this.rewriteIndex(
            s3,
            masterKey,
            (text) =>
                Object.entries(files).reduce(
                    (out, [lang, uri]) =>
                        upsertSessionData(out, chaptersEntry(lang, uri)),
                    text
                ),
            keyHex
        );
    }

    /**
     * Names a newly made thumbnail strip (`uri`, relative to the master's
     * folder) in a new revision of the master, as the video's only strip,
     * labelled with the angle it was sampled from when the video has angles.
     *
     * Every strip the master named before goes: there is one strip per video
     * for now, shown on every angle, and leaving an older line in place would
     * keep the old strip on the angles the new one is not labelled for.
     */
    async publishThumbnails(
        s3: S3ConfigDto,
        masterKey: string,
        uri: string,
        angleId: string | undefined,
        keyHex?: string
    ): Promise<{ masterKey: string; etag: string }> {
        return this.rewriteIndex(
            s3,
            masterKey,
            (text) => {
                for (const entry of listThumbnailEntries(text)) {
                    text = removeSessionData(text, entry.dataId);
                }
                return upsertSessionData(text, thumbnailsEntry(uri, angleId));
            },
            keyHex
        );
    }

    /**
     * Writes the master at `masterKey`, its sidecar index rewritten by
     * `rewrite`, as a new revision — encrypted when the master was read
     * encrypted. Returns the new revision's key and ETag.
     */
    private async rewriteIndex(
        s3: S3ConfigDto,
        masterKey: string,
        rewrite: (text: string) => string,
        keyHex?: string
    ): Promise<{ masterKey: string; etag: string }> {
        const { body } = await this.s3EtagService.getObjectWithEtag(
            s3,
            masterKey
        );
        const encrypted = isLmcencPayload(body);
        if (encrypted && !keyHex) {
            throw new BadRequestException(
                'This video is encrypted: its key is needed to edit it'
            );
        }
        const text = rewrite(this.decode(body, keyHex));
        return this.masterRevisions.writeNext(
            s3,
            masterKey,
            this.encode(text, encrypted ? keyHex : undefined),
            encrypted ? OCTET_STREAM : M3U8_CONTENT_TYPE
        );
    }

    /**
     * Removes a chapter file nothing can have fetched: one saved during the
     * encode and replaced before any master named it. Best effort.
     */
    async deleteChapterDraft(
        s3: S3ConfigDto,
        folderPrefix: string,
        uri: string
    ): Promise<void> {
        try {
            await this.s3EtagService.deleteObjects(s3, [
                `${withSlash(folderPrefix)}${uri}`,
            ]);
        } catch (err) {
            this.logger.warn(
                `Left the chapter draft ${uri} behind: ${(err as Error).message}`
            );
        }
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

function withSlash(folderPrefix: string): string {
    return !folderPrefix || folderPrefix.endsWith('/')
        ? folderPrefix
        : folderPrefix + '/';
}

/** Languages with chapters: named in the master's text, or at the legacy chapters/<lang>.vtt. */
function chapterLanguagesOf(
    masterText: string,
    keys: string[],
    folderPrefix: string
): string[] {
    const langs = new Set(collectChaptersLanguages(keys, folderPrefix));
    for (const entry of listChapterEntries(masterText)) {
        if (entry.language) langs.add(entry.language);
    }
    return Array.from(langs).sort();
}

/**
 * Of a folder's playlists, each master's newest revision only, with every
 * other playlist kept as it is. A media playlist (`stream_0/playlist.m3u8`)
 * parses as a revision 0 of its own, so it survives.
 */
function newestRevisions(keys: string[]): string[] {
    const newest = new Map<string, { key: string; n: number }>();
    for (const key of keys) {
        const lastSlash = key.lastIndexOf('/');
        const folder = key.slice(0, lastSlash + 1);
        const name = key.slice(lastSlash + 1);
        const revision = parseMasterRevision(name);
        if (!revision || name !== masterRevisionName(revision.stem, revision.n)) {
            newest.set(key, { key, n: 0 });
            continue;
        }
        const video = folder + revision.stem;
        const seen = newest.get(video);
        if (!seen || revision.n > seen.n) newest.set(video, { key, n: revision.n });
    }
    return [...newest.values()].map((v) => v.key);
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
