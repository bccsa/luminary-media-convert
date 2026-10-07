// @ts-check
/* global cast */
/**
 * Our Cast receiver: Google's player for the picture, the timeline and the remote's transport keys,
 * and a menu of our own at the top right for audio, subtitles, quality and angle.
 *
 * Audio and subtitles are switched here, on the TV. Angle and quality are the page's to change (they
 * are munges of the master that only the phone makes), so a pick of those goes to the phone, which
 * casts the new master at the same place.
 */
import { CLOSED, OFF, clamp, press, sectionsOf } from './menu.js';

/** The channel the phone talks on; the phone's `CAST_NAMESPACE` names the same one. */
const NAMESPACE = 'urn:x-cast:org.bccsa.luminary.player';
/** How long the row stays up after the last key, a load or a pause. */
const HINT_MS = 5000;

const context = cast.framework.CastReceiverContext.getInstance();
const player = context.getPlayerManager();
const { EventType } = cast.framework.events;

/** @type {import('./menu.js').PhoneMenu | null} */
let phone = null;
/** @type {import('./menu.js').Choice[]} */
let audio = [];
/** @type {string | null} */
let activeAudioId = null;
/** @type {import('./menu.js').Choice[]} */
let subtitles = [];
/** @type {string | null} */
let activeSubtitleId = null;
/** @type {import('./menu.js').View} */
let view = CLOSED;
let hintUntil = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let hintTimer;

const root = /** @type {HTMLElement} */ (document.getElementById('menu'));

function sections() {
    return sectionsOf({ audio, activeAudioId, subtitles, activeSubtitleId, phone });
}

/** The tracks the loaded media carries, read afresh: the framework knows them only once it has loaded. */
function readTracks() {
    try {
        const audioTracks = player.getAudioTracksManager();
        audio = audioTracks.getTracks().map((/** @type {any} */ track) => ({
            id: String(track.trackId),
            label: track.name || languageName(track.language) || `Track ${track.trackId}`,
        }));
        const active = audioTracks.getActiveId();
        activeAudioId = active === null || active === undefined ? null : String(active);
    } catch {
        audio = [];
        activeAudioId = null;
    }
    try {
        const textTracks = player.getTextTracksManager();
        subtitles = textTracks.getTracks().map((/** @type {any} */ track) => ({
            id: String(track.trackId),
            label: track.name || languageName(track.language) || `Track ${track.trackId}`,
        }));
        const [active] = textTracks.getActiveIds() ?? [];
        activeSubtitleId = active === undefined ? null : String(active);
    } catch {
        subtitles = [];
        activeSubtitleId = null;
    }
}

/** `en` → `English`, in the TV's own language; the code itself when the TV has no name for it. */
function languageName(/** @type {string | undefined} */ code) {
    if (!code) return '';
    try {
        return new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code;
    } catch {
        return code;
    }
}

/** @param {{ section: import('./menu.js').SectionKey, id: string }} pick */
function apply(pick) {
    switch (pick.section) {
        case 'audio':
            player.getAudioTracksManager().setActiveById(Number(pick.id));
            activeAudioId = pick.id;
            break;
        case 'subtitles':
            player.getTextTracksManager().setActiveByIds(pick.id === OFF ? [] : [Number(pick.id)]);
            activeSubtitleId = pick.id === OFF ? null : pick.id;
            break;
        case 'quality':
        case 'angle':
            context.sendCustomMessage(NAMESPACE, undefined, { type: 'select', kind: pick.section, id: pick.id });
            // Shown as chosen at once; the phone's next menu confirms it.
            if (phone && pick.section === 'quality') phone = { ...phone, activeQualityId: pick.id };
            if (phone && pick.section === 'angle') phone = { ...phone, activeAngleId: pick.id };
            break;
    }
}

function showHint() {
    hintUntil = Date.now() + HINT_MS;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(render, HINT_MS + 50);
    render();
}

function render() {
    const all = sections();
    view = clamp(view, all);
    const visible = all.length > 0 && (view.open || Date.now() < hintUntil);
    root.hidden = !visible;
    root.classList.toggle('menu--open', view.open);
    root.replaceChildren();
    if (!visible) return;

    const row = document.createElement('div');
    row.className = 'menu__row';
    all.forEach((section, index) => {
        const button = document.createElement('div');
        button.className = 'menu__button';
        if (view.open && index === view.section) button.classList.add(view.list ? 'menu__button--current' : 'menu__button--focus');
        const title = document.createElement('span');
        title.className = 'menu__title';
        title.textContent = section.title;
        const value = document.createElement('span');
        value.className = 'menu__value';
        value.textContent = section.items.find((item) => item.id === section.activeId)?.label ?? '';
        button.append(title, value);
        row.append(button);
    });
    root.append(row);

    if (!view.open) {
        const hint = document.createElement('div');
        hint.className = 'menu__hint';
        hint.textContent = '▲ Settings';
        root.append(hint);
        return;
    }
    if (!view.list) return;

    const section = all[view.section];
    const list = document.createElement('div');
    list.className = 'menu__list';
    section.items.forEach((item, index) => {
        const entry = document.createElement('div');
        entry.className = 'menu__item';
        if (item.id === section.activeId) entry.classList.add('menu__item--active');
        if (index === view.item) entry.classList.add('menu__item--focus');
        entry.textContent = item.label;
        list.append(entry);
    });
    root.append(list);
    list.querySelector('.menu__item--focus')?.scrollIntoView({ block: 'nearest' });
}

/** @param {KeyboardEvent} event */
function onKey(event) {
    if (event.type !== 'keydown') return;
    if (view.open) readTracks();
    const result = press(view, sections(), event.key);
    view = result.view;
    if (result.consumed) {
        // The player listens too, and must not seek or pause on a key the menu used.
        event.preventDefault();
        event.stopImmediatePropagation();
    }
    if (result.pick) apply(result.pick);
    showHint();
}

// Where a remote's keys arrive differs by device (the document, or the framework's touch layer,
// from which they do not propagate), so both are listened on, in the capture phase.
window.addEventListener('keydown', onKey, true);
function listenOnTouchLayer() {
    const layer = document.querySelector('touch-controls')?.shadowRoot?.querySelector('.touch-layer');
    if (layer) layer.addEventListener('keydown', /** @type {EventListener} */ (onKey), true);
    else setTimeout(listenOnTouchLayer, 1000);
}
listenOnTouchLayer();

context.addCustomMessageListener(NAMESPACE, (/** @type {any} */ event) => {
    const message = event.data;
    if (message?.type !== 'menu') return;
    phone = {
        angles: Array.isArray(message.angles) ? message.angles : [],
        activeAngleId: message.activeAngleId,
        qualities: Array.isArray(message.qualities) ? message.qualities : [],
        activeQualityId: message.activeQualityId ?? 'auto',
    };
    render();
});

player.addEventListener(EventType.PLAYER_LOAD_COMPLETE, () => {
    readTracks();
    // The phone may have sent its menu before this page was listening.
    context.sendCustomMessage(NAMESPACE, undefined, { type: 'ready' });
    showHint();
});
player.addEventListener(EventType.PAUSE, showHint);

context.start({
    customNamespaces: { [NAMESPACE]: cast.framework.system.MessageType.JSON },
    // A paused video waits for the viewer, as it does on the phone.
    disableIdleTimeout: false,
});
