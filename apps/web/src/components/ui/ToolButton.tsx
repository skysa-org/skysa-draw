import { type PointerEvent, type ReactNode, useEffect, useRef } from 'react';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';

/** How long a pointer is held before the press is a long one. */
const LONG_PRESS_MS = 500;

/**
 * A tool in the tool bar (docs/ARCHITECTURE.md §7, "The interface"): pressed
 * when it is the active tool, with the tool's key in its tooltip and, when a
 * `badge` is given, a corner mark such as the current color.
 *
 * With `onMenu`, the button has more under it, as a collapsed tool group has
 * its other tools, and says so (`aria-haspopup`, and a mark in its corner,
 * as Photoshop's tools with more under them have). A long press — the
 * pointer held `LONG_PRESS_MS` without leaving — asks for it, which a phone
 * has no other way to; the click the browser sends as the pointer comes up
 * is then swallowed. So does a right-click, and the keyboard's menu key, which
 * the browser sends as one. A key is never a long press. Pointer Events only,
 * as everything here (docs/decisions/0004-the-interface.md): the one handler
 * sees a finger, a pen and a mouse alike.
 */
export const ToolButton = ({
	icon,
	label,
	shortcut,
	pressed,
	disabled,
	unavailable,
	describedBy,
	onClick,
	onMenu,
	badge,
}: {
	icon: ReactNode;
	label: string;
	shortcut?: string;
	pressed?: boolean;
	disabled?: boolean;
	/**
	 * The tool does nothing where it would act now, as a tool in hand on a
	 * layer of a kind it has no use for: shown faded, and still pressed and
	 * pressable, so it does not vanish from under the hand.
	 */
	unavailable?: boolean;
	/** The ids of what says more than the name, as the colors the color pair holds. */
	describedBy?: string;
	onClick: () => void;
	/** The button's menu asked for, with the button to open it from. */
	onMenu?: (button: HTMLButtonElement) => void;
	badge?: ReactNode;
}) => {
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	// Whether the press now ending was a long one, so the click that follows
	// it is not also a short one.
	const longPressed = useRef(false);

	const cancel = () => {
		if (timer.current === undefined) return;
		clearTimeout(timer.current);
		timer.current = undefined;
	};

	// A button taken down mid-press leaves no timer behind.
	useEffect(() => cancel, []);

	const start = (event: PointerEvent<HTMLButtonElement>) => {
		// Any press begins afresh, a right one too, whose menu is not a long press's.
		longPressed.current = false;
		if (onMenu === undefined || event.button !== 0) return;
		const button = event.currentTarget;
		cancel();
		timer.current = setTimeout(() => {
			timer.current = undefined;
			longPressed.current = true;
			onMenu(button);
		}, LONG_PRESS_MS);
	};

	const click = () => {
		if (longPressed.current) {
			longPressed.current = false;
			return;
		}
		onClick();
	};

	return (
		<button
			type="button"
			// An icon button in looks, and a tool button for its badge.
			className={classes('icon-button tool-button', unavailable === true && 'is-unavailable')}
			aria-pressed={pressed}
			aria-haspopup={onMenu === undefined ? undefined : 'menu'}
			aria-label={label}
			aria-describedby={describedBy}
			title={shortcut === undefined ? label : t('ui.labelWithShortcut', { label, shortcut })}
			disabled={disabled}
			onClick={click}
			// A press that went long and was let go off the button sent no click
			// to swallow; the keyboard's click is never the one meant.
			onKeyDown={() => {
				longPressed.current = false;
			}}
			onPointerDown={start}
			onPointerUp={cancel}
			onPointerLeave={cancel}
			onPointerCancel={cancel}
			// The button's own menu, for a right-click and the menu key, in
			// place of the browser's; a long press is already one, so the menu
			// a touch screen sends after it is not a second.
			onContextMenu={
				onMenu === undefined
					? undefined
					: (event) => {
							event.preventDefault();
							if (longPressed.current || timer.current !== undefined) return;
							onMenu(event.currentTarget);
						}
			}
		>
			<span className="tool-button-icon">{icon}</span>
			{badge !== undefined && <span className="tool-button-badge">{badge}</span>}
		</button>
	);
};
