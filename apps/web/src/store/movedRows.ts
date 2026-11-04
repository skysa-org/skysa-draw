import { type DrawingKey, drawingRef } from './db.js';

/**
 * Where a drawing's row went when its connection changed under an open editor —
 * the device's own drawings going into the first source bound, or a detached
 * source's going home to the connection its account came back under
 * (`store/connection.ts`) — for as long as the tab lives.
 *
 * A drawing's key is its connection and its id, so a row that moves is a row
 * deleted and another added, and an edit typed before the move names a key
 * that is no longer there. Looked for by id under whichever source is showing
 * instead, it lands in another account's storage; with this it lands in the row
 * the drawing became, new id and all where the move had to give it one.
 *
 * In memory and per tab, like the edits it is for. It is a hint and is checked
 * as one: the move's transaction may not have committed, so whoever asks still
 * looks for the row. A move made from another tab is not recorded here, and
 * `whereShown` in `store/drawings.ts` says what happens then.
 */
const moved = new Map<string, DrawingKey>();

type Named = Readonly<{ connectionId: string; id: string }>;

export const movedRows = {
	record: (from: Named, to: Named): void => {
		moved.set(drawingRef(from), [to.connectionId, to.id]);
		// Back where it once was is not on from there: bound and let go again in
		// one page life would otherwise leave the two pointing at each other.
		moved.delete(drawingRef(to));
	},
	/** The last place it is known to have got to, through every move since. */
	whereNow: (drawing: Named): DrawingKey | undefined => {
		const follow = (key: DrawingKey | undefined, hops: number): DrawingKey | undefined => {
			const next = key === undefined ? undefined : moved.get(JSON.stringify(key));
			return next === undefined || hops === 0 ? key : follow(next, hops - 1);
		};
		return follow(moved.get(drawingRef(drawing)), 8);
	},
	/** No moves remembered, as a new page life starts. For tests, where a file is one page life. */
	clear: (): void => {
		moved.clear();
	},
};
