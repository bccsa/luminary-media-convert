import { failureMessage } from './failure-message.js';

const ffmpegTail =
    "FFmpeg exited with code null (signal: SIGKILL). stderr tail:\nrk/5e8e5c53/output/stream_144p_256x for writing [hls @ 0x760d127700] Opening\n'/Users/johanbell/Library/…' frame= 3467 fps=432";

describe('failureMessage', () => {
    it('says an encode that was stopped can be continued, without the ffmpeg output', () => {
        const message = failureMessage(ffmpegTail);

        expect(message).toBe(
            'The encode stopped before it finished. Open Luminary Media Convert to continue the encode or run it again.'
        );
        expect(message).not.toMatch(/stderr|hls @|\/Users\//);
    });

    it('says ffmpeg could not encode the video when it gave up by itself', () => {
        expect(
            failureMessage(
                'FFmpeg exited with code 1. stderr tail:\nInvalid data found'
            )
        ).toMatch(/^The encoder could not encode this video\./);
    });

    it('names a lost storage connection', () => {
        expect(
            failureMessage(
                'S3 upload failed for posts/x/media/v0_3.m4s after 3 attempts: socket hang up'
            )
        ).toMatch(/^The connection to storage was lost while uploading\./);
        expect(
            failureMessage(
                'Pipeline drain stalled: no bytes sent to S3 for 300s (active=1)'
            )
        ).toMatch(/connection to storage was lost/);
    });

    it('names a full disk', () => {
        expect(
            failureMessage(
                "ENOSPC: no space left on device, write '/work/x/output/seg'"
            )
        ).toMatch(/^The encoder ran out of disk space\./);
    });

    it('keeps a message that was already written for a person', () => {
        const plain =
            'Not enough disk space on the encoder: this encode needs about 4.2 GB and only 1.1 GB is free. Free space and retry — the uploaded source is kept.';
        expect(failureMessage(plain)).toBe(plain);
    });

    it('never passes on a long or multi-line technical message', () => {
        const message = failureMessage(
            `Something deep failed:\n${'x'.repeat(2000)}`
        );
        expect(message).toBe(
            'The encode failed. Open Luminary Media Convert to continue the encode or run it again. The log file has the details.'
        );
    });
});
