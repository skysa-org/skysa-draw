import { useEffect, useRef } from 'react';

/**
 * What the last pointer press landed on, for the hand key (`isHandKey`): a
 * control a pointer pressed keeps the focus in Chrome, and Space held over
 * the canvas after a tool is clicked must still pan, as in Photoshop, rather
 * than press the tool again. Forgotten as soon as the focus goes anywhere
 * that press is not in, by the keyboard or otherwise, so Space presses a
 * control the keyboard brought the focus to. `:focus-visible` cannot tell
 * the two apart: Chrome turns it on for the focused element at the first
 * key, Space included.
 *
 * A Pointer Event, in the capture phase on the window, so a control that
 * stops the press's propagation is still heard. Nothing is drawn or kept
 * but the node.
 */
export const usePointerPressed = (): (() => Node | null) => {
	const pressed = useRef<Node | null>(null);
	useEffect(() => {
		const pointerDown = (event: PointerEvent) => {
			pressed.current = event.target instanceof Node ? event.target : null;
		};
		const focusIn = (event: FocusEvent) => {
			if (!(event.target instanceof Node) || !event.target.contains(pressed.current)) {
				pressed.current = null;
			}
		};
		window.addEventListener('pointerdown', pointerDown, true);
		window.addEventListener('focusin', focusIn);
		return () => {
			window.removeEventListener('pointerdown', pointerDown, true);
			window.removeEventListener('focusin', focusIn);
		};
	}, []);
	return () => pressed.current;
};
