import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { IconButton } from './IconButton.js';
import {
	type Closing,
	enabledItems,
	MARGIN,
	type MenuItem,
	MenuList,
	type Place,
	raise,
} from './MenuList.js';

export type { MenuItem } from './MenuList.js';

/** Closed, or open with focus to go to the first item or, from ArrowUp, the last. */
type Open = 'closed' | 'first' | 'last';

type Align = 'start' | 'end';

/**
 * The side of its button a menu hangs from when the caller has not said: the
 * start, unless the menu would then run past the window's end, as one at the
 * end of a bar would.
 */
const alignFor = (root: HTMLElement, list: HTMLElement): Align => {
	const box = root.getBoundingClientRect();
	const width = list.offsetWidth;
	const overflows =
		getComputedStyle(root).direction === 'rtl'
			? box.right - width < 0
			: box.left + width > document.documentElement.clientWidth;
	return overflows ? 'end' : 'start';
};

/** Between the button and its menu, in CSS pixels. */
const GAP = 4;

/**
 * Where a menu in the top layer goes: under its button, on the side `align`
 * says, or over it where there is more room above than the menu needs below,
 * and never past the window's edges.
 */
const placeFor = (button: HTMLElement, list: HTMLElement, align: Align): Place => {
	const box = button.getBoundingClientRect();
	const view = document.documentElement;
	const width = list.offsetWidth;
	const height = list.scrollHeight;
	const rtl = getComputedStyle(button).direction === 'rtl';
	const startsAtLeft = (align === 'start') !== rtl;
	const left = startsAtLeft ? box.left : box.right - width;
	const below = view.clientHeight - box.bottom - GAP - MARGIN;
	const above = box.top - GAP - MARGIN;
	const under = height <= below || below >= above;
	const room = Math.max(0, under ? below : above);
	return {
		top: under ? box.bottom + GAP : box.top - GAP - Math.min(height, room),
		left: Math.max(MARGIN, Math.min(left, view.clientWidth - width - MARGIN)),
		maxHeight: room,
	};
};

/**
 * A menu under an icon button (docs/ARCHITECTURE.md §7, "The interface"): the
 * top bar's More, a layer's own. After the WAI-ARIA menu button pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/): the arrows move
 * among the items and wrap, Home and End go to the ends, Enter and Space
 * choose, Escape closes and gives the focus back, so does choosing, and a
 * press anywhere else closes it where it is. `align` says which side of the
 * button the menu lines up with; without it the menu finds the side that
 * keeps it in the window. Open, it is in the top layer (`raise`), so a panel
 * that clips what overflows it, as the dock does, does not cut it off. The
 * list itself, its items and its keys, is `MenuList`, which `ContextMenu`
 * shares.
 */
export const Menu = ({
	label,
	icon,
	items,
	align,
}: {
	label: string;
	icon: ReactNode;
	items: readonly MenuItem[];
	align?: Align;
}) => {
	const [open, setOpen] = useState<Open>('closed');
	const [fitted, setFitted] = useState<Align>('start');
	const [place, setPlace] = useState<Place | undefined>(undefined);
	const root = useRef<HTMLDivElement>(null);
	const button = useRef<HTMLButtonElement>(null);
	const list = useRef<HTMLDivElement>(null);
	const id = useId();

	// Measured before the menu is first painted, so it never shows on the wrong side.
	// Each opening is placed afresh, before it is painted, so a place kept from
	// the last one is never seen.
	useLayoutEffect(() => {
		if (open === 'closed') return;
		if (root.current === null || list.current === null || button.current === null) return;
		const side = align ?? alignFor(root.current, list.current);
		setFitted(side);
		setPlace(raise(list.current) ? placeFor(button.current, list.current, side) : undefined);
	}, [open, align]);

	// A menu in the top layer is placed once, by its button: when the page
	// under it scrolls or the window changes size, it closes rather than float
	// away from what opened it.
	useEffect(() => {
		if (open === 'closed') return undefined;
		const onMoved = (event: Event) => {
			if (event.target instanceof Node && list.current?.contains(event.target)) return;
			setOpen('closed');
		};
		window.addEventListener('resize', onMoved);
		document.addEventListener('scroll', onMoved, true);
		return () => {
			window.removeEventListener('resize', onMoved);
			document.removeEventListener('scroll', onMoved, true);
		};
	}, [open]);

	useEffect(() => {
		if (open === 'closed' || list.current === null) return;
		const enabled = enabledItems(list.current);
		(open === 'first' ? enabled[0] : enabled[enabled.length - 1])?.focus();
	}, [open]);

	useEffect(() => {
		if (open === 'closed') return undefined;
		const onPointerDown = (event: Event) => {
			if (event.target instanceof Node && root.current?.contains(event.target)) return;
			setOpen('closed');
		};
		document.addEventListener('pointerdown', onPointerDown);
		return () => document.removeEventListener('pointerdown', onPointerDown);
	}, [open]);

	// The list gives the focus back before the item acts, so that an item
	// which opens something of its own is not then robbed of the focus it
	// took. Tab moves it on from where the menu was, as the pattern has it.
	const onClose = (why: Closing) => {
		setOpen('closed');
		if (why !== 'tab') button.current?.focus();
	};

	const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key === 'Escape' && open !== 'closed') {
			event.preventDefault();
			event.stopPropagation();
			setOpen('closed');
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			setOpen('first');
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			setOpen('last');
		}
	};

	return (
		<div ref={root} className="menu">
			<IconButton
				ref={button}
				icon={icon}
				label={label}
				haspopup="menu"
				expanded={open !== 'closed'}
				controls={open === 'closed' ? undefined : id}
				onClick={() => setOpen(open === 'closed' ? 'first' : 'closed')}
				onKeyDown={onButtonKeyDown}
			/>
			{open !== 'closed' && (
				<MenuList
					ref={list}
					id={id}
					label={label}
					items={items}
					style={place}
					className={`menu-${align ?? fitted}`}
					onClose={onClose}
				/>
			)}
		</div>
	);
};
