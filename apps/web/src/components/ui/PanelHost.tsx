import { type PointerEvent, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

import { t } from '../../i18n/t.js';
import { classes } from './classes.js';

type Placement = 'sheet' | 'drawer' | 'dock';
type Side = 'start' | 'end';

/** How far down a sheet is let go before it closes rather than settling. */
const DISMISS_PX = 96;

/** The class every sheet and drawer has, by which the topmost one is found. */
const HOST = 'panel-host';

/**
 * The sheet's grab handle. Dragged up it makes the sheet taller, to
 * `--sheet-max`; dragged down it makes it shorter, and let go far enough down
 * it closes. The pointer is captured so a drag that leaves the handle still
 * ends on it. The sheet is the handle's parent, sized directly while the drag
 * lasts: a height in state would render the panel inside at every move.
 */
const SheetHandle = ({ onClose }: { onClose: () => void }) => {
	const drag = useRef<{ y: number; height: number } | undefined>(undefined);

	const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
		const sheet = event.currentTarget.parentElement;
		if (sheet === null) return;
		drag.current = { y: event.clientY, height: sheet.offsetHeight };
		event.currentTarget.setPointerCapture(event.pointerId);
	};

	const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const sheet = event.currentTarget.parentElement;
		if (sheet === null || drag.current === undefined) return;
		const height = drag.current.height - (event.clientY - drag.current.y);
		sheet.style.height = `${Math.max(0, height)}px`;
	};

	const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
		const from = drag.current;
		const sheet = event.currentTarget.parentElement;
		drag.current = undefined;
		if (sheet === null || from === undefined) return;
		const down = event.clientY - from.y;
		if (down > DISMISS_PX) {
			onClose();
			return;
		}
		// Let go a little way down, it settles back to its own height.
		if (down > 0) sheet.style.height = '';
	};

	return (
		<div
			className="sheet-handle"
			role="separator"
			aria-orientation="horizontal"
			aria-label={t('ui.sheetHandle')}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		/>
	);
};

/**
 * A sheet or a drawer: a dialog over the canvas, not modal — the canvas is
 * still there to look at and the sheet is put away by a tap beside it, by
 * Escape, or by its handle. Focus moves in as it opens and goes back to what
 * opened it as it closes. In a portal, so no transform or overflow of the
 * frame's can hold a fixed box in.
 */
const Floating = ({
	placement,
	side,
	label,
	onClose,
	children,
}: {
	placement: 'sheet' | 'drawer';
	side: Side;
	label: string;
	onClose: () => void;
	children: ReactNode;
}) => {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const opener = document.activeElement;
		ref.current?.focus();
		return () => {
			if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
		};
	}, []);

	// Escape closes the one on top, and not when something inside it — a
	// field reverting, a menu closing — has already taken the key.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape' || event.defaultPrevented) return;
			const hosts = document.querySelectorAll(`.${HOST}`);
			if (hosts[hosts.length - 1] !== ref.current) return;
			event.preventDefault();
			onClose();
		};
		document.addEventListener('keydown', onKeyDown);
		return () => document.removeEventListener('keydown', onKeyDown);
	}, [onClose]);

	return createPortal(
		<>
			{/* Escape and the handle close it for the keyboard and the screen reader; the backdrop is for a pointer. */}
			<div className="panel-backdrop" aria-hidden="true" onClick={onClose} />
			<div
				ref={ref}
				role="dialog"
				aria-modal="false"
				aria-label={label}
				tabIndex={-1}
				className={classes(
					HOST,
					`panel-${placement}`,
					placement === 'drawer' && `panel-drawer-${side}`
				)}
			>
				{placement === 'sheet' && <SheetHandle onClose={onClose} />}
				{children}
			</div>
		</>,
		document.body
	);
};

/**
 * Where the frame puts a panel (docs/ARCHITECTURE.md §7, "The interface"): a
 * sheet from the bottom on a compact window, a drawer over the canvas from
 * `side` on a medium one, a docked column in the flow on an expanded one. The
 * panel inside is the same whichever; only the host knows the size class,
 * and only through the frame, which chose the placement.
 */
export const PanelHost = ({
	placement,
	open,
	onClose,
	label,
	side = 'end',
	children,
}: {
	placement: Placement;
	open: boolean;
	onClose: () => void;
	label: string;
	side?: Side;
	children: ReactNode;
}) => {
	if (!open) return null;
	if (placement === 'dock') {
		return (
			<aside className="panel-dock" aria-label={label}>
				{children}
			</aside>
		);
	}
	return (
		<Floating placement={placement} side={side} label={label} onClose={onClose}>
			{children}
		</Floating>
	);
};
