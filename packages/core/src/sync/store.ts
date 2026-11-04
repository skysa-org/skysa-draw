import type { RemoteEntry } from '../providers/types.js';

/**
 * The local store, as the sync engine needs it. `packages/core` cannot import
 * Dexie — it has to run in Node and in a Worker — so the engine talks to this
 * port and `apps/web` implements it over IndexedDB.
 *
 * Two things shape the shape of it:
 *
 * The engine deals in **file bytes**, never in a drawing's parsed parts. A drawing is
 * its SVG text (`CLAUDE.md`), and an engine that took the root's attributes and
 * the body separately would be re-serializing the user's file on every
 * sync and quietly normalizing drawings nobody edited.
 *
 * Writes are **batched, not fine-grained**. docs/ARCHITECTURE.md §7 requires the pull
 * cursor to be persisted only after the batch it describes has committed; the
 * only way to promise that is to hand the store the whole batch and the cursor
 * together and let it use one transaction. A store that applied changes one at
 * a time could be interrupted holding a cursor that claims work it never did,
 * and the next pull would skip it.
 */

/** A drawing as the engine sees it. */
export interface SyncDrawing {
	id: string;
	path: string;
	/** The whole file, the SVG text as it is. */
	content: string;
	/** Absent until the drawing has been pushed, or after the remote copy is gone. */
	remoteId?: string;
	remoteVersion?: string;
	/**
	 * `contentHash` of the bytes this drawing and its remote file last agreed on:
	 * what a pull brought in, or what a push sent. What lets the engine tell a
	 * remote *edit* from a remote rename on a provider whose version changes on
	 * a move (OneDrive's `eTag`, docs/ARCHITECTURE.md §7): a drawing with unpushed edits
	 * whose file comes back under a new version but with these same bytes was
	 * not edited over there, and needs no conflict copy.
	 *
	 * Absent until the drawing has synced once with it recorded, and whenever the
	 * remote file is let go of. Absent means "cannot say", which takes the
	 * conflict branch as before — so rows from before it existed need nothing.
	 */
	syncedHash?: string;
	/** Has local edits that have not reached the remote yet. */
	dirty: boolean;
}

/**
 * A file the engine found and could not read as a drawing — not UTF-8 text, or
 * not an SVG document (`readDrawingText`) — and so left alone
 * (docs/ARCHITECTURE.md §7). Kept so the app can say which files it is not showing,
 * and for nothing else: **no decision may rest on this list.** No row holds
 * such a file's id, so every mention of it in a feed is read again, and a list
 * that is stale, or lost, costs the user a line of text and never a file.
 *
 * Keyed by `remoteId`. The path is where the file was when it was last read,
 * which is what the user needs to find it by.
 */
export interface UnreadableFile {
	remoteId: string;
	path: string;
	/**
	 * Where a drawing of the user's went when this file took its name, if one
	 * did. The file cannot be shown, so without this the drawing is renamed for
	 * no reason the user can see — and it is *not* a conflict: nobody edited
	 * anything twice, a file arrived that could not be read. Carried on the
	 * record rather than reported once, because the rename is permanent and a
	 * banner that has scrolled past is no answer to "why is my drawing called
	 * that".
	 *
	 * Kept when the same file is recorded again at a new path, since the drawing
	 * is still where it was put. More than one can end up here: a folder move
	 * can land two rows on one name before this decision is reached.
	 */
	movedAside?: readonly string[];
}

/**
 * A file beside a drawing that is not one: a picture, a PDF, anything a drawing links
 * (#187, docs/ARCHITECTURE.md §7). Mirrored as what the remote says of it and
 * nothing more — its bytes are fetched when it is shown, not when it is pulled
 * — so a row is cheap, and a store holds one for every such file the remote
 * has, linked or not.
 *
 * Two kinds of row, and two rules:
 *
 * - **Bound** (`remoteId` set): a copy of what the remote says. A pull may
 *   rewrite or drop one freely; the worst a wrong one costs is a picture that
 *   does not show until the next scan.
 * - **Pending** (no `remoteId`): added on this device and not yet uploaded.
 *   User data, as a dirty drawing is: a pull never removes one, a folder's
 *   deletion leaves it, and its bytes are held until they are up.
 *
 * Files never conflict on content — the app never writes into one — only on
 * where they are.
 */
export interface SyncFile {
	/** The store's own name for the row: a file has no `draw:id` to carry one. */
	id: string;
	path: string;
	/** Absent while the file is pending. */
	remoteId?: string;
	remoteVersion?: string;
	/** In bytes. */
	size: number;
}

/** A folder as the engine sees it. Only identity and position matter here. */
export interface SyncFolder {
	path: string;
	remoteId?: string;
}

/** What every queued push has, whatever it does. `seq` orders the queue and identifies the row. */
interface Queued {
	seq: number;
	/** Where it is about: the drawing's or the file's path, or the folder's. */
	path: string;
	/** How many times this op has already failed. */
	attempts: number;
}

/**
 * One queued push, by what it does: each kind carries the fields it needs, so
 * the engine never asks at run time for one it cannot be without (#447).
 */
export type SyncOp = Queued &
	(
		| { op: 'write'; drawingId: string }
		| {
				op: 'move';
				drawingId: string;
				/** Where it is going; `path` is where the file is now. */
				targetPath: string;
		  }
		| { op: 'delete'; drawingId: string }
		| { op: 'mkdir' }
		| {
				op: 'rmdir';
				/**
				 * The folder's `remoteId` as the queue recorded it. The op
				 * removes a folder this device no longer holds, so there is no
				 * row left to read it from — and without it the engine cannot
				 * tell the folder it is about from whatever has the name now, so
				 * it does nothing at all.
				 */
				remoteId?: string;
		  }
		| {
				/** A pending file's bytes, sent to `path`. */
				op: 'upload';
				fileId: string;
				/**
				 * Where this device does not hold the bytes: the `remoteId` of a
				 * file that has them, to read them from. A drawing moved out of a
				 * folder where another drawing links the same file takes a copy of
				 * it, and the copy can be owed before the original was ever
				 * downloaded here.
				 */
				copyOf?: string;
		  }
		| {
				/** A bound file, from `path` to `targetPath`. */
				op: 'move-file';
				fileId: string;
				targetPath: string;
		  }
		| {
				/**
				 * A file this device no longer holds a row for, by `remoteId`,
				 * for `rmdir`'s reason: the row goes when the user deletes the
				 * file, and the op is what is left of it.
				 */
				op: 'delete-file';
				remoteId: string;
		  }
		| {
				/**
				 * A queued row that is none of the above: one that lacks what its
				 * kind needs, or of a kind this version does not know, written by
				 * a later one. Read as it is rather than thrown on, so the rest of
				 * the queue still reads, and kept: the engine fails it as any op
				 * that cannot be sent, until it stops the push and says so.
				 * `problem` says what was wrong with it.
				 */
				op: 'malformed';
				problem: string;
		  }
	);

/** The kinds of op a device queues. `malformed` is only ever read. */
export type SyncOperation = Exclude<SyncOp['op'], 'malformed'>;

/** One kind of queued push. */
export type SyncOpOf<Operation extends SyncOp['op']> = Extract<SyncOp, { op: Operation }>;

type QueuedAs<Op> = Op extends unknown ? Omit<Op, 'seq' | 'attempts'> : never;

/** A push as it is queued, before the queue gives it a `seq`, with no attempts yet. */
export type NewSyncOp = QueuedAs<Exclude<SyncOp, { op: 'malformed' }>>;

/** Where an op leaves what it is about: a move's target, or else its own path. */
export const destinationOf = (op: SyncOp): string =>
	op.op === 'move' || op.op === 'move-file' ? op.targetPath : op.path;

/** The file an upload reads its bytes from instead, where it has one: none, or that one. */
export const copiedBy = (op: SyncOp): readonly string[] =>
	op.op === 'upload' && op.copyOf !== undefined ? [op.copyOf] : [];

/**
 * One decision the engine reached about one remote change. The engine works out
 * which of these applies; the store only has to carry them out.
 *
 * With one exception, which only the store can make: **a decision reached about
 * a drawing is carried out against the drawing as it stands, not as the engine read
 * it.** The engine reads a drawing, goes to the network for the remote file, and
 * only then hands the batch over — and the user can type in between.
 * `upsert-drawing` and `delete-drawing` are decided only for a clean drawing; carried out
 * against one that has since been edited, each throws away what was typed, and
 * an upsert calls the drawing clean as it does. So they are refused: the store is
 * the only place that can check atomically, the batch is rejected, the cursor
 * stays where it was, and the next pull reads the drawing as it now stands and
 * decides a conflict instead. A conflict needs no refusal — the drawing is dirty
 * either way — so its copy is simply made from the drawing's current file (see
 * `ConflictResolution`).
 *
 * Anything that puts a drawing at a path — `upsert-drawing`, `move-drawing`,
 * `displace-drawing`, and a conflict's copy — creates the folder rows above it
 * that are missing, in the same transaction. The engine emits `ensure-folder`
 * only for folders the *remote* reported, and a provider that reports a file
 * without its parent is ordinary (a scan page boundary, a `changes` feed that
 * only mentions what changed), so a store that skipped this would leave drawings
 * at paths with no folder behind them — invisible in the sidebar, and still
 * taking up their names.
 */
export type PullChange =
	| Readonly<{
			/**
			 * Remote is authoritative: create the drawing, or overwrite a clean one.
			 * Refused if the drawing is dirty by the time it is applied (see above).
			 */
			kind: 'upsert-drawing';
			/**
			 * Which local drawing this is. The engine decides it — an existing drawing's
			 * id, the `draw:id` the file carries on its root, or a fresh one —
			 * because only the engine knows whether the drawing it found at this path
			 * is the same file or a different one that has since taken the name. A
			 * store left to match on its own picks the wrong drawing the moment a
			 * path is reused, and overwrites it.
			 */
			id: string;
			/**
			 * Where the drawing ends up — it moves if it was elsewhere.
			 *
			 * Another drawing may be at this path *while the batch is being
			 * applied*: a drawing moving out of the way is a change of its own, and
			 * it can come later in the same batch. So the store must not enforce
			 * uniqueness on `path` (a unique index would reject the batch, and a
			 * rejected batch is retried for ever) and must not make room by
			 * deleting whatever is there — that drawing is about to be moved, and
			 * deleting it takes its unpushed edits with it. By the end of the
			 * batch exactly one drawing is at each path; the engine sees to that.
			 */
			path: string;
			content: string;
			remote: RemoteEntry;
			/** `contentHash(content)`, recorded as the drawing's `syncedHash`. */
			syncedHash: string;
			/**
			 * A queued `move` for this drawing has its *origin* pointed at `path`
			 * as well — the remote has just said where the file is, and the
			 * origin is what says whether a folder's deletion is about that file
			 * (`delete-folder`'s `keep`). A conflict's remote side does the same,
			 * and so does `adopt-version`, which is the branch a drawing with a
			 * queued rename actually takes when the remote moves its file.
			 * The queued rename's target is the name the user chose, and is left
			 * alone. `move-drawing` needs no such rule: the engine never emits one
			 * for a drawing whose own rename is queued.
			 */
	  }>
	| Readonly<{
			/**
			 * Take the remote's version and touch nothing else — the drawing may
			 * hold unpushed edits, which stay dirty and go out against it. Sent
			 * when the remote holds nothing the drawing lacks: bytes equal to the
			 * drawing's, or to the ones it last synced, under a new version; or the
			 * user's own queued rename coming back with its version unchanged.
			 */
			kind: 'adopt-version';
			id: string;
			remote: RemoteEntry;
			/**
			 * Recorded as the drawing's `syncedHash` when present. Absent means keep
			 * whatever the row holds: the engine sends it whenever it has one,
			 * so absent is a drawing that never recorded its bytes.
			 */
			syncedHash?: string;
	  }>
	| Readonly<{
			/**
			 * Renamed or moved remotely, contents unchanged. The drawing's queued
			 * ops follow it, as they do for `move-folder` and `displace-drawing`:
			 * anything that changes where a drawing is changes where its queued
			 * work is aimed.
			 *
			 * The engine never emits one of these for a drawing whose own rename is
			 * queued — a `move` in the queue is what tells the user's rename
			 * from the remote's, and the drawing is left where the user put it
			 * (docs/ARCHITECTURE.md §7) — so this never has to decide what a pending
			 * rename means once the drawing has moved somewhere else.
			 */
			kind: 'move-drawing';
			id: string;
			path: string;
			remote: RemoteEntry;
			/** As for `adopt-version`. `dirty` and the content are left alone. */
			syncedHash?: string;
	  }>
	| Readonly<{
			/**
			 * Gone remotely, with nothing local worth keeping. An id that is not
			 * in the store must succeed and do nothing: rejecting would fail the
			 * whole batch, and since the cursor moves only with the batch the
			 * same one would be retried for ever, leaving the user with a sync
			 * that never recovers on its own.
			 *
			 * A drawing that is here and dirty is refused rather than deleted: it was
			 * clean when the engine decided, so it has been edited since (see
			 * above).
			 */
			kind: 'delete-drawing';
			id: string;
	  }>
	| Readonly<{
			/**
			 * The remote copy is gone but the local one has unpushed edits. Keep
			 * the drawing and forget the remote — its `syncedHash` too — so the next
			 * push re-creates it rather than writing to a file that no longer
			 * exists. Tolerates an
			 * unknown id for the same reason `delete-drawing` does.
			 */
			kind: 'detach-drawing';
			id: string;
	  }>
	| Readonly<{
			/**
			 * A drawing of ours is sitting where a remote one is about to land. Move
			 * ours aside, keeping its contents and its dirty flag: it is the
			 * user's writing and the remote keeps the path (docs/ARCHITECTURE.md §7).
			 * Two rows at one path is a drawing the sidebar shows twice, two queued
			 * writes racing for one file, and — once both have been pushed — one
			 * `remoteId` between them, after which `drawingByRemoteId` only ever
			 * hands back one and the other is stale for ever.
			 *
			 * The store rebases the drawing's own queued ops in the same
			 * transaction, exactly as `move-folder` does, and for a sharper
			 * reason: a queued `move` is the user's rename, and its target is
			 * the very path the remote has just taken. Left pointing there it
			 * conflicts on every push and can never succeed — and since the
			 * queue is ordered and a dead op stops the drain, every later op for
			 * every other drawing is stranded behind it. On a provider whose move
			 * overwrites rather than conflicting, it does something worse and
			 * clobbers the file that displaced it.
			 */
			kind: 'displace-drawing';
			/**
			 * An id that is not in the store must succeed and do nothing, for the
			 * same reason `delete-drawing` must: a rejected batch is retried for
			 * ever, since the cursor moves only with the batch.
			 */
			id: string;
			path: string;
	  }>
	| Readonly<{
			/**
			 * A folder that must exist, with this `remoteId`. Idempotent: the
			 * folder may already be there, with an id or without one. Never the
			 * root: the app folder itself is not one of the user's folders and holds no row.
			 */
			kind: 'ensure-folder';
			path: string;
			remoteId?: string;
	  }>
	| Readonly<{
			/**
			 * A folder moved. The store rebases every drawing beneath it *and* every
			 * queued op that names a path under it, in the same transaction:
			 * docs/ARCHITECTURE.md §7 applies a remote folder move unconditionally, even
			 * over dirty drawings, because it is metadata and cannot conflict with
			 * an edit to the contents.
			 *
			 * Both halves of an op's address, not just `path`: a queued `move`
			 * says where the drawing is *and* where it is going, and one left aimed
			 * at a folder that no longer exists fails on every attempt. The
			 * queue is ordered, so that strands every op behind it — for every
			 * drawing, not only this one.
			 *
			 * And every `UnreadableFile` beneath it, whose path is rebased the
			 * same way. A feed that reports by id says the folder moved and
			 * nothing about what is in it, so nothing else would correct them.
			 *
			 * And every file row beneath it, bound or pending, with the queued
			 * ops that name them — the rule for ops above is about every op.
			 */
			kind: 'move-folder';
			from: string;
			to: string;
			remoteId?: string;
	  }>
	| Readonly<{
			/**
			 * The folder is gone remotely, and so is everything under it. The
			 * store cascades — clean drawings beneath are deleted, dirty ones are
			 * detached and kept — rather than the engine listing them: a provider
			 * that reports the descendants too would then name each drawing twice,
			 * and the second mention would be a delete of something already gone.
			 *
			 * A path with no folder at it must succeed and do nothing, for the
			 * same reason `delete-drawing` must: rejecting fails the batch, and
			 * since the cursor moves only with the batch the user is left with a
			 * sync that never recovers on its own.
			 *
			 * Every `UnreadableFile` beneath the path is forgotten with it,
			 * whether or not a folder row is there: those files are gone too, and
			 * an id-only feed mentions the folder alone.
			 */
			kind: 'delete-folder';
			path: string;
			/**
			 * Where this folder's row stood when the batch was decided, when the
			 * batch has moved it since — the same directory's other spelling.
			 * Absent when nothing moved it.
			 *
			 * The engine is what needs it: the queue it reads is frozen before
			 * the batch, so a queued rename's origin is spelled with the row's
			 * old path. A store applying the rule itself does not — a
			 * `move-folder` is always applied before the `delete-folder` that
			 * follows it, and rebases every queued op on the way — but it costs
			 * nothing to honor, and a rule that does not depend on the order
			 * two changes happen to arrive in is the one worth writing down.
			 */
			was?: string;
			/**
			 * Drawings the cascade must leave exactly as they are, by id. A row is
			 * under the folder because the user moved the drawing there, and until
			 * that rename runs the file is still where it was — so the folder
			 * going says nothing at all about it. Taking the row would drop a
			 * drawing whose file the remote still holds, and nothing would mention
			 * that file again, since the cursor has moved past it: only a
			 * re-scan would bring the drawing back.
			 *
			 * The engine names them rather than the store working it out,
			 * because the queue is read once for the batch and whether the drawing
			 * is still under the folder at all is the batch's answer, not the
			 * store's. A drawing whose file *is* inside the folder is not here: it
			 * goes with the folder, and the queued rename finds nothing left to
			 * move.
			 *
			 * A store that holds the queue must still apply the rule itself as a
			 * backstop — spare any drawing under the folder whose queued `move`
			 * says its file is outside both `path` and `was` — because the
			 * engine reads the queue when it decides the batch and the batch is
			 * applied later: a drawing the user moves in between is not named here.
			 *
			 * An id that is not there, or not under the folder, is ignored. The
			 * batch is decided before it is applied, and must not be rejected
			 * for saying more than the store needs.
			 */
			keep?: readonly string[];
			/**
			 * The same for files, by file id: a bound file under the folder goes
			 * with it unless it is named here, or its own queued `move-file` says
			 * it is outside both `path` and `was` — the same backstop, for the
			 * same reason. A pending file always stays: it is the user's, and
			 * exists nowhere else.
			 *
			 * A file that goes takes its bytes with it.
			 */
			keepFiles?: readonly string[];
	  }>
	| Readonly<{
			/**
			 * The scan did not return this drawing's file, but the provider has told us
			 * its own copy may be the one that lost it (`CursorResetError`'s
			 * `uploadDifferences` — Graph's "Upload any local items that the service
			 * didn't return"). So the drawing stays and goes back up instead of being
			 * deleted: forget the remote it had — `remoteId`, `remoteVersion` and
			 * `syncedHash` — mark it dirty, and queue a `write`, which then creates
			 * the file afresh rather than writing to one that is not there.
			 *
			 * `detach-drawing` is the same forgetting without the dirty flag and the
			 * op, which is right for a drawing that is *already* dirty: it has a write
			 * coming either way. This kind exists for the clean ones, which nothing
			 * would otherwise send.
			 *
			 * Tolerates an unknown id for the same reason `delete-drawing` does: a batch
			 * is decided before it is applied, and a rejected batch is retried for
			 * ever, since the cursor moves only with the batch.
			 */
			kind: 'reupload-drawing';
			id: string;
	  }>
	| Readonly<{
			/**
			 * The same, for a folder the scan did not return: keep the row, forget
			 * its `remoteId`, and queue a `mkdir` so the directory is made again.
			 * Never cascades — that is the whole point, since the drawings under it are
			 * being sent back up too, each named by its own `reupload-drawing`.
			 *
			 * Tolerates an unknown path, and a row that already has no `remoteId`.
			 */
			kind: 'reupload-folder';
			path: string;
	  }>
	| Readonly<{
			/**
			 * A file is there and is not a drawing's text, so nothing was imported
			 * (`UnreadableFile`). Remember it, under its `remoteId`: a second
			 * record for the same id replaces the first, which is how a rename
			 * of such a file is told. Committed with the batch and its cursor
			 * like everything else here, so the list never names a file from a
			 * batch that did not land.
			 *
			 * `file`, and not a `path` and an `id` of its own: the engine asks
			 * several questions of a batch by shape — which changes put a drawing
			 * at a path, which name a drawing — and this one does neither. Its
			 * `movedAside` is the same: the store only keeps it, and the
			 * `displace-drawing` in front of this change is what moves the drawing.
			 */
			kind: 'unreadable';
			file: UnreadableFile;
	  }>
	| Readonly<{
			/**
			 * The file reads now, or is gone, or is no longer a drawing: stop
			 * listing it. An id that is not listed must succeed and do nothing,
			 * as for `delete-drawing` — and here it is ordinary too, since the
			 * engine says this of a file a push recorded after the batch's list
			 * was read.
			 */
			kind: 'forget-unreadable';
			remoteId: string;
	  }>
	| Readonly<{ kind: 'conflict'; resolution: ConflictResolution }>
	/*
	 * A file's changes are keyed by `fileId`, never `id`, and say so in
	 * `CHANGE_KINDS`: what a change is about is read off its kind.
	 */
	| Readonly<{
			/**
			 * The remote has this file, at `remote.path`: put the row, bound to
			 * it, whole, at `path`. A row that had other bytes cached under
			 * another version keeps them, and `fileBytes` stops returning them
			 * (`SyncStore.fileBytes`).
			 *
			 * A row with a `move-file` queued stays where it is, whatever `path`
			 * says: the user moved it there and the remote has not heard yet. The
			 * move starts from `remote.path`, which is where the file is.
			 *
			 * Passed over while a `delete-file` for this `remoteId` is queued,
			 * which is the user's word that it should go — passed over rather
			 * than refused, or a delete stuck at the network would stop every
			 * pull that mentioned the file. Refused — the batch rejected, as for
			 * a dirty drawing — over a pending row without `adopt`, which would take
			 * a file that exists nowhere else and call it the remote's.
			 */
			kind: 'upsert-file';
			fileId: string;
			path: string;
			remote: RemoteEntry;
			/**
			 * The row is a pending file found already on the remote at its own
			 * path and size: the same file, uploaded by another device or by a run
			 * of this one that never heard back. Bound to it, and its bytes kept
			 * as the remote version's — what saves uploading them again. Its
			 * queued `upload` is withdrawn.
			 *
			 * Refused for anything but a pending row at `path` whose size is the
			 * remote's: adopted, the user's bytes would stop being held for an
			 * upload and pass for a cached copy of a file they are not.
			 */
			adopt?: true;
	  }>
	| Readonly<{
			/**
			 * A pending file is where a different remote file is about to land:
			 * moved aside, with its queued `upload`, as `displace-drawing` moves a
			 * drawing. An unknown id is a no-op, as there.
			 */
			kind: 'displace-file';
			fileId: string;
			path: string;
	  }>
	| Readonly<{
			/**
			 * Gone remotely: the row goes, and its bytes, and any `upload` or
			 * `move-file` queued for it. Bound rows only — a pending one is
			 * refused, since it was never the remote's to take. An unknown id is a
			 * no-op, as for `delete-drawing`.
			 *
			 * An `upload` that copies the file (`copyOf`) was to read it from the
			 * remote, which has just said it is gone; so the bytes this device
			 * holds of it, if they are current, are handed to the copy first, held
			 * until it is sent. The same goes for every bound row a
			 * `delete-folder` takes and for a `reupload-file`.
			 */
			kind: 'delete-file';
			fileId: string;
	  }>
	| Readonly<{
			/**
			 * A file gone from the remote that this device still wants there: a
			 * rescan did not return it where the provider said its own copy may be
			 * what lost it (`reupload-drawing`), or the user had moved it here. The
			 * row forgets its remote and is pending where it is, an `upload` is
			 * queued, and the bytes, where they are current here, are held until
			 * they are up. Where they are not, the row is pending all the same:
			 * its upload finds nothing to send, and the row goes then (`lost-file`).
			 *
			 * Pending either way, because the engine cannot see the bytes and has
			 * to know what the row is after this: a later file in the same batch
			 * at its path, of its size, is adopted into it, and adopting a row the
			 * store had dropped would reject the batch on every pull for good
			 * (#194). A `move-file` queued for it goes: the upload is to where the
			 * row is. An unknown id is a no-op.
			 */
			kind: 'reupload-file';
			fileId: string;
	  }>;

/**
 * What each kind of change is about, and what it says of it: whether it puts
 * it at a `path`, and whether it binds it to a `remote` file. Named for every
 * kind, so a new one does not compile until it says, and read by the helpers
 * below, so nothing asks a change which fields it happens to have (#447). A
 * kind said to carry a field it does not have fails to compile where the
 * helper reads it. A conflict is about two drawings, by its resolution's ids,
 * and every caller that asks says what it wants of those.
 */
const CHANGE_KINDS = {
	'upsert-drawing': { about: 'drawing', placed: true, bound: true },
	'adopt-version': { about: 'drawing', placed: false, bound: true },
	'move-drawing': { about: 'drawing', placed: true, bound: true },
	'delete-drawing': { about: 'drawing', placed: false, bound: false },
	'detach-drawing': { about: 'drawing', placed: false, bound: false },
	'displace-drawing': { about: 'drawing', placed: true, bound: false },
	'reupload-drawing': { about: 'drawing', placed: false, bound: false },
	'ensure-folder': { about: 'folder', placed: true, bound: false },
	'move-folder': { about: 'folder', placed: false, bound: false },
	'delete-folder': { about: 'folder', placed: true, bound: false },
	'reupload-folder': { about: 'folder', placed: true, bound: false },
	unreadable: { about: 'unreadable', placed: false, bound: false },
	'forget-unreadable': { about: 'unreadable', placed: false, bound: false },
	conflict: { about: 'conflict', placed: false, bound: false },
	'upsert-file': { about: 'file', placed: true, bound: true },
	'displace-file': { about: 'file', placed: true, bound: false },
	'delete-file': { about: 'file', placed: false, bound: false },
	'reupload-file': { about: 'file', placed: false, bound: false },
} as const satisfies Record<
	PullChange['kind'],
	{
		about: 'drawing' | 'folder' | 'file' | 'unreadable' | 'conflict';
		placed: boolean;
		bound: boolean;
	}
>;

type Kinds = typeof CHANGE_KINDS;

type KindsWhere<Key extends keyof Kinds[PullChange['kind']], Value> = {
	[Kind in PullChange['kind']]: Kinds[Kind][Key] extends Value ? Kind : never;
}[PullChange['kind']];

/** A change about one drawing, named by its `id`. */
export type DrawingChange = Extract<PullChange, { kind: KindsWhere<'about', 'drawing'> }>;
/** A change about a file that is not a drawing, named by its `fileId`. */
export type FileChange = Extract<PullChange, { kind: KindsWhere<'about', 'file'> }>;
type PlacingChange = Extract<PullChange, { kind: KindsWhere<'placed', true> }>;
type BindingChange = Extract<PullChange, { kind: KindsWhere<'bound', true> }>;

export const isDrawingChange = (change: PullChange): change is DrawingChange =>
	CHANGE_KINDS[change.kind].about === 'drawing';

export const isFileChange = (change: PullChange): change is FileChange =>
	CHANGE_KINDS[change.kind].about === 'file';

const isPlacing = (change: PullChange): change is PlacingChange => CHANGE_KINDS[change.kind].placed;

const isBinding = (change: PullChange): change is BindingChange => CHANGE_KINDS[change.kind].bound;

/** The drawing a change is about, where it is one drawing's: not a conflict's two. */
export const drawingIdOf = (change: PullChange): string | undefined =>
	isDrawingChange(change) ? change.id : undefined;

/**
 * Where a change puts what it is about, for the kinds that say: a drawing
 * written or moved, a folder made, deleted or sent back up, a file written or
 * moved aside. Not a folder's move, which says `from` and `to`.
 */
export const pathOf = (change: PullChange): string | undefined =>
	isPlacing(change) ? change.path : undefined;

/** The remote file a change binds what it is about to, for the kinds that do. */
export const remoteOf = (change: PullChange): RemoteEntry | undefined =>
	isBinding(change) ? change.remote : undefined;

/**
 * Both sides changed the same drawing. The remote keeps the path; the local copy
 * is written beside it as a new drawing and queued for push.
 *
 * One value rather than a pair of calls, because a crash between the two halves
 * is the case this whole scheme exists to prevent: it would leave the user's
 * edit overwritten with no copy of it anywhere.
 *
 * Applying one discards `drawingId`'s queued `write` ops, wherever it is applied
 * from — `applyChanges` as well as `resolveConflict`. Those ops carry the edit
 * that lost, which is exactly what the copy now holds, and the drawing itself now
 * holds the remote's bytes and is clean. Sending them anyway writes the
 * remote's own content back to it under a new version, which every other device
 * then pulls as a change that changed nothing — and can lose a race against a
 * real edit made between the two. A queued `move` is left alone: it is the
 * user's rename, and the conflict rule is about content.
 *
 * `copyContent` is `conflictContent(drawingContent, copyId)` for the drawing's content
 * as the engine read it. The store makes the copy from the drawing as it is when
 * the resolution is applied — the same thing unless the user typed while the
 * engine was at the network, in which case the older copy would leave the newest
 * words out. Refusing instead would stall every pull and push for as long as
 * someone keeps typing into a conflicted drawing.
 */
export interface ConflictResolution {
	/** The drawing that was already there, which becomes the remote's copy. */
	drawingId: string;
	remoteContent: string;
	/** `contentHash(remoteContent)`, the drawing's `syncedHash` from here on. */
	remoteHash: string;
	remote: RemoteEntry;
	/** The drawing the local edits move into. Fresh id, fresh path, no remote yet. */
	copyId: string;
	copyPath: string;
	copyContent: string;
}

export interface PullBatch {
	changes: readonly PullChange[];
	/**
	 * Persisted only if every change above committed — a cursor saved ahead of
	 * its batch skips work that never happened.
	 *
	 * Absent means "leave the stored cursor alone", which is how a full scan
	 * applies its pages: the scan is one logical batch, and a cursor written
	 * halfway through it would claim a scan that had not finished.
	 */
	cursor?: string;
}

/** What became of a queued op, so the store can settle the drawing in the same go. */
export type OpOutcome =
	| Readonly<{
			/** The drawing's contents reached the remote. */
			kind: 'pushed';
			drawingId: string;
			remote: RemoteEntry;
			/**
			 * Exactly the bytes that were sent. The store clears `dirty` only if
			 * this is still what the drawing holds: the user can type while the
			 * request is in flight, and marking a drawing clean when the newest
			 * edit never left the device is how a save disappears.
			 */
			content: string;
			/**
			 * `contentHash(content)`. Recorded as `syncedHash` whether or not the
			 * drawing is still what was sent: the remote holds these bytes either way.
			 */
			syncedHash: string;
	  }>
	| Readonly<{
			/** A move landed. Content was never in question, so `dirty` is not touched. */
			kind: 'moved';
			drawingId: string;
			remote: RemoteEntry;
	  }>
	/** A delete reached the remote, so the tombstone can go. */
	| Readonly<{ kind: 'purged'; drawingId: string }>
	| Readonly<{
			/**
			 * A `mkdir` landed. The folder row records the id, so a later
			 * `rmdir` can say which folder it means and a scan can recognize
			 * the folder as one we already have — until this, only a pull ever
			 * set it, so a folder made here had none until it came back.
			 */
			kind: 'made-folder';
			path: string;
			remote: RemoteEntry;
	  }>
	| Readonly<{
			/**
			 * An `upload` landed. The row is bound to what it made, and its bytes
			 * are kept as that version's rather than held: they are up now.
			 *
			 * Against the row as it stands, which the user may have changed while
			 * the bytes were on their way. Moved since (`sentAs` is not its path
			 * any more), a `move-file` is queued to take the file after it.
			 * Deleted since, a `delete-file` is queued for what was made. Either
			 * way, every `rmdir` over where the file landed goes behind it: the
			 * folder was let go meanwhile, and run first, its `rmdir` would
			 * find the file and leave the directory standing. Refused
			 * where another row already holds the `remoteId`: two rows on one file
			 * is an engine that lost track, and letting either go would take a
			 * link with it.
			 */
			kind: 'uploaded';
			fileId: string;
			remote: RemoteEntry;
			/** The path the upload was sent to. */
			sentAs: string;
	  }>
	| Readonly<{
			/**
			 * A `move-file` landed. Its bytes, if held, are still the file's: a
			 * move does not change them, whatever the provider does to the
			 * version. A row deleted since is left gone. Refused, as `uploaded`
			 * is, where another row already holds the `remoteId`.
			 */
			kind: 'moved-file';
			fileId: string;
			remote: RemoteEntry;
	  }>
	| Readonly<{
			/**
			 * An `upload` had nothing to send: no bytes here, and nothing left at
			 * `copyOf` to read them from. The row goes, with anything held for it.
			 */
			kind: 'lost-file';
			fileId: string;
	  }>
	/** Nothing to record beyond the op being finished. */
	| Readonly<{ kind: 'done' }>;

/**
 * Every read sees a drawing the user has deleted whose `delete` op is
 * still queued. The row *is* the tombstone: it is what carries the
 * `remoteId` the op needs, since the op itself holds only a drawing id, and it
 * goes when the op completes as `purged` — not when the user presses delete.
 *
 * All of them, not just `drawingById`. A store with a `deleted` flag and
 * filtered indexes is a natural reading of "every live drawing", passes a
 * contract suite that only checks `drawingById`, and loses a drawing the first
 * time one is deleted here and edited on another device: the pull cannot
 * see the row, mints a second drawing at that path, and the queued delete then
 * removes the file that was just imported.
 *
 * A drawing deleted here and changed remotely in the same window resolves in
 * favor of the delete — the row is written back by the pull and then
 * purged by the op behind it. That is a decision, not an accident: the
 * delete is something the user did, and the remote change may be their own
 * from the other device.
 */
export interface SyncStore {
	/** Where the last pull got to, or `undefined` for a cold start. */
	readonly cursor: () => Promise<string | undefined>;
	/**
	 * By id, within this store's connection. An id names a drawing there and
	 * nowhere else: the id a file arrives claiming is the remote's to choose, and
	 * a folder copied from one account into another brings files naming drawings
	 * another connection on the device still holds. A store that holds several
	 * connections keys its drawings by connection and id, so that one's is neither
	 * shown here nor in the way of a write here.
	 */
	readonly drawingById: (id: string) => Promise<SyncDrawing | undefined>;
	/**
	 * Only ever asked between batches, when exactly one drawing is at each path.
	 * Within a batch two can be — a drawing moving out of the way is a change of
	 * its own — but nothing reads the store while one is being applied, so the
	 * ambiguous case never arises and no implementation has to pick a winner.
	 */
	readonly drawingByPath: (path: string) => Promise<SyncDrawing | undefined>;
	readonly drawingByRemoteId: (remoteId: string) => Promise<SyncDrawing | undefined>;
	/** Every live drawing, for reconciling a full scan against what we hold. */
	readonly allDrawings: () => Promise<SyncDrawing[]>;
	/**
	 * Every live drawing at or beneath a folder. Used to name a conflict copy
	 * without colliding, and to decide what a remote folder delete takes with it
	 * on a provider that reports only the folder.
	 *
	 * The root (`ROOT`, the empty string) means every drawing in the store, loose
	 * ones included. It is asked for by name — every loose drawing's parent is the
	 * root — and an implementation that reads this as a path prefix and answers
	 * `startsWith('/')` returns nothing for it, so conflict copies at the root
	 * stop avoiding names that are already taken and quietly overwrite the copy
	 * that was there. The contract suite asks for it directly.
	 */
	readonly drawingsUnder: (folderPath: string) => Promise<SyncDrawing[]>;
	readonly folderByRemoteId: (remoteId: string) => Promise<SyncFolder | undefined>;
	/**
	 * Used to recognize a folder move reported as a deletion of the old path:
	 * the deletion may carry no id at all, and the only way to tell it from a
	 * real one is that the folder that used to be there is alive elsewhere in
	 * the same batch.
	 */
	readonly folderByPath: (path: string) => Promise<SyncFolder | undefined>;
	/**
	 * Every folder that has ever been pushed. Only needed after a cursor reset,
	 * where a full scan reports what exists and never what was removed: a
	 * folder deleted while the cursor was dead would otherwise sit in the
	 * sidebar for ever with nothing behind it. Folders with no `remoteId` were
	 * never in the scan to begin with and are not candidates.
	 */
	readonly foldersWithRemote: () => Promise<SyncFolder[]>;
	/**
	 * The files this connection holds that could not be read, one per
	 * `remoteId`, in no promised order. Written only by `applyChanges`. For the
	 * engine to tell a change from a repeat, and for the app to list: see
	 * `UnreadableFile` for what it must never be used for.
	 */
	readonly unreadable: () => Promise<UnreadableFile[]>;

	/** A file row by its id, within this store's connection, as for drawings. */
	readonly fileById: (id: string) => Promise<SyncFile | undefined>;
	readonly fileByRemoteId: (remoteId: string) => Promise<SyncFile | undefined>;
	/** Every file row, bound and pending, for reconciling a full scan. */
	readonly allFiles: () => Promise<SyncFile[]>;
	/** Every file row at or beneath a folder; the root means every one. */
	readonly filesUnder: (folderPath: string) => Promise<SyncFile[]>;
	/**
	 * The file's bytes, if this device holds them and they are still the
	 * file's: held because they are not uploaded yet, or cached under the
	 * version the row is bound to. Bytes cached under another version are not
	 * returned — the file has changed since, or been replaced at its name, and
	 * on OneDrive a rename moves the version too, which a stale picture would
	 * otherwise survive.
	 */
	readonly fileBytes: (id: string) => Promise<Uint8Array<ArrayBuffer> | undefined>;

	/**
	 * Apply a batch of changes and its cursor atomically, **in the order
	 * given**: a pull's decisions, or the push's own where it settles a
	 * conflict (`push/conflicts.ts`), which carries no cursor.
	 *
	 * Both halves of that are load-bearing. Atomically, because §7 requires the
	 * cursor to be persisted only after the batch it describes has committed: a
	 * cursor stored ahead of its batch skips work that never happened, and
	 * nothing ever asks for it again.
	 *
	 * In order, because the engine reaches every decision against the store as
	 * it was and relies on them being carried out one after another — a folder
	 * deleted before the drawing that moved out of it is written back, a drawing
	 * deleted before the file that replaced it at that path is imported. An
	 * implementation that grouped by kind to batch its writes (all the deletes,
	 * then all the puts) would turn each of those into a lost drawing, and would
	 * look perfectly reasonable doing it.
	 */
	readonly applyChanges: (batch: PullBatch) => Promise<void>;

	/** Queued pushes in order. */
	readonly pendingOps: () => Promise<SyncOp[]>;
	/**
	 * One queued op as it stands now, or `undefined` if it is no longer queued.
	 * The engine asks before sending each op it read from `pendingOps`, because
	 * the user can withdraw or replace one in between.
	 */
	readonly opBySeq: (seq: number) => Promise<SyncOp | undefined>;
	readonly completeOp: (seq: number, outcome: OpOutcome) => Promise<void>;
	/** Record a failure against the op and leave it queued. */
	readonly failOp: (seq: number, error: string) => Promise<void>;
	/**
	 * Resolve a conflict found while pushing, and finish the op that hit it in
	 * the same transaction — the op's content is preserved in the copy, so
	 * replaying it would overwrite the remote with what the user has already
	 * been given a copy of.
	 *
	 * The op may have been withdrawn while it was at the network, exactly as
	 * `completeOp` and `failOp` allow: the user deleted the drawing, and a
	 * tombstone owes the remote its delete and nothing else. The resolution is
	 * still applied, and makes no copy for a drawing that is gone.
	 */
	readonly resolveConflict: (seq: number, resolution: ConflictResolution) => Promise<void>;
}
