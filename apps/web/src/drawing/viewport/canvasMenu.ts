import { type RefObject, useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';

import type { MenuPoint } from '../../components/ui/ContextMenu.js';
import { isTyping } from '../keys.js';
import type { Point } from '../tools/vector/geometry.js';
import { toScreen, type View } from './transform.js';

/**
 * The context menu over the canvas (docs/decisions/0004-the-interface.md,
 * "The context menu"). The `contextmenu` event opens it: an event of its own
 * beside the Pointer Events the canvas draws with, which it replaces none of.
 * A mouse's right button sends it, a pen's barrel button, a long press where
 * the browser makes one of it (Chrome on Android; iOS Safari sends none, and
 * the selection bar is the way there), and the keyboard's Menu key or
 * Shift+F10 while the canvas has the focus. The browser's own menu is kept
 * from showing over the canvas, and only there.
 *
 * The keyboard's is told from a pointer's by the event itself, where the
 * browser sends it as a `PointerEvent`, as Pointer Events 3 says it must:
 * then a keyboard's has `pointerType` `''` and `pointerId` -1, and a
 * pointer's the type of the pointer that made it
 * (https://w3c.github.io/pointerevents/#the-click-auxclick-and-contextmenu-events).
 * A browser that still sends a plain `MouseEvent` is read by the key that came
 * just before it, the Menu key or Shift+F10, with no press on the canvas
 * since. A keyboard's menu has no point of its own, the event saying 0, 0 in
 * most browsers, so it opens at the middle of what is selected, or of the
 * canvas where nothing is, kept inside the canvas.
 *
 * Shift+F10 is opened by the canvas itself, on the key: Windows and Linux
 * browsers make a `contextmenu` of it, and a Mac's make none, though WAI-ARIA
 * names it the key for a context menu on every platform. The key is spent, so
 * the browser makes no second one; one it makes anyway opens the menu where it
 * already is.
 */

/** Whether a key is one that opens a context menu: the Menu key, or Shift+F10. */
const isMenuKey = (event: KeyboardEvent): boolean =>
	event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);

/** Shift+F10 alone, outside a field: the key the canvas opens its menu on itself. */
const isShiftF10 = (event: KeyboardEvent): boolean =>
	event.key === 'F10' &&
	event.shiftKey &&
	!event.ctrlKey &&
	!event.metaKey &&
	!event.altKey &&
	!isTyping(event.target);

/** Whether a `contextmenu` came from the keyboard, the last key down being `menuKey` or not. */
const fromKeyboard = (event: MouseEvent, menuKey: boolean): boolean => {
	const { pointerType } = event as Partial<Pick<PointerEvent, 'pointerType'>>;
	return typeof pointerType === 'string' ? pointerType === '' : menuKey;
};

/**
 * Whether a `contextmenu` is the browser's long press of the finger now
 * drawing, held where it landed: Chrome on Android makes one of a finger
 * held still. That was never a stroke, and the menu opens in its place.
 */
export const isLongPress = (
	event: MouseEvent,
	stroke: number | undefined,
	still: boolean
): boolean => {
	const { pointerType, pointerId } = event as Partial<
		Pick<PointerEvent, 'pointerType' | 'pointerId'>
	>;
	return pointerType === 'touch' && pointerId === stroke && still;
};

type Rect = Readonly<{ left: number; top: number; width: number; height: number }>;

/**
 * Where a menu the keyboard opened goes, in the window: `center`, a point in
 * user units, through the view, or the middle of the canvas for none; kept
 * inside the canvas, so a selection scrolled out of sight still opens it in
 * view.
 */
export const keyboardPoint = (rect: Rect, view: View, center: Point | undefined): MenuPoint => {
	if (center === undefined) {
		return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
	}
	const [x, y] = toScreen(view, center.x, center.y);
	return {
		x: rect.left + Math.min(rect.width, Math.max(0, x)),
		y: rect.top + Math.min(rect.height, Math.max(0, y)),
	};
};

type CanvasMenuDeps = Readonly<{
	element: RefObject<HTMLElement | null>;
	/** Where a menu the keyboard opened goes. */
	keyboardAt: () => MenuPoint;
	/** Whether the menu may open for this event: never while a stroke is under way. */
	mayOpen: (event: MouseEvent) => boolean;
}>;

export type CanvasMenu = Readonly<{
	/** Where the menu is open, or none. */
	at: MenuPoint | undefined;
	close: () => void;
	/**
	 * Whether the press now going down on the canvas found the menu open: it
	 * closes the menu, which does not keep the press from the canvas, and
	 * draws nothing. Read in the press's own handler.
	 */
	dismissing: () => boolean;
}>;

export const useCanvasMenu = ({ element, keyboardAt, mayOpen }: CanvasMenuDeps): CanvasMenu => {
	const [at, setAt] = useState<MenuPoint | undefined>(undefined);
	// Whether the menu is open, as the handlers see it, before React has.
	const open = useRef(false);
	// Whether it was when the press now going down began, read before the
	// menu's own listener closes it.
	const pressedOpen = useRef(false);
	const menuKey = useRef(false);

	const onContextMenu = useEffectEvent((event: MouseEvent) => {
		event.preventDefault();
		if (!mayOpen(event)) return;
		open.current = true;
		setAt(
			fromKeyboard(event, menuKey.current)
				? keyboardAt()
				: { x: event.clientX, y: event.clientY }
		);
	});

	const onCanvasKey = useEffectEvent((event: KeyboardEvent) => {
		if (!isShiftF10(event)) return;
		event.preventDefault();
		// A menu event of no pointer, to be asked as the browser's would be: never during a stroke.
		if (!mayOpen(new MouseEvent('contextmenu'))) return;
		open.current = true;
		setAt(keyboardAt());
	});

	useEffect(() => {
		const target = element.current;
		if (target === null) return undefined;
		const onMenu = (event: MouseEvent) => {
			onContextMenu(event);
		};
		const onKey = (event: KeyboardEvent) => {
			menuKey.current = isMenuKey(event);
		};
		const onCanvasKeyDown = (event: KeyboardEvent) => {
			onCanvasKey(event);
		};
		// The window's capture phase comes before every other listener: the
		// menu's, which closes it, and the canvas's, which reads this.
		const onPress = (event: PointerEvent) => {
			pressedOpen.current = open.current;
			if (event.composedPath().includes(target)) menuKey.current = false;
		};
		target.addEventListener('contextmenu', onMenu);
		target.addEventListener('keydown', onCanvasKeyDown);
		window.addEventListener('keydown', onKey, true);
		window.addEventListener('pointerdown', onPress, true);
		return () => {
			target.removeEventListener('contextmenu', onMenu);
			target.removeEventListener('keydown', onCanvasKeyDown);
			window.removeEventListener('keydown', onKey, true);
			window.removeEventListener('pointerdown', onPress, true);
		};
	}, [element]);

	const close = useCallback(() => {
		open.current = false;
		setAt(undefined);
	}, []);

	const dismissing = useCallback(() => pressedOpen.current, []);

	return { at, close, dismissing };
};
