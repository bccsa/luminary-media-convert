import { describe, it, expect } from 'vitest';
import { FRAME_NAMESPACE, originOf, parseFrameEvent } from '../src/youtubeFrameProtocol';

const win = {};
const msg = (data: unknown, origin = 'https://embed.test', source: unknown = win) => ({ data, origin, source });

describe('parseFrameEvent', () => {
    it('accepts a known event from the embed window and origin', () => {
        const data = { ns: FRAME_NAMESPACE, name: 'state', state: 1 };
        expect(parseFrameEvent(msg(data), 'https://embed.test', win)).toEqual(data);
    });
    it('drops a foreign origin, a foreign window, another namespace and unknown names', () => {
        const ok = { ns: FRAME_NAMESPACE, name: 'ready' };
        expect(parseFrameEvent(msg(ok, 'https://evil.test'), 'https://embed.test', win)).toBeNull();
        expect(parseFrameEvent(msg(ok, undefined, {}), 'https://embed.test', win)).toBeNull();
        expect(parseFrameEvent(msg({ ...ok, ns: 'x' }), 'https://embed.test', win)).toBeNull();
        expect(parseFrameEvent(msg({ ns: FRAME_NAMESPACE, name: 'load' }), 'https://embed.test', win)).toBeNull();
        expect(parseFrameEvent(msg(null), 'https://embed.test', win)).toBeNull();
    });
});

describe('originOf', () => {
    it('reads the origin and rejects non-URLs', () => {
        expect(originOf('https://a.test/x/y.html?z=1')).toBe('https://a.test');
        expect(originOf('nope')).toBeNull();
    });
});
