import {
	type CSSProperties,
	Fragment,
	type KeyboardEvent,
	type MouseEvent,
	type PointerEvent,
	type Ref,
} from 'react';

import { classes } from './classes.js';

/**
 * What both menus share (docs/ARCHITECTURE.md §7, "The interface"): the list
 * under a button (`Menu`) and the one at a point (`ContextMenu`) are one list,
 * drawn and keyed here, so that the two cannot come to differ. Where each one
 * sits, and where the focus goes when it closes, are each menu's own.
 */

export interface MenuItem {
	readonly id: string;
	readonly label: string;
	readonly onSelect: () => void;
	readonly disabled?: boolean;
	readonly shortcut?: string;
	/** An item that destroys something: drawn in `--bad`. */
	readonly danger?: boolean;
	/** A rule before this item, beginning a group of its own. */
	readonly separatorBefore?: boolean;
}

/** Why a list asks to be closed: Escape, Tab, or an item chosen. */
export type Closing = 'escape' | 'tab' | 'choice';

/** Where a menu in the top layer sits: from the window's top left, and as tall as it may be. */
export type Place = Readonly<{ top: number; left: number; maxHeight: number }>;

/** Between a menu and the window's edge, in CSS pixels. */
export const MARGIN = 8;

/**
 * Whether the browser has the Popover API. jsdom has not, and yet hides an
 * element that asks for it, so the attribute is given only where it works.
 */
const HAS_POPOVER = typeof HTMLElement !== 'undefined' && 'showPopover' in HTMLElement.prototype;

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

/** The items the arrow keys move among: a disabled one is read, but passed over, and so is a rule. */
export const enabledItems = (menu: HTMLElement): HTMLElement[] => [
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

/**
 * A menu's list, after the WAI-ARIA menu pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/menubar/): the arrows move among
 * the items and wrap, Home and End go to the ends, Enter and Space choose
 * (the item is a button), Escape and Tab close. A disabled item is read but
 * passed over, as a rule is. Choosing closes the list and then lets the item
 * act, so that whatever the item opens of its own has the last word, the
 * focus among it. A key pressed in the list is the list's alone: no tool's
 * key, nor the editor's, nor the sheet's Escape, reaches past it.
 */
export const MenuList = ({
	ref,
	id,
	label,
	items,
	className,
	style,
	onClose,
}: {
	ref: Ref<HTMLDivElement>;
	id: string;
	label: string;
	items: readonly MenuItem[];
	className?: string;
	style?: CSSProperties;
	/** Called to close the list, with why; for Escape and Tab, with the key. */
	onClose: (why: Closing, event?: KeyboardEvent<HTMLDivElement>) => void;
}) => {
	const choose = (item: MenuItem) => {
		if (item.disabled === true) return;
		onClose('choice');
		item.onSelect();
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		event.stopPropagation();
		if (event.key === 'Escape') {
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
		enabled[to]?.focus();
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
			onContextMenu={keepContextMenu}
		>
			{items.map((item, index) => {
				// The key is the item's description, not part of its name: the
				// name is what is shown, so that a voice saying it is understood.
				const keyId = item.shortcut === undefined ? undefined : `${id}-key-${index}`;
				return (
					<Fragment key={item.id}>
						{/* A rule begins a group, so there is none above the first. */}
						{item.separatorBefore === true && index > 0 && (
							<div role="separator" className="menu-separator" />
						)}
						<button
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
					</Fragment>
				);
			})}
		</div>
	);
};
