import { BadRequestException, Injectable, Logger, PayloadTooLargeException } from '@nestjs/common';
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
} from '@luminary-media-converter/hls';
import { S3EtagService } from './s3-etag.service.js';
import type { S3ConfigDto } from '../encode/dto/s3-config.dto.js';
import type { HlsReadRequestDto } from './dto/read.dto.js';
import type { HlsMutateRequestDto } from './dto/mutate.dto.js';
import type { HlsDiscoverRequestDto } from './dto/discover.dto.js';
import { applyOperation, type OperationContext } from './operations/index.js';

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

/** Validate a relaxed BCP-47 form: 2–3 char primary subtag, optional region. */
const LANG_PATTERN = /^[a-z]{2,3}(?:-[A-Z]{2})?$/;
const MAX_VTT_BYTES = 1024 * 1024;

@Injectable()
export class HlsEditService {
    private readonly logger = new Logger(HlsEditService.name);

    constructor(private readonly s3EtagService: S3EtagService) {}

    async read(dto: HlsReadRequestDto): Promise<HlsReadResult> {
        const masterPlaylistKey = normalizeS3Key(dto.masterPlaylistKey, dto.s3.bucket);
        const folderPrefix = folderOf(masterPlaylistKey);

        const { body, etag } = await this.s3EtagService.getObjectWithEtag(
            dto.s3,
            masterPlaylistKey,
        );
        const master = parseMasterPlaylist(body.toString('utf-8'));

        return { master, etag, folderPrefix, masterPlaylistKey };
    }

    async mutate(dto: HlsMutateRequestDto): Promise<HlsMutateResult> {
        const masterPlaylistKey = normalizeS3Key(dto.masterPlaylistKey, dto.s3.bucket);

        // Read with an independent round-trip so we can both parse and carry the ETag.
        // Caller supplies `ifMatch` — we do NOT require it to match what we read here,
        // the conditional write enforces the real invariant.
        const { body } = await this.s3EtagService.getObjectWithEtag(dto.s3, masterPlaylistKey);
        const master = parseMasterPlaylist(body.toString('utf-8'));

        const ctx: OperationContext = {
            s3: dto.s3,
            masterKey: masterPlaylistKey,
            master,
            s3EtagService: this.s3EtagService,
            writtenKeys: [],
        };

        for (const op of dto.operations) {
            await applyOperation(op, ctx);
        }

        // Always rewrite master.m3u8 — even on a no-op — so the ETag rotates
        // and the caller can observe plumbing. Conditional on the client's
        // `ifMatch` so stale writes fail with 409.
        const rebuilt = buildMasterPlaylist(master);
        const put = await this.s3EtagService.putObjectIfMatch(
            dto.s3,
            masterPlaylistKey,
            rebuilt,
            dto.ifMatch,
            'application/vnd.apple.mpegurl',
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
                'Either masterPlaylistKey or folderPrefix must be provided',
            );
        }
        const normalized = normalizeS3Key(raw, dto.s3.bucket);

        let folderPrefix: string;
        if (normalized.endsWith('.m3u8')) {
            folderPrefix = folderOf(normalized);
        } else {
            folderPrefix = normalized.endsWith('/') ? normalized : normalized + '/';
        }

        const keys = await this.listObjects(dto.s3, folderPrefix);
        const m3u8Keys = keys.filter((k) => k.endsWith('.m3u8')).sort();
        if (m3u8Keys.length === 0) {
            throw new BadRequestException('No HLS playlist found under the given prefix');
        }

        // Only master playlists — identified by presence of #EXT-X-STREAM-INF
        const playlists: string[] = [];
        for (const key of m3u8Keys) {
            const { body } = await this.s3EtagService.getObjectWithEtag(dto.s3, key);
            if (body.toString('utf-8').includes('#EXT-X-STREAM-INF')) {
                playlists.push(key);
            }
        }
        if (playlists.length === 0) {
            throw new BadRequestException(
                'No HLS master playlist found under the given prefix',
            );
        }

        const primaryIdx = playlists.findIndex(
            (k) => k === 'master.m3u8' || k.endsWith('/master.m3u8'),
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
     * Read the chapter sidecar at `{folderPrefix}chapters/{lang}.vtt`.
     * Returns null when the object does not exist.
     */
    async readChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
    ): Promise<{ vtt: string } | null> {
        if (!LANG_PATTERN.test(lang)) {
            throw new BadRequestException('lang must be a BCP-47 language code');
        }
        const key = chaptersKey(folderPrefix, lang);
        try {
            const { body } = await this.s3EtagService.getObjectWithEtag(s3, key);
            return { vtt: body.toString('utf-8') };
        } catch (err) {
            if (isNoSuchKey(err)) return null;
            throw err;
        }
    }

    /**
     * Write a WebVTT chapter sidecar to `{folderPrefix}chapters/{lang}.vtt`.
     * Validates language code, body size, and `WEBVTT` magic before uploading.
     */
    async writeChapters(
        s3: S3ConfigDto,
        folderPrefix: string,
        lang: string,
        vtt: string,
    ): Promise<void> {
        if (!LANG_PATTERN.test(lang)) {
            throw new BadRequestException('lang must be a BCP-47 language code');
        }
        const trimmedHead = vtt.slice(0, 16).trimStart();
        if (!/^WEBVTT(\b|$)/.test(trimmedHead)) {
            throw new BadRequestException('Body must be a WebVTT document (start with WEBVTT)');
        }
        const byteLength = Buffer.byteLength(vtt, 'utf-8');
        if (byteLength > MAX_VTT_BYTES) {
            throw new PayloadTooLargeException(
                `Chapter VTT body exceeds ${MAX_VTT_BYTES} bytes`,
            );
        }
        const key = chaptersKey(folderPrefix, lang);
        await this.s3EtagService.putObject(s3, key, vtt, 'text/vtt');
    }

    private async listObjects(config: S3ConfigDto, prefix: string): Promise<string[]> {
        const client: S3Client = this.s3EtagService.createClient(config);
        const out: string[] = [];
        let continuationToken: string | undefined;
        do {
            const resp = await client.send(
                new ListObjectsV2Command({
                    Bucket: config.bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken,
                }),
            );
            for (const obj of (resp.Contents ?? []) as S3Object[]) {
                if (obj.Key) out.push(obj.Key);
            }
            continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
        } while (continuationToken);
        return out;
    }
}

function folderOf(key: string): string {
    const lastSlash = key.lastIndexOf('/');
    return lastSlash >= 0 ? key.slice(0, lastSlash + 1) : '';
}

function chaptersKey(folderPrefix: string, lang: string): string {
    const prefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
    return `${prefix}chapters/${lang}.vtt`;
}

function collectChaptersLanguages(keys: string[], folderPrefix: string): string[] {
    const prefix = folderPrefix.endsWith('/') ? folderPrefix : folderPrefix + '/';
    const matcher = new RegExp(
        `^${escapeRegExp(prefix)}chapters/([a-z]{2,3}(?:-[A-Z]{2})?)\\.vtt$`,
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
    const e = err as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    return (
        e.name === 'NoSuchKey' ||
        e.Code === 'NoSuchKey' ||
        e.$metadata?.httpStatusCode === 404
    );
}
