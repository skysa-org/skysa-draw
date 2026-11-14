import { cell } from '@skysa/storage';
import { type PointerEvent, type RefObject, useEffect, useLayoutEffect } from 'react';

import { raise } from '../ui/MenuList.js';

/**
 * The page blocked behind a cover, for as long as the component that asks
 * for it is there: a window out of date (`StaleTabGate`), whose database is
 * closed for good, and one settling as a new build takes over
 * (`UpdatePrompt`), which reloads once it has. Neither may take a stroke,
 * since neither would keep it.
 *
 * The cover is in the top layer where there is one, and everything else in
 * the page is made inert while it is there, the sheets and drawers in their
 * portals with it, and anything put there later: the drawing can still be
 * seen behind it, and nothing behind it can be pressed, focused or typed
 * into. The page's own listeners hear no key pressed, paste or drop either,
 * the editor's shortcuts and its picture placing among them; the cover's own
 * buttons answer by the browser's own handling of a key, which that leaves
 * alone. A key let go is heard, so that one held as the cover came — Space,
 * for the hand — is not held for good. Only a listener on the window's
 * capture phase put there before the cover came still hears a key pressed. A
 * gesture's under way does, until it ends. So does an area transform's
 * (`viewport/areaTransform.ts`), whose undo and redo step the transform while
 * one is open: they move the selection's outline, never the drawing. And
 * work under way's does (`Applying`): its cover holds every key, the cover's
 * buttons' with them, until the work is done, while a press on them goes
 * through.
 *
 * A press on the cover itself leaves the focus where it is (`keepFocus`), as
 * `Applying`'s cover does, and a drag over the window shows as one that
 * cannot drop.
 */

/** A key, kept from the page's listeners and left to the browser, which presses the cover's buttons. */
const keepKey = (event: Event): void => {
	event.stopImmediatePropagation();
};

/**
 * A paste or a drop, taken from the page altogether: a drop the page did not
 * take, the browser would open in the window, in place of the drawing.
 */
const refuse = (event: Event): void => {
	event.preventDefault();
	event.stopImmediatePropagation();
};

/** A drag over the window, taken from the page and shown as one that cannot drop. */
const refuseDrag = (event: Event): void => {
	const { dataTransfer } = event as Partial<DragEvent>;
	// eslint-disable-next-line functional/immutable-data -- the drag's answer, as the DOM asks for it
	if (dataTransfer) dataTransfer.dropEffect = 'none';
	refuse(event);
};

const KEPT = [
	['keydown', keepKey],
	['paste', refuse],
	['dragover', refuseDrag],
	['drop', refuse],
] as const;

/** A press on the cover itself, which would otherwise take the focus out of it. */
export const keepFocus = (event: PointerEvent<HTMLElement>): void => {
	if (event.target === event.currentTarget) event.preventDefault();
};

/** The page blocked behind `cover`, which is put in the top layer, while the caller is there. */
export const useBlockedPage = (cover: RefObject<HTMLElement | null>): void => {
	useLayoutEffect(() => {
		if (cover.current !== null) raise(cover.current);
	}, [cover]);

	// The window's capture phase comes before every other listener but those
	// put there earlier. Inert takes the focus away from what had it, which
	// gets it back once the cover goes; what the page had made inert itself
	// stays so.
	useEffect(() => {
		const had = document.activeElement;
		const made = cell<readonly Element[]>([]);
		const quieten = (nodes: readonly Node[]) => {
			const fresh = nodes.filter(
				(node): node is Element =>
					node instanceof Element && node !== cover.current && !node.hasAttribute('inert')
			);
			fresh.forEach((element) => element.setAttribute('inert', ''));
			made.current = [...made.current, ...fresh];
		};
		quieten(Array.from(document.body.children));
		const later = new MutationObserver((records) => {
			quieten(records.flatMap((record) => Array.from(record.addedNodes)));
		});
		later.observe(document.body, { childList: true });
		KEPT.forEach(([type, listener]) => window.addEventListener(type, listener, true));
		return () => {
			later.disconnect();
			KEPT.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
			made.current.forEach((element) => element.removeAttribute('inert'));
			if (had instanceof HTMLElement && had.isConnected) had.focus();
		};
	}, [cover]);
};
