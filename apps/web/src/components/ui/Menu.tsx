import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { classes } from './classes.js';
import { IconButton } from './IconButton.js';

export interface MenuItem {
	readonly id: string;
	readonly label: string;
	readonly onSelect: () => void;
	readonly disabled?: boolean;
	readonly shortcut?: string;
	/** An item that destroys something: drawn in `--bad`. */
	readonly danger?: boolean;
}

/** Closed, or open with focus to go to the first item or, from ArrowUp, the last. */
type Open = 'closed' | 'first' | 'last';

type Align = 'start' | 'end';

/** The items the arrow keys move among: a disabled one is read, but passed over. */
const enabledItems = (menu: HTMLElement): HTMLElement[] => [
	...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])'),
];

/** Where a key moves focus from `at` among `count` items, wrapping; `at` is -1 off the items. */
const moveTo = (key: string, at: number, count: number): number | undefined => {
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	if (key === 'ArrowDown') return (at + 1) % count;
	if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
	return undefined;
};

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

/** Where a menu in the top layer sits: from the window's top left, and as tall as it may be. */
type Place = Readonly<{ top: number; left: number; maxHeight: number }>;

/** Between the button and its menu, and between a menu and the window's edge, in CSS pixels. */
const GAP = 4;
const MARGIN = 8;

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
 * Whether the browser has the Popover API. jsdom has not, and yet hides an
 * element that asks for it, so the attribute is given only where it works.
 */
const HAS_POPOVER = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/**
 * Puts the menu in the top layer, out of every panel's overflow and over
 * everything, where the browser can; whether it could. Elsewhere the menu
 * stays where it is in the page.
 */
const raise = (list: HTMLElement): boolean => {
	if (!HAS_POPOVER) return false;
	list.showPopover();
	return true;
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
 * that clips what overflows it, as the dock does, does not cut it off.
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

	const close = () => {
		setOpen('closed');
		button.current?.focus();
	};

	const choose = (item: MenuItem) => {
		if (item.disabled === true) return;
		// The focus goes back before the item acts, so that an item which opens
		// something of its own is not then robbed of the focus it took.
		close();
		item.onSelect();
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

	const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			event.preventDefault();
			// The menu's own, not also the sheet's or the dialog's it may be in.
			event.stopPropagation();
			close();
			return;
		}
		if (event.key === 'Tab') {
			setOpen('closed');
			return;
		}
		if (list.current === null) return;
		const enabled = enabledItems(list.current);
		if (enabled.length === 0) return;
		const at = enabled.findIndex((item) => item === event.target);
		const to = moveTo(event.key, at, enabled.length);
		if (to === undefined) return;
		event.preventDefault();
		enabled[to]?.focus();
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
				<div
					ref={list}
					id={id}
					role="menu"
					aria-label={label}
					tabIndex={-1}
					popover={HAS_POPOVER ? 'manual' : undefined}
					style={place}
					className={classes('menu-list', `menu-${align ?? fitted}`)}
					onKeyDown={onMenuKeyDown}
				>
					{items.map((item, index) => {
						// The key is the item's description, not part of its name: the
						// name is what is shown, so that a voice saying it is understood.
						const keyId =
							item.shortcut === undefined ? undefined : `${id}-key-${index}`;
						return (
							<button
								key={item.id}
								type="button"
								role="menuitem"
								tabIndex={-1}
								className={classes(
									'menu-item',
									item.danger === true && 'menu-item-danger'
								)}
								aria-disabled={item.disabled === true || undefined}
								aria-describedby={keyId}
								onClick={() => choose(item)}
							>
								<span className="menu-item-label">{item.label}</span>
								{item.shortcut !== undefined && (
									<kbd id={keyId} className="menu-shortcut" aria-hidden="true">
										{item.shortcut}
									</kbd>
								)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
};
