export { default as EncodeConfigForm } from './EncodeConfigForm.vue';
export * from './types';
export { computeLayoutKey, getStoredConfig, saveConfig } from './layoutStorage';
export {
    ABR_LADDER,
    aspectWidthForHeight,
    fpsAdjustedBitrateKbps,
    ladderFor,
} from './ladder';
export type { LadderRung } from './ladder';

/**
 * Language-code validation, for hosts that collect a language outside this form
 * — the same register and the same rules, rather than a second opinion.
 */
export {
    ISO_639_2_CODES,
    LANGUAGE_NAMES,
    LANGUAGE_OPTIONS,
    isValidLanguageCode,
    languageName,
    normalizeLanguageInput,
} from './language-codes';
export {
    copyModeBlockedReason,
    latestStreamStart,
    quickTrimBlockedReason,
} from './copyMode';

/**
 * Square-pixel geometry, for hosts that need to lay out a picture the same way
 * the ladder does — a coded frame size does not say what shape it is.
 */
export { displayDimensionsOf, isAnamorphic } from './aspect';
export type { AspectTrack } from './aspect';
