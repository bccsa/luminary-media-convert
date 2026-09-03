import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ProgressBar from './ProgressBar.vue';

const mountBar = (props: Record<string, unknown>) =>
    mount(ProgressBar, { props: { label: 'Encoding', ...props } });

const shown = (wrapper: ReturnType<typeof mountBar>) =>
    wrapper.find('span.font-mono').text();

/**
 * Progress arrives as a raw float from the encoder, and the label is the one
 * place it is read rather than used for layout.
 */
describe('ProgressBar', () => {
    it('rounds a float to one decimal instead of printing the arithmetic', () => {
        expect(shown(mountBar({ progress: 3.1000000000000005 }))).toBe('3.1%');
    });

    it('leaves a whole percentage whole, rather than showing 23.0%', () => {
        expect(shown(mountBar({ progress: 23 }))).toBe('23%');
    });

    it('rounds rather than truncates', () => {
        expect(shown(mountBar({ progress: 1.7666666666666668 }))).toBe('1.8%');
    });

    it('keeps the unrounded value for the bar, where precision costs nothing', () => {
        const bar = mountBar({ progress: 3.1000000000000005 });

        expect(bar.html()).toContain('width: 3.1000000000000005%');
    });

    it('shows nothing when there is no progress to show', () => {
        expect(
            mountBar({ progress: null }).find('span.font-mono').exists()
        ).toBe(false);
    });

    it('prefers a subtitle over the percentage, as it always has', () => {
        const bar = mountBar({
            progress: 42,
            subtitle: 'waiting for the encoder',
        });

        expect(bar.text()).toContain('waiting for the encoder');
        expect(bar.text()).not.toContain('42%');
    });
});
