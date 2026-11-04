import { drawingIdOf, type PullChange } from '../store.js';

/**
 * What a pull's batch has already spoken for, read off its decisions: the
 * drawings and folders it writes back (`reestablished`), and every drawing it has
 * said anything about (`decidedDrawings`, `decidedApartFromMoves`). Pure, and
 * below every part that asks, so asking pulls in nothing else. Moved out of
 * `engine.ts` as they were (#446).
 */

/**
 * After a full scan, anything we hold that the scan did not mention is gone
 * from the remote. A scan reports what exists, never what was removed, so
 * this is the only thing standing between a cursor reset and every drawing the
 * user deleted coming back.
 *
 * Only entries that have a `remoteId` are candidates: one created here and
 * never pushed was never in the scan to begin with.
 *
 * And, like every other decision, this one is reached against the store as
 * it was and applied after the changes in front of it — so anything the scan
 * has just re-established has to be exempt. The `remoteId` on the row is the
 * *old* one when a file was replaced at the same path while the cursor was
 * dead, and it is missing from a scan that only ever saw the new one; acting
 * on that deletes the drawing the same batch has just imported, reports `ok`,
 * and stores the cursor, so it never comes back.
 */
export const reestablished = (
	changes: readonly PullChange[]
): Readonly<{ drawings: ReadonlySet<string>; folders: ReadonlySet<string> }> => ({
	drawings: new Set(
		changes.flatMap((change) => {
			if (change.kind === 'conflict') {
				return [change.resolution.drawingId, change.resolution.copyId];
			}
			// Written back, not merely mentioned. A `delete-drawing` carries an
			// id too, and counting it here would mean a file arriving with
			// the id of a drawing this batch deleted was refused that id — two
			// devices then disagreeing for ever about which drawing it is.
			return change.kind === 'upsert-drawing' ||
				change.kind === 'adopt-version' ||
				change.kind === 'move-drawing'
				? [change.id]
				: [];
		})
	),
	folders: new Set(
		changes.flatMap((change) => {
			if (change.kind === 'ensure-folder') return [change.path];
			return change.kind === 'move-folder' ? [change.to] : [];
		})
	),
});

/**
 * Every drawing this batch has already said something about, whatever it said.
 * A wider question than `reestablished`, and a different one: reconciling is
 * about the drawings the scan never mentioned, so a drawing the batch has already
 * decided — written back *or* taken away — is not its business either way.
 * Saying it twice is at best a duplicate and at worst a second delete of
 * something the batch has already removed, which fails the whole batch.
 */
export const decidedDrawings = (changes: readonly PullChange[]): ReadonlySet<string> =>
	new Set(
		changes.flatMap((change) => {
			if (change.kind === 'conflict') {
				return [change.resolution.drawingId, change.resolution.copyId];
			}
			return drawingIdOf(change) ?? [];
		})
	);

/**
 * The same, minus the drawings the batch only moved aside. A displacement is
 * not a word about the drawing's own file: it says a *different* file arrived
 * at the drawing's path and ours got out of the way, which a scan can do
 * without ever mentioning the file our row is bound to. Exempted on the
 * strength of that, a clean drawing whose file is gone keeps its row and a
 * dead `remoteId`, and the user is left a conflict copy of a drawing that
 * never conflicted — until the next scan, which is the only thing that can
 * put it right and need not come for weeks. That one does: nothing
 * displaces the row a second time, so it falls straight out of `kept` and
 * is let go of there.
 *
 * A drawing the scan did return is still safe: `seen` holds its file's id and
 * answers before this is asked. This only stops a displacement from
 * standing in for an answer nothing gave.
 */
export const decidedApartFromMoves = (changes: readonly PullChange[]): ReadonlySet<string> =>
	decidedDrawings(changes.filter((change) => change.kind !== 'displace-drawing'));
