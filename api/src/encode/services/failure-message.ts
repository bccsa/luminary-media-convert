/**
 * What a failed encode tells the person who started it.
 *
 * The errors an encode fails with are written for whoever reads the log: an
 * ffmpeg failure carries the last two thousand characters of its output, an
 * upload failure the object key and the storage client's reply. Shown as they
 * are, a CMS put a wall of file paths and progress lines where an editor
 * needed one sentence. This turns them into that sentence; the original stays
 * in the log, which is where it is useful.
 */

/** What to do next, for every failure: the encode is kept, and can be run again. */
const NEXT_STEP =
    'Open Luminary Media Convert to continue the encode or run it again.';

/** A message this short, on one line, was already written for a person. */
const PLAIN_MAX_LENGTH = 240;

export function failureMessage(technical: string): string {
    const text = technical.trim();

    if (
        /^FFmpeg .*exited with code null/i.test(text) ||
        /\(signal: SIG/i.test(text)
    ) {
        return `The encode stopped before it finished. ${NEXT_STEP}`;
    }
    if (/ENOSPC|no space left on device/i.test(text)) {
        return `The encoder ran out of disk space. Free some space, then ${lowerFirst(NEXT_STEP)}`;
    }
    if (/^FFmpeg .*exited with code/i.test(text)) {
        return `The encoder could not encode this video. ${NEXT_STEP} If it fails again, the source may be damaged or in a format it cannot read.`;
    }
    if (
        /S3 upload failed|drain stalled|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(
            text
        )
    ) {
        return `The connection to storage was lost while uploading. Check the internet connection, then ${lowerFirst(NEXT_STEP)}`;
    }
    if (/Segment encryption failed/i.test(text)) {
        return `The encoder could not encrypt the video. ${NEXT_STEP}`;
    }
    if (!text.includes('\n') && text.length <= PLAIN_MAX_LENGTH) return text;
    return `The encode failed. ${NEXT_STEP} The log file has the details.`;
}

function lowerFirst(sentence: string): string {
    return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}
