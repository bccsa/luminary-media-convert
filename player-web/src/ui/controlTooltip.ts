/**
 * The name of a control, shown above it when the pointer rests on it or the keyboard reaches it.
 *
 * The name is read from the control itself, as it is right then: the label a button carries (Video.js keeps
 * it current, "Enter fullscreen" becoming "Exit fullscreen"), or for the settings the name the button keeps
 * for a screen reader. A tooltip that kept its own copy would go stale and say a second thing.
 */

/** The controls that get a name: the icon buttons and the middle cluster, but not the volume card's plus and minus. */
export const TOOLTIP_TARGETS = '.lmpl-icon-btn:not(.lmpl-vstep), .lmpl-play, .lmpl-seek';

/** A pause before the name appears, so one passing over the row does not flash a name at every control. */
export const TOOLTIP_DELAY_MS = 350;

/** Gap, in px, between a control and its name. */
const TOOLTIP_GAP_PX = 10;
/** The least room, in px, between a name and the edge of the player. */
const TOOLTIP_EDGE_PX = 8;

export interface Tooltip {
    text: string;
    /** Where the control's centre is, in px from the container's left. */
    centre: number;
    /** Gap, in px, between the container's bottom edge and the name's. */
    bottom: number;
}

/** What a control is called: its label, else the name its button keeps for a screen reader. Empty when it has neither. */
export function controlLabel(control: Element): string {
    const label = control.getAttribute('aria-label')?.trim();
    if (label) return label;
    return control.querySelector('.media-settings-menu-trigger-label')?.textContent?.trim() ?? '';
}

/** Where a name goes: centred above its control, as far as the container's edges let it. */
export function tooltipFor(
    control: Pick<DOMRect, 'left' | 'width' | 'top'>,
    container: Pick<DOMRect, 'left' | 'bottom'>,
    text: string
): Tooltip {
    return {
        text,
        centre: control.left + control.width / 2 - container.left,
        bottom: container.bottom - control.top + TOOLTIP_GAP_PX,
    };
}

/** The left edge of a name `width` px wide centred on `centre`, kept inside a container `containerWidth` px wide. */
export function clampTooltipLeft(centre: number, width: number, containerWidth: number): number {
    const room = Math.max(TOOLTIP_EDGE_PX, containerWidth - width - TOOLTIP_EDGE_PX);
    return Math.min(room, Math.max(TOOLTIP_EDGE_PX, centre - width / 2));
}

/**
 * Wires a player's controls to a callback that is told which name to show, or none.
 *
 * A mouse or pen shows a name after a short rest on a control; a keyboard shows it at once, but only when the
 * focus came from the keyboard, not from a click. A touch shows none: it has no hover, and a tap would leave a
 * name stuck on. Pressing, clicking, leaving, losing focus or Escape takes it away, so it never sits over the
 * menu a control has just opened.
 */
export function attachControlTooltips(
    container: HTMLElement,
    onChange: (tip: Tooltip | null) => void,
    delayMs: number = TOOLTIP_DELAY_MS
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let shownFor: Element | null = null;

    const hide = (): void => {
        clearTimeout(timer);
        timer = undefined;
        if (shownFor) {
            shownFor = null;
            onChange(null);
        }
    };

    const show = (control: Element): void => {
        const text = controlLabel(control);
        if (!text) return hide();
        shownFor = control;
        onChange(tooltipFor(control.getBoundingClientRect(), container.getBoundingClientRect(), text));
    };

    const targetOf = (event: Event): Element | null =>
        event.target instanceof Element ? event.target.closest(TOOLTIP_TARGETS) : null;

    const onOver = (event: Event): void => {
        if ((event as PointerEvent).pointerType === 'touch') return;
        const control = targetOf(event);
        if (!control) return hide();
        if (control === shownFor) return;
        hide();
        timer = setTimeout(() => show(control), delayMs);
    };
    const onOut = (event: Event): void => {
        const control = targetOf(event);
        const into = (event as PointerEvent).relatedTarget;
        // Moving between the parts of one control (its icon and the button) is still being on it.
        if (control && into instanceof Node && control.contains(into)) return;
        hide();
    };
    const onFocusIn = (event: Event): void => {
        const control = targetOf(event);
        if (!control || !(control as HTMLElement).matches(':focus-visible')) return;
        hide();
        show(control);
    };
    const onKeydown = (event: Event): void => {
        if ((event as KeyboardEvent).key === 'Escape') hide();
    };

    container.addEventListener('pointerover', onOver);
    container.addEventListener('pointerout', onOut);
    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('focusout', hide);
    container.addEventListener('pointerdown', hide);
    container.addEventListener('click', hide, true);
    container.addEventListener('keydown', onKeydown);
    container.addEventListener('pointerleave', hide);
    return () => {
        hide();
        container.removeEventListener('pointerover', onOver);
        container.removeEventListener('pointerout', onOut);
        container.removeEventListener('focusin', onFocusIn);
        container.removeEventListener('focusout', hide);
        container.removeEventListener('pointerdown', hide);
        container.removeEventListener('click', hide, true);
        container.removeEventListener('keydown', onKeydown);
        container.removeEventListener('pointerleave', hide);
    };
}
