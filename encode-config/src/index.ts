export { default as EncodeConfigForm } from './EncodeConfigForm.vue';
export * from './types';
export { computeLayoutKey, getStoredConfig, saveConfig } from './layoutStorage';
export { fpsAdjustedBitrateKbps } from './ladder';

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
export { copyModeBlockedReason, latestStreamStart } from './copyMode';
