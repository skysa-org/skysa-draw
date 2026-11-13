import { isWithin } from '@skysa/storage';
import { outOfAttempts } from '@skysa/sync';

import {
	type DrawDatabase,
	type DrawingRecord,
	drawingRef,
	type FileRecord,
	type FolderRecord,
	type OpQueueRecord,
} from './db.js';
import { foldPath } from './naming.js';
import { MAX_OP_ATTEMPTS } from './queue.js';
import { rowsOf } from './rows.js';
import { isLive, isTombstone } from './rowStates.js';

/**
 * What one source holds on this device that its remote has never been sent.
 *
 * Letting a source go removes its drawings from the device, and everything the
 * remote already has comes back on connecting again. This is the rest: what
 * exists here and nowhere else, which the user has to be shown and asked about
 * before any of it goes (docs/ARCHITECTURE.md §6). Read from the rows and the queue
 * together, because neither says it alone: a drawing can be clean and still have a
 * write queued for it, a drawing that was never pushed need not be dirty, and a
 * rename shows on the row only as the path it already has.
 *
 * **A resumed connection that has not been verified has sent nothing, as far
 * as anyone knows.** Its rows came back clean and naming files, from an earlier
 * bind to the same account, and nobody has yet looked for those files:
 * `verifyResume` in `store/connection.ts` does, before the first sync, and cuts
 * every row loose if the folder turns out to have been emptied or replaced.
 * Until it has answered, "clean, with a `remoteId`" is a memory and not a fact,
 * and a discard that believed it would delete the only copy. So while
 * `resumeUnverified` is set every live drawing and every folder is unsent, and
 * `unverified` says that is why.
 *
 * **What an editor still holds is invisible from here.** Text typed inside the
 * autosave window, or held behind a save that failed, is in no row yet. Every
 * caller settles the editors first (`settleEditors` in `store/heldEdits.ts`);
 * asked without, the answer is about the store and not about the user's work.
 *
 * One connection's, by name, always. A drawing's id names it only inside its
 * source, and so does an op's `drawingId`: another source's drawing of the same id
 * has a queue of its own, and counting across the two would tell the user that
 * a drawing they are not disconnecting is about to be lost.
 */
export interface Unsynced {
	/**
	 * Live drawings whose text the remote does not have: edited, never pushed, or
	 * owed a write. A conflict copy and a drawing an undo brought back are both
	 * dirty with no `remoteId`, so they are here without a rule of their own.
	 */
	drawings: DrawingRecord[];
	/**
	 * Live drawings the remote has in full under another name: clean, pushed, and
	 * with only a `move` queued. Told apart from `drawings` because nothing written
	 * is at stake — the file is safe where it is, under its old name.
	 */
	renames: DrawingRecord[];
	/**
	 * Tombstones whose file the remote still has. One with no `remoteId` owes
	 * nothing — there was never a file to delete — and is not counted.
	 */
	deletes: DrawingRecord[];
	/**
	 * Folders the remote does not have: a `mkdir` is queued, or nothing here
	 * shows the directory was ever made (`unsentFolder` below).
	 */
	folders: FolderRecord[];
	/** Directories still owed their removal. The rows are gone, so the ops stand for them. */
	rmdirs: OpQueueRecord[];
	/**
	 * Files added here and not uploaded yet (skysa-notes #187): pending rows, whose bytes
	 * exist on this device and nowhere else. A bound file is the remote's, and
	 * its queued move or delete goes with the drawing or the folder that queued
	 * it, which is counted already — except while `unverified`, when a bound
	 * file whose bytes are held here is listed too, since nobody has looked
	 * for it on the remote and those bytes may be the only copy.
	 */
	files: FileRecord[];
	/**
	 * Of `files`, the ones a move to another source can take: those whose
	 * bytes are on this device. A pending row without them is a copy a drawing's
	 * move owes (`carryLinkedFiles` in `store/files.ts`), to be made on the
	 * remote from the file it copies (`copyOf`). Nothing here can send it to
	 * any other account, so a move leaves it, as it leaves a linked file this
	 * device has never downloaded, and the original stays where it is.
	 */
	portable: FileRecord[];
	/**
	 * Files the remote has that the unsent drawings link. Not unsent, and not
	 * counted: for a move to another source to say that it takes the ones
	 * this device holds the bytes of, and leaves the others in the account
	 * being left.
	 *
	 * Always empty for now. A drawing links a file beside it once attachments
	 * come (docs/ARCHITECTURE.md §10); skysa-notes reads these from a note's
	 * links, and the field is kept so the screens already say it.
	 */
	linked: FileRecord[];
	/**
	 * An op of this source is out of attempts, so none of the above can be sent
	 * right now however long the user waits (`outOfAttempts`, the kit's engine's,
	 * from `@skysa/sync`: the same rule the sync status says `blocked` by).
	 */
	blocked: boolean;
	/**
	 * The connection was resumed and its files have not been looked for yet, so
	 * everything it holds is counted above whatever the rows say. For the dialog
	 * to say why a source that looks synced is listed in full.
	 */
	unverified: boolean;
}

export interface UnsyncedOptions {
	/** As the scheduler was given it, where it was given one. */
	maxAttempts?: number;
}

type Scope = Pick<
	DrawDatabase,
	'drawings' | 'folders' | 'opQueue' | 'syncState' | 'files' | 'fileBytes'
>;

/** The ids of the drawings that have an op of this kind queued. */
const drawingsWith = (ops: readonly OpQueueRecord[], kind: OpQueueRecord['op']): Set<string> =>
	new Set(
		ops.flatMap((op) => (op.op === kind && op.drawingId !== undefined ? [op.drawingId] : []))
	);

/**
 * Safe inside a transaction over `drawings`, `folders`, `opQueue`, `syncState`,
 * `files` and `fileBytes`: every await is on a promise Dexie made. No file's
 * bytes are read, only which files have some, by key: this is asked on every
 * change to a source shown in the tab bar. A caller that has to act on the
 * answer — discard exactly what the user was shown, and nothing typed since —
 * asks again inside the transaction that acts.
 */
export const unsyncedIn = async (
	db: Scope,
	connectionId: string,
	options: UnsyncedOptions = {}
): Promise<Unsynced> => {
	const rows = await rowsOf(db.drawings, connectionId).toArray();
	const folders = await rowsOf(db.folders, connectionId).toArray();
	const ops = await rowsOf(db.opQueue, connectionId).sortBy('seq');
	const unverified = (await db.syncState.get(connectionId))?.resumeUnverified === true;
	const files = await rowsOf(db.files, connectionId).toArray();
	// Keys alone. A pending row's bytes are pinned, so to hold some is to hold
	// its own; a bound file's may be a stale version, and are counted anyway
	// while unverified, since the question then is whether they could be the
	// only copy.
	const held = new Set(
		(await rowsOf(db.fileBytes, connectionId).primaryKeys()).map(([, id]) => id)
	);
	const unsentFiles = files.filter(
		(file) => file.remoteId === undefined || (unverified && held.has(file.id))
	);

	const written = drawingsWith(ops, 'write');
	const moved = drawingsWith(ops, 'move');
	const made = new Set(ops.flatMap((op) => (op.op === 'mkdir' ? [op.path] : [])));

	const live = rows.filter(isLive);
	const unsent = (drawing: DrawingRecord): boolean =>
		unverified ||
		drawing.dirty === 1 ||
		drawing.remoteId === undefined ||
		written.has(drawing.id);

	// A folder row with no `remoteId` is not thereby a folder the remote lacks.
	// Only `createFolder` and `moveFolder` queue a `mkdir`, and only a completed
	// `mkdir` writes an id onto the row (`made-folder` in `sync/store.ts`). A
	// folder that came into being because a drawing was created in it, moved
	// into it or restored into it (`ensureFolder`, from `store/drawings.ts`) has a
	// row and no op: the engine makes the directory itself when the drawing's
	// write or move finds no parent (`ensureRemoteFolder` in the engine), and
	// that reports no id back, so the row has none until a later pull names the
	// folder. Counted by the row alone, every such folder would be listed as
	// unsent for as long as that takes, with all its drawings safely on the remote.
	//
	// So the drawings are asked instead. A file cannot be in a directory that does
	// not exist: one live drawing beneath the folder, at any depth, that the remote
	// has in full and *at that path* — pushed, clean, no write queued and no
	// move queued, since a drawing with a move still owed is at its old path and
	// proves nothing about the new one — is proof the directory is there. No
	// such drawing, and no id, is a folder nothing has yet made.
	const settled = live.filter((drawing) => !unsent(drawing) && !moved.has(drawing.id));
	const unsentFolder = (folder: FolderRecord): boolean =>
		unverified ||
		made.has(folder.path) ||
		(folder.remoteId === undefined &&
			// Folded: `Work` and `work` are one directory on the provider.
			!settled.some((drawing) => isWithin(foldPath(drawing.path), foldPath(folder.path))));

	return {
		drawings: live.filter(unsent),
		renames: live.filter((drawing) => !unsent(drawing) && moved.has(drawing.id)),
		deletes: rows.filter((drawing) => isTombstone(drawing) && drawing.remoteId !== undefined),
		folders: folders.filter(unsentFolder),
		rmdirs: ops.filter((op) => op.op === 'rmdir'),
		files: unsentFiles,
		portable: unsentFiles.filter((file) => held.has(file.id)),
		linked: [],
		blocked: ops.some((op) => outOfAttempts(op, options.maxAttempts ?? MAX_OP_ATTEMPTS)),
		unverified,
	};
};

/**
 * What the user was shown of a source, as it stood: each listed drawing by
 * `drawingRef` with its `updatedAt`, and the folders and directory removals by
 * path. For a discard, which may reach only this (`releaseConnection` in
 * `store/connection.ts`): a drawing written into since — same ref, new text — is
 * not the drawing that was listed, and neither is one the list never had.
 *
 * `updatedAt` rather than the text, because every writer moves it — an edit, a
 * rename, a move, a delete — and nothing else does while the source is
 * detached: a pull would, and nothing pulls a detached source.
 */
export interface Seen {
	drawings: ReadonlyMap<string, number>;
	folders: ReadonlySet<string>;
	rmdirs: ReadonlySet<string>;
	/** By id: a file is never written into, so one listed is the same file however it has moved. */
	files: ReadonlySet<string>;
}

/**
 * `standing` is every folder the source had when the list was made, for a
 * caller that made it while the source was still connected.
 *
 * Letting a source go removes the drawings the remote has, and a folder with no
 * `remoteId` was only ever *not* listed because one of those drawings was inside
 * it and sent (`unsentFolder` above). With them gone the same folder reads as
 * unsent, having had nothing done to it — and taken for something written since
 * the list, it would keep the whole source standing. A folder the user really
 * did make in between is not in `standing` either way.
 */
export const seenIn = (unsynced: Unsynced, standing: readonly string[] = []): Seen => ({
	drawings: new Map(
		[...unsynced.drawings, ...unsynced.renames, ...unsynced.deletes].map((drawing) => [
			drawingRef(drawing),
			drawing.updatedAt,
		])
	),
	folders: new Set([...unsynced.folders.map((folder) => folder.path), ...standing]),
	rmdirs: new Set(unsynced.rmdirs.map((op) => op.path)),
	files: new Set(unsynced.files.map((file) => file.id)),
});

/** Whether the drawing is one the list stood for, exactly as it stood. */
export const wasSeen = (seen: Seen, drawing: DrawingRecord): boolean =>
	seen.drawings.get(drawingRef(drawing)) === drawing.updatedAt;

/**
 * What a source holds now that `seen` did not stand for: written since the
 * list was made, or into a drawing on it. Anything, and a discard of what was
 * shown must leave the source standing around it.
 */
export const unseenIn = (unsynced: Unsynced, seen: Seen): boolean =>
	[...unsynced.drawings, ...unsynced.renames, ...unsynced.deletes].some(
		(drawing) => !wasSeen(seen, drawing)
	) ||
	unsynced.folders.some((folder) => !seen.folders.has(folder.path)) ||
	unsynced.rmdirs.some((op) => !seen.rmdirs.has(op.path)) ||
	unsynced.files.some((file) => !seen.files.has(file.id));

/**
 * The folders worth telling the user about in their own right: the ones with
 * no unsent drawing inside them.
 *
 * One that holds an unsent drawing goes wherever that drawing goes and is not a
 * second thing to count; and on a detached source a folder can look unmade
 * only because the clean drawings that proved it was there were removed with the
 * rest of what the remote has (`keepOnly` in `store/connection.ts`), which is
 * no change of the user's at all. What is left is the folder that is a change
 * on its own — made and never sent, or the empty one an unsent rename left
 * behind — and every count the user sees uses this one rule, so the headline,
 * the breakdown and the two steps of a move cannot disagree.
 */
export const countedFolders = (unsynced: Unsynced): FolderRecord[] =>
	unsynced.folders.filter(
		(folder) =>
			!unsynced.drawings.some((drawing) =>
				isWithin(foldPath(drawing.path), foldPath(folder.path))
			)
	);

/**
 * How many rows could be taken to another source: the drawings, the folders
 * that are changes in their own right, and the files not uploaded yet whose
 * bytes are here (`portable`). Not the renames and not the deletes —
 * each is about a file in the account being left, and means nothing anywhere
 * else. Zero means a move would move nothing, and a move of nothing is a
 * discard under another name.
 */
export const movable = (unsynced: Unsynced): number =>
	unsynced.drawings.length + countedFolders(unsynced).length + unsynced.portable.length;

/**
 * How many changes the remote has not had, for saying "3 not sent" of a source.
 *
 * Every category, since each is something the user did that went nowhere. A
 * number for people, then, and not the test of whether a source can be let go:
 * that is `isEmpty`, which counts everything.
 */
export const countOf = (unsynced: Unsynced): number =>
	unsynced.drawings.length +
	unsynced.renames.length +
	unsynced.deletes.length +
	unsynced.rmdirs.length +
	unsynced.files.length +
	countedFolders(unsynced).length;

/**
 * Nothing here that the remote lacks. `blocked` is not asked: an op that is
 * stuck with nothing behind it that the user made — left over for a row since
 * purged — is no reason to stop them and ask about work that does not exist.
 */
export const isEmpty = (unsynced: Unsynced): boolean =>
	unsynced.drawings.length === 0 &&
	unsynced.renames.length === 0 &&
	unsynced.deletes.length === 0 &&
	unsynced.folders.length === 0 &&
	unsynced.rmdirs.length === 0 &&
	unsynced.files.length === 0;
