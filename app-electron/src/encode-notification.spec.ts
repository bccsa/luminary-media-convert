import { describe, expect, it } from 'vitest';
import { encodeNotification } from './encode-notification';

describe('encodeNotification', () => {
    it('names the post when an encode finishes', () => {
        expect(
            encodeNotification({
                sessionId: 's',
                outcome: 'completed',
                title: 'Sunday meeting',
                fileName: 'sunday.mp4',
            })
        ).toEqual({ title: 'Encode finished', body: 'Sunday meeting is ready.' });
    });

    it('names the file for a session no CMS opened', () => {
        expect(
            encodeNotification({
                sessionId: 's',
                outcome: 'completed',
                fileName: 'sunday.mp4',
            }).body
        ).toBe('sunday.mp4 is ready.');
    });

    it('says why an encode failed', () => {
        expect(
            encodeNotification({
                sessionId: 's',
                outcome: 'failed',
                title: 'Sunday meeting',
                message: 'The encoder ran out of disk space.',
            })
        ).toEqual({
            title: 'Encode failed',
            body: 'Sunday meeting: The encoder ran out of disk space.',
        });
    });

    it('cuts a long reason short', () => {
        const { body } = encodeNotification({
            sessionId: 's',
            outcome: 'failed',
            message: 'x'.repeat(500),
        });
        expect(body.length).toBeLessThan(220);
        expect(body.endsWith('…')).toBe(true);
    });

    it('still says something with no name and no reason', () => {
        expect(
            encodeNotification({ sessionId: 's', outcome: 'failed' }).body
        ).toBe('Your encode did not finish.');
    });
});
