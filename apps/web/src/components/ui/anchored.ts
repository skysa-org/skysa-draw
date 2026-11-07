import { MARGIN } from './MenuList.js';

/**
 * What a menu at a point (`ContextMenu`) and a popover beside its button
 * (`Popover`) share: where each starts along an axis, against what it opens
 * from, and where the focus goes back to when it closes.
 */

/** Between a control and what it opens beside it, in CSS pixels. */
export const GAP = 4;

/**
 * Where something `size` long starts along one axis, lined up with the span
 * `from` to `to` of what it opens from, going `toward` the end of the axis or
 * back from it: its start at `from`, ahead, where there is the room ahead;
 * its end at `to`, behind, where there is the room only behind; and where
 * there is neither, as little short of ahead as the window needs. Never past
 * `MARGIN` nor `far`, whatever the room; a span outside the window comes in.
 * A point is a span of none. Going back from the end, ahead is the end at
 * `to` and behind the start at `from`. Something beside a span, after it or
 * before it, is lined up with the span between the two gaps: from its far
 * side to its near one.
 */
export const along = (
	from: number,
	to: number,
	size: number,
	far: number,
	toward: 1 | -1
): number => {
	const ahead = toward === 1 ? from : to - size;
	const behind = toward === 1 ? to - size : from;
	const fits = (start: number) => start >= MARGIN && start + size <= far;
	const start = fits(ahead) || !fits(behind) ? ahead : behind;
	return Math.max(MARGIN, Math.min(start, far - size));
};

/** The element with the focus, inside the shadow roots it is in: the canvas keeps one. */
export const focused = (root: DocumentOrShadowRoot): Element | null => {
	const inner = root.activeElement?.shadowRoot;
	return inner?.activeElement instanceof Element ? focused(inner) : root.activeElement;
};

/** Whether the focus is in `opened`, or went with it: to nothing, or to the page's body. */
const holds = (opened: HTMLElement | null): boolean => {
	const now = document.activeElement;
	return now === null || now === document.body || (opened?.contains(now) ?? false);
};

/**
 * Gives the focus back to `to`, what had it when `opened` opened or the
 * button it opened from, if `opened` has it still or took it when it went;
 * not if it has gone somewhere since, as to what a press outside landed on.
 */
export const giveBack = (to: Element | null, opened: HTMLElement | null) => {
	if (!holds(opened) || to === document.body || to?.isConnected !== true) return;
	if (to instanceof HTMLElement || to instanceof SVGElement) to.focus();
};
