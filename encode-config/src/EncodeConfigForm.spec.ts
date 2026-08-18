import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import EncodeConfigForm from './EncodeConfigForm.vue';
import type { ProbeResult, VideoTrackInfo } from './types';

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
