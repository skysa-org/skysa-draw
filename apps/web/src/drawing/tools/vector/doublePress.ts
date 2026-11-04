import type { PointerSample } from '../types.js';
import { distance, type Point } from './geometry.js';

/**
 * A double press (docs/decisions/0004-the-interface.md): the canvas hears
 * Pointer Events alone, never `dblclick`, so the select tool tells a double
 * press from two presses itself, the same way for a mouse, a pen and a finger,
 * whose double tap is the same double press. Two presses are one double press
 * when the second lands soon after the first, near it and on the same
 * element, by the same kind of pointer, and the first stayed where it began.
 */

/** The platform's double-click time: Windows' default, and near enough macOS's. */
const DOUBLE_PRESS_MS = 500;

/** How far apart a mouse's or a pen's two presses may be, in CSS pixels: as near as the select tool's hit. */
const SLOP_PX = 4;

/**
 * A finger's: half the 44 px a control is wide, since a fingertip lands
 * anywhere on one. The same element is asked of both presses, so a wider
 * reach never joins taps on two things.
 */
const TOUCH_SLOP_PX = 22;

/** A press that may be the first of a double press: what it was on, where in the drawing, when, and by what. */
export type Press = Readonly<{
	element: Element;
	at: Point;
	time: number;
	pointerType: PointerSample['pointerType'];
}>;

export const pressOf = (element: Element, sample: PointerSample): Press => ({
	element,
	at: { x: sample.x, y: sample.y },
	time: sample.time,
	pointerType: sample.pointerType,
});

const slopOf = (pointerType: PointerSample['pointerType']): number =>
	pointerType === 'touch' ? TOUCH_SLOP_PX : SLOP_PX;

/** Whether `to`, in the drawing's units, is within a press's reach of where `press` was; `scale` is screen pixels per user unit. */
export const near = (press: Press, to: Point, scale: number): boolean =>
	distance(press.at, to) * scale <= slopOf(press.pointerType);

/** Whether `second` makes a double press with `first`. */
export const isDoublePress = (first: Press | undefined, second: Press, scale: number): boolean => {
	if (first === undefined) return false;
	const elapsed = second.time - first.time;
	return (
		first.element === second.element &&
		first.pointerType === second.pointerType &&
		elapsed >= 0 &&
		elapsed <= DOUBLE_PRESS_MS &&
		near(first, second.at, scale)
	);
};
