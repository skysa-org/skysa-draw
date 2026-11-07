/**
 * The canvas's region (`Viewport.tsx`), found by its role in the page: what
 * hears the keys the page is sent, and what a press draws on. Found rather
 * than handed down, since what hands it the keys or keeps a press from it is
 * a panel's or the tool bar's, not under it.
 */
const CANVAS = '.viewport[role="region"]';

/**
 * The keyboard given back to the canvas, so the arrows nudge what a press in
 * a panel selected rather than walk the panel's rows, as Illustrator's and
 * Figma's panels hand the keys back (`useItemRows`); nothing scrolls to show it.
 */
export const focusCanvas = (): void => {
	document.querySelector<HTMLElement>(CANVAS)?.focus({ preventScroll: true });
};

/**
 * Whether a press, by its path (`composedPath()`), is on the canvas: one that
 * puts the color panel away is spent doing so (`Popover`'s `spends`), and
 * draws nothing.
 */
export const onCanvas = (path: readonly EventTarget[]): boolean =>
	path.some((each) => each instanceof Element && each.matches(CANVAS));
