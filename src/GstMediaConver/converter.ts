// Generic GStreamer file converter using node-gtk and ts-for-gir types
// - Input: source (path), destination (path), bitrate (kbps), format (container/codec label)
// - Output: resolves when file is written and EOS is reached; rejects on error

import * as gi from 'node-gtk';
import type Gst from '@girs/gst-1.0';
import type GLib from '@girs/glib-2.0';
import { isAbsolute, resolve } from 'path';
import { pathToFileURL } from 'url';

const GstRT: typeof Gst = gi.require('Gst', '1.0');
const GLibRT: typeof GLib = gi.require('GLib', '2.0');

gi.startLoop();

export type OutputFormat =
    | 'mp4'
    | 'mov'
    | 'avi'
    | 'mkv'
    | 'flv'
    | 'wmv'
    | 'webm'
    | 'mp3'
    | 'wav'
    | 'aac'
    | 'ogg'
    | 'opus'
    | 'flac';

export interface ConvertOptions {
    source: string;
    destination: string;
    bitrateKbps?: number;
    format: OutputFormat;
}

function kbpsToBitsPerSec(kbps?: number): number | undefined {
    if (!kbps || kbps <= 0) return undefined;
    return Math.floor(kbps * 1000);
}

function ensureUri(input: string): string {
    // If it already looks like a URI (has a scheme), return as-is
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return input;
    // Otherwise treat as filesystem path and convert to file:// URI
    const abs = isAbsolute(input) ? input : resolve(input);
    return pathToFileURL(abs).href;
}

function buildPipelineLaunch({
    source,
    destination,
    bitrateKbps,
    format,
}: ConvertOptions): string {
    const abps = kbpsToBitsPerSec(bitrateKbps);
    const sourceUri = ensureUri(source);

    switch (format) {
        case 'mp4': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! x264enc speed-preset=veryfast tune=zerolatency key-int-max=60${vBit} ! h264parse ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! avenc_aac${aBit} ! aacparse ! queue ! mux. ` +
                `mp4mux name=mux faststart=true ! filesink location="${destination}"`
            );
        }
        case 'mov': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! x264enc speed-preset=veryfast tune=zerolatency key-int-max=60${vBit} ! h264parse ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! avenc_aac${aBit} ! aacparse ! queue ! mux. ` +
                `qtmux name=mux ! filesink location="${destination}"`
            );
        }
        case 'avi': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! avenc_mpeg4${vBit} ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! lamemp3enc${aBit} ! queue ! mux. ` +
                `avimux name=mux ! filesink location="${destination}"`
            );
        }
        case 'flv': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! x264enc speed-preset=veryfast tune=zerolatency key-int-max=60${vBit} ! h264parse ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! avenc_aac${aBit} ! aacparse ! queue ! mux. ` +
                `flvmux name=mux streamable=true ! filesink location="${destination}"`
            );
        }
        case 'wmv': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! avenc_wmv2${vBit} ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! avenc_wmav2${aBit} ! queue ! mux. ` +
                `asfmux name=mux ! filesink location="${destination}"`
            );
        }
        case 'webm': {
            const vBit = abps ? ` target-bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! vp8enc${vBit} ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! vorbisenc${aBit} ! queue ! mux. ` +
                `webmmux name=mux ! filesink location="${destination}"`
            );
        }
        case 'mkv': {
            const vBit = abps ? ` bitrate=${abps}` : '';
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" name=dec ` +
                `dec. ! queue ! videoconvert ! x264enc speed-preset=veryfast tune=zerolatency key-int-max=60${vBit} ! h264parse ! queue ! mux. ` +
                `dec. ! queue ! audioconvert ! audioresample ! avenc_aac${aBit} ! aacparse ! queue ! mux. ` +
                `matroskamux name=mux ! filesink location="${destination}"`
            );
        }
        case 'mp3': {
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! lamemp3enc${aBit} ! id3v2mux ! filesink location="${destination}"`
            );
        }
        case 'wav': {
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! wavenc ! filesink location="${destination}"`
            );
        }
        case 'aac': {
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! avenc_aac${aBit} ! adtsparse ! filesink location="${destination}"`
            );
        }
        case 'ogg': {
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! vorbisenc${aBit} ! oggmux ! filesink location="${destination}"`
            );
        }
        case 'opus': {
            const aBit = abps ? ` bitrate=${abps}` : '';
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! opusenc${aBit} ! oggmux ! filesink location="${destination}"`
            );
        }
        case 'flac': {
            return (
                `uridecodebin uri="${sourceUri}" ! ` +
                `audioconvert ! audioresample ! flacenc ! filesink location="${destination}"`
            );
        }
        default:
            throw new Error(`Unsupported format: ${format}`);
    }
}

export async function convert(opts: ConvertOptions): Promise<void> {
    GstRT.init(null);

    if (!opts.source || !opts.destination) {
        throw new Error('source and destination are required');
    }

    const pipelineStr = buildPipelineLaunch(opts);

    return new Promise<void>((resolve, reject) => {
        let pipeline: Gst.Pipeline;
        try {
            pipeline = (GstRT as any).parseLaunch(
                pipelineStr
            ) as unknown as Gst.Pipeline;
        } catch (e) {
            const errMsg = `Failed to create pipeline: ${(e as Error).message}`;
            reject(new Error(errMsg));
            return;
        }

        const bus = (pipeline as any).getBus();

        const cleanup = () => {
            try {
                (pipeline as any).setState(GstRT.State.NULL);
            } catch (e) {
                // ignore
            }
        };

        // Use signal-based watching which maps to Node's EventEmitter under node-gtk
        (bus as any).addSignalWatch();
        let finished = false;
        const done = (err?: Error) => {
            if (finished) return;
            finished = true;
            cleanup();
            try {
                (bus as any).removeSignalWatch?.();
                (bus as any).off?.('message', onMessage);
            } catch {
                // ignore cleanup errors
            }
            if (pollTimer) clearInterval(pollTimer);
            if (err) reject(err);
            else resolve();
        };

        const onMessage = (_bus: Gst.Bus, msg: Gst.Message) => {
            if (finished) return;
            if (msg.type === GstRT.MessageType.EOS) {
                done();
            } else if (msg.type === GstRT.MessageType.ERROR) {
                const [err, debug] = (msg as any).parseError();
                done(
                    new Error(
                        `GStreamer error: ${err?.message || 'unknown'}; debug: ${debug}`
                    )
                );
            }
        };
        (bus as any).on('message', onMessage);

        // Polling fallback: in some environments signal emissions may not fire reliably
        const pollTimer = setInterval(() => {
            try {
                while (!finished && (bus as any).havePending?.()) {
                    const msg = (bus as any).pop?.();
                    if (!msg) break;
                    onMessage(bus as any, msg as any);
                }
            } catch {
                // ignore polling errors
            }
        }, 100);

        // Start playback; do not block the Node.js event loop.
        (pipeline as any).setState(GstRT.State.PLAYING);
        // Non-blocking: gi.startLoop() integrates GLib loop with Node's event loop.
    });
}

export async function convertTo(
    source: string,
    destination: string,
    opts?: { bitrateKbps?: number; format?: OutputFormat }
): Promise<void> {
    if (!opts?.format) {
        const ext = destination.split('.').pop()?.toLowerCase();
        if (!ext)
            throw new Error(
                'format not provided and cannot infer from destination'
            );
        return convert({
            source,
            destination,
            bitrateKbps: opts?.bitrateKbps,
            format: ext as OutputFormat,
        });
    }
    return convert({
        source,
        destination,
        bitrateKbps: opts?.bitrateKbps,
        format: opts.format,
    });
}
