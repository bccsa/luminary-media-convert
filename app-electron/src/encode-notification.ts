import type { EncodeOutcome } from '@luminary-media-converter/api';

/** What a desktop notification about an ended encode says. */
export interface NotificationText {
    title: string;
    body: string;
}

/** The longest failure sentence shown before it is cut; the app has it whole. */
const MAX_BODY = 180;

/**
 * The notification for an encode that finished or failed, naming the post (or,
 * for a session no CMS opened, the file) so it is clear which one.
 */
export function encodeNotification(outcome: EncodeOutcome): NotificationText {
    const name = outcome.title?.trim() || outcome.fileName || 'Your encode';
    if (outcome.outcome === 'completed') {
        return { title: 'Encode finished', body: `${name} is ready.` };
    }
    const reason = outcome.message?.trim() ?? '';
    const shown =
        reason.length > MAX_BODY ? `${reason.slice(0, MAX_BODY - 1)}…` : reason;
    return {
        title: 'Encode failed',
        body: shown ? `${name}: ${shown}` : `${name} did not finish.`,
    };
}
