/**
 * The edits the editors are holding, which the store cannot see.
 *
 * An editor keeps what was drawn for a moment before it saves it, and an edit
 * whose save the store refused until one goes in (`drawing/useOpenDrawing.ts`,
 * registered while a drawing is open). None of that is in a row. So anything
 * about to act on "what this device holds" has to have the editors write first
 * — a tab closing its database for a newer build (`store/staleTab.ts`), and a
 * source being let go, where a count of what is unsynced taken from the store
 * alone would leave out the stroke the user has just drawn
 * (`store/unsynced.ts`).
 *
 * A registry rather than a call into the editor, because `store/` knows nothing
 * of React and an editor comes and goes: each registers its own flush while it
 * is mounted.
 */

/**
 * Write what is held, now. It should resolve whether or not the writes went
 * through, and may say how they went: an array of `drawingRef`s is the drawings it
 * still holds text for that the store would not take. Anything else makes no
 * claim.
 */
export type HeldEditsFlush = () => Promise<unknown>;

/**
 * The drawings a flush that has not answered by `FLUSH_WAIT_MS` is taken to
 * hold text for, by `drawingRef`: an editor knows its drawing before it knows
 * how its writes went.
 */
export type HeldEditsUnanswered = () => readonly string[];

const unfinished = new Map<HeldEditsFlush, HeldEditsUnanswered | undefined>();

/**
 * Work under way that leaves an edit with an editor when it is done. In
 * skysa-notes it is a file being added to a note, which goes in once it is
 * beside the note (skysa-notes #187), and a note moved a moment after a file
 * was pasted into it takes the file only if its stored body links it
 * (`carryLinkedFiles` there). Settling waits for it, so that the edit it
 * leaves is among those written. Nothing in this app calls `settleAfter` yet.
 */
const underway = new Set<Promise<unknown>>();

/**
 * How long settling waits on work under way before it goes on without it. A
 * file's bytes can take as long as the disk they are on, and one dragged from
 * a cloud drive's folder may be fetched first: whoever is settling — a move,
 * a disconnect — is not kept waiting on that past a few seconds.
 */
export const UNDERWAY_WAIT_MS = 10_000;

/**
 * How long settling waits on one editor before it takes it to hold what it
 * said it would (`beforeClosing`), or what it cannot name: raster work whose
 * encoding never lands, a store that never answers. Whoever is settling — an export, a disconnect, an editor closing —
 * is not kept waiting past it, as with `UNDERWAY_WAIT_MS`.
 */
export const FLUSH_WAIT_MS = 10_000;

/** `work`, or `late` where it fails or `wait` goes by first. */
export const inTime = <T>(work: Promise<T>, late: T, wait = FLUSH_WAIT_MS): Promise<T> =>
	new Promise((resolve) => {
		const timer = setTimeout(() => {
			resolve(late);
		}, wait);
		const done = (value: T) => {
			clearTimeout(timer);
			resolve(value);
		};
		work.then(done, () => {
			done(late);
		});
	});

/** Have `settleEditors` wait for `work` before it has the editors write. */
export const settleAfter = (work: Promise<unknown>): void => {
	underway.add(work);
	const done = () => {
		underway.delete(work);
	};
	work.then(done, done);
};

/**
 * Register work to be finished first — an editor's held edits — with, where
 * it can say, what it holds should it not answer in time. Answers how to
 * withdraw it.
 */
export const beforeClosing = (
	finish: HeldEditsFlush,
	unanswered?: HeldEditsUnanswered
): (() => void) => {
	unfinished.set(finish, unanswered);
	return () => {
		unfinished.delete(finish);
	};
};

export interface SettledEditors {
	/**
	 * The drawings that still have text here that could not be saved, by `drawingRef`,
	 * as far as the editors said. A floor, not a census: a flush that answers
	 * with no list is counted as holding none, because the registry cannot know
	 * what it is not told. skysa-notes' editor's flush (`Autosave.settle`) does
	 * answer with one. Named, so that whoever is about to remove a source's rows
	 * can keep exactly these, whose row is not the whole of what the user wrote.
	 */
	failing: readonly string[];
	/**
	 * How many flushes threw or rejected, or had not answered by
	 * `FLUSH_WAIT_MS` with nothing to say for them (`HeldEditsUnanswered`). Each
	 * holds whatever it holds and cannot say for which drawings, so above zero
	 * the store is not the whole of what the user has written and nothing here
	 * can say where the rest is.
	 */
	rejected: number;
}

const isRefs = (answer: unknown): answer is readonly string[] =>
	Array.isArray(answer) && answer.every((each) => typeof each === 'string');

const NOTHING_CLAIMED: SettledEditors = { failing: [], rejected: 0 };
const REJECTED: SettledEditors = { failing: [], rejected: 1 };

/** One registered flush started, and what it is taken to hold if it does not answer in time. */
const begin = ([finish, unanswered]: readonly [
	HeldEditsFlush,
	HeldEditsUnanswered | undefined,
]) => ({
	// Inside the executor, so a `finish` that throws is one that settled.
	settled: new Promise<unknown>((resolve) => {
		resolve(finish());
	}).then(
		(left): SettledEditors => (isRefs(left) ? { failing: left, rejected: 0 } : NOTHING_CLAIMED),
		() => REJECTED
	),
	late: unanswered === undefined ? REJECTED : { failing: unanswered(), rejected: 0 },
});

/**
 * Start every registered flush, there and then, and answer one promise for
 * each. None of them rejects. Empty when no editor is holding anything open, so
 * a caller with nothing to wait for can tell without waiting.
 */
export const flushEditors = (): Promise<SettledEditors>[] =>
	[...unfinished].map((entry) => begin(entry).settled);

const waitForUnderway = (): Promise<void> =>
	inTime(
		Promise.allSettled([...underway]).then(() => undefined),
		undefined,
		UNDERWAY_WAIT_MS
	);

/**
 * Have every editor write what it holds, and wait for all of them. One that
 * rejects does not stop the others being waited for, and one that has not
 * settled by `FLUSH_WAIT_MS` is taken to hold what it said it would
 * (`beforeClosing`), or else counted as one that rejected. Work under way
 * that will leave an edit (`settleAfter`) is waited for first, for as long as
 * `UNDERWAY_WAIT_MS`.
 */
export const settleEditors = async (): Promise<SettledEditors> => {
	// Only where there is some, so that the flushes otherwise start there and
	// then, as `flushEditors` does.
	if (underway.size > 0) await waitForUnderway();
	const each = await Promise.all(
		[...unfinished].map(begin).map(({ settled, late }) => inTime(settled, late))
	);
	return {
		failing: [...new Set(each.flatMap((settled) => settled.failing))],
		rejected: each.reduce((sum, settled) => sum + settled.rejected, 0),
	};
};
