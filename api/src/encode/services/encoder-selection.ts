/**
 * Which H.264 encoder to use, and the arguments that go with it.
 *
 * Four places used to answer this independently — the ABR ladder, previews,
 * quick-trim bridges, and each of their CPU-fallback paths — every one with its
 * own `if (accelMode === …)` chain over the same four cases. Adding a fifth
 * encoder meant finding all of them, and adding it to three of the four is a
 * silent bug: the ladder would use it and previews would not.
 *
 * Capabilities are described as data here rather than as branches, so a new
 * encoder is a new table entry.
 *
 * What this deliberately does *not* unify is the presets. The ladder scales its
 * preset to rendition height because it is optimising throughput over a whole
 * file; previews use the fastest setting there is because a stale preview is
 * worse than a rough one; bridges are under a second of video and use a fixed
 * middle setting. Those differences are intentional, so `EncodePurpose` keeps
 * them apart rather than averaging them into one number.
 */

/**
 * Which encoder family is in use. Named for the acceleration rather than the
 * encoder because that is what the probe answers and what the UI reports.
 */
export type AccelMode =
    | 'none'
    | 'cpu'
    | 'nvidia'
    | 'apple'
    | 'intel'
    | 'amd'
    | 'mediafoundation';

/** The ffmpeg encoder each mode selects. */
export type EncoderId =
    | 'h264_nvenc'
    | 'h264_qsv'
    | 'h264_amf'
    | 'h264_mf'
    | 'h264_videotoolbox'
    | 'libx264';

/** What the encode is for. Governs preset choice, not encoder choice. */
export type EncodePurpose = 'ladder' | 'preview' | 'bridge';

export const ENCODER_FOR: Record<Exclude<AccelMode, 'none'>, EncoderId> = {
    nvidia: 'h264_nvenc',
    intel: 'h264_qsv',
    amd: 'h264_amf',
    mediafoundation: 'h264_mf',
    apple: 'h264_videotoolbox',
    cpu: 'libx264',
};

/**
 * The order the Windows chain is tried in, fastest and best first.
 *
 * `h264_mf` is last for a reason beyond speed: it is Microsoft's own encoder,
 * present on every Windows install, so it is the one that answers for a machine
 * with no usable GPU at all. It is a "produces output" tier rather than a
 * "produces good output" one — thin rate control, and reportedly capped near
 * 1080p — but the alternative for those machines is not encoding.
 *
 * macOS has a chain of one. VideoToolbox is a framework rather than a hardware
 * API: on a Mac with no hardware encoder it falls back to Apple's own software
 * encoder behind `-allow_sw`, so the coverage is already total.
 */
export const WINDOWS_CHAIN: AccelMode[] = [
    'nvidia',
    'intel',
    'amd',
    'mediafoundation',
];
export const MACOS_CHAIN: AccelMode[] = ['apple'];

/**
 * Spare NVDEC decode surfaces.
 *
 * Measured on the GTX 1050 with a six-rendition ladder, identical for direct
 * and concat inputs: 0-4 extra exhausts the pool mid-decode, 6-12 works, and
 * 16 or more makes cuvidCreateDecoder refuse to initialise at all
 * (CUDA_ERROR_INVALID_VALUE) because NVDEC caps total surfaces.
 *
 * So this is a fixed budget, not a per-rendition one: the ceiling belongs to
 * the decoder, not the ladder. Scaling it by rendition count reached 20 on a
 * six-rung ladder and broke every encode outright.
 */
export const EXTRA_HW_FRAMES = 8;

/**
 * Refuse to build arguments when there is no encoder to name.
 *
 * `'none'` reaching an argument builder means detection found nothing usable and
 * something asked for an encode anyway. Naming libx264 here — which the switch
 * default would do — produces an ffmpeg command that fails with "Unknown
 * encoder" on the build we ship, several layers from the actual problem.
 */
function assertEncodable(mode: AccelMode): void {
    if (mode === 'none') {
        throw new Error(
            'No usable encoder on this machine: this ffmpeg has no software ' +
                'H.264 encoder and no hardware encoder is available.'
        );
    }
}

/**
 * Audio encoder arguments: FFmpeg's native AAC encoder, Low Complexity profile.
 *
 * The profile is stated rather than left to the default. The native encoder
 * does produce LC today, so this changes no output — but "AAC-LC only" then
 * rests on a default rather than on anything in the command line, and HE-AAC
 * and HE-AACv2 carry patents running years past AAC-LC's. A constraint nothing
 * expresses is a constraint a future change can lift without noticing.
 *
 * `streamIndex` is omitted where one output is being written and given where
 * the ladder writes several from one invocation.
 */
export function aacArgs(streamIndex?: number): string[] {
    const t = streamIndex === undefined ? ':a' : `:a:${streamIndex}`;
    return [`-c${t}`, 'aac', `-profile${t}`, 'aac_low'];
}

/**
 * Flags that go before `-i`, to decode on the same device that will encode.
 *
 * Empty for the CPU path, and empty when nothing is being re-encoded: a
 * stream-copy ladder never decodes, so asking for a hardware decoder would set
 * up a device for no reason.
 */
export function decodeArgs(
    mode: AccelMode,
    purpose: EncodePurpose,
    hasReencode: boolean
): string[] {
    if (!hasReencode) return [];
    switch (mode) {
        case 'nvidia': {
            // Only the ladder needs spare surfaces: it splits one decode across
            // every rendition, and each branch holds frames. A preview or a
            // bridge decodes for a single encoder, so the pool is never drained
            // and asking for extra would take surfaces from nothing.
            const spare =
                purpose === 'ladder'
                    ? ['-extra_hw_frames', String(EXTRA_HW_FRAMES)]
                    : [];
            return [
                ...spare,
                '-hwaccel',
                'cuda',
                '-hwaccel_output_format',
                'cuda',
            ];
        }
        case 'apple':
            return [
                '-hwaccel',
                'videotoolbox',
                '-hwaccel_output_format',
                'videotoolbox_vld',
            ];
        case 'intel':
            return ['-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv'];
        default:
            return [];
    }
}

/**
 * The scaler for this mode, as a filtergraph fragment.
 *
 * Each hardware path has its own filter that keeps the frame in device memory;
 * using plain `scale` with a hardware decoder forces a download and an upload
 * around every frame.
 */
export function scalerExpr(
    mode: AccelMode,
    width: number,
    height: number
): string {
    switch (mode) {
        case 'nvidia':
            return `scale_cuda=${width}:${height}`;
        case 'apple':
            return `scale_vt=w=${width}:h=${height}`;
        case 'intel':
            // vpp_qsv, not scale_qsv: the VPP filter is what current FFmpeg
            // builds carry, and it keeps the frame in QSV memory so no
            // download/upload round trip appears between decode and encode.
            return `vpp_qsv=w=${width}:h=${height}`;
        default:
            return `scale=${width}:${height}`;
    }
}

/** Preset by rendition height, for the ladder's throughput-over-a-file tradeoff. */
export function x264Preset(height: number): string {
    if (height >= 1080) return 'veryfast';
    if (height >= 720) return 'faster';
    if (height >= 480) return 'fast';
    if (height >= 360) return 'medium';
    return 'slow';
}

export function nvencPreset(height: number): string {
    if (height >= 1080) return 'p4';
    if (height >= 720) return 'p5';
    if (height >= 480) return 'p5';
    if (height >= 360) return 'p6';
    return 'p7';
}

/**
 * A quality target on x264's 0-51 CRF scale, derived from the bitrate the
 * rendition was given.
 *
 * NVENC's `-cq` and QSV's `-global_quality` use the same scale, so one mapping
 * serves all three.
 */
export function bitrateToVideoCrf(
    bitrateKbps: number,
    width: number,
    height: number,
    fps: number
): number {
    // Bits per pixel must use the real frame rate: this assumed 30 fps, so a
    // 50 fps source was treated as having 66% more bits per pixel than it
    // does, and the quality target it derived demanded more than the rate cap
    // could pay for — the encoder rode the cap and motion fell apart.
    const bpp = (bitrateKbps * 1000) / (width * height * (fps > 0 ? fps : 30));
    const crf = 23 - Math.log2(bpp / 0.1) * 3;
    return Math.max(16, Math.min(34, Math.round(crf)));
}

/**
 * Encoder and scaler for one preview segment.
 *
 * Presets are the fastest each encoder offers, because a preview is generated
 * while somebody waits for it — the opposite of the ladder's tradeoff.
 *
 * `scaleFilter` is a `w:h` pair. Note VideoToolbox takes only the width and
 * derives the height: it is the one path that scales by aspect rather than to
 * exact dimensions, which is fine for a preview and would not be for a ladder
 * rung that has to match its playlist.
 */
export function previewVideoArgs(
    mode: AccelMode,
    useGpu: boolean,
    scaleFilter?: string
): string[] {
    assertEncodable(mode);
    const scale = (expr: string) => (scaleFilter ? ['-vf', expr] : []);
    if (!useGpu) mode = 'cpu';

    switch (mode) {
        case 'nvidia':
            return [
                '-c:v',
                'h264_nvenc',
                '-preset',
                'p1',
                ...scale(`scale_cuda=${scaleFilter}`),
            ];
        case 'intel': {
            // veryfast for the same reason NVENC gets p1 here.
            const [w, h] = (scaleFilter ?? '').split(':');
            return [
                '-c:v',
                'h264_qsv',
                '-preset',
                'veryfast',
                ...scale(`vpp_qsv=w=${w}:h=${h}`),
            ];
        }
        case 'amd':
            return [
                '-c:v',
                'h264_amf',
                '-usage',
                'transcoding',
                '-quality',
                'speed',
                ...scale(`scale=${scaleFilter}`),
            ];
        case 'mediafoundation':
            return ['-c:v', 'h264_mf', ...scale(`scale=${scaleFilter}`)];
        case 'apple':
            return [
                '-c:v',
                'h264_videotoolbox',
                '-allow_sw',
                '1',
                '-realtime',
                '0',
                '-b:v',
                '1500k',
                ...scale(
                    `scale_vt=w=${(scaleFilter ?? '').split(':')[0]}:h=-2`
                ),
            ];
        default:
            return [
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-crf',
                '28',
                '-tune',
                'zerolatency',
                ...scale(`scale=${scaleFilter}`),
            ];
    }
}

/**
 * Encoder arguments for a quick-trim bridge, split around the caller's own
 * profile/rate/GOP flags so their order is unchanged.
 *
 * A bridge is under a second of video, so the ladder's height-based preset
 * table — which is about throughput over a whole file — does not apply.
 */
export function bridgeVideoArgs(
    mode: AccelMode,
    useGpu: boolean,
    opts: { pixFmt?: string; gopFrames: number }
): { head: string[]; tail: string[] } {
    assertEncodable(mode);
    if (!useGpu) mode = 'cpu';

    switch (mode) {
        case 'nvidia':
            return { head: ['-c:v', 'h264_nvenc', '-preset', 'p4'], tail: [] };
        case 'apple':
            return {
                head: [
                    '-c:v',
                    'h264_videotoolbox',
                    '-allow_sw',
                    '1',
                    '-realtime',
                    '0',
                ],
                tail: [],
            };
        case 'intel':
            return {
                head: ['-c:v', 'h264_qsv', '-preset', 'medium'],
                tail: [],
            };
        case 'amd':
            return {
                head: [
                    '-c:v',
                    'h264_amf',
                    '-usage',
                    'transcoding',
                    '-quality',
                    'balanced',
                ],
                tail: [],
            };
        case 'mediafoundation':
            return { head: ['-c:v', 'h264_mf'], tail: [] };
        default:
            return {
                head: [
                    '-c:v',
                    'libx264',
                    '-preset',
                    'veryfast',
                    // Pinned only here: the hardware encoders take their pixel
                    // format from the frames they are handed, and refuse most
                    // of what could be named.
                    '-pix_fmt',
                    opts.pixFmt ?? 'yuv420p',
                ],
                tail: [
                    '-keyint_min',
                    String(opts.gopFrames),
                    '-sc_threshold',
                    '0',
                ],
            };
    }
}

export interface LadderRendition {
    width: number;
    height: number;
    videoBitrateKbps: number;
    vbr?: boolean;
}

/**
 * Video encoder arguments for one ladder rendition.
 *
 * `streamIndex` is the output's position, which every flag has to carry: a
 * single ffmpeg invocation writes the whole ladder, so `-c:v` alone would
 * apply to all of them.
 */
export function ladderVideoArgs(
    mode: AccelMode,
    r: LadderRendition,
    streamIndex: number,
    fps: number
): string[] {
    assertEncodable(mode);
    const t = `:v:${streamIndex}`;
    const args: string[] = [];
    const cap = Math.round(r.videoBitrateKbps * 1.07);
    const buf = Math.round(r.videoBitrateKbps * 1.5);
    const quality = () =>
        bitrateToVideoCrf(r.videoBitrateKbps, r.width, r.height, fps);

    // Constant bitrate, used by every mode that has no quality-targeted path.
    const cbr = () => [
        `-b${t}`,
        `${r.videoBitrateKbps}k`,
        `-maxrate${t}`,
        `${cap}k`,
        `-bufsize${t}`,
        `${buf}k`,
    ];

    switch (mode) {
        case 'nvidia':
            args.push(
                `-c${t}`,
                'h264_nvenc',
                `-profile${t}`,
                'high',
                `-preset${t}`,
                nvencPreset(r.height),
                `-tune${t}`,
                'hq',
                `-rc${t}`,
                'vbr'
            );
            if (r.vbr) {
                args.push(
                    `-cq${t}`,
                    `${quality()}`,
                    `-b${t}`,
                    '0',
                    `-maxrate${t}`,
                    `${r.videoBitrateKbps}k`,
                    `-bufsize${t}`,
                    `${buf}k`
                );
            } else {
                args.push(...cbr());
            }
            break;

        case 'intel':
            // `-global_quality` with `-look_ahead 0` is QSV's constant-quality
            // mode, the counterpart of NVENC's `-cq`; the scale is the same 0-51
            // range as x264's CRF, so the existing mapping applies unchanged.
            args.push(
                `-c${t}`,
                'h264_qsv',
                `-profile${t}`,
                'high',
                `-preset${t}`,
                'medium'
            );
            if (r.vbr) {
                args.push(
                    `-global_quality${t}`,
                    `${quality()}`,
                    `-look_ahead${t}`,
                    '0',
                    `-maxrate${t}`,
                    `${r.videoBitrateKbps}k`,
                    `-bufsize${t}`,
                    `${buf}k`
                );
            } else {
                args.push(...cbr());
            }
            break;

        // Conservative on purpose: plain rate control, no quality-targeted mode.
        // Neither of these has been run here, and an option an encoder rejects
        // is not a worse picture, it is a failure to open. Quality tuning for
        // them belongs with the measurement work, not with adding them.
        case 'amd':
            args.push(
                `-c${t}`,
                'h264_amf',
                `-usage${t}`,
                'transcoding',
                `-quality${t}`,
                'balanced',
                `-profile${t}`,
                'high'
            );
            args.push(...cbr());
            break;

        case 'mediafoundation':
            // Microsoft's encoder takes almost no options worth setting. Bitrate
            // and nothing else is the whole vocabulary we can rely on.
            args.push(`-c${t}`, 'h264_mf');
            args.push(...cbr());
            break;

        case 'apple':
            args.push(
                `-c${t}`,
                'h264_videotoolbox',
                `-allow_sw${t}`,
                '1',
                `-realtime${t}`,
                '0',
                `-profile${t}`,
                'high'
            );
            args.push(
                `-b${t}`,
                `${r.videoBitrateKbps}k`,
                `-maxrate${t}`,
                `${Math.round(r.videoBitrateKbps * (r.vbr ? 1.5 : 1.07))}k`,
                `-bufsize${t}`,
                `${Math.round(r.videoBitrateKbps * (r.vbr ? 2 : 1.5))}k`
            );
            break;

        default:
            args.push(`-c${t}`, 'libx264', `-preset${t}`, x264Preset(r.height));
            if (r.vbr) {
                args.push(
                    `-crf${t}`,
                    `${quality()}`,
                    `-maxrate${t}`,
                    `${r.videoBitrateKbps}k`,
                    `-bufsize${t}`,
                    `${buf}k`
                );
            } else {
                args.push(...cbr());
            }
            // x264 puts a keyframe wherever it detects a cut, which lands off
            // the `-g` cadence and takes the segment boundary with it — the HLS
            // muxer closes a chunk at the first keyframe past `-hls_time`, so a
            // scene change two seconds early yields a short segment and the
            // chain stops being uniform. NVENC and VideoToolbox do not
            // scene-cut unless asked, so this is the CPU path's problem alone.
            args.push(`-sc_threshold${t}`, '0');
            break;
    }

    return args;
}
