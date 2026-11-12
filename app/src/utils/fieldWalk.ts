/** Whether a field's text runs over more than one line, wrapped or not. */
function isMultiline(el: HTMLTextAreaElement): boolean {
    if (el.value.includes('\n')) return true;
    const styles = getComputedStyle(el);
    const lineHeight = parseFloat(styles.lineHeight);
    if (!(lineHeight > 0)) return false;
    const padding = (parseFloat(styles.paddingTop) || 0) + (parseFloat(styles.paddingBottom) || 0);
    return el.scrollHeight - padding >= lineHeight * 1.5;
}

/**
 * Up and Down step to the previous or next of `fields`, with the caret at the end of its text. In a
 * multi-line field they first move the caret as usual, and leave only once it has reached that end of
 * the text. A selection or a modifier key leaves the arrow to the browser.
 *
 * @returns the field moved to, or null when the key was left alone
 */
export function stepBetweenFields(e: KeyboardEvent, fields: HTMLTextAreaElement[]): HTMLTextAreaElement | null {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return null;
    if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey) return null;
    const el = e.target as HTMLTextAreaElement;
    if (el.selectionStart !== el.selectionEnd) return null;
    const up = e.key === 'ArrowUp';
    const edge = up ? 0 : el.value.length;
    if (isMultiline(el) && el.selectionStart !== edge) return null;

    const next = fields[fields.indexOf(el) + (up ? -1 : 1)];
    if (!next) return null;
    e.preventDefault();
    next.focus();
    next.setSelectionRange(next.value.length, next.value.length);
    return next;
}
