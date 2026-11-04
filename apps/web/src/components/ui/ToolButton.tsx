import { type PointerEvent, type ReactNode, useEffect, useRef } from 'react';

import { t } from '../../i18n/t.js';

/** How long a pointer is held before the press is a long one. */
const LONG_PRESS_MS = 500;

/**
 * A tool in the tool bar (docs/ARCHITECTURE.md §7, "The interface"): pressed
 * when it is the active tool, with the tool's key in its tooltip and, when a
 * `badge` is given, a corner mark such as the current color.
 *
 * A long press — the pointer held `LONG_PRESS_MS` without leaving — calls
 * `onLongPress` instead of `onClick`, which a phone has no other way to ask
 * for a tool's options; the click the browser sends as the pointer comes up
 * is then swallowed. A key is never a long press. Pointer Events only, as
 * everything here (docs/decisions/0004-the-interface.md): the one handler sees
 * a finger, a pen and a mouse alike.
 */
export const ToolButton = ({
	icon,
	label,
	shortcut,
	pressed,
	disabled,
	onClick,
	onLongPress,
	badge,
}: {
	icon: ReactNode;
	label: string;
	shortcut?: string;
	pressed?: boolean;
	disabled?: boolean;
	onClick: () => void;
	onLongPress?: () => void;
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
		if (onLongPress === undefined || event.button !== 0) return;
		longPressed.current = false;
		cancel();
		timer.current = setTimeout(() => {
			timer.current = undefined;
			longPressed.current = true;
			onLongPress();
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
			className="icon-button tool-button"
			aria-pressed={pressed}
			aria-label={label}
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
			// A long press is this button's own; the browser's menu for one is not wanted on it.
			onContextMenu={
				onLongPress === undefined ? undefined : (event) => event.preventDefault()
			}
		>
			<span className="tool-button-icon">{icon}</span>
			{badge !== undefined && <span className="tool-button-badge">{badge}</span>}
		</button>
	);
};
