declare module '*.vue' {
    import type { DefineComponent } from 'vue';
    const component: DefineComponent<object, object, unknown>;
    export default component;
}

/**
 * `videojs-mobile-ui` ships no usable types, and the player imports it
 * dynamically (see `LuminaryPlayer.vue`) so the specifier stays out of the
 * emitted declarations. A dynamic import produces a *value*, which under
 * `noImplicitAny` needs the module to have a type — and a shorthand ambient
 * declaration is the one that gives it `any` without inventing an API.
 *
 * It has to live here rather than beside the plugin's `Player` augmentation in
 * `types/videojs-mobile-ui.d.ts`: that file has top-level exports, so a
 * `declare module` in it is an *augmentation* of the resolved JavaScript rather
 * than a stand-in for it, and augmenting an untyped module types nothing. This
 * file has no top-level exports, so the declaration is ambient and wins.
 */
declare module 'videojs-mobile-ui';
