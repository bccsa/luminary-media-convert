import { describe, expect, it, vi } from 'vitest';
import { Hls } from '@videojs/hlsjs-video';
import { HlsStallSignals } from '../src/adapter/hlsStallSignals';
import { fakeEngine } from './helpers';
import type { HlsEngine } from '../src/adapter/hlsTypes';

const ERROR = Hls.Events.ERROR;
const asEngine = (e: ReturnType<typeof fakeEngine>) => e as unknown as HlsEngine;

function setup() {
    const onStalled = vi.fn();
    const signals = new HlsStallSignals({ onStalled });
    const engine = fakeEngine();
    signals.attach(asEngine(engine));
    return { signals, engine, onStalled };
}

describe('HlsStallSignals', () => {
    it.each([
        Hls.ErrorDetails.BUFFER_STALLED_ERROR,
        Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL,
        Hls.ErrorDetails.BUFFER_SEEK_OVER_HOLE,
    ])('reports a stall on %s', (details) => {
        const { engine, onStalled } = setup();
        engine.emit(ERROR, { fatal: false, details });
        expect(onStalled).toHaveBeenCalledWith(true);
    });

    it('leaves fatal errors to the recovery ladder', () => {
        const { engine, onStalled } = setup();
        engine.emit(ERROR, { fatal: true, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        expect(onStalled).not.toHaveBeenCalled();
    });

    it('ignores errors that are not stalls', () => {
        const { engine, onStalled } = setup();
        engine.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.FRAG_LOAD_ERROR });
        expect(onStalled).not.toHaveBeenCalled();
    });

    it('says so once however many nudges follow', () => {
        const { engine, onStalled } = setup();
        for (let i = 0; i < 3; i++) engine.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.BUFFER_NUDGE_ON_STALL });
        expect(onStalled).toHaveBeenCalledTimes(1);
    });

    it('ends the stall when the playhead moves forward, and only forward', () => {
        const { signals, engine, onStalled } = setup();
        signals.resetBaseline(10);
        engine.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        signals.noteTime(9);
        expect(onStalled).toHaveBeenLastCalledWith(true);
        signals.noteTime(10.5);
        expect(onStalled).toHaveBeenLastCalledWith(false);
    });

    it('moves to a new engine without keeping the old one\'s subscription', () => {
        const { signals, engine, onStalled } = setup();
        const next = fakeEngine();
        signals.attach(asEngine(next));
        engine.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        expect(onStalled).not.toHaveBeenCalled();
        next.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        expect(onStalled).toHaveBeenCalledWith(true);
    });

    it('subscribes once for the same engine', () => {
        const { signals, engine } = setup();
        signals.attach(asEngine(engine));
        expect(engine.handlers.get(ERROR)?.size).toBe(1);
    });

    it('stops listening once detached', () => {
        const { signals, engine, onStalled } = setup();
        signals.detach();
        engine.emit(ERROR, { fatal: false, details: Hls.ErrorDetails.BUFFER_STALLED_ERROR });
        expect(onStalled).not.toHaveBeenCalled();
    });
});
