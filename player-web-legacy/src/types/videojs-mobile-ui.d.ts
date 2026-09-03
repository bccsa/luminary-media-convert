/**
 * `videojs-mobile-ui` ships no types of its own, and the published
 * `@types/videojs-mobile-ui` describes the 0.x API — a different options shape
 * from the 1.1.1 pin this workspace uses. So the plugin is declared here
 * instead, narrowed to the options the player actually passes.
 *
 * The plugin registers itself on the Player prototype as a side effect of being
 * imported, so there is no API to describe — only the method it grafts on,
 * which arrives through a declaration merge on video.js's own `Player` class.
 * The module itself is declared in `src/env.d.ts`, which has no top-level
 * exports and can therefore stand in for the untyped package rather than merely
 * augment it; the comment there explains why that distinction matters.
 */

/** Options accepted by `player.mobileUi()` in videojs-mobile-ui 1.x. */
export interface MobileUiOptions {
    fullscreen?: {
        /** Enter fullscreen when the device is rotated to landscape. */
        enterOnRotate?: boolean;
        /** Leave fullscreen when the device is rotated back to portrait. */
        exitOnRotate?: boolean;
        /** Lock the screen orientation while fullscreen. */
        lockOnRotate?: boolean;
        /** Lock to landscape as soon as fullscreen is entered, however it was entered. */
        lockToLandscapeOnEnter?: boolean;
        /** Turn the fullscreen handling off entirely. */
        disabled?: boolean;
    };
    touchControls?: {
        /** Turn the plugin's own touch overlay off, leaving the stock control bar. */
        disabled?: boolean;
    };
}

// `Player` is a default-exported class, so the augmentation targets the default
// export of the module the class is declared in — `video.js` itself re-exports
// it, but only this path names the declaration a merge can attach to.
declare module 'video.js/dist/types/player' {
    export default interface Player {
        mobileUi(options?: MobileUiOptions): void;
    }
}
