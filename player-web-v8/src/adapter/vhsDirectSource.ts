/**
 * How VHS hands its MediaSource to the `<video>` element: through `src`, on
 * every browser.
 *
 * On Safari and iOS, VHS 3.17 attaches the MediaSource by appending two
 * `<source>` children instead of setting `src` — the MediaSource's object URL,
 * then the manifest URL for AirPlay — whenever the tech offers
 * `addSourceElement`. Each new source swaps the pair, but WebKit's resource
 * selection carries on through the swapped list instead of starting over:
 * after a source change it loads the second child, the manifest, which WebKit
 * cannot play natively here. The element sits at `NETWORK_NO_SOURCE` and the
 * load never becomes ready — a reload, an angle switch, any source change.
 * Chrome takes the `src` path and is unaffected.
 *
 * The manifest child buys nothing here: every source this adapter plays is a
 * munged `blob:` playlist, which an AirPlay receiver cannot fetch. So the
 * tech's `addSourceElement` is shadowed on the instance, and VHS takes the
 * `src` path, which restarts resource selection on every source.
 *
 * Internal VHS behaviour, pinned to the 3.17.x this workspace installs. Call
 * from `xhr-hooks-ready`, which VHS fires on the tech's handler just before
 * it attaches the MediaSource.
 */

import type Player from 'video.js/dist/types/player';
import { vhsTech } from './vhsXhrSeam';

export function attachMediaSourceBySrc(player: Player): void {
    const tech = vhsTech(player) as { vhs?: unknown; addSourceElement?: unknown } | null;
    if (!tech?.vhs) return;
    tech.addSourceElement = undefined;
}
