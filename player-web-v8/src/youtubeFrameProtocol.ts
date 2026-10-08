/**
 * The postMessage contract between the player and `embed/youtube-embed.html`.
 *
 * It exists because YouTube refuses an embed whose Referer is not http(s)
 * (error 153), and a Capacitor iOS page is `capacitor://localhost`. The iframe
 * that holds YouTube has to be an HTTPS page, and the two pages then talk by
 * message. The embed page repeats `FRAME_NAMESPACE` and the message shapes by
 * hand, being a static file with no build.
 */

export const FRAME_NAMESPACE = 'lmc-youtube';

export type FrameCommand =
    | { name: 'hello' }
    | { name: 'load'; videoId: string; start?: number }
    | { name: 'play' | 'pause' | 'mute' | 'unmute' | 'destroy' }
    | { name: 'seek' | 'volume' | 'rate'; value: number };

/** YouTube's `YT.PlayerState` numbers, which the embed forwards untouched. */
export type FrameEvent =
    | { name: 'ready' }
    | { name: 'state'; state: number }
    | { name: 'time'; time: number; duration: number; loaded: number }
    | { name: 'rate'; rate: number; rates: number[] }
    | { name: 'volume'; volume: number; muted: boolean }
    | { name: 'error'; code: number };

export function toFrameMessage(command: FrameCommand): { ns: string } & FrameCommand {
    return { ns: FRAME_NAMESPACE, ...command };
}

/** The origin of a URL, or null when it is not an absolute one. */
export function originOf(url: string): string | null {
    try {
        const origin = new URL(url).origin;
        return origin === 'null' ? null : origin;
    } catch {
        return null;
    }
}

/**
 * The event a message carries, or null. Anything not from the embed page's own
 * origin and window is dropped: a page the player frames can be navigated away.
 */
export function parseFrameEvent(
    event: { data: unknown; origin: string; source: unknown },
    embedOrigin: string,
    embedWindow: unknown,
): FrameEvent | null {
    if (event.origin !== embedOrigin || event.source !== embedWindow) return null;
    const data = event.data as { ns?: unknown; name?: unknown } | null;
    if (!data || typeof data !== 'object' || data.ns !== FRAME_NAMESPACE) return null;
    switch (data.name) {
        case 'ready':
        case 'state':
        case 'time':
        case 'rate':
        case 'volume':
        case 'error':
            return data as FrameEvent;
        default:
            return null;
    }
}
