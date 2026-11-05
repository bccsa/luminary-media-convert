import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, ref } from 'vue';

const player = vi.hoisted(() => ({
    state: null as unknown as import('vue').Ref<Record<string, unknown>>,
    controller: { setSubtitleTrack: vi.fn(), setAngle: vi.fn(), setAudioTrack: vi.fn(), setQuality: vi.fn() },
}));

// The real player needs a browser's media; its state and controller are what the row reads and drives.
vi.mock('@luminary-media-converter/player-web', () => ({
    LuminaryPlayer: defineComponent({
        name: 'LuminaryPlayer',
        setup(_, { expose }) {
            expose({ controller: player.controller });
            return () => h('div');
        },
    }),
    usePlayerState: () => player.state,
}));

import SessionPlayerStrip from './SessionPlayerStrip.vue';
import FormSelect from '../FormSelect.vue';

const baseState = {
    lifecycle: 'ready',
    angles: [],
    qualities: [],
    audioTracks: [],
    activeAudioTrackId: null,
    activeAngleId: null,
    activeQualityId: 'auto',
    isAudioOnly: false,
    subtitleTracks: [] as { id: string; lang?: string; label: string; source: string }[],
    activeSubtitleTrackId: null as string | null,
    playing: false,
    duration: 60,
};

async function mountStrip(state: Partial<typeof baseState>) {
    player.state = ref({ ...baseState, ...state });
    const wrapper = mount(SessionPlayerStrip, {
        props: {
            source: { masterUrl: 'https://x/master.m3u8' },
            showAside: false,
            activeTab: 'trim',
            showAudioSelect: false,
            previewAudioSelectOptions: [],
            selectedAudioTrack: 0,
        },
    });
    await flushPromises();
    return wrapper;
}

const select = (wrapper: Awaited<ReturnType<typeof mountStrip>>) =>
    wrapper.findAllComponents(FormSelect).find((c) => c.attributes('data-test') === 'subtitleSelect')!;

describe('SessionPlayerStrip subtitles', () => {
    it('offers no subtitles selector for a video without any', async () => {
        const wrapper = await mountStrip({});
        expect(wrapper.find('[data-test="subtitleSelect"]').exists()).toBe(false);
    });

    it("lists the video's subtitles, off first, and turns the one picked on, or all off", async () => {
        const wrapper = await mountStrip({
            subtitleTracks: [
                { id: 'm:subs:Français:fr', lang: 'fr', label: 'Français', source: 'master' },
                { id: 'm:subs:English:en', lang: 'en', label: 'English', source: 'master' },
            ],
        });
        expect(select(wrapper).props('options')).toEqual([
            { value: '', label: 'Off' },
            { value: 'm:subs:Français:fr', label: 'Français (fr)' },
            { value: 'm:subs:English:en', label: 'English (en)' },
        ]);
        expect(select(wrapper).props('modelValue')).toBe('');

        select(wrapper).vm.$emit('update:modelValue', 'm:subs:Français:fr');
        expect(player.controller.setSubtitleTrack).toHaveBeenLastCalledWith('m:subs:Français:fr');
        select(wrapper).vm.$emit('update:modelValue', '');
        expect(player.controller.setSubtitleTrack).toHaveBeenLastCalledWith(null);
    });
});
