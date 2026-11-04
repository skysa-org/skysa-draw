import { isWithin, normalizePath, ROOT } from '../../paths.js';
import type { EngineContext } from '../context.js';
import { pathOf, type PullChange, type SyncFolder, type UnreadableFile } from '../store.js';
import type { PullAttachments } from './attachments.js';
import type { Cascade } from './cascade.js';
import { decidedApartFromMoves, decidedDrawings, reestablished } from './decided.js';
import type { PullDrawings } from './drawings.js';
import { type FileBase, fileGone } from './files.js';
import { folderNow, removedInBatch, survives, unreadNow } from './replay.js';

/**
 * A scan's last word: every drawing and folder the scan never mentioned, let go
 * of or kept (`reconcile`), reached against what the batch has already spoken
 * for (`decided.ts`). Moved out of `engine.ts` as it was (#446).
 */

export const createPullReconcile = (
	{ store }: EngineContext,
	{
		cascadeOver,
		filesNow,
		forgetDrawing,
		keepDrawing,
		roofsFor,
	}: Pick<Cascade, 'cascadeOver' | 'roofsFor'> &
		Pick<PullAttachments, 'filesNow'> &
		Pick<PullDrawings, 'forgetDrawing' | 'keepDrawing'>
) => {
	const reconcile = async (
		seen: ReadonlySet<string>,
		changes: readonly PullChange[],
		renaming: ReadonlyMap<string, string>,
		/**
		 * The provider said the scan may be missing things rather than proving
		 * them gone. Nothing is deleted: every drawing and folder it did not
		 * return is sent back up instead (§7, "A rescan that uploads").
		 */
		upload: boolean,
		/** The unreadable files listed when this page of the scan began. */
		unread: ReadonlyMap<string, UnreadableFile>,
		/** The files that are not drawings, as this page of the scan found them. */
		known: FileBase
	): Promise<PullChange[]> => {
		// A file the scan did not return is gone from the remote, as a drawing is,
		// or sent back up where the provider says its own copy may have lost
		// it. Only a bound row: a pending one was never there to be returned.
		const lostFiles = [...filesNow(known, changes).values()].flatMap((file): PullChange[] => {
			if (file.remoteId === undefined || seen.has(file.remoteId)) return [];
			return [upload ? { kind: 'reupload-file', fileId: file.id } : fileGone(file)];
		});
		// A scan that proves what is there asks the narrower question, so a drawing
		// moved aside for somebody else's file is still asked after.
		//
		// A scan that may be missing things asks the wider one, and not because
		// absence proves less there — it acts on absence all the time, by
		// sending the drawing back up. It is what sending a *displaced* drawing back
		// up does. `reupload-drawing` strips the row and queues a create-only write
		// at `drawing.path`, read after the displacement has moved the row, so the
		// path is a fresh conflict name nothing holds: the create cannot fail
		// the way it would at the drawing's own path, where a file that was there
		// all along conflicts into `resolvePushConflict`'s same-bytes branch and
		// puts itself right. It simply lands, and the user has two files where
		// they had one, with nothing left to reconcile them.
		const kept = {
			drawings: upload ? decidedDrawings(changes) : decidedApartFromMoves(changes),
			folders: reestablished(changes).folders,
		};
		// Folders the batch has just put a drawing into. Deleting one cascades over
		// what is inside it, so the exemption above would be undone from the
		// other direction — the drawing is spared by name and taken by its folder.
		//
		// A displacement counts here, unlike above, and on the face of it that
		// could spare a folder on the strength of a drawing `forgotten` then
		// removes, leaving an empty folder until the next scan. No reachable
		// shape was found for it: a displacement lands in the drawing's own folder
		// (`conflictPath` replaces the basename), and it happens because the
		// scan returned a file at a path inside that folder — which is a scan
		// that listed the folder too, so its id is in `seen`, or, where the
		// directory was replaced at the name, an `ensure-folder` for that path
		// is in `kept.folders`. If one is ever found, this is where it starts.
		const holding = changes.flatMap((change) =>
			change.kind === 'delete-folder' ? [] : (pathOf(change) ?? [])
		);
		const drawings = await store.allDrawings();
		const folders = await store.foldersWithRemote();
		// A folder the scan did not mention, which is therefore gone from the
		// remote.
		const vanished = (folder: SyncFolder): boolean =>
			// Belt and braces with `decideFolder`: a row for the root should not
			// exist, and if one ever does, deleting it takes every drawing with it
			// — `isWithin` is true of everything.
			normalizePath(folder.path) !== ROOT &&
			folder.remoteId !== undefined &&
			!seen.has(folder.remoteId) &&
			!kept.folders.has(folder.path) &&
			!holding.some((path) => isWithin(path, folder.path)) &&
			!changes.some((c) => c.kind === 'delete-folder' && !survives(folder.path, c));
		const doomedFolders = folders.filter(vanished);
		const forgotten = drawings
			.filter(
				(drawing) =>
					drawing.remoteId !== undefined &&
					!seen.has(drawing.remoteId) &&
					!kept.drawings.has(drawing.id) &&
					// A folder delete in the same batch names none of the
					// drawings it cascades over, so `kept` does not know about
					// them. Naming one here is a second delete of something
					// already gone.
					!removedInBatch(drawing, changes)
			)
			.map(upload ? keepDrawing : forgetDrawing);
		// Folders too, or a folder deleted while the cursor was dead stays
		// in the sidebar for ever with nothing behind it.
		//
		// Unless the scan is one that may be missing things, in which case each
		// of them is made again instead — every one, not the outermost only,
		// since nothing cascades and each needs its own `mkdir`. The drawings
		// inside are already named one by one above.
		if (upload) {
			const remade = [
				...doomedFolders.flatMap((folder): string[] => {
					const at = folderNow(folder.path, changes);
					return at === undefined ? [] : [at];
				}),
			]
				// Outermost first, as `roofsFor` orders the folders it makes.
				// `foldersWithRemote` promises no order — both stores happen to
				// answer parent-first, one by its primary key and one by
				// insertion, and neither is the port's to rely on.
				.sort((one, two) => one.length - two.length)
				.map((path): PullChange => ({ kind: 'reupload-folder', path }));
			// Ahead of the writes, not behind them: the queue is ordered, and a
			// write that runs before its folder exists is only rescued by
			// `runWrite`'s `NotFoundError` recovery — a wasted round trip per
			// drawing, and the folder made by a side effect rather than by the op
			// that exists to make it.
			return [...remade, ...forgotten, ...lostFiles];
		}
		// The outermost of them only. `delete-folder` cascades over what is
		// inside it, so naming a nested one as well is a second delete of a
		// row the first has already taken away.
		const cascades = doomedFolders
			.filter(
				(folder) =>
					!doomedFolders.some(
						(other) => other.path !== folder.path && isWithin(folder.path, other.path)
					)
			)
			// Where the row ends up, not where the store last saw it. A scan
			// is one batch like any other, and a `move-folder` decided in
			// front of this has already rebased the row — naming the old
			// path asks the store to delete something that is not there,
			// and leaves the folder the remote no longer has sitting in
			// the sidebar under its new name until the next cursor reset.
			.flatMap((folder): { at: string; was: string }[] => {
				const at = folderNow(folder.path, changes);
				return at === undefined ? [] : [{ at, was: folder.path }];
			});
		// A scan is a batch like any other, and the drawings its cascades must
		// spare are the ones whose files a queued rename says are elsewhere.
		// The scan saw those files, so the drawing branch above keeps them; the
		// folder branch would take them anyway.
		const removals = await Promise.all(
			cascades.map(({ at, was }) => cascadeOver(at, was, renaming, changes))
		);
		// And an unreadable file the scan did not return is not there to be
		// listed. Those it did return it read again, and said what it found.
		// This is the whole of what a rescan does to the list: nothing clears it
		// when the scan starts, so an interrupted one leaves the notice standing
		// rather than blank. Not on a scan that may be missing things, above —
		// not seen there does not mean gone.
		//
		// `unreadNow` rather than `unread` for what the scan's own decisions have
		// already done to the list. Nothing observable turns on it: a record the
		// decisions dropped is one `seen` holds (it was dropped because the scan
		// returned the file), and one they re-made is a file the scan returned
		// too, so either list forgets exactly the same ids. What it buys is not
		// counting a change that is already there — a smaller `pulled` — and not
		// asking the store to forget an id twice.
		const unlisted = [...unreadNow(unread, changes).keys()]
			.filter((remoteId) => !seen.has(remoteId))
			.map((remoteId): PullChange => ({ kind: 'forget-unreadable', remoteId }));
		const tail = [...forgotten, ...lostFiles, ...removals, ...unlisted];
		const paths = cascades.map(({ at }) => at);
		return [...tail, ...(await roofsFor(paths, [...changes, ...tail], known))];
	};

	return { reconcile };
};

/** What the pull's other parts are handed of it. */
export type PullReconcile = ReturnType<typeof createPullReconcile>;
