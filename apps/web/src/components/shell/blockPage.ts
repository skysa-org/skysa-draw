import { cell } from '@skysa/storage';
import { type PointerEvent, type RefObject, useLayoutEffect } from 'react';

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
 *
 * Blocks stack, since a window can go out of date while it settles at a
 * take-over, which a newer database brings: each cover is kept out of the
 * page that is blocked, and the page is let go, the focus given back to what
 * had it as the first came, only once the last has gone.
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

/** The covers up, in the order they came: the page is blocked while there is one. */
const covers = cell<readonly Element[]>([]);
/** What blocking made inert; what the page had made inert itself stays so. */
const made = cell<readonly Element[]>([]);
/** What had the focus as the first cover came, which inert takes it away from. */
const had = cell<Element | null>(null);

const quieten = (nodes: readonly Node[]): void => {
	const fresh = nodes.filter(
		(node): node is Element =>
			node instanceof Element && !covers.current.includes(node) && !node.hasAttribute('inert')
	);
	fresh.forEach((element) => element.setAttribute('inert', ''));
	made.current = [...made.current, ...fresh];
};

/** What is put in the page while it is blocked, a sheet opened by a timer, is blocked too. */
const later = new MutationObserver((records) => {
	quieten(records.flatMap((record) => Array.from(record.addedNodes)));
});

// The window's capture phase comes before every other listener but those
// put there earlier.
const block = (cover: Element): void => {
	covers.current = [...covers.current, cover];
	if (covers.current.length > 1) return;
	had.current = document.activeElement;
	quieten(Array.from(document.body.children));
	later.observe(document.body, { childList: true });
	KEPT.forEach(([type, listener]) => window.addEventListener(type, listener, true));
};

const unblock = (cover: Element): void => {
	covers.current = covers.current.filter((each) => each !== cover);
	if (covers.current.length > 0) return;
	later.disconnect();
	KEPT.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
	made.current.forEach((element) => element.removeAttribute('inert'));
	made.current = [];
	const back = had.current;
	had.current = null;
	if (back instanceof HTMLElement && back.isConnected) back.focus();
};

/**
 * The page blocked behind `cover`, which is put in the top layer, while the
 * caller is there. In the commit that puts the cover in the page, before
 * anything after it can reach the page, a key, a press or another block's
 * watch on it, which would take the cover for the page.
 */
export const useBlockedPage = (cover: RefObject<HTMLElement | null>): void => {
	useLayoutEffect(() => {
		const element = cover.current;
		if (element === null) return undefined;
		raise(element);
		block(element);
		return () => {
			unblock(element);
		};
	}, [cover]);
};
