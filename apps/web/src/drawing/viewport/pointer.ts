import type { PointerSample } from '../tools/types.js';
import { toUser, type View } from './transform.js';

/**
 * A pointer event as a tool sees it (docs/ARCHITECTURE.md §7, "Input"):
 * Pointer Events only, read into user units through the view's inverse, with
 * what the device says of pressure and tilt. Pure over the event's fields, so
 * a sample is tested from a plain object; the viewport hands it the live event.
 */
export type PointerEventLike = Readonly<{
	clientX: number;
	clientY: number;
	pressure: number;
	tiltX: number;
	tiltY: number;
	pointerType: string;
	timeStamp: number;
	shiftKey: boolean;
	altKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
}>;

/** What a device that does not say pressure is taken to press at. */
const DEFAULT_PRESSURE = 0.5;

/** The three kinds a pointer can be; anything the browser calls otherwise is a mouse. */
export const pointerTypeOf = (type: string): PointerSample['pointerType'] =>
	type === 'pen' || type === 'touch' ? type : 'mouse';

/**
 * A mouse always presses at the default: the spec says 0.5 while a button is
 * down, and some browsers say 0 on a move, which would draw nothing.
 * A pen or a finger presses as it says, held to 0 to 1.
 */
const pressureOf = (event: PointerEventLike): number => {
	if (pointerTypeOf(event.pointerType) === 'mouse') return DEFAULT_PRESSURE;
	return Number.isFinite(event.pressure)
		? Math.min(1, Math.max(0, event.pressure))
		: DEFAULT_PRESSURE;
};

/** A tilt a device does not report, or a fake event lacks, is upright. */
const tiltOf = (value: number | undefined): number =>
	value !== undefined && Number.isFinite(value) ? value : 0;

/**
 * The event's point in user units, with the view as it is at this moment and
 * the viewport's corner on the page, and what else the tool reads of it.
 */
export const sampleFrom = (
	event: PointerEventLike,
	view: View,
	rect: Readonly<{ left: number; top: number }>,
	isMac: boolean
): PointerSample => {
	const [x, y] = toUser(view, event.clientX - rect.left, event.clientY - rect.top);
	return {
		x,
		y,
		pressure: pressureOf(event),
		tiltX: tiltOf(event.tiltX),
		tiltY: tiltOf(event.tiltY),
		pointerType: pointerTypeOf(event.pointerType),
		time: event.timeStamp,
		shiftKey: event.shiftKey,
		altKey: event.altKey,
		primaryKey: isMac ? event.metaKey : event.ctrlKey,
		controlKey: event.ctrlKey,
	};
};

/** Whether a platform string names Apple's: an iPad with a keyboard has ⌘ too. */
export const isMacPlatform = (platform: string | undefined): boolean =>
	/mac|iphone|ipad|ipod/i.test(platform ?? '');

/**
 * Whether the primary key is ⌘. `userAgentData.platform` where the browser has
 * it (Chromium; not in TypeScript's DOM types yet), else the user agent string,
 * which is the one `navigator` field that is not deprecated. Without a
 * `navigator` at all, not a Mac, which only means Ctrl.
 */
export const isMac = (): boolean => {
	if (typeof navigator === 'undefined') return false;
	const hinted = (navigator as Navigator & { userAgentData?: { platform?: string } })
		.userAgentData?.platform;
	return isMacPlatform(hinted ?? navigator.userAgent);
};
