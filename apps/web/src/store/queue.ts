import {
	ancestorPaths,
	foldName,
	type NewSyncOp,
	parentPath,
	pathSegments,
} from '@skysa/draw-core';
import Dexie, { type PromiseExtended } from 'dexie';

import type { DrawDatabase, DrawingRecord, FileRecord, OpQueueRecord } from './db.js';
import { isTombstone } from './rowStates.js';

/**
 * The push queue: what the sync engine owes the remote, in the order it has to
 * happen. Every writer in `store/` that changes a drawing or a folder calls one
 * of these in the same transaction as the change itself, so a change and the
 * op that carries it land together or not at all. Pulls never do — what a pull
 * writes came from the remote.
 *
 * The engine reads the queue once, asks for each op again just before sending
 * it — so one withdrawn here in the meantime is never sent — and holds it while
 * it is at the network, and the user can go on editing meanwhile. So what is
 * queued is kept to what the engine needs and no more, and every rule below has
 * to hold even for an op that is already on its way:
 *
 * - **A write carries no content.** The engine reads the drawing when it runs the
 *   op, so one queued write covers every edit made before it runs, and a drawing
 *   edited again while its write is in flight is left dirty by the store and
 *   owed a fresh write (`settle` in `sync/store.ts`).
 * - **A move says where the drawing is going, so a second rename replaces it.**
 *   Two moves queued for one drawing would move the file to the first name and
 *   back again, and a write addressed to the second name would find nothing
 *   and look for a move that explains it — which is the one queued last. If
 *   the replaced move was in flight, the engine's `completeOp` finds it gone,
 *   and the store settles it as the drawing having moved on.
 * - **A drawing never pushed is not moved.** There is nothing at the old path; its
 *   write creates the file wherever the drawing is by then.
 * - **A delete withdraws the drawing's writes and keeps its moves, and a deleted
 *   drawing is still moved.** A tombstone owes the remote its delete and nothing
 *   else, which is the rule `queueWrite` applies from the other end; left
 *   queued, the write of a drawing made and deleted before either op was sent
 *   creates the file for the delete to remove, and another device's drawing binds
 *   to that file rather than making one (`queueDelete`). Only the queue row
 *   goes: a write already at the network still records the `remoteId` on the
 *   row, which is what the delete needs, and `completeOp`, `failOp` and
 *   `resolveConflict` all tolerate finding the op withdrawn. The moves stay
 *   because the file is still at the name it had, and a deleted drawing carried
 *   along by a folder rename can be restored, when its write needs the file
 *   where the drawing is.
 *
 * Folder renames and deletes go up as the drawings inside them moving or being
 * deleted one by one — the engine has no op that moves a whole folder — and an
 * `rmdir` queued behind them removes the directory they left. Ordered that way
 * round because the drawings' own ops are what empty it: the engine refuses an
 * `rmdir` over a directory that still holds any file (`runRmdir`).
 *
 * A file beside a drawing (skysa-notes #187) has ops of its own, by the same rules where a
 * file has a counterpart to them:
 *
 * - **An upload is sent to wherever the row is when it runs**, as a write is,
 *   and a pending file that moves only has its upload's `path` follow it. The
 *   engine never lets an upload hold up what is behind it.
 * - **A `move-file` replaces an earlier one and keeps its origin**, as a move
 *   does, and one in flight that is replaced is settled as the file having
 *   moved on (`settleFileMove` in `sync/store.ts`).
 * - **A `delete-file` withdraws the file's upload and moves.** It is by id, so
 *   it finds the file wherever an earlier move got it to; its `path` is where
 *   the remote has the file, which is the first withdrawn move's origin.
 * - **A file reaches the remote before the drawing that links it.** `queueWrite`
 *   adds nothing while a write is queued, so a write queued before the file was
 *   added would run first; the writer that adds or carries the file sends
 *   that write to the back, and so does one that finds the file already there
 *   and not up yet. A folder's move queues its files' moves ahead of its
 *   drawings'.
 *
 * What a whole library owes at once — an import, or the rows a bind carries in
 * — is queued folder by folder (`queueByFolder`), so that another device
 * fills in one folder at a time.
 */

type QueueDb = Pick<DrawDatabase, 'opQueue'>;

/**
 * Failures in a row before an op is left alone and the sync says `blocked`.
 * Enough that an outage has to outlast the scheduler's backoff on its climb to
 * its cap — about ten minutes of failures in a row — before an op is given up
 * on.
 *
 * Here rather than in the scheduler because it is a fact about the queue, and
 * more than the scheduler asks it: `store/unsynced.ts` has to say "these cannot
 * be sent right now" by the same rule the status line does, or the two disagree
 * about the same op.
 */
export const MAX_OP_ATTEMPTS = 8;

/**
 * Whether an op has been given up on for now, and is holding up everything
 * queued behind it. The one statement of the rule: the engine stops a batch at
 * `attempts >= maxAttempts` (`drainOps` in
 * `packages/core/src/sync/push/drain.ts`), the scheduler names the op by it,
 * and what is unsynced is called blocked by it.
 *
 * Never an `rmdir`, because the engine makes the same exception: one that is
 * out of attempts is completed as done and stepped over — it tidies an empty
 * directory away, nothing behind it depends on that, and it is not the user's
 * work. Calling it blocked here would tell the user their drawings cannot be sent
 * while the engine is about to send them.
 *
 * An `upload` is the other exception, and only half of one. The engine steps
 * over it too, so it holds nothing up — but it is the only copy of the file,
 * so it is kept, and the run ends `blocked` on its account (`drained` in the
 * engine). So it counts here: the status line and this rule must agree.
 */
export const outOfAttempts = (
	op: Pick<OpQueueRecord, 'op' | 'attempts'>,
	maxAttempts: number = MAX_OP_ATTEMPTS
): boolean => op.op !== 'rmdir' && op.attempts >= maxAttempts;

// Every helper here returns the promise Dexie made rather than being an `async`
// function. They run inside the writers' transactions, often straight after a
// `Dexie.waitFor`, and Dexie follows its own promises through a transaction
// reliably but native ones only for a limited number of hops: two `async`
// helpers awaited one after another in `applyEdit`, behind the digest, lost the
// transaction to a `PrematureCommitError`.
type Queued = PromiseExtended<void>;

/**
 * The ops queued for one drawing. For *that* drawing: an id names a drawing only inside
 * its connection, and another source's drawing of the same id has a queue of its
 * own, which a write here must not be taken to be covered by, nor a delete here
 * withdraw.
 */
export const opsFor = (
	db: QueueDb,
	drawing: Pick<DrawingRecord, 'connectionId' | 'id'>
): PromiseExtended<OpQueueRecord[]> =>
	db.opQueue
		.where('drawingId')
		.equals(drawing.id)
		.filter((op) => op.connectionId === drawing.connectionId)
		.toArray();

const seqsOf = (ops: readonly OpQueueRecord[]): number[] =>
	ops.flatMap((op) => (op.seq === undefined ? [] : [op.seq]));

/** The connection's ops about one path, by the `path` index. */
const atPath = (
	db: QueueDb,
	connectionId: string,
	path: string
): PromiseExtended<OpQueueRecord[]> =>
	db.opQueue
		.where('path')
		.equals(path)
		.filter((op) => op.connectionId === connectionId)
		.toArray();

const nothing = (): Queued => Dexie.Promise.resolve();

const add = (db: QueueDb, op: NewSyncOp & { connectionId: string }): Queued =>
	db.opQueue.add({ attempts: 0, queuedAt: Date.now(), ...op }).then(() => undefined);

/**
 * The drawing's contents have changed. One queued write is enough, however many
 * edits land before it runs. `except` is an op that is finishing, which does not
 * count as still queued.
 */
export const queueWrite = (db: QueueDb, drawing: DrawingRecord, except?: number): Queued =>
	// A tombstone owes the remote its delete and nothing else.
	isTombstone(drawing)
		? nothing()
		: opsFor(db, drawing).then((queued) =>
				queued.some((op) => op.op === 'write' && op.seq !== except)
					? undefined
					: add(db, {
							connectionId: drawing.connectionId,
							op: 'write',
							drawingId: drawing.id,
							path: drawing.path,
						})
			);

/**
 * The drawing is now at `drawing.path`, having been at `from`. Replaces any move
 * already queued for it, keeping that move's origin: the file is still wherever
 * the first move would have taken it from.
 */
export const queueMove = (db: QueueDb, drawing: DrawingRecord, from: string): Queued =>
	opsFor(db, drawing).then((ops) => {
		const moves = ops.filter((op) => op.op === 'move');
		// Already on its way to where the drawing is: leave it where it stands in the
		// queue rather than sending it to the back.
		if (moves.length === 1 && moves[0]?.targetPath === drawing.path) return undefined;
		const origin = moves[0]?.path ?? from;
		// A tombstone is moved too. Its delete would find the file wherever it
		// is, but it can be restored, and its write is then addressed to where
		// the drawing has got to — which only a move queued for it explains.
		const owed = drawing.remoteId !== undefined && origin !== drawing.path;
		return db.opQueue.bulkDelete(seqsOf(moves)).then(() =>
			owed
				? add(db, {
						connectionId: drawing.connectionId,
						op: 'move',
						drawingId: drawing.id,
						path: origin,
						targetPath: drawing.path,
					})
				: undefined
		);
	});

/**
 * The drawing is deleted. Only ever asked once per deletion: `deleteDrawing` does
 * nothing to a drawing already deleted, and a folder's delete passes over them.
 *
 * Any write still queued for it is withdrawn first — it owes the remote its
 * delete and nothing else, which is the same rule `queueWrite` applies to a
 * tombstone from the other end.
 *
 * Without that, a drawing made and deleted before either op was ever sent still
 * has its write run: the file is created and then removed again. Harmless on
 * its own, and not harmless at all when another device has made a drawing of the
 * same name meanwhile. The write puts *this* device's file at the path first,
 * the other device's write then binds its drawing to that file rather than making
 * one, and the delete behind it takes the other device's drawing away with it —
 * a drawing nobody deleted, gone from every device. The two-browser soak found it
 * (`apps/web/tests/soak.test.ts`).
 *
 * A write already at the network is withdrawn from the queue only, which is
 * what `settle` handles: the file it creates is still recorded on the row, so
 * this delete has the `remoteId` it needs to remove it.
 */
export const queueDelete = (db: QueueDb, drawing: DrawingRecord): Queued =>
	opsFor(db, drawing)
		.then((queued) => db.opQueue.bulkDelete(seqsOf(queued.filter((op) => op.op === 'write'))))
		.then(() =>
			add(db, {
				connectionId: drawing.connectionId,
				op: 'delete',
				drawingId: drawing.id,
				path: drawing.path,
			})
		);

/**
 * A deleted drawing is the user's again. A delete still queued is withdrawn — if it
 * was already on its way, the file is gone and the write re-creates it — and the
 * drawing is owed a write either way.
 */
export const queueRestore = (db: QueueDb, drawing: DrawingRecord): Queued =>
	opsFor(db, drawing)
		.then((ops) => db.opQueue.bulkDelete(seqsOf(ops.filter((op) => op.op === 'delete'))))
		.then(() => queueWrite(db, drawing));

/**
 * A folder that has to exist on the remote even with nothing in it yet.
 *
 * An `rmdir` queued for this path or for one above it is withdrawn: the user
 * has made the folder again, and the directory it would remove is the one
 * this needs — or holds it. The engine checks for a row at the path as well
 * (`runRmdir`), which covers an `rmdir` already at the network; this keeps one
 * still queued from being sent at all, since it would otherwise be sent after
 * this `mkdir` and undo it.
 */
export const queueMkdir = (db: QueueDb, connectionId: string, path: string): Queued =>
	// By the `path` index, and only the paths that can hold such an `rmdir`:
	// this runs once per folder a create or a move brings into being, and a
	// device with a long offline backlog would otherwise read the whole queue
	// each time.
	db.opQueue
		.where('path')
		.anyOf([path, ...ancestorPaths(path)])
		.filter((op) => op.connectionId === connectionId && op.op === 'rmdir')
		.toArray()
		.then((stale) =>
			db.opQueue
				.bulkDelete(seqsOf(stale))
				.then(() => atPath(db, connectionId, path))
				.then((queued) =>
					queued.some((op) => op.op === 'mkdir')
						? undefined
						: add(db, { connectionId, op: 'mkdir', path })
				)
		);

/** The ops queued for one file, within its connection, as `opsFor` for a drawing. */
export const opsForFile = (
	db: QueueDb,
	file: Pick<FileRecord, 'connectionId' | 'id'>
): PromiseExtended<OpQueueRecord[]> =>
	db.opQueue
		.where('fileId')
		.equals(file.id)
		.filter((op) => op.connectionId === file.connectionId)
		.toArray();

/**
 * A file added here, owed its bytes on the remote. The engine reads the bytes
 * when it runs the op, from this device or, for a copy whose bytes it does
 * not hold, from `copyOf` — the `remoteId` of the file it copies.
 *
 * One upload is enough, as one write is for a drawing: asked again for a file
 * that has one queued — a bind that both resumes rows and finds the same
 * connection's own owed (`bindConnection`) — it adds nothing, and the file is
 * not sent twice.
 */
export const queueUpload = (db: QueueDb, file: FileRecord, copyOf?: string): Queued =>
	opsForFile(db, file).then((queued) =>
		queued.some((op) => op.op === 'upload')
			? undefined
			: add(db, {
					connectionId: file.connectionId,
					op: 'upload',
					fileId: file.id,
					path: file.path,
					...(copyOf === undefined ? {} : { copyOf }),
				})
	);

/** What a library owes the remote at once: folders to make, files to send, drawings to write. */
export interface Owed {
	readonly folders: readonly string[];
	readonly files: readonly FileRecord[];
	readonly drawings: readonly DrawingRecord[];
}

/** One owed op, by the folder it is in (folded segments) and which of its ops it is. */
interface InFolder {
	readonly folder: readonly string[];
	readonly rank: number;
	readonly queue: () => Queued;
}

const folderOf = (path: string): string[] => pathSegments(path).map(foldName);

/**
 * Folders in depth-first pre-order: each before every folder inside it, and
 * siblings by name. The top of the source, which is no folder, is first.
 */
const preOrder = (a: readonly string[], b: readonly string[]): number => {
	const [name, ...insideA] = a;
	const [other, ...insideB] = b;
	if (name === undefined || other === undefined) return a.length - b.length;
	return name.localeCompare(other) || preOrder(insideA, insideB);
};

/**
 * What a whole library owes the remote, queued folder by folder: a pick of
 * files imported (`importLibrary`), or the rows a bind or a move carries into a
 * connection (`queueOwed` in `connection.ts`). The drawings at the top of the
 * source first, which need no `mkdir`; then each folder in turn — its
 * `mkdir`, the uploads of the files directly in it, the writes of the drawings
 * directly in it — and after it the folders inside it, in the same way.
 *
 * So another device fills in a folder at a time. Queued as they once were,
 * every `mkdir`, then every upload, then every write, a library of a thousand
 * drawings on Google Drive, where a drawing is about four requests one after another,
 * showed every folder on another device, empty, long before the first drawing
 * reached any of them.
 *
 * A folder's `mkdir` comes before everything in it, since `createFolder` is
 * not recursive everywhere. A folder's files come before its drawings, so a
 * picture beside a drawing lands before the drawing does. One a drawing links from
 * elsewhere — a folder inside, such as `assets/`, or another by `../` — may
 * land after it, and shows as not there until it does, which heals itself.
 *
 * Siblings by name, by `localeCompare`, as paths are sorted elsewhere in the
 * store; folded, so one folder spelled two ways by two rows is one folder
 * here as on every provider, and its `mkdir` comes before what is in it in
 * either spelling. Within a folder, its files, and its drawings, keep the order
 * they are given in.
 *
 * Only what is queued here is ordered so. Each op is queued by the helper that
 * dedupes it, so a folder with a `mkdir` queued, a file with an upload or a
 * drawing with a write gets nothing more, and the one queued keeps its place.
 */
export const queueByFolder = (db: QueueDb, connectionId: string, owed: Owed): Queued =>
	[
		...owed.folders.map((path): InFolder => ({
			folder: folderOf(path),
			rank: 0,
			queue: () => queueMkdir(db, connectionId, path),
		})),
		...owed.files.map((file): InFolder => ({
			folder: folderOf(parentPath(file.path)),
			rank: 1,
			queue: () => queueUpload(db, file),
		})),
		...owed.drawings.map((drawing): InFolder => ({
			folder: folderOf(parentPath(drawing.path)),
			rank: 2,
			queue: () => queueWrite(db, drawing),
		})),
	]
		.sort((a, b) => preOrder(a.folder, b.folder) || a.rank - b.rank)
		.reduce<Queued>((queued, next) => queued.then(next.queue), nothing());
