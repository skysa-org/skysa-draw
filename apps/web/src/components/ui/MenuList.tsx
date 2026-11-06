import {
	type CSSProperties,
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type ReactNode,
	type Ref,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react';

import { classes } from './classes.js';
import { ICONS } from './icons.js';

/**
 * What both menus share (docs/ARCHITECTURE.md §7, "The interface"): the list
 * under a button (`Menu`) and the one at a point (`ContextMenu`) are one list,
 * drawn and keyed here, so that the two cannot come to differ; a submenu is
 * that list again, beside the item it opens from. Where each menu sits, and
 * where the focus goes when it closes, are each menu's own.
 */

export interface MenuItem {
	readonly id: string;
	readonly label: string;
	/**
	 * What choosing the item does. Every item has one, so that a list of them
	 * reads alike; an item with a `submenu` opens it instead, and its
	 * `onSelect` is never called.
	 */
	readonly onSelect: () => void;
	readonly disabled?: boolean;
	readonly shortcut?: string;
	/** An item that destroys something: drawn in `--bad`. */
	readonly danger?: boolean;
	/** A rule before this item, beginning a group of its own. */
	readonly separatorBefore?: boolean;
	/** What the item is drawn as, before its name, as a tool's icon in the tool bar's menus. */
	readonly icon?: ReactNode;
	/**
	 * Whether this is the one in force among the menu's choices, as the tool
	 * in hand among a tool group's: given, the item is a `menuitemradio` and
	 * says so, drawn as a pressed tool is.
	 */
	readonly checked?: boolean;
	/**
	 * A menu of its own, which this item opens beside it, as Photoshop's
	 * Image › Image Rotation does; the item's `onSelect` is not called. The
	 * item is drawn with a chevron at its end, and a disabled one does not
	 * open. What is in it is a menu's in every way: rules, icons, choices,
	 * disabled and destroying items, and submenus of its own.
	 */
	readonly submenu?: readonly MenuItem[];
}

/** Why a list asks to be closed: Escape, Tab, or an item chosen. */
export type Closing = 'escape' | 'tab' | 'choice';

/** Where a menu in the top layer sits: from the window's top left, and as tall as it may be. */
export type Place = Readonly<{ top: number; left: number; maxHeight: number }>;

/**
 * Where a menu placed by its own style sits, a menu at a point or a submenu,
 * and the point in it that it grows from: the one it was opened at, or the
 * side of it the item it opens from is on.
 */
export type Spot = Place & Readonly<{ position: 'fixed'; transformOrigin: string }>;

/** Between a menu and the window's edge, in CSS pixels. */
export const MARGIN = 8;

/** How long, in milliseconds, a mouse or a pen rests on an item before its submenu opens. */
const OPEN_AFTER = 200;

/**
 * How long it rests on another item before an open submenu closes, or gives
 * way to that item's: longer, so that the pointer can cross an item or two
 * on its way over to the submenu, as it does going there on a slant.
 */
const CLOSE_AFTER = 300;

/**
 * Whether the browser has the Popover API. jsdom has not, and yet hides an
 * element that asks for it, so the attribute is given only where it works:
 * by a menu, and by what else goes in the top layer (`Applying.tsx`).
 */
export const HAS_POPOVER =
	typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

/**
 * Puts the menu in the top layer, out of every panel's overflow and over
 * everything, where the browser can; whether it could. Elsewhere the menu
 * stays where it is in the page. Once: a menu placed again while it is open
 * is open already, and some browsers throw on a second `showPopover`.
 */
export const raise = (list: HTMLElement): boolean => {
	if (!HAS_POPOVER) return false;
	if (!list.matches(':popover-open')) list.showPopover();
	return true;
};

/**
 * The items the arrow keys move among: a disabled one is read, but passed
 * over, and so is a rule. The list's own, and not those of a submenu open in it.
 */
export const enabledItems = (menu: HTMLElement): HTMLElement[] => [
	...menu.querySelectorAll<HTMLElement>(
		':scope > [role^="menuitem"]:not([aria-disabled="true"])'
	),
];

/** The focus to the first item that can be chosen, or to the list itself where none can, so that Escape still closes it. */
export const focusFirst = (menu: HTMLElement) => {
	(enabledItems(menu)[0] ?? menu).focus();
};

/** Where a key moves focus from `at` among `count` items, wrapping; `at` is -1 off the items. */
const moveTo = (key: string, at: number, count: number): number | undefined => {
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	if (key === 'ArrowDown') return (at + 1) % count;
	if (key === 'ArrowUp') return at < 0 ? count - 1 : (at - 1 + count) % count;
	return undefined;
};

/** Whether an item opens a submenu: it has one, and can be chosen. */
const opens = (item: MenuItem): boolean => item.submenu !== undefined && item.disabled !== true;

/** Whether the line runs right to left where `element` is. */
const isRtl = (element: Element): boolean => getComputedStyle(element).direction === 'rtl';

/** The arrow into a submenu, toward the end of the line: ArrowRight, or ArrowLeft in a right-to-left language. */
const intoKey = (element: Element): string => (isRtl(element) ? 'ArrowLeft' : 'ArrowRight');

/** The arrow back out of a submenu, toward the item it opens from. */
const outKey = (element: Element): string => (isRtl(element) ? 'ArrowRight' : 'ArrowLeft');

/**
 * Where a submenu `width` wide starts across, beside `menu`, the menu it
 * opens from: after it, toward the end of the line, where there is the room;
 * before it where there is the room only there; and where there is the room
 * on neither side, as on a phone, over it from the side with more room,
 * rather than past the window's edge. Never past `MARGIN` nor `end`.
 */
const across = (menu: DOMRect, width: number, end: number, rtl: boolean): number => {
	const right = { start: menu.right, room: end - menu.right };
	const left = { start: menu.left - width, room: menu.left - MARGIN };
	const [ahead, behind] = rtl ? [left, right] : [right, left];
	const fits = (start: number) => start >= MARGIN && start + width <= end;
	const side =
		fits(ahead.start) || (!fits(behind.start) && ahead.room >= behind.room) ? ahead : behind;
	return Math.max(MARGIN, Math.min(side.start, end - width));
};

/**
 * Where a submenu goes, measured as it is, beside `item`, the item it opens
 * from: across as `across` says; down, with its first item level with `item`,
 * or as much higher as keeps it in the window, and as tall as fits with the
 * rest scrolling; growing from the side of it that `item` is on.
 */
const besideFor = (item: HTMLElement, list: HTMLElement): Spot => {
	const view = document.documentElement;
	const foot = view.clientHeight - MARGIN;
	const box = item.getBoundingClientRect();
	const width = list.offsetWidth;
	const menu = (item.parentElement ?? item).getBoundingClientRect();
	const left = across(menu, width, view.clientWidth - MARGIN, isRtl(item));
	// Up by the list's edge and padding, so that its first item is level with
	// `item`, rather than its edge.
	const inset = list.clientTop + (Number.parseFloat(getComputedStyle(list).paddingTop) || 0);
	const top = Math.max(MARGIN, Math.min(box.top - inset, foot - list.scrollHeight));
	const fromLeft = left + width / 2 >= box.left + box.width / 2;
	return {
		position: 'fixed',
		top,
		left,
		maxHeight: Math.max(0, foot - top),
		transformOrigin: `${fromLeft ? 0 : width}px ${box.top - top}px`,
	};
};

/**
 * A press in a menu is the menu's: it does not reach what the menu is drawn
 * over, as the canvas under a context menu, which would begin a stroke.
 */
const keepPress = (event: PointerEvent<HTMLDivElement>) => {
	event.stopPropagation();
};

/** No browser menu over ours, and no second one of ours from what holds it. */
const keepContextMenu = (event: MouseEvent<HTMLDivElement>) => {
	event.preventDefault();
	event.stopPropagation();
};

const ChevronIcon = ICONS.chevronRight;

/** What an item shows: its icon, its name, its key, and a chevron toward the submenu it opens. */
const ItemFace = ({ item, keyId }: Readonly<{ item: MenuItem; keyId: string | undefined }>) => (
	<>
		{item.icon !== undefined && (
			<span className="menu-item-icon" aria-hidden="true">
				{item.icon}
			</span>
		)}
		<span className="menu-item-label">{item.label}</span>
		{item.shortcut !== undefined && (
			<kbd id={keyId} className="menu-shortcut" aria-hidden="true">
				{item.shortcut}
			</kbd>
		)}
		{item.submenu !== undefined && (
			<span className="menu-item-more" aria-hidden="true">
				<ChevronIcon size={16} />
			</span>
		)}
	</>
);

/** The item whose submenu is open, and whether the focus went into it as it opened. */
type Opened = Readonly<{ id: string; enter: boolean }>;

type OnClose = (why: Closing, event?: KeyboardEvent<HTMLDivElement>) => void;

/**
 * A menu's list, after the WAI-ARIA menu pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): the arrows move among
 * the items and wrap, Home and End go to the ends, Enter and Space choose
 * (the item is a button), Escape and Tab close. A disabled item is read but
 * passed over, as a rule is. Choosing closes the list and then lets the item
 * act, so that whatever the item opens of its own has the last word, the
 * focus among it. A key pressed in the list is the list's alone: no tool's
 * key, nor the editor's, nor the sheet's Escape, reaches past it.
 *
 * An item with a submenu is a `menuitem` that says it has a menu and whether
 * it is open. ArrowRight, or ArrowLeft in a right-to-left language, Enter,
 * Space and a press open it, with the focus on its first item; a mouse or a
 * pen resting on the item opens it after a moment, leaving the focus on the
 * item, and resting on another item closes it after a longer one, so that
 * going over to it on a slant does not. In the submenu, the arrow back and
 * Escape close it alone, the focus back on its item; a choice there closes
 * every list and then acts, and so does Tab, as here. It is this list again,
 * in the top layer beside its item (`Submenu`).
 */
export const MenuList = ({
	ref,
	id,
	label,
	items,
	className,
	style,
	nested = false,
	onClose,
}: {
	ref: Ref<HTMLDivElement>;
	id: string;
	label: string;
	items: readonly MenuItem[];
	className?: string;
	style?: CSSProperties;
	/** Whether the list is a submenu, which the arrow back toward its item closes as Escape does. */
	nested?: boolean;
	/** Called to close the list, with why; for Escape and Tab, with the key. */
	onClose: OnClose;
}) => {
	const [opened, setOpened] = useState<Opened | undefined>(undefined);
	// The item whose submenu is open, and the submenu.
	const from = useRef<HTMLButtonElement>(null);
	const sublist = useRef<HTMLDivElement>(null);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const wait = () => {
		clearTimeout(timer.current);
	};

	// Nothing waiting on the pointer acts once the list is gone.
	useEffect(() => wait, []);

	// The focus in the submenu goes back to its item first, rather than with it.
	const closeSubmenu = () => {
		wait();
		if (sublist.current?.contains(document.activeElement) === true) from.current?.focus();
		setOpened(undefined);
	};

	const openSubmenu = (item: MenuItem, enter: boolean) => {
		wait();
		if (opened?.id !== item.id) {
			setOpened({ id: item.id, enter });
			return;
		}
		if (enter && sublist.current !== null) focusFirst(sublist.current);
	};

	const choose = (item: MenuItem) => {
		if (item.disabled === true) return;
		if (item.submenu !== undefined) {
			openSubmenu(item, true);
			return;
		}
		onClose('choice');
		item.onSelect();
	};

	// Escape and the arrow back close the submenu alone; a choice or Tab
	// there is every list's, and goes on to what holds this one.
	const onSubmenuClose: OnClose = (why, event) => {
		if (why === 'escape') {
			closeSubmenu();
			return;
		}
		setOpened(undefined);
		onClose(why, event);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		event.stopPropagation();
		if (event.key === 'Escape' || (nested && event.key === outKey(event.currentTarget))) {
			event.preventDefault();
			onClose('escape', event);
			return;
		}
		if (event.key === 'Tab') {
			onClose('tab', event);
			return;
		}
		const enabled = enabledItems(event.currentTarget);
		if (enabled.length === 0) return;
		const at = enabled.findIndex((item) => item === event.target);
		const to = moveTo(event.key, at, enabled.length);
		if (to === undefined) return;
		event.preventDefault();
		// Moving off an item closes what it opened, as moving off it with the pointer does.
		closeSubmenu();
		enabled[to]?.focus();
	};

	const onItemKeyDown = (item: MenuItem) => (event: KeyboardEvent<HTMLButtonElement>) => {
		if (event.key !== intoKey(event.currentTarget) || !opens(item)) return;
		event.preventDefault();
		openSubmenu(item, true);
	};

	// A finger's press is a tap, and only the tap opens; a mouse or a pen
	// resting on an item is the pointer's way to it.
	const onItemEnter = (item: MenuItem) => (event: PointerEvent<HTMLButtonElement>) => {
		wait();
		if (event.pointerType === 'touch' || opened?.id === item.id) return;
		const button = event.currentTarget;
		const after = opened === undefined ? OPEN_AFTER : CLOSE_AFTER;
		if (opens(item)) {
			timer.current = setTimeout(() => {
				button.focus();
				openSubmenu(item, false);
			}, after);
			return;
		}
		if (opened !== undefined) timer.current = setTimeout(closeSubmenu, after);
	};

	// The pointer gone over into the open submenu, on its way from its item:
	// nothing waiting closes it. Gone out of every list, nothing waiting acts.
	const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
		if (event.target instanceof Node && sublist.current?.contains(event.target) === true)
			wait();
	};

	return (
		<div
			ref={ref}
			id={id}
			role="menu"
			aria-label={label}
			tabIndex={-1}
			popover={HAS_POPOVER ? 'manual' : undefined}
			style={style}
			className={classes('menu-list', className)}
			onKeyDown={onKeyDown}
			onPointerDown={keepPress}
			onPointerOver={onPointerOver}
			onPointerLeave={wait}
			onContextMenu={keepContextMenu}
		>
			{items.map((item, index) => {
				// The key is the item's description, not part of its name: the
				// name is what is shown, so that a voice saying it is understood.
				const keyId = item.shortcut === undefined ? undefined : `${id}-key-${index}`;
				const subId = `${id}-menu-${index}`;
				const parent = item.submenu !== undefined;
				const open = opened?.id === item.id && opens(item);
				return (
					<Fragment key={item.id}>
						{/* A rule begins a group, so there is none above the first. */}
						{item.separatorBefore === true && index > 0 && (
							<div role="separator" className="menu-separator" />
						)}
						<button
							ref={open ? from : undefined}
							type="button"
							role={
								parent || item.checked === undefined ? 'menuitem' : 'menuitemradio'
							}
							aria-checked={parent ? undefined : item.checked}
							aria-haspopup={parent ? 'menu' : undefined}
							aria-expanded={parent ? open : undefined}
							aria-controls={open ? subId : undefined}
							tabIndex={-1}
							className={classes(
								'menu-item',
								item.danger === true && 'menu-item-danger'
							)}
							aria-disabled={item.disabled === true || undefined}
							aria-describedby={keyId}
							onClick={() => choose(item)}
							onKeyDown={parent ? onItemKeyDown(item) : undefined}
							onPointerEnter={onItemEnter(item)}
						>
							<ItemFace item={item} keyId={keyId} />
						</button>
						{open && item.submenu !== undefined && (
							<Submenu
								listRef={sublist}
								from={from}
								id={subId}
								label={item.label}
								items={item.submenu}
								enter={opened.enter}
								onClose={onSubmenuClose}
							/>
						)}
					</Fragment>
				);
			})}
		</div>
	);
};

/**
 * An item's submenu (`MenuItem.submenu`): the same list, keys and all, in the
 * top layer where the browser has the Popover API and fixed in place where it
 * has not, placed beside `from`, its item, before it is painted (`besideFor`).
 * It is inside the list it opens from, so that a press, a scroll or the focus
 * in it are in that menu still, for whatever closes the menu on them.
 */
const Submenu = ({
	listRef,
	from,
	id,
	label,
	items,
	enter,
	onClose,
}: Readonly<{
	listRef: RefObject<HTMLDivElement | null>;
	from: RefObject<HTMLButtonElement | null>;
	id: string;
	label: string;
	items: readonly MenuItem[];
	/** Whether the focus goes into it as it opens: from a key or a press, not from the pointer resting. */
	enter: boolean;
	onClose: OnClose;
}>) => {
	const [spot, setSpot] = useState<Spot | undefined>(undefined);

	useLayoutEffect(() => {
		if (listRef.current === null || from.current === null) return;
		raise(listRef.current);
		setSpot(besideFor(from.current, listRef.current));
	}, [listRef, from]);

	useEffect(() => {
		if (enter && listRef.current !== null) focusFirst(listRef.current);
	}, [enter, listRef]);

	return (
		<MenuList
			ref={listRef}
			id={id}
			label={label}
			items={items}
			nested
			style={spot}
			className="menu-submenu"
			onClose={onClose}
		/>
	);
};
