import { Injectable, Logger } from '@nestjs/common';
import { SessionService } from './session.service.js';
import { ProbeService } from './probe.service.js';
import { PreviewService } from './preview.service.js';
import { WaveformService } from './waveform.service.js';
import { ThumbnailService } from './thumbnail.service.js';

/**
 * The post-ingest pipeline, shared by every way a source file arrives.
 *
 * Whatever put the file on disk — a local pick, a URL fetch — everything after
 * that point is identical, so it lives here rather than in whichever ingest
 * path happened to own it first.
 */
@Injectable()
export class IngestService {
    private readonly logger = new Logger(IngestService.name);

    constructor(
        private readonly sessionService: SessionService,
        private readonly probeService: ProbeService,
        private readonly previewService: PreviewService,
        private readonly waveformService: WaveformService,
        private readonly thumbnailService: ThumbnailService
    ) {}

    /**
     * Run the post-ingest pipeline once a source file is in place at destPath:
     * record file path, probe metadata, init preview, and transition the
     * session to 'uploaded'. Clients learn of the transition over SSE or by
     * polling.
     */
    async finalizeUpload(sessionId: string, destPath: string): Promise<void> {
        this.sessionService.setFilePath(sessionId, destPath);

        const probeResult = await this.probeService.probe(destPath);

        // Initialize preview before exposing probe result —
        // clients poll for probeResult and immediately use preview
        // endpoints, so the preview must be ready first.
        this.sessionService.setProbeResult(sessionId, probeResult);
        try {
            await this.previewService.init(sessionId);
        } catch (err) {
            this.logger.warn(
                `Preview init failed for ${sessionId}: ${(err as Error).message}`
            );
        }

        this.sessionService.updateStatus(sessionId, 'uploaded');

        // Prime the waveform cache in the background — by the time the user
        // opens the trim UI, the JSON is already on disk and the HTTP GET
        // serves from cache. Skipped for files with no audio tracks.
        if (probeResult.audioTracks.length > 0) {
            void this.waveformService
                .getOrComputeCached(sessionId, { inputPath: destPath })
                .catch((err) => {
                    this.logger.warn(
                        `Background waveform prime failed for ${sessionId}: ${(err as Error).message}`
                    );
                });
        }

        // Same for the storyboard: the trim timeline wants frames as soon as it
        // opens, and generating them takes an ffmpeg pass over the whole file.
        const video = probeResult.videoTracks[0];
        const duration = probeResult.format?.duration ?? 0;
        if (video?.width && video?.height && duration > 0) {
            void this.thumbnailService
                .getOrGeneratePreview(sessionId, {
                    inputPath: destPath,
                    duration,
                    sourceWidth: video.width,
                    sourceHeight: video.height,
                })
                .catch((err) => {
                    this.logger.warn(
                        `Background storyboard prime failed for ${sessionId}: ${(err as Error).message}`
                    );
                });
        }

        this.logger.log(
            `Ingest complete for session ${sessionId}: ` +
                `${probeResult.videoTracks.length} video, ` +
                `${probeResult.audioTracks.length} audio track(s)`
        );
    }
}
