/**
 * The browser's leave-page prompt, held while an open drawing may have edits
 * that are not in the store yet: a stroke still being encoded, an edit
 * waiting on the autosave's pause, a save on its way, a save the store refused
 * (`drawing/useOpenDrawing.ts`). A page the user closes or reloads is gone
 * before a save it starts then has opened its transaction, so the browser asks
 * first (#16).
 *
 * Each holder says, as the page is about to go, whether it would lose
 * anything (`losing`), and the browser asks only if one would: a hold taken
 * early, or let go late, costs nothing more than the listener being there.
 * That is there only while something is held, as MDN advises, so that a page
 * with nothing open to lose never has it, which a browser may give up the
 * back-forward cache for.
 * https://developer.mozilla.org/en-US/docs/Web/API/Window/beforeunload_event
 *
 * A phone's browser seldom asks, or fires the event at all; it hides the page
 * first, which the editor saves at.
 */

const holders = new Map<symbol, () => boolean>();

const ask = (event: BeforeUnloadEvent): void => {
	if (![...holders.values()].some((losing) => losing())) return;
	event.preventDefault();
	// eslint-disable-next-line @typescript-eslint/no-deprecated, functional/immutable-data -- Chrome and Edge before 119 ask only for this (MDN, above), and the build reaches back further
	event.returnValue = true;
};

/** Until `by` lets go, or `letLeave`, the page asks before it goes whenever `losing` says so. */
export const holdLeaving = (by: symbol, losing: () => boolean): void => {
	holders.set(by, losing);
	window.addEventListener('beforeunload', ask);
};

/** `by` has nothing left to lose; the listener stays only while another holds it. */
export const releaseLeaving = (by: symbol): void => {
	holders.delete(by);
	if (holders.size === 0) window.removeEventListener('beforeunload', ask);
};

/** Whether anything holds the prompt, and so the listener is there. */
export const leavingHeld = (): boolean => holders.size > 0;

/**
 * Nothing held any longer, whoever held it: a new build's take-over reloads
 * the window however its open drawing's settle went (`UpdatePrompt`), and does
 * not ask.
 */
export const letLeave = (): void => {
	holders.clear();
	window.removeEventListener('beforeunload', ask);
};
