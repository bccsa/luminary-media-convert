import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EncodeConfigForm from './EncodeConfigForm.vue';
import { computeLayoutKey } from './layoutStorage';
import type {
    AudioTrackInfo,
    EncodeConfig,
    ProbeResult,
    VideoRendition,
    VideoTrackInfo,
} from './types';

/** 25 fps, 2 s GOP — cadence that fits 6 s segments, so only alignment can object. */
function videoTrack(overrides: Partial<VideoTrackInfo>): VideoTrackInfo {
    return {
        index: 0,
        codec: 'h264',
        width: 1920,
        height: 1080,
        bitrateKbps: 5000,
        frameRate: 25,
        gopFrames: 50,
        gopSeconds: 2,
        gopRegular: true,
        startTime: 0,
        ...overrides,
    };
}

/**
 * The reference source: two camera angles and an audio track that start
 * 0.06 / 0.62 / 0.98 s apart, so a straight copy is refused and a quick cut is
 * not.
 */
function misalignedProbe(): ProbeResult {
    return {
        format: { duration: 120, bitrateKbps: 8000, formatName: 'mov,mp4' },
        videoTracks: [
            videoTrack({ index: 0, startTime: 0.06, name: 'Wide' }),
            videoTrack({
                index: 1,
                startTime: 0.62,
                width: 1280,
                height: 720,
                bitrateKbps: 2500,
                name: 'Close',
            }),
        ],
        audioTracks: [
            {
                index: 0,
                codec: 'aac',
                bitrateKbps: 128,
                channels: 2,
                sampleRate: 48000,
                startTime: 0.98,
            },
        ],
    };
}

/**
 * Aligned streams, so nothing but the keyframe cadence is left to object to —
 * and it objects under both rules, trim or no trim.
 */
function irregularCadenceProbe(): ProbeResult {
    const probe = misalignedProbe();
    probe.videoTracks = probe.videoTracks.map((t) => ({
        ...t,
        startTime: 0,
        gopRegular: false,
    }));
    probe.audioTracks = probe.audioTracks.map((t) => ({ ...t, startTime: 0 }));
    return probe;
}

/** The Copy tick boxes of the video ladder, one per rendition, in row order. */
function copyBoxes(wrapper: ReturnType<typeof mount>) {
    const ladder = wrapper.findAll('table.ecf-lt')[0];
    return ladder
        .findAll('tbody tr.ecf-lt-tr')
        .map((row) => row.findAll('td.ecf-lt-td--opts input.ecf-checkbox')[1]);
}

function copyFlags(wrapper: ReturnType<typeof mount>): boolean[] {
    const config = (
        wrapper.vm as unknown as {
            buildEncodeConfig: () => { videoRenditions?: { copyStream: boolean }[] } | null;
        }
    ).buildEncodeConfig();
    return (config?.videoRenditions ?? []).map((r) => r.copyStream);
}

describe('EncodeConfigForm copy eligibility', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('greys the Copy boxes out on a misaligned source with no trim', () => {
        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: misalignedProbe(), byteRange: false },
        });

        const boxes = copyBoxes(wrapper);
        expect(boxes).toHaveLength(2);
        for (const box of boxes) {
            expect(box.attributes('disabled')).toBeDefined();
        }
        expect(
            boxes[0].element.closest('label')?.getAttribute('title')
        ).toMatch(/out of sync/);
    });

    it('offers them on the same source once something is trimmed', async () => {
        const wrapper = mount(EncodeConfigForm, {
            props: {
                probeResult: misalignedProbe(),
                byteRange: false,
                trimActive: true,
            },
        });

        const boxes = copyBoxes(wrapper);
        for (const box of boxes) {
            expect(box.attributes('disabled')).toBeUndefined();
        }
        expect(
            boxes[0].element.closest('label')?.getAttribute('title')
        ).toBeNull();

        await boxes[0].setValue(true);
        expect(copyFlags(wrapper)[0]).toBe(true);
    });

    it('keeps a bad keyframe cadence blocked whether or not a trim is active', () => {
        for (const trimActive of [false, true]) {
            const wrapper = mount(EncodeConfigForm, {
                props: {
                    probeResult: irregularCadenceProbe(),
                    byteRange: false,
                    trimActive,
                },
            });

            for (const box of copyBoxes(wrapper)) {
                expect(box.attributes('disabled')).toBeDefined();
            }
            expect(
                copyBoxes(wrapper)[0].element.closest('label')?.getAttribute('title')
            ).toMatch(/keyframe structure could not be determined/);
        }
    });

    it('unticks a copy that only the trim allowed when the trim goes away', async () => {
        const wrapper = mount(EncodeConfigForm, {
            props: {
                probeResult: misalignedProbe(),
                byteRange: false,
                trimActive: true,
            },
        });

        const boxes = copyBoxes(wrapper);
        await boxes[0].setValue(true);
        await boxes[1].setValue(true);
        expect(copyFlags(wrapper)).toEqual([true, true]);

        await wrapper.setProps({ trimActive: false });

        expect(copyFlags(wrapper)).toEqual([false, false]);
        for (const box of copyBoxes(wrapper)) {
            expect(box.attributes('disabled')).toBeDefined();
        }
    });
});

/**
 * The user-visible end of the anamorphic fix: what the form actually opens on
 * for a 720x576 PAL broadcast carrying 16:9. Before, it suggested 600x480 and
 * down — every rung a 5:4 squash of a 16:9 picture, and the source's own
 * 1024x576 never offered at all.
 */
describe('EncodeConfigForm non-square pixels', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    function palProbe(overrides: Partial<VideoTrackInfo> = {}): ProbeResult {
        return {
            format: { duration: 120, bitrateKbps: 4000, formatName: 'mxf' },
            videoTracks: [
                videoTrack({
                    index: 0,
                    width: 720,
                    height: 576,
                    displayWidth: 1024,
                    displayHeight: 576,
                    bitrateKbps: 4000,
                    ...overrides,
                }),
            ],
            audioTracks: [
                {
                    index: 0,
                    codec: 'pcm_s16le',
                    bitrateKbps: 1536,
                    channels: 2,
                    sampleRate: 48000,
                    startTime: 0,
                },
            ],
        };
    }

    function renditions(wrapper: ReturnType<typeof mount>): string[] {
        const config = (
            wrapper.vm as unknown as {
                buildEncodeConfig: () => {
                    videoRenditions?: { width: number; height: number }[];
                } | null;
            }
        ).buildEncodeConfig();
        return (config?.videoRenditions ?? []).map(
            (r) => `${r.width}x${r.height}`
        );
    }

    it('opens on a square-pixel ladder at the source display size', () => {
        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: palProbe(), byteRange: false },
        });

        expect(renditions(wrapper)).toEqual([
            '1024x576',
            '854x480',
            '640x360',
            '426x240',
            '256x144',
        ]);
    });

    it('greys the Copy box out with the reason it cannot be squared', () => {
        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: palProbe(), byteRange: false },
        });

        // One box per rung, and every one of them refused: the reason is the
        // source's, so no rendition of it can escape by being smaller.
        const boxes = copyBoxes(wrapper);
        expect(boxes).toHaveLength(5);
        for (const box of boxes) {
            expect(box.attributes('disabled')).toBeDefined();
            expect(box.element.closest('label')?.getAttribute('title')).toMatch(
                /non-square pixels/
            );
        }
        expect(copyFlags(wrapper)).toEqual([
            false,
            false,
            false,
            false,
            false,
        ]);
    });

    it('keeps Copy out of reach under a trim as well', () => {
        // The alignment rule is the one a quick cut relaxes. This one it does
        // not: a lossless cut of an anamorphic source is anamorphic output.
        const wrapper = mount(EncodeConfigForm, {
            props: {
                probeResult: palProbe(),
                byteRange: false,
                trimActive: true,
            },
        });

        expect(copyBoxes(wrapper)[0].attributes('disabled')).toBeDefined();
    });

    it('offers each angle of a multi-angle source at its display size', () => {
        const probe = palProbe();
        probe.videoTracks.push(
            videoTrack({
                index: 1,
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
                bitrateKbps: 4000,
                name: 'Close',
            })
        );

        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: probe, byteRange: false },
        });

        // Multi-angle defaults to copying each angle; anamorphic takes that
        // away, so both open re-encoded at the display size instead.
        expect(renditions(wrapper)).toEqual(['1024x576', '1024x576']);
        expect(copyFlags(wrapper)).toEqual([false, false]);
    });

    it('leaves a square-pixel source exactly as it was', () => {
        const square = palProbe({
            width: 1920,
            height: 1080,
            displayWidth: 1920,
            displayHeight: 1080,
            bitrateKbps: 8000,
        });

        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: square, byteRange: false },
        });

        expect(renditions(wrapper)).toEqual([
            '1920x1080',
            '1280x720',
            '854x480',
            '640x360',
            '426x240',
            '256x144',
        ]);
        expect(copyBoxes(wrapper)[0].attributes('disabled')).toBeUndefined();
    });
});

/**
 * Clearing the last cut takes the quick path away with it, so every Copy the
 * relaxed rule allowed is re-examined under the full one. A rendition that
 * survives that is re-pinned to its source track's *coded* dimensions — which
 * is right, because a copy publishes the source's own bytes, and is only ever
 * reached for a track whose coded and display sizes agree.
 */
describe('EncodeConfigForm copy dimensions when a trim is cleared', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    function alignedSquareProbe(): ProbeResult {
        return {
            format: { duration: 120, bitrateKbps: 8000, formatName: 'mov,mp4' },
            videoTracks: [
                videoTrack({ index: 0, startTime: 0, name: 'Wide' }),
                videoTrack({
                    index: 1,
                    startTime: 0,
                    width: 1280,
                    height: 720,
                    bitrateKbps: 2500,
                    name: 'Close',
                }),
            ],
            audioTracks: [
                {
                    index: 0,
                    codec: 'aac',
                    bitrateKbps: 128,
                    channels: 2,
                    sampleRate: 48000,
                    startTime: 0,
                },
            ],
        };
    }

    function dimensions(wrapper: ReturnType<typeof mount>): string[] {
        const config = (
            wrapper.vm as unknown as {
                buildEncodeConfig: () => {
                    videoRenditions?: { width: number; height: number }[];
                } | null;
            }
        ).buildEncodeConfig();
        return (config?.videoRenditions ?? []).map(
            (r) => `${r.width}x${r.height}`
        );
    }

    it('re-pins a surviving copy to its source track', async () => {
        const wrapper = mount(EncodeConfigForm, {
            props: {
                probeResult: alignedSquareProbe(),
                byteRange: false,
                trimActive: true,
            },
        });

        expect(copyFlags(wrapper)).toEqual([true, true]);

        await wrapper.setProps({ trimActive: false });

        // Streams start together, so the full rule allows these too: both stay
        // ticked and both carry their own track's dimensions.
        expect(copyFlags(wrapper)).toEqual([true, true]);
        expect(dimensions(wrapper)).toEqual(['1920x1080', '1280x720']);
    });

    it('un-ticks a copy the full rule refuses instead of re-pinning it', async () => {
        // The dead end this guard exists for: a misaligned source opens
        // un-ticked (reanalyze applies the full rule whatever the trim state),
        // but under a trim the box is enabled and the user may tick it. Clear
        // the cut and that rendition would sit greyed out and still ticked,
        // with no way back.
        const wrapper = mount(EncodeConfigForm, {
            props: {
                probeResult: misalignedProbe(),
                byteRange: false,
                trimActive: true,
            },
        });

        const box = copyBoxes(wrapper)[0];
        expect(box.attributes('disabled')).toBeUndefined();
        await box.setValue(true);
        expect(copyFlags(wrapper)[0]).toBe(true);

        await wrapper.setProps({ trimActive: false });

        // The alignment rule comes back and takes it away again.
        expect(copyFlags(wrapper)[0]).toBe(false);
        expect(copyBoxes(wrapper)[0].attributes('disabled')).toBeDefined();
    });

    it('never re-pins an anamorphic track, because it never survives', async () => {
        // The guard above the re-pin catches it first, which is what makes the
        // coded dimensions on that line safe to write.
        const probe = alignedSquareProbe();
        probe.videoTracks = [
            videoTrack({
                index: 0,
                startTime: 0,
                width: 720,
                height: 576,
                displayWidth: 1024,
                displayHeight: 576,
                bitrateKbps: 4000,
            }),
        ];

        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: probe, byteRange: false, trimActive: true },
        });
        await wrapper.setProps({ trimActive: false });

        expect(copyFlags(wrapper).some(Boolean)).toBe(false);
        expect(dimensions(wrapper)[0]).toBe('1024x576');
    });
});

describe('EncodeConfigForm dropdowns', () => {
    it('uses the one themed menu for every dropdown, never a native select or datalist', () => {
        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: misalignedProbe(), byteRange: false },
        });

        expect(wrapper.findAll('select')).toHaveLength(0);
        expect(wrapper.findAll('datalist')).toHaveLength(0);
        const labels = wrapper
            .findAll('[data-select-menu]')
            .map((m) => m.attributes('aria-label'));
        expect(labels).toEqual(
            expect.arrayContaining([
                'Source track',
                'Audio group',
                'Channels',
                'Track language',
                'Audio group language',
            ]),
        );
    });

    it('shows a picked channel layout on the trigger', async () => {
        const wrapper = mount(EncodeConfigForm, {
            props: { probeResult: misalignedProbe(), byteRange: false },
            attachTo: document.body,
        });

        const channels = wrapper.find('[data-select-menu][aria-label="Channels"]');
        await channels.trigger('click');
        const mono = Array.from(
            document.body.querySelectorAll<HTMLElement>('[role="option"]'),
        ).find((li) => li.textContent!.trim() === 'Mono')!;
        mono.click();
        await wrapper.vm.$nextTick();

        expect(channels.text()).toBe('Mono');
        wrapper.unmount();
    });
});

// ─── The bitrate ladder: suggestion, dials, content preset ──────────────────
//
// Every expected number below was produced by running code — `suggestLadder`
// and `sourceCapKbps` directly for the suggestions, and the documented dial
// rules (`base * max / suggestedMax`, and the linear remap onto a pinned
// `[min, max]`) for the dials — never worked out by hand.

/** An aligned stereo AAC track, so no alignment rule has anything to say. */
function aacTrack(): AudioTrackInfo {
    return {
        index: 0,
        codec: 'aac',
        bitrateKbps: 128,
        channels: 2,
        sampleRate: 48000,
        startTime: 0,
    };
}

/** A source made of these video tracks, indexed in the order given. */
function probeOf(...tracks: Partial<VideoTrackInfo>[]): ProbeResult {
    return {
        format: { duration: 3600, bitrateKbps: 2000, formatName: 'mov,mp4' },
        videoTracks: tracks.map((t, index) => videoTrack({ index, ...t })),
        audioTracks: [aacTrack()],
    };
}

/**
 * The acceptance case: a Sunday-service recording, 1920×1080 at 24 fps and
 * measured at 1805 kbps — lean enough that the source cap, not the table,
 * prices every rung.
 */
function acceptanceProbe(overrides: Partial<VideoTrackInfo> = {}): ProbeResult {
    return probeOf({
        frameRate: 24,
        gopFrames: 48,
        bitrateKbps: 1805,
        ...overrides,
    });
}

/** 1280×720 at 50 fps, 3698 kbps: the cap binds at the top, the table below. */
function probe720p50(): ProbeResult {
    return probeOf({
        width: 1280,
        height: 720,
        frameRate: 50,
        gopFrames: 100,
        bitrateKbps: 3698,
    });
}

/**
 * 20 Mbps at 30 fps: rich enough that the table prices every rung and the cap
 * never binds, so a content factor shows in both directions.
 */
function richProbe(): ProbeResult {
    return probeOf({ frameRate: 30, gopFrames: 60, bitrateKbps: 20000 });
}

/**
 * The shape of a real multi-camera source that arrives as pre-cut angles: seven
 * video tracks at their own sizes and measured bitrates. `gopRegular: false`
 * makes every one of them ineligible for copy, so each angle is re-encoded.
 */
function sevenAngleProbe(): ProbeResult {
    return probeOf(
        ...[
            { width: 1280, height: 720, bitrateKbps: 3689 },
            { width: 854, height: 480, bitrateKbps: 1636 },
            { width: 854, height: 480, bitrateKbps: 1643 },
            { width: 640, height: 360, bitrateKbps: 796 },
            { width: 426, height: 240, bitrateKbps: 281 },
            { width: 426, height: 240, bitrateKbps: 292 },
            { width: 256, height: 144, bitrateKbps: 150 },
        ].map((t) => ({ ...t, gopRegular: false }))
    );
}

/** The opening ladder of {@link acceptanceProbe}: the source cap at every size. */
const SUGGESTED = [1805, 983, 535, 347, 189, 88];

/** {@link SUGGESTED} with the max dial at 3000 — `base * 3000 / 1805`. */
const AT_3000 = [3000, 1634, 889, 577, 314, 146];

/** The fields `VideoRenditionDto` whitelists; the API 400s on anything else. */
const RENDITION_DTO_KEYS = [
    'width',
    'height',
    'videoBitrateKbps',
    'copyStream',
    'sourceTrackIndex',
    'audioGroupId',
    'label',
    'vbr',
];

/**
 * The fields `EncodeConfigDto` whitelists, plus `audioTrackMetadata` — kept for
 * the saved config and stripped by the host (`SessionView`) before it posts.
 */
const CONFIG_DTO_KEYS = [
    'type',
    'segmentDuration',
    'videoRenditions',
    'audioGroups',
    'videoTrackNames',
    'byteRange',
    'trimSegments',
    'audioTrackMetadata',
];

const PRESET_STORAGE_KEY = 'luminary_content_presets';

type FormWrapper = ReturnType<typeof mount>;

const ladderMounts: FormWrapper[] = [];

/**
 * Attached to the document, because the Content preset is a `SelectMenu` whose
 * panel teleports to `<body>` — picking from it is a real click there.
 */
function mountForm(
    probeResult: ProbeResult,
    props: { trimActive?: boolean } = {}
): FormWrapper {
    const wrapper = mount(EncodeConfigForm, {
        props: { probeResult, byteRange: false, ...props },
        attachTo: document.body,
    });
    ladderMounts.push(wrapper);
    return wrapper;
}

function unmountForm(wrapper: FormWrapper): void {
    ladderMounts.splice(ladderMounts.indexOf(wrapper), 1);
    wrapper.unmount();
}

/** What Start would submit — the ladder as the API will receive it. */
function submitted(wrapper: FormWrapper): EncodeConfig {
    const config = (
        wrapper.vm as unknown as { buildEncodeConfig: () => EncodeConfig | null }
    ).buildEncodeConfig();
    expect(config, 'the form refused to build a config').not.toBeNull();
    return config!;
}

function renditionsOf(wrapper: FormWrapper): VideoRendition[] {
    return submitted(wrapper).videoRenditions ?? [];
}

function kbpsOf(wrapper: FormWrapper): number[] {
    return renditionsOf(wrapper).map((r) => r.videoBitrateKbps);
}

function ladderRows(wrapper: FormWrapper) {
    return wrapper.findAll('table.ecf-lt')[0].findAll('tbody tr.ecf-lt-tr');
}

function warningRows(wrapper: FormWrapper) {
    return wrapper.findAll('table.ecf-lt')[0].findAll('tbody tr.ecf-lt-warning');
}

function rowKbpsField(wrapper: FormWrapper, row: number) {
    return ladderRows(wrapper)[row].find<HTMLInputElement>('input.ecf-input-kbps');
}

const maxField = (w: FormWrapper) => w.find<HTMLInputElement>('#ecf-ladder-max');
const minField = (w: FormWrapper) => w.find<HTMLInputElement>('#ecf-ladder-min');
const factorField = (w: FormWrapper) =>
    w.find<HTMLInputElement>('#ecf-content-factor');
const contentMenu = (w: FormWrapper) =>
    w.find('[data-select-menu][aria-label="Content"]');
const sourceSummary = (w: FormWrapper) =>
    w.find('.ecf-form-row > span.ecf-box-hint');

/** Open a themed menu and click one of its options, as a user would. */
async function pickFromMenu(
    wrapper: FormWrapper,
    trigger: ReturnType<FormWrapper['find']>,
    label: string
): Promise<void> {
    await trigger.trigger('click');
    const option = Array.from(
        document.body.querySelectorAll<HTMLElement>('[role="option"]')
    ).find((li) => li.textContent!.trim() === label);
    expect(option, `no "${label}" in the open menu`).toBeDefined();
    option!.click();
    await wrapper.vm.$nextTick();
}

async function pickContent(wrapper: FormWrapper, label: string): Promise<void> {
    await pickFromMenu(wrapper, contentMenu(wrapper), label);
}

/** Point one rung at another source track through its picker. */
async function pickSourceTrack(
    wrapper: FormWrapper,
    row: number,
    label: string
): Promise<void> {
    await pickFromMenu(
        wrapper,
        ladderRows(wrapper)[row].find(
            '[data-select-menu][aria-label="Source track"]'
        ),
        label
    );
}

async function clickButton(wrapper: FormWrapper, text: string): Promise<void> {
    const button = wrapper.findAll('button').find((b) => b.text() === text);
    expect(button, `no "${text}" button`).toBeDefined();
    await button!.trigger('click');
}

function storedPresets(): Record<string, unknown> {
    return JSON.parse(localStorage.getItem(PRESET_STORAGE_KEY) ?? '{}');
}

describe('EncodeConfigForm bitrate ladder', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        while (ladderMounts.length) ladderMounts.pop()!.unmount();
    });

    describe('opening suggestion', () => {
        it('opens a lean 1080p24 source on its own bitrate, capped at every size', () => {
            const wrapper = mountForm(acceptanceProbe());

            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
            expect(
                renditionsOf(wrapper).map((r) => `${r.width}x${r.height}`)
            ).toEqual([
                '1920x1080',
                '1280x720',
                '854x480',
                '640x360',
                '426x240',
                '256x144',
            ]);
            // What the operator reads is what gets submitted.
            expect(
                ladderRows(wrapper).map(
                    (_, i) => rowKbpsField(wrapper, i).element.value
                )
            ).toEqual(SUGGESTED.map(String));
        });

        it('sets the dials to the suggestion: max at the top rung, min on auto', () => {
            const wrapper = mountForm(acceptanceProbe());

            expect(maxField(wrapper).element.value).toBe('1805');
            // Auto is an empty box showing the value it currently stands for.
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('88');
            expect(contentMenu(wrapper).text()).toBe('Standard');
            expect(factorField(wrapper).exists()).toBe(false);
        });

        it('summarises the single source the dials are judged against', () => {
            const wrapper = mountForm(acceptanceProbe());

            expect(sourceSummary(wrapper).text()).toBe(
                '1920×1080 · 24 fps · 1805 kbps'
            );
        });

        it('says so when the source bitrate is unknown', () => {
            const wrapper = mountForm(acceptanceProbe({ bitrateKbps: 0 }));

            expect(sourceSummary(wrapper).text()).toBe(
                '1920×1080 · 24 fps · bitrate n/a'
            );
        });

        it('summarises an anamorphic source at the size it is shown, not stored', () => {
            const wrapper = mountForm(
                probeOf({
                    width: 720,
                    height: 576,
                    displayWidth: 1024,
                    displayHeight: 576,
                    bitrateKbps: 4000,
                })
            );

            expect(sourceSummary(wrapper).text()).toBe(
                '1024×576 · 25 fps · 4000 kbps'
            );
        });

        it('shows no source summary for a multi-track source', () => {
            const wrapper = mountForm(sevenAngleProbe());

            expect(maxField(wrapper).exists()).toBe(true);
            expect(sourceSummary(wrapper).exists()).toBe(false);
        });
    });

    describe('ladder max dial', () => {
        it('rescales every rung from the suggestion', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await maxField(wrapper).setValue('3000');

            expect(kbpsOf(wrapper)).toEqual(AT_3000);
            expect(maxField(wrapper).element.value).toBe('3000');
            // The auto min follows the max: 88 * 3000 / 1805.
            expect(minField(wrapper).attributes('placeholder')).toBe('146');
        });

        it('does not move a rung while a value is still being typed', async () => {
            const wrapper = mountForm(acceptanceProbe());
            const field = maxField(wrapper);

            // `3` on the way to `3000` is a number too.
            field.element.value = '3';
            await field.trigger('input');
            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
            field.element.value = '3000';
            await field.trigger('input');
            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);

            await field.trigger('change');
            expect(kbpsOf(wrapper)).toEqual(AT_3000);
        });

        it('lands in the same place however it got there', async () => {
            const direct = mountForm(acceptanceProbe());
            await maxField(direct).setValue('3000');

            const detour = mountForm(acceptanceProbe());
            await maxField(detour).setValue('1');
            expect(kbpsOf(detour)).toEqual([1, 1, 1, 1, 1, 1]);
            await maxField(detour).setValue('3000');

            expect(kbpsOf(detour)).toEqual(kbpsOf(direct));
            expect(kbpsOf(detour)).toEqual(AT_3000);

            // And back to the suggestion exactly, with no rounding left behind.
            await maxField(detour).setValue('1805');
            expect(kbpsOf(detour)).toEqual(SUGGESTED);
        });

        it.each(['', '0', '-5'])(
            'puts the last good value back for %j and moves no rung',
            async (bad) => {
                const wrapper = mountForm(acceptanceProbe());
                await maxField(wrapper).setValue('3000');

                await maxField(wrapper).setValue(bad);

                expect(maxField(wrapper).element.value).toBe('3000');
                expect(kbpsOf(wrapper)).toEqual(AT_3000);
            }
        );

        it('leaves a hand-edited rung alone until the next dial move', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await maxField(wrapper).setValue('3000');

            await rowKbpsField(wrapper, 2).setValue('777');
            expect(kbpsOf(wrapper)).toEqual([3000, 1634, 777, 577, 314, 146]);

            // A dial move is a pure function of the suggestion and the dial,
            // so the edit is replaced, not scaled.
            await maxField(wrapper).setValue('2000');
            expect(kbpsOf(wrapper)).toEqual([2000, 1089, 593, 384, 209, 98]);
        });
    });

    describe('ladder min dial', () => {
        it('lifts the bottom rung to a pinned min and the rungs above it progressively less', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await minField(wrapper).setValue('200');

            expect(kbpsOf(wrapper)).toEqual([1805, 1037, 618, 442, 294, 200]);
            expect(minField(wrapper).element.value).toBe('200');
        });

        it('holds its pin while the max moves', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await minField(wrapper).setValue('200');

            await maxField(wrapper).setValue('3000');

            expect(kbpsOf(wrapper)).toEqual([3000, 1660, 929, 622, 365, 200]);
            expect(minField(wrapper).element.value).toBe('200');
        });

        it('goes back to auto when the field is cleared', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await minField(wrapper).setValue('200');

            await minField(wrapper).setValue('');

            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('88');
        });

        it.each(['5000', '0', '-3'])(
            'refuses %j and puts the previous pin back in the field',
            async (bad) => {
                const wrapper = mountForm(acceptanceProbe());
                await minField(wrapper).setValue('200');

                await minField(wrapper).setValue(bad);

                expect(minField(wrapper).element.value).toBe('200');
                expect(kbpsOf(wrapper)).toEqual([
                    1805, 1037, 618, 442, 294, 200,
                ]);
            }
        );

        it('refuses a min above the max while on auto and leaves the field empty', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await minField(wrapper).setValue('5000');

            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('88');
            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
        });

        it('lets a max set below a pinned min win, and returns the min to auto', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await minField(wrapper).setValue('200');

            await maxField(wrapper).setValue('150');

            expect(maxField(wrapper).element.value).toBe('150');
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('7');
            expect(kbpsOf(wrapper)).toEqual([150, 82, 44, 29, 16, 7]);
        });

        it('disappears when fewer than two rungs are left to hold apart', async () => {
            const wrapper = mountForm(acceptanceProbe());

            while (ladderRows(wrapper).length > 2) {
                const last = ladderRows(wrapper).length - 1;
                await ladderRows(wrapper)[last]
                    .find('button.ecf-btn-remove')
                    .trigger('click');
            }
            expect(minField(wrapper).exists()).toBe(true);

            await ladderRows(wrapper)[1]
                .find('button.ecf-btn-remove')
                .trigger('click');

            expect(minField(wrapper).exists()).toBe(false);
            expect(maxField(wrapper).exists()).toBe(true);
        });

        it('treats a flat ladder as having no shape to remap', async () => {
            // Two identical cameras: top and bottom are the same number, so a
            // pin has no span to stretch — the max dial's rule stays in charge.
            const wrapper = mountForm(
                probeOf(
                    { width: 1280, height: 720, bitrateKbps: 2500, gopRegular: false },
                    { width: 1280, height: 720, bitrateKbps: 2500, gopRegular: false }
                )
            );
            expect(minField(wrapper).attributes('placeholder')).toBe('2500');

            await minField(wrapper).setValue('1000');
            expect(kbpsOf(wrapper)).toEqual([2500, 2500]);

            await maxField(wrapper).setValue('3000');
            expect(kbpsOf(wrapper)).toEqual([3000, 3000]);
        });
    });

    describe('back to the suggestion', () => {
        async function moveEverything(wrapper: FormWrapper) {
            await maxField(wrapper).setValue('3000');
            await minField(wrapper).setValue('200');
            await rowKbpsField(wrapper, 2).setValue('777');
            expect(kbpsOf(wrapper)).toEqual([3000, 1660, 777, 622, 365, 200]);
        }

        it('Reset restores the suggestion and clears a pinned min', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await moveEverything(wrapper);

            await clickButton(wrapper, 'Reset to suggested');

            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
            expect(maxField(wrapper).element.value).toBe('1805');
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('88');
        });

        it('Re-analyze Mapping resets both dials with the ladder', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await moveEverything(wrapper);

            await clickButton(wrapper, 'Re-analyze Mapping');

            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
            expect(maxField(wrapper).element.value).toBe('1805');
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('88');
        });
    });

    describe('dial visibility', () => {
        /** Two aligned, square, regular-cadence angles: both open copying. */
        function copyableTwoAngleProbe(): ProbeResult {
            return probeOf(
                { bitrateKbps: 5000 },
                { width: 1280, height: 720, bitrateKbps: 2500 }
            );
        }

        it('hides the dials in audio-only mode and brings them back in video', async () => {
            const wrapper = mountForm(acceptanceProbe());
            expect(maxField(wrapper).exists()).toBe(true);

            await clickButton(wrapper, 'Audio only');
            expect(maxField(wrapper).exists()).toBe(false);
            expect(contentMenu(wrapper).exists()).toBe(false);

            await clickButton(wrapper, 'Video');
            expect(maxField(wrapper).exists()).toBe(true);
            expect(maxField(wrapper).element.value).toBe('1805');
        });

        it('has no dials for a source with no video at all', () => {
            const wrapper = mountForm(probeOf());

            expect(maxField(wrapper).exists()).toBe(false);
            expect(contentMenu(wrapper).exists()).toBe(false);
        });

        it('hides the dials while every rung copies, and shows them once one does not', async () => {
            const wrapper = mountForm(copyableTwoAngleProbe());
            expect(copyFlags(wrapper)).toEqual([true, true]);
            expect(maxField(wrapper).exists()).toBe(false);
            expect(contentMenu(wrapper).exists()).toBe(false);

            await copyBoxes(wrapper)[0].setValue(false);
            expect(maxField(wrapper).exists()).toBe(true);
            expect(contentMenu(wrapper).exists()).toBe(true);
            // One re-encoded rung: nothing for a min to hold apart yet.
            expect(minField(wrapper).exists()).toBe(false);

            await copyBoxes(wrapper)[1].setValue(false);
            expect(minField(wrapper).exists()).toBe(true);
        });

        it('never moves a copied rung, whichever dial is turned', async () => {
            // The copied angle sits between the re-encoded ones, so the dials'
            // ends are both rungs they can move.
            const wrapper = mountForm(
                probeOf(
                    { width: 1280, height: 720, bitrateKbps: 3689, gopRegular: false },
                    { width: 854, height: 480, bitrateKbps: 1636 },
                    { width: 640, height: 360, bitrateKbps: 796, gopRegular: false }
                )
            );
            expect(copyFlags(wrapper)).toEqual([false, true, false]);
            expect(kbpsOf(wrapper)).toEqual([3689, 1636, 796]);

            await maxField(wrapper).setValue('5000');
            expect(kbpsOf(wrapper)).toEqual([5000, 1636, 1079]);

            await minField(wrapper).setValue('1000');
            expect(kbpsOf(wrapper)).toEqual([5000, 1636, 1000]);

            await clickButton(wrapper, 'Reset to suggested');
            expect(kbpsOf(wrapper)).toEqual([3689, 1636, 796]);
        });
    });

    describe('copy transitions', () => {
        /** Two aligned, square, regular-cadence angles: both open copying. */
        function copyableTwoAngleProbe(): ProbeResult {
            return probeOf(
                { bitrateKbps: 5000 },
                { width: 1280, height: 720, bitrateKbps: 2500 }
            );
        }

        /** A copyable 1080p angle beside a 720p one that can only re-encode. */
        function copyBesideReencodeProbe(): ProbeResult {
            return probeOf(
                { bitrateKbps: 5000 },
                { width: 1280, height: 720, bitrateKbps: 2500, gopRegular: false }
            );
        }

        it('anchors the max to the re-encoded rung, not a copied one beside it', async () => {
            const wrapper = mountForm(copyableTwoAngleProbe());

            await copyBoxes(wrapper)[1].setValue(false);

            expect(copyFlags(wrapper)).toEqual([true, false]);
            // The 720p rung's own value — not the 1080p copy's 5000.
            expect(maxField(wrapper).element.value).toBe('2500');
            expect(kbpsOf(wrapper)).toEqual([5000, 2500]);

            await maxField(wrapper).setValue('2500');
            expect(kbpsOf(wrapper)).toEqual([5000, 2500]);

            await maxField(wrapper).setValue('3000');
            expect(kbpsOf(wrapper)).toEqual([5000, 3000]);
        });

        it('prices an angle that stops copying as a re-encode under the preset in force', async () => {
            const wrapper = mountForm(copyBesideReencodeProbe());
            await pickContent(wrapper, 'Low motion');
            expect(kbpsOf(wrapper)).toEqual([5000, 1500]);
            expect(maxField(wrapper).element.value).toBe('1500');

            await copyBoxes(wrapper)[0].setValue(false);

            // 5000 x 0.6, where it used to stay at the copy's 5000.
            expect(kbpsOf(wrapper)).toEqual([3000, 1500]);
            expect(maxField(wrapper).element.value).toBe('3000');
        });

        it('joins an angle that stops copying at the level the dial is already at', async () => {
            const wrapper = mountForm(copyBesideReencodeProbe());
            await maxField(wrapper).setValue('3000');
            expect(kbpsOf(wrapper)).toEqual([5000, 3000]);

            await copyBoxes(wrapper)[0].setValue(false);

            // 5000 at the dial's x1.2, and the rung already set stays where it
            // was; the field reads the new top rung.
            expect(kbpsOf(wrapper)).toEqual([6000, 3000]);
            expect(maxField(wrapper).element.value).toBe('6000');
        });

        it('re-prices a copy dropped because its new source track cannot be copied', async () => {
            const wrapper = mountForm(copyBesideReencodeProbe());
            await pickContent(wrapper, 'Low motion');
            expect(copyFlags(wrapper)).toEqual([true, false]);

            await pickSourceTrack(wrapper, 0, '#1 (1280×720, 2500 kbps)');

            // Now a re-encode of the 720p angle: its Low-motion budget, at its
            // own size. Left at the 1080p angle's frame it was priced for one
            // angle and scaled to another's.
            expect(copyFlags(wrapper)).toEqual([false, false]);
            expect(kbpsOf(wrapper)).toEqual([1500, 1500]);
            expect(
                renditionsOf(wrapper).map((r) => `${r.width}x${r.height}`)
            ).toEqual(['1280x720', '1280x720']);
            expect(maxField(wrapper).element.value).toBe('1500');
        });

        it('re-prices a copy dropped when the trim that allowed it is cleared', async () => {
            const wrapper = mountForm(misalignedProbe(), { trimActive: true });
            await pickContent(wrapper, 'Low motion');
            expect(kbpsOf(wrapper)).toEqual([3000, 1500]);
            await copyBoxes(wrapper)[0].setValue(true);
            expect(kbpsOf(wrapper)).toEqual([5000, 1500]);

            await wrapper.setProps({ trimActive: false });

            expect(copyFlags(wrapper)).toEqual([false, false]);
            expect(kbpsOf(wrapper)).toEqual([3000, 1500]);
            expect(maxField(wrapper).element.value).toBe('3000');
        });

        it('keeps a pinned min when an angle stops copying beneath the max', async () => {
            const wrapper = mountForm(
                probeOf(
                    { width: 1280, height: 720, bitrateKbps: 3689, gopRegular: false },
                    { width: 854, height: 480, bitrateKbps: 1636 },
                    { width: 640, height: 360, bitrateKbps: 796, gopRegular: false }
                )
            );
            await minField(wrapper).setValue('1000');
            expect(kbpsOf(wrapper)).toEqual([3689, 1636, 1000]);

            await copyBoxes(wrapper)[1].setValue(false);

            // Remapped between the pinned ends by its own suggestion.
            expect(kbpsOf(wrapper)).toEqual([3689, 1781, 1000]);
            expect(minField(wrapper).element.value).toBe('1000');
            expect(maxField(wrapper).element.value).toBe('3689');
        });

        it('hands the max to the next re-encoded rung when the top one starts copying', async () => {
            const wrapper = mountForm(copyableTwoAngleProbe());
            await copyBoxes(wrapper)[0].setValue(false);
            await copyBoxes(wrapper)[1].setValue(false);
            await maxField(wrapper).setValue('6000');
            expect(kbpsOf(wrapper)).toEqual([6000, 3000]);

            await copyBoxes(wrapper)[0].setValue(true);

            // The copy mirrors its source; the field reads the rung still
            // re-encoded, at the dial's x1.2.
            expect(kbpsOf(wrapper)).toEqual([5000, 3000]);
            expect(maxField(wrapper).element.value).toBe('3000');
        });

        it('prices a single-track rung that stops copying as the suggested rung at its height', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await pickContent(wrapper, 'Low motion');
            expect(kbpsOf(wrapper)).toEqual([1083, 590, 321, 208, 113, 53]);

            // Ticked, the 480p rung mirrors the 1080p source; un-ticked, it is
            // a 1080p re-encode, priced as the Low-motion 1080p rung. (Read off
            // the field while it copies: a single-track rung carries no source
            // track index, so the form will not build a config around a copy.)
            await copyBoxes(wrapper)[2].setValue(true);
            expect(rowKbpsField(wrapper, 2).element.value).toBe('1805');
            await copyBoxes(wrapper)[2].setValue(false);

            expect(renditionsOf(wrapper)[2]).toMatchObject({
                width: 1920,
                height: 1080,
            });
            expect(kbpsOf(wrapper)).toEqual([1083, 590, 1083, 208, 113, 53]);
        });

        it('falls back to the source budget when no suggested rung has that height', async () => {
            // Above 4K the ladder stops at 4K, so an 8K copy un-ticked has no
            // rung of its own height to be priced from.
            const wrapper = mountForm(
                probeOf({ width: 7680, height: 4320, bitrateKbps: 50000 })
            );

            await copyBoxes(wrapper)[0].setValue(true);
            await copyBoxes(wrapper)[0].setValue(false);

            expect(renditionsOf(wrapper)[0]).toMatchObject({
                width: 7680,
                height: 4320,
                videoBitrateKbps: 50000,
            });
            expect(maxField(wrapper).element.value).toBe('50000');
        });
    });

    describe('content preset', () => {
        const STANDARD_720P50 = [3698, 2014, 1173, 587, 293];
        const LOW_720P50 = [2219, 1208, 704, 352, 176];

        it('re-derives the ladder for Low motion, dials included', async () => {
            const wrapper = mountForm(probe720p50());
            expect(kbpsOf(wrapper)).toEqual(STANDARD_720P50);

            await pickContent(wrapper, 'Low motion');

            expect(contentMenu(wrapper).text()).toBe('Low motion');
            expect(kbpsOf(wrapper)).toEqual(LOW_720P50);
            expect(maxField(wrapper).element.value).toBe('2219');
            expect(minField(wrapper).attributes('placeholder')).toBe('176');
        });

        it('replaces hand edits and a pinned min, as a dial move would', async () => {
            const wrapper = mountForm(probe720p50());
            await rowKbpsField(wrapper, 1).setValue('1500');
            await minField(wrapper).setValue('300');

            await pickContent(wrapper, 'Low motion');

            expect(kbpsOf(wrapper)).toEqual(LOW_720P50);
            expect(minField(wrapper).element.value).toBe('');
            expect(minField(wrapper).attributes('placeholder')).toBe('176');
        });

        it('cannot raise a lean source past what it carries with High motion', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await pickContent(wrapper, 'High motion');

            expect(contentMenu(wrapper).text()).toBe('High motion');
            expect(kbpsOf(wrapper)).toEqual(SUGGESTED);
        });

        it('raises a rich source with High motion', async () => {
            const wrapper = mountForm(richProbe());
            expect(kbpsOf(wrapper)).toEqual([5500, 3000, 1400, 800, 400, 200]);

            await pickContent(wrapper, 'High motion');

            expect(kbpsOf(wrapper)).toEqual([7150, 3900, 1820, 1040, 520, 260]);
        });

        it('reveals a factor field for Custom and applies what is typed there', async () => {
            const wrapper = mountForm(richProbe());
            expect(factorField(wrapper).exists()).toBe(false);

            await pickContent(wrapper, 'Custom…');

            expect(factorField(wrapper).element.value).toBe('0.6');
            expect(kbpsOf(wrapper)).toEqual([3300, 1800, 840, 480, 240, 120]);

            await factorField(wrapper).setValue('0.5');

            expect(kbpsOf(wrapper)).toEqual([2750, 1500, 700, 400, 200, 100]);
            expect(maxField(wrapper).element.value).toBe('2750');
        });

        it.each([
            ['5', 'clamped to 2', [11000, 6000, 2800, 1600, 800, 400]],
            ['0.01', 'clamped to 0.1', [550, 300, 140, 80, 40, 20]],
        ])('prices a custom factor of %s as %s', async (typed, _, expected) => {
            const wrapper = mountForm(richProbe());
            await pickContent(wrapper, 'Custom…');

            await factorField(wrapper).setValue(typed);

            expect(kbpsOf(wrapper)).toEqual(expected);
        });

        // A number field never hands over NaN — the browser empties anything
        // unparseable — so '' is the unparseable case; 0 and -1 are the
        // parseable-but-meaningless ones.
        it.each(['', '0', '-1'])(
            'prices an unusable custom factor %j as the generic ladder',
            async (typed) => {
                const wrapper = mountForm(richProbe());
                await pickContent(wrapper, 'Custom…');
                await factorField(wrapper).setValue('0.5');

                await factorField(wrapper).setValue(typed);

                expect(kbpsOf(wrapper)).toEqual([5500, 3000, 1400, 800, 400, 200]);
            }
        );
    });

    describe('remembered content preset', () => {
        const LOW_720P50 = [2219, 1208, 704, 352, 176];
        const RICH_AT_0_6 = [3300, 1800, 840, 480, 240, 120];

        function storePreset(probe: ProbeResult, entryJson: string): void {
            const key = JSON.stringify(computeLayoutKey(probe, 'video'));
            localStorage.setItem(PRESET_STORAGE_KEY, `{${key}:${entryJson}}`);
        }

        it('writes each choice under the source video layout key', async () => {
            const probe = probe720p50();
            const key = computeLayoutKey(probe, 'video');
            const wrapper = mountForm(probe);

            await pickContent(wrapper, 'Low motion');
            expect(storedPresets()).toEqual({
                [key]: { preset: 'low', customFactor: 0.6 },
            });

            await pickContent(wrapper, 'Custom…');
            await factorField(wrapper).setValue('0.5');
            expect(storedPresets()).toEqual({
                [key]: { preset: 'custom', customFactor: 0.5 },
            });
        });

        it('reopens on the remembered preset with the ladder already derived from it', async () => {
            const probe = probe720p50();
            const first = mountForm(probe);
            await pickContent(first, 'Low motion');
            unmountForm(first);

            const reopened = mountForm(probe);

            expect(contentMenu(reopened).text()).toBe('Low motion');
            expect(kbpsOf(reopened)).toEqual(LOW_720P50);
            expect(maxField(reopened).element.value).toBe('2219');
            expect(minField(reopened).attributes('placeholder')).toBe('176');
            // The dial scales the Low-motion suggestion, not a generic one
            // re-labelled after the fact.
            await maxField(reopened).setValue('4438');
            expect(kbpsOf(reopened)).toEqual([4438, 2416, 1408, 704, 352]);
        });

        it('restores a remembered custom factor', () => {
            const probe = richProbe();
            storePreset(probe, '{"preset":"custom","customFactor":0.5}');

            const wrapper = mountForm(probe);

            expect(contentMenu(wrapper).text()).toBe('Custom…');
            expect(factorField(wrapper).element.value).toBe('0.5');
            expect(kbpsOf(wrapper)).toEqual([2750, 1500, 700, 400, 200, 100]);
        });

        it('keeps the remembered custom factor for when Custom is picked again', async () => {
            const probe = richProbe();
            storePreset(probe, '{"preset":"low","customFactor":0.5}');
            const wrapper = mountForm(probe);
            expect(kbpsOf(wrapper)).toEqual(RICH_AT_0_6);

            await pickContent(wrapper, 'Custom…');

            expect(factorField(wrapper).element.value).toBe('0.5');
            expect(kbpsOf(wrapper)).toEqual([2750, 1500, 700, 400, 200, 100]);
        });

        it('ignores a remembered preset it does not know', () => {
            const probe = richProbe();
            storePreset(probe, '{"preset":"turbo","customFactor":0.5}');

            const wrapper = mountForm(probe);

            expect(contentMenu(wrapper).text()).toBe('Standard');
            expect(factorField(wrapper).exists()).toBe(false);
            expect(kbpsOf(wrapper)).toEqual([5500, 3000, 1400, 800, 400, 200]);
        });

        it.each([
            ['above 2', '5'],
            ['below 0.1', '0.05'],
            ['a string', '"0.5"'],
            // Hand-edited JSON is the only way to store a non-finite number.
            ['not finite', '1e999'],
        ])(
            'keeps Custom but ignores a remembered factor that is %s',
            (_, factorJson) => {
                const probe = richProbe();
                storePreset(
                    probe,
                    `{"preset":"custom","customFactor":${factorJson}}`
                );

                const wrapper = mountForm(probe);

                expect(contentMenu(wrapper).text()).toBe('Custom…');
                expect(factorField(wrapper).element.value).toBe('0.6');
                expect(kbpsOf(wrapper)).toEqual(RICH_AT_0_6);
            }
        );

        it.each([
            ['5', '2', 2, [11000, 6000, 2800, 1600, 800, 400]],
            ['0.01', '0.1', 0.1, [550, 300, 140, 80, 40, 20]],
            ['', '1', 1, [5500, 3000, 1400, 800, 400, 200]],
        ])(
            'shows, stores and reopens a custom %j as the %s actually applied',
            async (typed, shown, stored, ladder) => {
                const probe = richProbe();
                const key = computeLayoutKey(probe, 'video');
                const first = mountForm(probe);
                await pickContent(first, 'Custom…');

                await factorField(first).setValue(typed);

                expect(factorField(first).element.value).toBe(shown);
                expect(kbpsOf(first)).toEqual(ladder);
                expect(storedPresets()).toEqual({
                    [key]: { preset: 'custom', customFactor: stored },
                });

                unmountForm(first);
                const reopened = mountForm(probe);

                expect(contentMenu(reopened).text()).toBe('Custom…');
                expect(factorField(reopened).element.value).toBe(shown);
                expect(kbpsOf(reopened)).toEqual(ladder);
            }
        );

        it('keeps each layout preset to itself', async () => {
            const first = acceptanceProbe();
            const firstForm = mountForm(first);
            await pickContent(firstForm, 'Low motion');
            unmountForm(firstForm);

            const other = mountForm(probe720p50());

            expect(contentMenu(other).text()).toBe('Standard');
            expect(kbpsOf(other)).toEqual([3698, 2014, 1173, 587, 293]);
            expect(Object.keys(storedPresets())).toEqual([
                computeLayoutKey(first, 'video'),
            ]);
        });
    });

    describe('multi-angle budgets', () => {
        const MEASURED = [3689, 1636, 1643, 796, 281, 292, 150];

        it('opens each re-encoded angle at its own measured bitrate', () => {
            const wrapper = mountForm(sevenAngleProbe());

            expect(copyFlags(wrapper)).toEqual(Array(7).fill(false));
            expect(kbpsOf(wrapper)).toEqual(MEASURED);
        });

        it('scales every re-encoded angle down for Low motion', async () => {
            const wrapper = mountForm(sevenAngleProbe());

            await pickContent(wrapper, 'Low motion');

            expect(kbpsOf(wrapper)).toEqual([2213, 982, 986, 478, 169, 175, 90]);
        });

        it('cannot raise an angle past what it carries with High motion', async () => {
            const wrapper = mountForm(sevenAngleProbe());

            await pickContent(wrapper, 'High motion');

            expect(kbpsOf(wrapper)).toEqual(MEASURED);
        });

        it('leaves a copied angle at its measured bitrate under Low motion', async () => {
            const wrapper = mountForm(
                probeOf(
                    { bitrateKbps: 5000 },
                    { width: 1280, height: 720, bitrateKbps: 2500, gopRegular: false },
                    { width: 640, height: 360, bitrateKbps: 800 }
                )
            );
            expect(copyFlags(wrapper)).toEqual([true, false, true]);

            await pickContent(wrapper, 'Low motion');

            expect(kbpsOf(wrapper)).toEqual([5000, 1500, 800]);
        });

        it('opens an angle with no measured bitrate at the table top for its size', async () => {
            // It used to open at 1000 kbps — a 240p budget for a 2160p picture.
            const wrapper = mountForm(
                probeOf(
                    { width: 3840, height: 2160, bitrateKbps: 0, gopRegular: false },
                    { width: 1280, height: 720, bitrateKbps: 2500, gopRegular: false }
                )
            );
            expect(kbpsOf(wrapper)).toEqual([13955, 2500]);

            await pickContent(wrapper, 'Low motion');

            expect(kbpsOf(wrapper)).toEqual([8373, 1500]);
        });
    });

    describe('adding and removing rungs', () => {
        it('prices an added rung from the source 480p rung and names it for its size', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await clickButton(wrapper, '+ Add rendition');

            const added = renditionsOf(wrapper)[6];
            expect(added).toEqual({
                width: 854,
                height: 480,
                videoBitrateKbps: 535,
                copyStream: false,
                audioGroupId: submitted(wrapper).audioGroups![0].id,
                label: '480p',
                vbr: true,
            });
            // Its own suggestion joins the baseline, so the dial prices it
            // exactly like the ladder's own 480p rung.
            await maxField(wrapper).setValue('3000');
            expect(kbpsOf(wrapper)).toEqual([...AT_3000, 889]);
        });

        it('prices an added rung under the content preset in force', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await pickContent(wrapper, 'Low motion');
            expect(kbpsOf(wrapper)).toEqual([1083, 590, 321, 208, 113, 53]);

            await clickButton(wrapper, '+ Add rendition');

            expect(kbpsOf(wrapper)[6]).toBe(321);
        });

        it('offers the smallest rung when the source has no 480p to offer', async () => {
            const wrapper = mountForm(
                probeOf({ width: 640, height: 360, bitrateKbps: 800 })
            );
            expect(kbpsOf(wrapper)).toEqual([698, 349, 174]);

            await clickButton(wrapper, '+ Add rendition');

            expect(renditionsOf(wrapper)[3]).toMatchObject({
                width: 256,
                height: 144,
                videoBitrateKbps: 174,
                label: '144p',
            });
        });

        it('keeps the suggestion aligned with the rungs when a middle one is removed', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await ladderRows(wrapper)[2]
                .find('button.ecf-btn-remove')
                .trigger('click');
            expect(kbpsOf(wrapper)).toEqual([1805, 983, 347, 189, 88]);

            // Each rung below the gap is priced from its own suggestion, not
            // its old neighbour's.
            await maxField(wrapper).setValue('3000');
            expect(kbpsOf(wrapper)).toEqual([3000, 1634, 577, 314, 146]);
        });

        it('shows the new top rung in the max field when the top one is removed', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await ladderRows(wrapper)[0]
                .find('button.ecf-btn-remove')
                .trigger('click');

            expect(kbpsOf(wrapper)).toEqual([983, 535, 347, 189, 88]);
            expect(maxField(wrapper).element.value).toBe('983');
            // An honest field: committing what it shows moves nothing.
            await maxField(wrapper).setValue('983');
            expect(kbpsOf(wrapper)).toEqual([983, 535, 347, 189, 88]);
        });

        it('keeps the dial level when the top rung is removed after it moved', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await maxField(wrapper).setValue('3000');

            await ladderRows(wrapper)[0]
                .find('button.ecf-btn-remove')
                .trigger('click');

            expect(kbpsOf(wrapper)).toEqual([1634, 889, 577, 314, 146]);
            expect(maxField(wrapper).element.value).toBe('1634');
        });

        it('lets a pin go when removing rungs drops the max beneath it', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await minField(wrapper).setValue('900');

            await ladderRows(wrapper)[0]
                .find('button.ecf-btn-remove')
                .trigger('click');
            // 983 still clears the pin.
            expect(minField(wrapper).element.value).toBe('900');

            await ladderRows(wrapper)[0]
                .find('button.ecf-btn-remove')
                .trigger('click');

            expect(maxField(wrapper).element.value).toBe('535');
            expect(minField(wrapper).element.value).toBe('');
        });

        it('prices a rung added after the dial moved at the dial level straight away', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await maxField(wrapper).setValue('3000');

            await clickButton(wrapper, '+ Add rendition');

            expect(kbpsOf(wrapper)).toEqual([...AT_3000, 889]);
            expect(maxField(wrapper).element.value).toBe('3000');
        });

        it('adds a rung to a pinned ladder where its twin already sits', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await minField(wrapper).setValue('200');
            expect(kbpsOf(wrapper)).toEqual([1805, 1037, 618, 442, 294, 200]);

            await clickButton(wrapper, '+ Add rendition');

            expect(kbpsOf(wrapper)).toEqual([
                1805, 1037, 618, 442, 294, 200, 618,
            ]);
            expect(minField(wrapper).element.value).toBe('200');
        });
    });

    describe('over-cap warning', () => {
        it('flags a rung raised above what the source carries at its size', async () => {
            const wrapper = mountForm(acceptanceProbe());
            expect(warningRows(wrapper)).toHaveLength(0);

            await rowKbpsField(wrapper, 1).setValue('1500');

            const warnings = warningRows(wrapper);
            expect(warnings).toHaveLength(1);
            expect(ladderRows(wrapper)[1].element.nextElementSibling).toBe(
                warnings[0].element
            );
            expect(warnings[0].text()).toContain(
                'Above what the source carries at this size (983 kbps)'
            );
            expect(warnings[0].find('td').attributes('colspan')).toBe('6');

            await rowKbpsField(wrapper, 1).setValue('900');
            expect(warningRows(wrapper)).toHaveLength(0);
        });

        it('flags every rung, each with its own cap, when the max is raised past the source', async () => {
            const wrapper = mountForm(acceptanceProbe());

            await maxField(wrapper).setValue('3000');

            expect(
                warningRows(wrapper).map((w) => w.text().match(/\((\d+) kbps\)/)![1])
            ).toEqual(SUGGESTED.map(String));
        });

        it('spans the source-track column on a multi-track ladder', async () => {
            const wrapper = mountForm(sevenAngleProbe());

            await rowKbpsField(wrapper, 0).setValue('5000');

            const warnings = warningRows(wrapper);
            expect(warnings).toHaveLength(1);
            expect(warnings[0].text()).toContain('(3689 kbps)');
            expect(warnings[0].find('td').attributes('colspan')).toBe('7');
        });

        it('never flags a copied rung', async () => {
            const wrapper = mountForm(
                probeOf(
                    { bitrateKbps: 5000 },
                    { width: 1280, height: 720, bitrateKbps: 2500 }
                )
            );
            await copyBoxes(wrapper)[1].setValue(false);
            await rowKbpsField(wrapper, 1).setValue('4000');

            // Only the re-encoded rung; the copied one beside it says nothing.
            expect(warningRows(wrapper)).toHaveLength(1);
            expect(ladderRows(wrapper)[1].element.nextElementSibling).toBe(
                warningRows(wrapper)[0].element
            );
            expect(warningRows(wrapper)[0].text()).toContain('(2500 kbps)');

            await copyBoxes(wrapper)[1].setValue(true);

            expect(warningRows(wrapper)).toHaveLength(0);
            expect(kbpsOf(wrapper)).toEqual([5000, 2500]);
        });

        it('says nothing when the source bitrate is unknown', async () => {
            const wrapper = mountForm(acceptanceProbe({ bitrateKbps: 0 }));

            await rowKbpsField(wrapper, 0).setValue('99999');

            expect(warningRows(wrapper)).toHaveLength(0);
        });
    });

    describe('submitted config', () => {
        it('submits single-track ladder rungs without a label', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await maxField(wrapper).setValue('3000');

            // A label would rename each stream's S3 directory, which the API
            // otherwise derives as `${height}p`.
            for (const rendition of renditionsOf(wrapper)) {
                expect(rendition).not.toHaveProperty('label');
            }
        });

        it('submits only fields the API whitelists, whatever the dials and preset did', async () => {
            const wrapper = mountForm(acceptanceProbe());
            await pickContent(wrapper, 'Custom…');
            await factorField(wrapper).setValue('0.5');
            await maxField(wrapper).setValue('3000');
            await minField(wrapper).setValue('200');
            await clickButton(wrapper, '+ Add rendition');

            const config = submitted(wrapper);

            for (const key of Object.keys(config)) {
                expect(CONFIG_DTO_KEYS).toContain(key);
            }
            expect(config.videoRenditions).toHaveLength(7);
            for (const rendition of config.videoRenditions!) {
                for (const key of Object.keys(rendition)) {
                    expect(RENDITION_DTO_KEYS).toContain(key);
                }
            }
        });

        it('submits only whitelisted fields for multi-angle rows too', async () => {
            const wrapper = mountForm(sevenAngleProbe());
            await pickContent(wrapper, 'Low motion');
            await maxField(wrapper).setValue('5000');

            for (const rendition of renditionsOf(wrapper)) {
                for (const key of Object.keys(rendition)) {
                    expect(RENDITION_DTO_KEYS).toContain(key);
                }
            }
        });
    });
});
