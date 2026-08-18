/**
 * The editor's button styling, in one place because more than one component
 * wears it.
 *
 * These were descendant CSS rules — `.se-controls-bar .se-btn` and
 * `.se-playback-controls .se-btn` — which sized a button by the row it sat in.
 * Utilities cannot express "whatever is inside me", so the row's contribution
 * moves here and each button asks for the set belonging to its row. Exported
 * rather than inlined because `AccountMenu` puts its appearance button in the
 * controls bar and has to come out identical, not merely similar; a copy would
 * be free to drift, and the CSS rule it replaces never could.
 */

/** Shared by every button in either row: a square tap target that centres its icon. */
const SQUARE = 'inline-flex items-center justify-center box-border';

/** The combined controls bar, used in trim mode: 2.25rem targets. */
export const BAR_BUTTON = `${SQUARE} min-h-9 min-w-9`;
export const BAR_JOG = 'leading-none p-0 gap-0';
export const BAR_PLAY = 'leading-none min-w-9 min-h-9 p-0';
export const BAR_JOG_ICON = 'w-5 h-5 block align-baseline';
export const BAR_PLAY_ICON = 'w-7 h-7 block align-baseline';

/** The standalone playback strip, used elsewhere: 2.75rem targets. */
export const STRIP_BUTTON = `${SQUARE} min-h-11 min-w-11 leading-none`;
export const STRIP_JOG = 'p-0 gap-0';
export const STRIP_PLAY = 'min-w-11 min-h-11 p-0';
export const STRIP_JOG_ICON = 'w-6 h-6 block align-baseline';
export const STRIP_PLAY_ICON = 'w-10 h-10 block align-baseline';

/**
 * The editor's icon button, exactly as its own toolbar wears it. `AccountMenu`
 * imports this so its appearance button is the same button, not a lookalike.
 */
export const EDITOR_ICON_BUTTON =
    'appearance-none inline-flex items-center gap-1 px-2 py-1 text-xs font-medium font-[inherit] text-zinc-900 dark:text-slate-200 bg-slate-50 dark:bg-slate-800 border border-sky-200 dark:border-sky-400/12 rounded-md cursor-pointer transition-colors duration-[120ms] ease-[ease] enabled:hover:bg-slate-100 dark:enabled:hover:bg-slate-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600 dark:focus-visible:outline-sky-400 disabled:opacity-50 disabled:cursor-not-allowed';
