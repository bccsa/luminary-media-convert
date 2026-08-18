import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import SegmentEditor from '../SegmentEditor.vue';
import type { Segment } from '../types';

/** Stable HTMLElement.getBoundingClientRect stub keyed off element class. */
function stubRect(el: Element): DOMRect {
    // The timeline wrap is 1000px wide, positioned at x=0 for easy pixel↔time math.
    // Width=1000, so 1px = 0.1% = duration/1000 seconds.
    const isScrollbar = el.classList?.contains('se-scrollbar');
    return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 1000,
        bottom: isScrollbar ? 10 : 40,
        width: 1000,
        height: isScrollbar ? 10 : 40,
        toJSON: () => ({}),
    } as DOMRect;
}

Element.prototype.getBoundingClientRect = function () {
    return stubRect(this);
};

/**
 * The component uses a recursive requestAnimationFrame loop to track the playhead.
 * Stubbing it as a no-op keeps tests finite; tests that need a "current time" value
 * just read from the getCurrentTime prop directly (the component does the same for
 * every action except painting the playhead DOM element).
 */
globalThis.requestAnimationFrame = ((_cb: FrameRequestCallback): number => 1) as typeof globalThis.requestAnimationFrame;
globalThis.cancelAnimationFrame = (() => {}) as typeof globalThis.cancelAnimationFrame;

export type EditorMount = VueWrapper<InstanceType<typeof SegmentEditor>>;

interface MountOpts {
    duration?: number;
    segments?: Segment[];
    currentTime?: { value: number };
    props?: Record<string, unknown>;
}

export function mountEditor(opts: MountOpts = {}): EditorMount {
    const duration = opts.duration ?? 100;
    const segments = opts.segments ?? [];
    const currentTime = opts.currentTime ?? { value: 0 };
    const wrapper = mount(SegmentEditor, {
        attachTo: document.body,
        props: {
            modelValue: segments,
            duration,
            getCurrentTime: () => currentTime.value,
            // Simulate v-model so emits flow back into the prop — otherwise undo/redo/multi-op
            // tests see a static modelValue and internal state drifts. The microtask wrap
            // defers the setProps call until after `wrapper` is assigned; the first emit
            // (synchronous id-hydration during mount) would otherwise hit an uninitialized ref.
            'onUpdate:modelValue': (next: Segment[]) => {
                queueMicrotask(() => wrapper.setProps({ modelValue: next }));
            },
            ...opts.props,
        },
    });
    wrapper.vm.$nextTick();
    return wrapper;
}

export async function flush(): Promise<void> {
    await nextTick();
    await nextTick();
}

export function pxForSec(sec: number, duration = 100): number {
    return (sec / duration) * 1000;
}

/** Fire a MouseEvent on an element at a given timeline second, plus optional modifiers. */
export function mouseAt(
    el: Element,
    type: 'mousedown' | 'mousemove' | 'mouseup' | 'click',
    sec: number,
    opts: MouseEventInit & { duration?: number; button?: number } = {},
): void {
    const duration = opts.duration ?? 100;
    const ev = new MouseEvent(type, {
        clientX: pxForSec(sec, duration),
        clientY: 20,
        bubbles: true,
        button: opts.button ?? 0,
        shiftKey: opts.shiftKey ?? false,
        ctrlKey: opts.ctrlKey ?? false,
        metaKey: opts.metaKey ?? false,
        cancelable: true,
    });
    el.dispatchEvent(ev);
}

/** Dispatch a KeyboardEvent to the timeline wrapper. */
export function keyOn(el: Element, key: string, opts: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...opts }));
}

export function keyDown(el: Element, key: string, opts: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }));
}

export function keyUp(el: Element, key: string, opts: KeyboardEventInit = {}): void {
    el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...opts }));
}

/** Pull the latest `update:modelValue` payload (or empty array if none emitted). */
export function latestSegments(wrapper: EditorMount): Segment[] {
    const emits = wrapper.emitted('update:modelValue');
    if (!emits || emits.length === 0) return (wrapper.props('modelValue') as Segment[]) ?? [];
    return emits[emits.length - 1][0] as Segment[];
}

export async function setSegments(wrapper: EditorMount, segs: Segment[]): Promise<void> {
    await wrapper.setProps({ modelValue: segs });
}
