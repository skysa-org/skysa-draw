import {
	type KeyboardEvent,
	useEffect,
	useEffectEvent,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { along, focused, giveBack } from './anchored.js';
import {
	type Closing,
	focusFirst,
	MARGIN,
	type MenuItem,
	MenuList,
	raise,
	type Spot,
} from './MenuList.js';

/** Where a context menu opens: a point in the window, in CSS pixels from its top left. */
export type MenuPoint = Readonly<{ x: number; y: number }>;

/** Where the menu goes for `at`, measured as it is: as tall as fits, the rest scrolling. */
const spotFor = (at: MenuPoint, list: HTMLElement): Spot => {
	const view = document.documentElement;
	const end = view.clientWidth - MARGIN;
	const foot = view.clientHeight - MARGIN;
	// Across, toward the end of the line: rightward, or leftward in a
	// right-to-left language; down, under the point.
	const rtl = getComputedStyle(list).direction === 'rtl';
	const left = along(at.x, at.x, list.offsetWidth, end, rtl ? -1 : 1);
	const top = along(at.y, at.y, list.scrollHeight, foot, 1);
	return {
		position: 'fixed',
		top,
		left,
		maxHeight: Math.max(0, foot - top),
		transformOrigin: `${at.x - left}px ${at.y - top}px`,
	};
};

/**
 * A menu opened at a point rather than from a button (docs/decisions/
 * 0004-the-interface.md, "The context menu"): what a right-click, a pen's
 * barrel button or the keyboard's menu key opens over the canvas. Open while
 * `at` is a point, in the top layer where the browser has the Popover API and
 * in place, `position: fixed`, where it has not; under the point and toward
 * the end of the line, or over it and back from it where the window has not
 * the room, never past an edge, and as tall as fits with the rest scrolling.
 *
 * The list is `Menu`'s (`MenuList`), keys and all. The focus goes to the first
 * item that can be chosen and, when it closes, back to where it was, however
 * it closes. `onClose` is called when it should: on Escape or Tab, on a
 * choice, on a press, a scroll or a wheel outside it, on the window changing
 * size or losing the focus. On a choice the focus goes back first, then
 * `onClose`, then the item's `onSelect`, as a button's menu does it: what the
 * item does, the focus it takes or another menu it opens, is the last word.
 * Tab is spent closing it, since a menu at a point has no place in the tab
 * order to go on from. An item's submenu is inside the menu, so a press, a
 * scroll or a wheel in it, or the focus in it, are in the menu as well.
 */
export const ContextMenu = ({
	label,
	items,
	at,
	onClose,
}: {
	label: string;
	items: readonly MenuItem[];
	at: MenuPoint | undefined;
	onClose: () => void;
}) => {
	const list = useRef<HTMLDivElement>(null);
	const before = useRef<Element | null>(null);
	const [spot, setSpot] = useState<Spot | undefined>(undefined);
	const id = useId();
	const open = at !== undefined;
	const x = at?.x;
	const y = at?.y;

	// Before the menu takes the focus: what had it, to have it back however
	// the menu closes, by its own keys, by the caller, or by being unmounted.
	useLayoutEffect(() => {
		if (!open) return undefined;
		const was = focused(document);
		const menu = list.current;
		before.current = was;
		return () => giveBack(was, menu);
	}, [open]);

	// Placed before it is painted, and again if it is opened at another point.
	useLayoutEffect(() => {
		if (x === undefined || y === undefined || list.current === null) return;
		raise(list.current);
		setSpot(spotFor({ x, y }, list.current));
	}, [x, y]);

	// The first item that can be chosen; the list itself where none can, so
	// that Escape still closes it.
	useEffect(() => {
		if (x === undefined || y === undefined || list.current === null) return;
		focusFirst(list.current);
	}, [x, y]);

	// Placed once, at its point: when what is under it moves, or the window
	// does, it closes rather than float away from what it was about.
	const dismiss = useEffectEvent(() => {
		onClose();
	});
	useEffect(() => {
		if (!open) return undefined;
		const onOutside = (event: Event) => {
			// By its path, not its target, which a shadow root retargets to its host.
			if (list.current !== null && event.composedPath().includes(list.current)) return;
			dismiss();
		};
		const onWindow = () => {
			dismiss();
		};
		// In the capture phase: before the canvas, which may keep a press to
		// itself, and not for the press that opened the menu, gone by already.
		document.addEventListener('pointerdown', onOutside, true);
		document.addEventListener('scroll', onOutside, true);
		document.addEventListener('wheel', onOutside, { capture: true, passive: true });
		window.addEventListener('resize', onWindow);
		window.addEventListener('blur', onWindow);
		return () => {
			document.removeEventListener('pointerdown', onOutside, true);
			document.removeEventListener('scroll', onOutside, true);
			document.removeEventListener('wheel', onOutside, true);
			window.removeEventListener('resize', onWindow);
			window.removeEventListener('blur', onWindow);
		};
	}, [open]);

	if (at === undefined) return null;

	const onListClose = (why: Closing, event?: KeyboardEvent<HTMLDivElement>) => {
		if (why === 'tab') event?.preventDefault();
		giveBack(before.current, list.current);
		onClose();
	};

	return (
		<MenuList
			ref={list}
			id={id}
			label={label}
			items={items}
			style={spot ?? { position: 'fixed', top: at.y, left: at.x }}
			className="menu-context"
			onClose={onListClose}
		/>
	);
};
