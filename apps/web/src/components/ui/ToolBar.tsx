import { type FocusEvent, type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

import { classes } from './classes.js';

type Orientation = 'horizontal' | 'vertical';

/** The arrow keys that move along a bar, by the way it runs. */
const ARROWS = {
	horizontal: { next: 'ArrowRight', previous: 'ArrowLeft' },
	vertical: { next: 'ArrowDown', previous: 'ArrowUp' },
} as const;

/**
 * The buttons the arrow keys move among: a disabled one is passed over, and
 * so is the item of a menu open in the bar, whose arrows are the menu's own.
 */
const enabledButtons = (bar: HTMLElement): HTMLButtonElement[] => [
	...bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([role="menuitem"])'),
];

/** Where a key moves focus from `at` among `count` buttons, wrapping at the ends. */
const moveTo = (
	key: string,
	orientation: Orientation,
	at: number,
	count: number
): number | undefined => {
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	if (key === ARROWS[orientation].next) return (at + 1) % count;
	if (key === ARROWS[orientation].previous) return (at - 1 + count) % count;
	return undefined;
};

/**
 * One tab stop for the whole bar: the button focused, else the one focused
 * last, else the first. The others are reached with the arrow keys, not Tab.
 * Written on the buttons themselves, since they are the caller's and arrive
 * as children.
 */
const rove = (bar: HTMLElement, preferred: readonly (Element | null)[]) => {
	const buttons = enabledButtons(bar);
	const stop =
		preferred
			.map((wanted) => buttons.find((button) => button === wanted))
			.find((button) => button !== undefined) ?? buttons[0];
	buttons.forEach((button) => {
		button.tabIndex = button === stop ? 0 : -1;
	});
};

/**
 * A bar of tools or options (docs/ARCHITECTURE.md §7, "The interface"), after
 * the WAI-ARIA toolbar pattern
 * (https://www.w3.org/WAI/ARIA/apg/patterns/toolbar/): one tab stop, the
 * arrow keys along its axis moving focus among its enabled buttons and
 * wrapping, Home and End to the first and the last. A key on something that
 * is not one of its buttons — a slider, a select — is that control's own, as
 * is a key a control inside has already acted on.
 */
export const ToolBar = ({
	orientation,
	label,
	children,
	className,
}: {
	orientation: Orientation;
	label: string;
	children: ReactNode;
	className?: string;
}) => {
	const ref = useRef<HTMLDivElement>(null);
	// The button the bar's tab stop goes back to when focus comes in again.
	const last = useRef<Element | null>(null);

	// After every render, since the children, and which of them is disabled,
	// may have changed with it.
	useEffect(() => {
		if (ref.current !== null) rove(ref.current, [document.activeElement, last.current]);
	});

	// Focus coming to one of the buttons makes it the stop; coming to some
	// other control in the bar leaves the stop where it was.
	const onFocus = (event: FocusEvent<HTMLDivElement>) => {
		if (ref.current === null) return;
		const focused: EventTarget = event.target;
		const button = enabledButtons(ref.current).find((each) => each === focused);
		if (button !== undefined) last.current = button;
		rove(ref.current, [last.current]);
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const bar = ref.current;
		if (bar === null || event.defaultPrevented) return;
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		const buttons = enabledButtons(bar);
		const at = buttons.findIndex((button) => button === event.target);
		if (at === -1) return;
		const to = moveTo(event.key, orientation, at, buttons.length);
		if (to === undefined) return;
		event.preventDefault();
		buttons[to]?.focus();
	};

	return (
		<div
			ref={ref}
			role="toolbar"
			aria-label={label}
			aria-orientation={orientation}
			className={classes('toolbar', `toolbar-${orientation}`, className)}
			onKeyDown={onKeyDown}
			onFocus={onFocus}
		>
			{children}
		</div>
	);
};
