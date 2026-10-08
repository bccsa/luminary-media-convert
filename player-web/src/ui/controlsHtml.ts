import type { PlayerControlsOptions } from '../controls';

/**
 * The player's control surface, as markup.
 *
 * A string rather than a Vue template because the menus rely on `<template>` children that
 * Video.js 10's radio groups clone from, and Vue renders a plain `<template>` as an ordinary element
 * whose children never reach `.content`. The class names are the default skin's, so its stylesheet
 * keeps drawing the buttons, icons, menus and sliders; the layout around them is `lmpl-*` and lives in
 * `styles.css`.
 *
 * The layout: pause/play in the middle with the skips either side, and under it the timeline, then one
 * row — volume and the four settings (quality, language, speed, captions) on the left, each its own
 * button opening its own card, and casting, picture-in-picture and fullscreen on the right.
 */

export type ControlsHtmlOptions = Pick<
    PlayerControlsOptions,
    'audioMenu' | 'subtitlesMenu' | 'skipBackSeconds' | 'skipForwardSeconds'
>;

const icon = (name: string, cls: string): string => `<media-icon name="${name}" class="media-button-icon ${cls}"></media-icon>`;

/** A circular arrow with the interval written in it; `forward` mirrors the arrow, never the number. */
function skipIcon(seconds: number, forward: boolean): string {
    const arc = forward ? 'M20.5 12a8.5 8.5 0 1 1-2.9-6.4' : 'M3.5 12a8.5 8.5 0 1 0 2.9-6.4';
    const head = forward ? 'M20.8 4.2v4.4h-4.4' : 'M3.2 4.2v4.4h4.4';
    const size = seconds >= 100 ? 6 : 7.5;
    return (
        '<svg class="lmpl-skip-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        `<path d="${arc}"/><path d="${head}"/>` +
        `<text x="12" y="15.2" text-anchor="middle" font-size="${size}" font-weight="700" fill="currentColor" stroke="none">${seconds}</text>` +
        '</svg>'
    );
}

/** A `0` removes the button, which is the honest way to say "this player does not skip". */
function skipButton(seconds: number, direction: 'back' | 'forward'): string {
    if (!(seconds > 0)) return '';
    const signed = direction === 'back' ? -seconds : seconds;
    return (
        `<media-seek-button seconds="${signed}" class="lmpl-seek lmpl-seek-${direction}">` +
        skipIcon(seconds, direction === 'forward') +
        '</media-seek-button>'
    );
}

const radioItem = (inner: string): string =>
    '<template><media-menu-radio-item class="media-menu-radio-item">' +
    inner +
    '<media-menu-item-indicator force-mount class="media-menu-item-indicator">' +
    '<media-icon name="check" class="media-menu-radio-item-icon"></media-icon>' +
    '</media-menu-item-indicator></media-menu-radio-item></template>';

const labelled = '<span data-part="label"></span>';

const GROUPS = {
    quality:
        '<media-quality-radio-group class="media-menu-radio-group">' +
        radioItem(
            '<span><span data-part="label"></span><sup data-part="tier" class="media-menu-tier"></sup></span>' +
                '<span data-part="badge" class="media-menu-badge"></span>'
        ) +
        '</media-quality-radio-group>',
    audio: `<media-audio-track-radio-group class="media-menu-radio-group">${radioItem(labelled)}</media-audio-track-radio-group>`,
    speed: `<media-playback-rate-radio-group class="media-menu-radio-group">${radioItem(labelled)}</media-playback-rate-radio-group>`,
    captions: `<media-captions-radio-group class="media-menu-radio-group">${radioItem(labelled)}</media-captions-radio-group>`,
} as const;

type Setting = keyof typeof GROUPS;

const SETTINGS: Record<Setting, { icon: string; title: string }> = {
    quality: { icon: 'switches', title: 'Quality' },
    audio: { icon: 'speech', title: 'Language' },
    speed: { icon: 'speed', title: 'Speed' },
    captions: { icon: 'captions-off', title: 'Captions' },
};

/**
 * One setting: a round button, and the card it opens above the bar. The card is a menu holding its radio
 * group directly, under a title, so nothing is nested a level deep behind a cogwheel.
 */
function setting(kind: Setting, id: string): string {
    const { icon: iconName, title } = SETTINGS[kind];
    const menuId = `${id}-${kind}`;
    return (
        `<button commandfor="${menuId}" class="media-button lmpl-icon-btn lmpl-opt lmpl-opt-${kind}" type="button">` +
        `<media-icon name="${iconName}" class="media-button-icon-base media-settings-menu-trigger-icon"></media-icon>` +
        // Visually hidden: the button is an icon, and this is its name for a screen reader.
        `<span class="media-settings-menu-trigger-label">${title}</span>` +
        '</button>' +
        `<media-menu side="top" align="center" class="media-popup media-popup-surface media-menu-popup media-menu-resizable-popup lmpl-menu lmpl-card lmpl-card-${kind}" id="${menuId}">` +
        '<media-menu-content class="media-menu-content">' +
        `<span class="lmpl-card-title">${title}</span>` +
        GROUPS[kind] +
        '</media-menu-content></media-menu>'
    );
}

const plus =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
const minus =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

/**
 * The mute button, and the card its volume opens over it: plus at the top, a thick vertical slider, minus
 * at the bottom. The slider has no thumb, like the timeline. The plus and minus buttons carry
 * `data-volume-step`, which the component turns into a volume change; v10 has no element of its own for it.
 */
function volume(id: string): string {
    const step = (direction: 1 | -1, label: string, glyph: string): string =>
        `<button type="button" class="media-button lmpl-icon-btn lmpl-vstep" data-volume-step="${direction}" aria-label="${label}">${glyph}</button>`;
    return (
        '<div class="lmpl-group lmpl-volume">' +
        `<media-mute-button commandfor="${id}-volume" class="media-button lmpl-icon-btn media-mute-button lmpl-mute">` +
        icon('volume-off', 'media-mute-button-off-icon') +
        icon('volume-low', 'media-mute-button-low-icon') +
        icon('volume-high', 'media-mute-button-high-icon') +
        '</media-mute-button>' +
        `<media-volume-popover open-on-hover delay="150" close-delay="250" side="top" align="center" class="media-popup media-popup-safe-area media-popup-transition media-popup-surface lmpl-volume-card" id="${id}-volume">` +
        // A wrapper, because a popover's own `display` is what closes it.
        '<div class="lmpl-volume-card-inner">' +
        step(1, 'Volume up', plus) +
        '<media-volume-slider class="media-slider media-volume-slider lmpl-volume-slider" orientation="vertical">' +
        '<media-slider-track class="media-slider-track lmpl-vtrack">' +
        '<media-slider-fill class="media-slider-fill lmpl-vfill"></media-slider-fill>' +
        '</media-slider-track></media-volume-slider>' +
        step(-1, 'Volume down', minus) +
        '</div></media-volume-popover>' +
        '</div>'
    );
}

/** The settings. Language and captions are left out when the host asks; the two always offered are quality and speed. */
function settings(options: ControlsHtmlOptions, id: string): string {
    return (
        '<div class="lmpl-group lmpl-options">' +
        setting('quality', id) +
        (options.audioMenu ? setting('audio', id) : '') +
        setting('speed', id) +
        (options.subtitlesMenu ? setting('captions', id) : '') +
        '</div>'
    );
}

/** Casting and picture-in-picture sit with fullscreen, the buttons that act on the whole player. */
function remote(): string {
    return (
        '<div class="lmpl-group lmpl-remote">' +
        `<media-cast-button class="media-button lmpl-icon-btn media-cast-button">${icon('cast-enter', 'media-cast-button-enter-icon')}${icon('cast-exit', 'media-cast-button-exit-icon')}</media-cast-button>` +
        `<media-airplay-button class="media-button lmpl-icon-btn media-airplay-button">${icon('airplay-enter', 'media-airplay-button-enter-icon')}${icon('airplay-exit', 'media-airplay-button-exit-icon')}</media-airplay-button>` +
        `<media-pip-button class="media-button lmpl-icon-btn media-pip-button">${icon('pip-enter', 'media-pip-button-enter-icon')}${icon('pip-exit', 'media-pip-button-exit-icon')}</media-pip-button>` +
        `<media-fullscreen-button class="media-button lmpl-icon-btn media-fullscreen-button">${icon('fullscreen-enter', 'media-fullscreen-button-enter-icon')}${icon('fullscreen-exit', 'media-fullscreen-button-exit-icon')}</media-fullscreen-button>` +
        '</div>'
    );
}

/** Pause/play in the middle, the skip buttons flanking it. */
function centreCluster(options: ControlsHtmlOptions): string {
    return (
        '<div class="lmpl-cluster lmpl-cluster-centre">' +
        skipButton(options.skipBackSeconds, 'back') +
        '<media-play-button class="media-button lmpl-play media-play-button">' +
        icon('restart', 'media-play-button-restart-icon') +
        icon('play', 'media-play-button-play-icon') +
        icon('pause', 'media-play-button-pause-icon') +
        '</media-play-button>' +
        skipButton(options.skipForwardSeconds, 'forward') +
        '</div>'
    );
}

/**
 * Two rows: the timeline on its own, then the buttons. The timeline is thick and round and has no
 * thumb — the fill is the playhead — and it sits well in from both edges (see `styles.css`), because
 * these controls are mostly met in fullscreen, where a stray touch at the screen edge must not start a
 * seek or trip a system gesture. The pointer preview stays: a bar with no readout of where a click
 * lands is a guess.
 */
function bottomBar(options: ControlsHtmlOptions, id: string): string {
    return (
        '<div class="lmpl-bottom">' +
        '<div class="lmpl-timeline-row">' +
        '<media-time class="lmpl-time" type="current"></media-time>' +
        '<media-time-slider class="media-slider media-time-slider lmpl-time-slider">' +
        '<media-slider-track class="media-slider-track lmpl-track">' +
        '<media-slider-buffer class="media-slider-buffer lmpl-buffer"></media-slider-buffer>' +
        '<media-slider-fill class="media-slider-fill lmpl-fill"></media-slider-fill>' +
        '</media-slider-track>' +
        '<media-slider-preview class="media-slider-preview" overflow="visible">' +
        '<div class="media-slider-preview-content media-time-slider-preview-content lmpl-preview">' +
        '<media-slider-value class="media-time-slider-value" type="pointer"></media-slider-value></div>' +
        '</media-slider-preview></media-time-slider>' +
        '<media-time class="lmpl-time" type="remaining" toggle></media-time>' +
        '</div>' +
        '<div class="lmpl-actions-row">' +
        volume(id) +
        settings(options, id) +
        '<span class="lmpl-spacer"></span>' +
        remote() +
        '</div>' +
        '</div>'
    );
}

/** Everything that sits inside `<media-controls>`, ids made unique with `id`. */
export function buildControlsHtml(options: ControlsHtmlOptions, id: string): string {
    return (
        '<media-controls-backdrop class="video-controls-backdrop"></media-controls-backdrop>' +
        '<media-controls-content class="lmpl-controls-content">' +
        centreCluster(options) +
        bottomBar(options, id) +
        '</media-controls-content>'
    );
}
