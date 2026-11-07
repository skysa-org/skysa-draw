import {
	type ReactNode,
	type RefObject,
	useEffect,
	useEffectEvent,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { along, GAP, giveBack } from './anchored.js';
import { HAS_POPOVER, MARGIN, raise, type Spot } from './MenuList.js';
import type { Orientation } from './ToolBar.js';

/** What a popover is placed by: its button, itself and the window, as they are now. */
export type Beside = Readonly<{
	/** The button's box, from the window's top left. */
	box: Readonly<{ top: number; right: number; bottom: number; left: number }>;
	/** The popover's own width and height, as tall as what it holds. */
	width: number;
	height: number;
	/** The window's width and height. */
	view: Readonly<{ width: number; height: number }>;
	/** Whether the line runs right to left where the button is. */
	rtl: boolean;
	/** Which way the bar the button is in runs. */
	orientation: Orientation;
}>;

/**
 * Where a popover goes beside its button, toward the canvas, as a folded tool
 * group's menu does (`ToolGroups`): from a bar that runs down, beside it,
 * toward the end of the line, or back from it where the window has not the
 * room, its top lined up with the button's, or its foot with the button's
 * where there is no room under it; from a bar that runs across, under it or,
 * where there is not the room under it, over it, as at the foot of a compact
 * window, its start lined up with the button's, or its end with the button's
 * end. Never past an edge, never over the button across the bar, and as tall
 * as fits, the rest scrolling; growing from the button.
 */
export const spotBeside = ({ box, width, height, view, rtl, orientation }: Beside): Spot => {
	const end = view.width - MARGIN;
	const foot = view.height - MARGIN;
	const toward = rtl ? -1 : 1;
	const at = (top: number, left: number, maxHeight: number): Spot => ({
		position: 'fixed',
		top,
		left,
		maxHeight,
		transformOrigin: `${(box.left + box.right) / 2 - left}px ${(box.top + box.bottom) / 2 - top}px`,
	});
	if (orientation === 'vertical') {
		const top = along(box.top, box.bottom, height, foot, 1);
		const left = along(box.right + GAP, box.left - GAP, width, end, toward);
		return at(top, left, Math.max(0, foot - top));
	}
	const below = foot - box.bottom - GAP;
	const above = box.top - GAP - MARGIN;
	const under = height <= below || below >= above;
	const room = Math.max(0, under ? below : above);
	const top = under ? box.bottom + GAP : box.top - GAP - Math.min(height, room);
	return at(top, along(box.left, box.right, width, end, toward), room);
};

/**
 * A panel opened from a button and placed beside it (docs/ARCHITECTURE.md
 * §7, "The interface"), as the colors' button opens the color panel: a
 * dialog, not modal, in the menus' container, in the top layer where the
 * browser has the Popover API and in place, `position: fixed`, where it has
 * not. Where it goes is `spotBeside`'s, and it is placed again as the window,
 * what it holds or the page under it changes size, rather than closing as a
 * menu does: a phone's keyboard, coming up for a field in it, changes the
 * window's.
 *
 * Open while `open` is, after its button in the page, so that Tab goes from
 * the button into it and on out of it to what follows. The focus goes into
 * it as it opens and, when it closes, back to its button, if it has the focus
 * still or lost it as it went. `onClose` is called when it should: on Escape
 * in it, unless something in it took the key already, as a field going back
 * to its value; and on a press outside it, that one also going on to what it
 * landed on, but where `spends` says the press is spent in closing it, as one
 * on the canvas is, so that a tap to put it away draws nothing. A press on
 * its button is the button's, which closes it as a toggle. The window losing
 * the focus does not close it: the system's color picker, opened from a field
 * in it, is a window of its own.
 */
export const Popover = ({
	id,
	label,
	open,
	anchor,
	orientation,
	onClose,
	spends,
	children,
}: Readonly<{
	id?: string;
	label: string;
	open: boolean;
	/** The button it opens from, which it is placed beside. */
	anchor: RefObject<HTMLElement | null>;
	/** Which way the bar the button is in runs. */
	orientation: Orientation;
	onClose: () => void;
	/** Whether a press outside, by its path (`composedPath()`), is spent in closing it. */
	spends?: (path: readonly EventTarget[]) => boolean;
	children: ReactNode;
}>) => {
	const ref = useRef<HTMLDivElement>(null);
	const [spot, setSpot] = useState<Spot | undefined>(undefined);

	// When it closes, the focus back to its button, however it closes.
	useLayoutEffect(() => {
		if (!open) return undefined;
		const element = ref.current;
		const button = anchor.current;
		return () => giveBack(button, element);
	}, [open, anchor]);

	// Placed before it is painted, and again whenever what it is placed by
	// changes size or moves. It is what scrolls, so that what it holds is
	// measured at its own height, however little of it there is room for.
	useLayoutEffect(() => {
		const element = ref.current;
		const button = anchor.current;
		if (!open || element === null || button === null) return undefined;
		raise(element);
		const place = () => {
			const view = document.documentElement;
			setSpot(
				spotBeside({
					box: button.getBoundingClientRect(),
					width: element.offsetWidth,
					// What it holds, and its own border, which `scrollHeight` leaves out.
					height: element.scrollHeight + element.offsetHeight - element.clientHeight,
					view: { width: view.clientWidth, height: view.clientHeight },
					rtl: getComputedStyle(button).direction === 'rtl',
					orientation,
				})
			);
		};
		const onScroll = (event: Event) => {
			if (event.target instanceof Node && element.contains(event.target)) return;
			place();
		};
		place();
		const observer =
			typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined;
		observer?.observe(element);
		window.addEventListener('resize', place);
		document.addEventListener('scroll', onScroll, true);
		return () => {
			observer?.disconnect();
			window.removeEventListener('resize', place);
			document.removeEventListener('scroll', onScroll, true);
			setSpot(undefined);
		};
	}, [open, anchor, orientation]);

	useEffect(() => {
		if (open) ref.current?.focus({ preventScroll: true });
	}, [open]);

	const pressedOutside = useEffectEvent((event: PointerEvent) => {
		const path = event.composedPath();
		const own = [ref.current, anchor.current];
		if (own.some((each) => each !== null && path.includes(each))) return;
		// Before what it landed on hears of it: this is the capture phase.
		if (spends?.(path) === true) event.stopPropagation();
		onClose();
	});
	useEffect(() => {
		if (!open) return undefined;
		const onPress = (event: PointerEvent) => {
			pressedOutside(event);
		};
		document.addEventListener('pointerdown', onPress, true);
		return () => document.removeEventListener('pointerdown', onPress, true);
	}, [open]);

	// Escape in it, on the document, which hears it after what is in it,
	// React's handlers among them, has had the chance to take it.
	const escaped = useEffectEvent((event: KeyboardEvent) => {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		if (ref.current === null || !event.composedPath().includes(ref.current)) return;
		event.preventDefault();
		onClose();
	});
	useEffect(() => {
		if (!open) return undefined;
		const onKey = (event: KeyboardEvent) => {
			escaped(event);
		};
		document.addEventListener('keydown', onKey);
		return () => document.removeEventListener('keydown', onKey);
	}, [open]);

	if (!open) return null;

	return (
		<div
			ref={ref}
			id={id}
			role="dialog"
			aria-modal="false"
			aria-label={label}
			tabIndex={-1}
			popover={HAS_POPOVER ? 'manual' : undefined}
			className="popover"
			style={spot ?? { position: 'fixed', top: MARGIN, left: MARGIN }}
		>
			{children}
		</div>
	);
};
