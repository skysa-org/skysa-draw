/**
 * The browser's leave-page prompt, held while an open drawing has edits that
 * are not in the store yet: a stroke still being encoded, an edit waiting on
 * the autosave's pause, a save on its way, a save the store refused
 * (`drawing/useOpenDrawing.ts`). A page the user closes or reloads is gone
 * before a save it starts then has opened its transaction, so the browser asks
 * first (#16).
 *
 * Listened for only while something is held, as MDN advises, so that a page
 * with nothing to lose never has the listener, which a browser may give up the
 * back-forward cache for.
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
 *
 * A phone's browser seldom asks, or fires the event at all; it hides the page
 * first, which the editor saves at.
 */

const holders = new Set<symbol>();

const ask = (event: BeforeUnloadEvent): void => {
	event.preventDefault();
	// eslint-disable-next-line @typescript-eslint/no-deprecated, functional/immutable-data -- Chrome and Edge before 119 ask only for this (MDN, above), and the build reaches back further
	event.returnValue = true;
};

/** The page asks before it goes until `by` lets go, or `letLeave`. */
export const holdLeaving = (by: symbol): void => {
	holders.add(by);
	window.addEventListener('beforeunload', ask);
};

/** `by` has nothing left to lose; the page asks only while another holds it. */
export const releaseLeaving = (by: symbol): void => {
	holders.delete(by);
	if (holders.size === 0) window.removeEventListener('beforeunload', ask);
};

/**
 * Nothing held any longer, whoever held it: a new build's take-over reloads
 * the window however its open drawing's settle went (`UpdatePrompt`), and does
 * not ask.
 */
export const letLeave = (): void => {
	holders.clear();
	window.removeEventListener('beforeunload', ask);
};
