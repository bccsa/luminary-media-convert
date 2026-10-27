// @ts-check
/**
 * The TV menu's logic, apart from the Cast SDK and the page so it can be tested: which sections
 * there are, and what each key of the remote does to them.
 */

/** @typedef {{ id: string, label: string }} Choice */
/** @typedef {'audio' | 'subtitles' | 'quality' | 'angle'} SectionKey */
/** @typedef {{ key: SectionKey, title: string, items: Choice[], activeId: string | null }} Section */
/**
 * The page's angles and qualities, as the phone sends them.
 * @typedef {{ angles: Choice[], activeAngleId?: string, qualities: Choice[], activeQualityId: string }} PhoneMenu
 */
/**
 * Where the viewer is: the menu shut, its row of sections, or the list of one of them.
 * @typedef {{ open: boolean, list: boolean, section: number, item: number }} View
 */

/** @type {View} */
export const CLOSED = Object.freeze({ open: false, list: false, section: 0, item: 0 });

/** Off and Auto are the TV's own entries; neither is an id the page or a track uses. */
export const OFF = 'off';
export const AUTO = 'auto';

/**
 * The sections worth showing: a choice of one is no choice, except subtitles, where Off is the other.
 * @param {{ audio: Choice[], activeAudioId: string | null, subtitles: Choice[], activeSubtitleId: string | null, phone: PhoneMenu | null }} input
 * @returns {Section[]}
 */
export function sectionsOf({ audio, activeAudioId, subtitles, activeSubtitleId, phone }) {
    /** @type {Section[]} */
    const sections = [];
    if (audio.length > 1) {
        sections.push({ key: 'audio', title: 'Audio', items: audio, activeId: activeAudioId });
    }
    if (subtitles.length > 0) {
        sections.push({
            key: 'subtitles',
            title: 'Subtitles',
            items: [{ id: OFF, label: 'Off' }, ...subtitles],
            activeId: activeSubtitleId ?? OFF,
        });
    }
    if (phone && phone.qualities.length > 0) {
        sections.push({
            key: 'quality',
            title: 'Quality',
            items: [{ id: AUTO, label: 'Auto' }, ...phone.qualities],
            activeId: phone.activeQualityId || AUTO,
        });
    }
    if (phone && phone.angles.length > 1) {
        sections.push({ key: 'angle', title: 'Angle', items: phone.angles, activeId: phone.activeAngleId ?? null });
    }
    return sections;
}

const BACK = new Set(['BrowserBack', 'GoBack', 'Escape', 'Backspace']);

/**
 * One key of the remote. `consumed` says the menu used it, so the player must not act on it too;
 * a key the menu does not use while shut is the player's (play, pause, seek).
 * @param {View} view
 * @param {Section[]} sections
 * @param {string} key `KeyboardEvent.key`
 * @returns {{ view: View, consumed: boolean, pick?: { section: SectionKey, id: string } }}
 */
export function press(view, sections, key) {
    if (sections.length === 0) return { view: CLOSED, consumed: false };
    const at = clamp(view, sections);

    if (!at.open) {
        // Up is the way in: the player uses left, right and Enter for seeking and pausing.
        if (key === 'ArrowUp') return { view: { open: true, list: false, section: at.section, item: 0 }, consumed: true };
        return { view: at, consumed: false };
    }

    const section = sections[at.section];
    if (!at.list) {
        switch (key) {
            case 'ArrowLeft':
                return { view: { ...at, section: Math.max(0, at.section - 1) }, consumed: true };
            case 'ArrowRight':
                return { view: { ...at, section: Math.min(sections.length - 1, at.section + 1) }, consumed: true };
            case 'ArrowDown':
            case 'Enter':
                return { view: { ...at, list: true, item: Math.max(0, activeIndex(section)) }, consumed: true };
            case 'ArrowUp':
                return { view: { ...CLOSED, section: at.section }, consumed: true };
            default:
                if (BACK.has(key)) return { view: { ...CLOSED, section: at.section }, consumed: true };
                // Anything else while the menu is up is the menu's, so nothing seeks behind it.
                return { view: at, consumed: true };
        }
    }

    switch (key) {
        case 'ArrowUp':
            if (at.item === 0) return { view: { ...at, list: false }, consumed: true };
            return { view: { ...at, item: at.item - 1 }, consumed: true };
        case 'ArrowDown':
            return { view: { ...at, item: Math.min(section.items.length - 1, at.item + 1) }, consumed: true };
        case 'ArrowLeft':
        case 'ArrowRight': {
            const next = Math.min(sections.length - 1, Math.max(0, at.section + (key === 'ArrowLeft' ? -1 : 1)));
            return { view: { ...at, section: next, item: Math.max(0, activeIndex(sections[next])) }, consumed: true };
        }
        case 'Enter': {
            const choice = section.items[at.item];
            return { view: { ...CLOSED, section: at.section }, consumed: true, pick: { section: section.key, id: choice.id } };
        }
        default:
            if (BACK.has(key)) return { view: { ...at, list: false }, consumed: true };
            return { view: at, consumed: true };
    }
}

/**
 * The view kept inside sections that changed under it (a track list that arrived, an angle that went).
 * @param {View} view
 * @param {Section[]} sections
 * @returns {View}
 */
export function clamp(view, sections) {
    if (sections.length === 0) return CLOSED;
    const section = Math.min(view.section, sections.length - 1);
    const item = Math.min(view.item, sections[section].items.length - 1);
    return { ...view, section, item: Math.max(0, item) };
}

/** @param {Section} section */
function activeIndex(section) {
    return section.items.findIndex((item) => item.id === section.activeId);
}
