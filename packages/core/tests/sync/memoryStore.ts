import { foldName } from '../../src/names/fold.js';
import { isWithin, normalizePath, parentPath, rebasePath, ROOT } from '../../src/paths.js';
import { conflictContent } from '../../src/sync/document.js';
import {
	type ConflictResolution,
	type FileChange,
	isFileChange,
	type NewSyncOp,
	type OpOutcome,
	type PullBatch,
	type PullChange,
	type SyncDrawing,
	type SyncFile,
	type SyncFolder,
	type SyncOp,
	type SyncStore,
	type UnreadableFile,
} from '../../src/sync/store.js';

/**
 * A `SyncStore` in memory. This is what every engine test drives, and — like
 * the fake provider — it is deliberately the strictest implementation in the
 * repo: it throws where the port leaves something undefined, so an engine that
 * relies on a convenience nobody promised fails here rather than in a browser.
 *
 * It also enforces the one promise the port makes that a lazy implementation
 * would quietly drop: `applyChanges` is all-or-nothing, cursor included.
 */

/** An op to queue: any a device queues, or one read back as `malformed`. */
type QueuedOp = (NewSyncOp | Omit<Extract<SyncOp, { op: 'malformed' }>, 'seq' | 'attempts'>) & {
	attempts?: number;
};

type Stored = SyncOp & { lastError?: string };

/** The drawing a queued op is about, for the kinds that are about one. */
const drawingOfOp = (op: SyncOp): string | undefined =>
	op.op === 'write' || op.op === 'move' || op.op === 'delete' ? op.drawingId : undefined;

/** The file a queued op is about, for the kinds that are about one. */
const fileOfOp = (op: SyncOp): string | undefined =>
	op.op === 'upload' || op.op === 'move-file' ? op.fileId : undefined;

/** The op with its paths, `targetPath` too where it has one, each put through `rebase`. */
const repathed = (op: Stored, rebase: (path: string) => string): Stored =>
	op.op === 'move' || op.op === 'move-file'
		? { ...op, path: rebase(op.path), targetPath: rebase(op.targetPath) }
		: { ...op, path: rebase(op.path) };

/**
 * A file's bytes as this device holds them: held until they are uploaded
 * (`pinned`), or cached under the version they were read at.
 */
interface HeldBytes {
	bytes: Uint8Array<ArrayBuffer>;
	version?: string;
	pinned?: boolean;
}

export interface MemoryStore extends SyncStore {
	readonly drawings: () => SyncDrawing[];
	readonly files: () => SyncFile[];
	/** What is held for a file, valid or not: what `fileBytes` decides from. */
	readonly heldBytes: (id: string) => HeldBytes | undefined;
	/** Seed a file row, and the bytes held for it if any. */
	readonly putFile: (file: SyncFile, bytes?: HeldBytes) => void;
	/** Take a file row and its bytes away, as the user deleting it does. */
	readonly dropFile: (id: string) => void;
	readonly folders: () => SyncFolder[];
	readonly ops: () => SyncOp[];
	readonly storedCursor: () => string | undefined;
	/** Seed a drawing as though it were already synced, or already edited. */
	readonly put: (
		drawing: Partial<SyncDrawing> & Pick<SyncDrawing, 'id' | 'path' | 'content'>
	) => void;
	readonly putFolder: (folder: SyncFolder) => void;
	/** Drop a folder row, as the app does when the user deletes or renames one. */
	readonly removeFolder: (path: string) => void;
	/**
	 * Queue an op. A `malformed` one too, which no device queues, so the engine
	 * can be shown one as the web store reads a row that fits no kind.
	 */
	readonly queue: (op: QueuedOp) => SyncOp;
	/** Withdraw a queued op, as the web queue does when a second rename replaces a move. */
	readonly unqueue: (seq: number) => void;
	/** Fail the next `applyChanges`, to prove the cursor does not move without it. */
	readonly breakNextApply: () => void;
	/**
	 * Every no-op the contract required this store to tolerate. The contract
	 * says a `delete-drawing` for an id that is not here must succeed, because a
	 * batch that rejects is a batch that is retried for ever — but an engine
	 * that emits one is still wrong, so the engine tests assert this is empty
	 * and the strictness is kept without the deadlock.
	 */
	readonly anomalies: () => string[];
	readonly lastError: (seq: number) => string | undefined;
}

export const createMemoryStore = (): MemoryStore => {
	const drawings = new Map<string, SyncDrawing>();
	const files = new Map<string, SyncFile>();
	const held = new Map<string, HeldBytes>();
	const folders = new Map<string, SyncFolder>();
	const ops = new Map<number, Stored>();
	/** By `remoteId`, which is what makes a second record for a file a rename. */
	const unreadable = new Map<string, UnreadableFile>();
	const state = new Map<'cursor', string>();
	const counters = new Map<'seq', number>();
	const flags = new Map<'break', boolean>();
	const anomalies: string[] = [];

	const nextSeq = (): number => {
		const seq = (counters.get('seq') ?? 0) + 1;
		counters.set('seq', seq);
		return seq;
	};

	const requireDrawing = (id: string): SyncDrawing => {
		const drawing = drawings.get(id);
		if (drawing === undefined) throw new Error(`no drawing ${id}`);
		return drawing;
	};

	const ensureFolderChain = (path: string): void => {
		if (path === ROOT || folders.has(path)) return;
		ensureFolderChain(parentPath(path));
		folders.set(path, { path });
	};

	const queue = (input: QueuedOp): SyncOp => {
		const op: SyncOp = { seq: nextSeq(), attempts: 0, ...input };
		ops.set(op.seq, op);
		return op;
	};

	const applyConflict = (resolution: ConflictResolution): void => {
		const drawing = requireDrawing(resolution.drawingId);
		// From the drawing as it stands: the user may have typed since the engine
		// read it, and a copy of the older file would leave those words out.
		const copyContent = conflictContent(drawing.content, resolution.copyId);
		// The remote takes the path it claims, which is not necessarily the one
		// the local drawing was at: a drawing can be moved and edited between syncs.
		ensureFolderChain(parentPath(resolution.remote.path));
		drawings.set(drawing.id, {
			...drawing,
			path: resolution.remote.path,
			content: resolution.remoteContent,
			syncedHash: resolution.remoteHash,
			remoteId: resolution.remote.remoteId,
			remoteVersion: resolution.remote.version,
			dirty: false,
		});
		if (drawings.has(resolution.copyId)) {
			throw new Error(`copy id ${resolution.copyId} is taken`);
		}
		ensureFolderChain(parentPath(resolution.copyPath));
		drawings.set(resolution.copyId, {
			id: resolution.copyId,
			path: resolution.copyPath,
			content: copyContent,
			dirty: true,
		});
		// The edit that lost is in the copy now, and the drawing holds the remote's
		// bytes. Anything still queued to write the old content would put it
		// straight back on the remote under a new version.
		for (const op of [...ops.values()]) {
			if (op.op === 'write' && op.drawingId === resolution.drawingId) ops.delete(op.seq);
		}
		// And a queued rename's origin is where the remote says the file is.
		originIsNow(resolution.drawingId, resolution.remote.path);
		// The copy only exists locally, so it needs a push of its own.
		queue({ op: 'write', drawingId: resolution.copyId, path: resolution.copyPath });
	};

	/** Held until uploaded, or cached under the version the row is bound to. */
	const validBytes = (file: SyncFile): Uint8Array<ArrayBuffer> | undefined => {
		const entry = held.get(file.id);
		if (entry === undefined) return undefined;
		const current =
			entry.pinned === true ||
			(entry.version !== undefined && entry.version === file.remoteVersion);
		return current ? entry.bytes : undefined;
	};

	/** A row and whatever is held for it, together. */
	const dropFile = (id: string): void => {
		files.delete(id);
		held.delete(id);
	};

	/** The same, and the ops queued for it: there is nothing left to send or move. */
	const forgetFile = (id: string): void => {
		dropFile(id);
		[...ops.values()].filter((op) => fileOfOp(op) === id).forEach((op) => ops.delete(op.seq));
	};

	/**
	 * A bound row a pull is about to take or cut loose. An upload that copies
	 * its file (`copyOf`) would read the bytes from the remote, which has just
	 * said the file is gone — so whatever this device holds of them goes to
	 * each copy, held until it is sent, and the copy no longer reads anything.
	 */
	const handOver = (file: SyncFile): void => {
		const bytes = validBytes(file);
		if (bytes === undefined || file.remoteId === undefined) return;
		[...ops.values()]
			.flatMap((op) => (op.op === 'upload' && op.copyOf === file.remoteId ? [op] : []))
			.forEach(({ copyOf: _copyOf, ...op }) => {
				held.set(op.fileId, { bytes, pinned: true });
				ops.set(op.seq, op);
			});
	};

	/** A row is another's file, which only an engine that has lost track makes. */
	const refuseTwin = (fileId: string, remoteId: string): void => {
		const twin = [...files.values()].find(
			(each) => each.id !== fileId && each.remoteId === remoteId
		);
		if (twin !== undefined) throw new Error(`file ${remoteId} is ${twin.id}'s already`);
	};

	/** Bytes that were held, kept as the remote version's now that it has them. */
	const releaseBytes = (id: string, version: string): void => {
		const entry = held.get(id);
		if (entry !== undefined) held.set(id, { bytes: entry.bytes, version });
	};

	/** A queued `move-file`'s origin, pointed at where the remote says the file is. */
	const fileOriginIsNow = (fileId: string, at: string): void => {
		for (const op of [...ops.values()]) {
			if (op.op === 'move-file' && op.fileId === fileId) ops.set(op.seq, { ...op, path: at });
		}
	};

	/** One file's queued ops, after it as it moves. */
	const rebaseFileOps = (fileId: string, from: string, to: string): void => {
		for (const op of [...ops.values()]) {
			if (fileOfOp(op) !== fileId) continue;
			ops.set(
				op.seq,
				repathed(op, (path) => (path === from ? to : path))
			);
		}
	};

	const upsertFile = (change: Extract<PullChange, { kind: 'upsert-file' }>): void => {
		// The user's word that it should go, said since the batch was decided.
		const deleting = [...ops.values()].some(
			(op) => op.op === 'delete-file' && op.remoteId === change.remote.remoteId
		);
		if (deleting) return;
		const existing = files.get(change.fileId);
		const adoptable =
			existing?.remoteId === undefined &&
			existing?.path === change.path &&
			existing.size === (change.remote.size ?? 0);
		if (change.adopt === true && !adoptable) {
			throw new Error(`file ${change.fileId} is not one to adopt as that file`);
		}
		if (change.adopt !== true && existing !== undefined && existing.remoteId === undefined) {
			throw new Error(`file ${change.fileId} is pending, and only an adoption binds it`);
		}
		const moving = [...ops.values()].some(
			(op) => op.op === 'move-file' && op.fileId === change.fileId
		);
		const path = moving && existing !== undefined ? existing.path : change.path;
		ensureFolderChain(parentPath(path));
		files.set(change.fileId, {
			id: change.fileId,
			path,
			remoteId: change.remote.remoteId,
			remoteVersion: change.remote.version,
			size: change.remote.size ?? 0,
		});
		if (change.adopt === true) {
			releaseBytes(change.fileId, change.remote.version);
			[...ops.values()]
				.filter((op) => op.op === 'upload' && op.fileId === change.fileId)
				.forEach((op) => ops.delete(op.seq));
		}
		fileOriginIsNow(change.fileId, change.remote.path);
	};

	const applyFileChange = (change: FileChange): void => {
		if (change.kind === 'upsert-file') {
			upsertFile(change);
			return;
		}
		const file = files.get(change.fileId);
		if (file === undefined) {
			anomalies.push(`${change.kind} for unknown file ${change.fileId}`);
			return;
		}
		if (change.kind === 'displace-file') {
			ensureFolderChain(parentPath(change.path));
			files.set(file.id, { ...file, path: change.path });
			rebaseFileOps(file.id, file.path, change.path);
			return;
		}
		if (file.remoteId === undefined) {
			// Never the remote's: a pending file exists nowhere else.
			if (change.kind === 'delete-file') {
				throw new Error(`file ${file.id} is pending, and not the remote's to delete`);
			}
			anomalies.push(`reupload-file for pending file ${file.id}`);
			return;
		}
		handOver(file);
		if (change.kind === 'delete-file') {
			forgetFile(file.id);
			return;
		}
		// Gone from the remote, and wanted there. Sent again from here to where
		// the row is: a move queued for it has nothing to move. Pending whether
		// or not there is anything to send, which the upload finds out.
		const bytes = validBytes(file);
		forgetFile(file.id);
		files.set(file.id, { id: file.id, path: file.path, size: file.size });
		if (bytes !== undefined) held.set(file.id, { bytes, pinned: true });
		queue({ op: 'upload', fileId: file.id, path: file.path });
	};

	/**
	 * The files whose queued `move-file` says they are outside the folder being
	 * deleted, as `renamedOutOf` reads the drawings' renames.
	 */
	const filesMovedOut = (path: string, was: string | undefined): string[] =>
		[
			...[...ops.values()]
				.sort((one, two) => one.seq - two.seq)
				.reduce<Map<string, string>>(
					(map, op) =>
						op.op !== 'move-file' || map.has(op.fileId)
							? map
							: map.set(op.fileId, op.path),
					new Map()
				),
		].flatMap(([fileId, from]) =>
			!isWithin(from, path) && (was === undefined || !isWithin(from, was)) ? [fileId] : []
		);

	/**
	 * A folder's deletion, for the files beneath it: a bound one goes, with its
	 * bytes, unless spared as a drawing is. A pending one stays: it is the user's,
	 * and exists nowhere else.
	 */
	const deleteFilesUnder = (change: Extract<PullChange, { kind: 'delete-folder' }>): void => {
		const keepFiles = new Set([
			...(change.keepFiles ?? []),
			...filesMovedOut(change.path, change.was),
		]);
		[...files.values()]
			.filter(
				(file) =>
					isWithin(file.path, change.path) &&
					file.remoteId !== undefined &&
					!keepFiles.has(file.id)
			)
			.forEach((file) => {
				handOver(file);
				forgetFile(file.id);
			});
	};

	const drawingAt = (path: string): SyncDrawing | undefined =>
		[...drawings.values()].find((drawing) => drawing.path === path);

	/**
	 * What a folder delete does to one drawing inside it. A dirty drawing survives as
	 * a local-only drawing rather than being thrown away with the folder: an
	 * unsaved edit outranks a remote deletion (CLAUDE.md — never lose user data).
	 */
	const detachOrDelete = (drawing: SyncDrawing): void => {
		if (!drawing.dirty) {
			drawings.delete(drawing.id);
			return;
		}
		const { remoteId: _id, remoteVersion: _version, syncedHash: _hash, ...rest } = drawing;
		drawings.set(drawing.id, rest);
	};

	/**
	 * Point a queued rename's origin at where the pull says the drawing's file is.
	 * See `originIsNow` in `apps/web/src/sync/store.ts`: the origin is what a
	 * folder deletion reads as "where the file is", and a pull that carries the
	 * remote's own path for the drawing has just said it is somewhere else. The
	 * target is the name the user chose, and is left alone.
	 */
	const originIsNow = (drawingId: string, at: string): void => {
		for (const op of [...ops.values()]) {
			if (op.op === 'move' && op.drawingId === drawingId)
				ops.set(op.seq, { ...op, path: at });
		}
	};

	/** Point one drawing's queued ops at where it has just been moved to. */
	const rebaseOps = (drawingId: string, from: string, to: string): void => {
		for (const op of [...ops.values()]) {
			if (drawingOfOp(op) !== drawingId) continue;
			ops.set(
				op.seq,
				repathed(op, (path) => (path === from ? to : path))
			);
		}
	};

	const upsert = (change: Extract<PullChange, { kind: 'upsert-drawing' }>): void => {
		// Decided against a clean drawing that has been edited since.
		if (drawings.get(change.id)?.dirty === true) {
			throw new Error(`drawing ${change.id} changed since the upsert was decided`);
		}
		// The engine names the drawing; the store never guesses. Matching on the
		// path here instead would overwrite whatever drawing happened to be
		// sitting at a path the remote has since reused.
		ensureFolderChain(parentPath(change.path));
		drawings.set(change.id, {
			id: change.id,
			path: change.path,
			content: change.content,
			remoteId: change.remote.remoteId,
			remoteVersion: change.remote.version,
			syncedHash: change.syncedHash,
			dirty: false,
		});
		// The remote has just said where this drawing's file is.
		originIsNow(change.id, change.path);
	};

	const deleteOrDetach = (
		change: Extract<PullChange, { kind: 'delete-drawing' | 'detach-drawing' }>
	): void => {
		const drawing = drawings.get(change.id);
		// Already gone. Saying so twice is a no-op, not a failure: see
		// `anomalies` above.
		if (drawing === undefined) {
			anomalies.push(`${change.kind} for unknown drawing ${change.id}`);
			return;
		}
		if (change.kind === 'delete-drawing') {
			// Decided against a clean drawing that has been edited since.
			if (drawing.dirty)
				throw new Error(`drawing ${drawing.id} changed since its delete was decided`);
			drawings.delete(drawing.id);
			return;
		}
		const { remoteId: _id, remoteVersion: _version, syncedHash: _hash, ...rest } = drawing;
		drawings.set(change.id, rest);
	};

	const ensureFolder = (change: Extract<PullChange, { kind: 'ensure-folder' }>): void => {
		// The app folder is not one of the user's folders and holds no row. A store that kept
		// one would have it reconciled away after the next cursor reset — and
		// since every path is within the root, that one `delete-folder` is
		// every drawing on the device.
		if (change.path === ROOT) {
			anomalies.push('ensure-folder for the root');
			return;
		}
		ensureFolderChain(parentPath(change.path));
		// No id says nothing about the one the row already has.
		const remoteId = change.remoteId ?? folders.get(change.path)?.remoteId;
		folders.set(change.path, {
			path: change.path,
			...(remoteId === undefined ? {} : { remoteId }),
		});
	};

	/**
	 * A drawing the rescan did not return, where the provider said its own copy may
	 * be what lost it. Everything the remote gave the row goes — a write against
	 * a `remoteVersion` for a file that is not there would be refused, and a
	 * kept `syncedHash` would say these bytes are already up.
	 */
	const reuploadDrawing = (id: string): void => {
		// Unknown id forgiven, like `delete-drawing`: the batch was decided before
		// it was applied.
		const drawing = drawings.get(id);
		if (drawing === undefined) {
			anomalies.push(`reupload-drawing for unknown drawing ${id}`);
			return;
		}
		const { remoteId: _id, remoteVersion: _version, syncedHash: _hash, ...rest } = drawing;
		drawings.set(id, { ...rest, dirty: true });
		// A clean drawing has no op owed to it, so the write has to be made here; a
		// dirty one arrives as `detach-drawing` and already has one.
		queue({ op: 'write', drawingId: drawing.id, path: drawing.path });
	};

	/** The same for a folder, which never cascades: its drawings are named too. */
	const reuploadFolder = (path: string): void => {
		const folder = folders.get(path);
		if (folder === undefined) {
			anomalies.push(`reupload-folder for unknown folder ${path}`);
			return;
		}
		const { remoteId: _id, ...rest } = folder;
		folders.set(path, rest);
		queue({ op: 'mkdir', path });
	};

	type ListChange = Extract<PullChange, { kind: 'unreadable' | 'forget-unreadable' }>;

	/**
	 * The list of files that could not be read, which no row has anything to do
	 * with: the two changes that are about it, and the one about rows that it
	 * has to hear of as well.
	 */
	const applyChange = (change: PullChange): void => {
		if (change.kind === 'unreadable') {
			const { remoteId, path, movedAside } = change.file;
			unreadable.set(remoteId, {
				remoteId,
				path,
				...(movedAside === undefined ? {} : { movedAside: [...movedAside] }),
			});
			return;
		}
		// No anomaly for an id that is not listed, unlike the other no-ops here:
		// the engine reads the list once for a batch, and a push may list a file
		// after that, so forgetting one it never saw listed is not a mistake.
		if (change.kind === 'forget-unreadable') {
			unreadable.delete(change.remoteId);
			return;
		}
		// Whether or not the folder is one we hold: the files under it are gone
		// with it either way. Never the root, which every path is within.
		if (change.kind === 'delete-folder' && normalizePath(change.path) !== ROOT) {
			[...unreadable.values()]
				.filter((file) => isWithin(file.path, change.path))
				.forEach((file) => unreadable.delete(file.remoteId));
		}
		if (isFileChange(change)) {
			applyFileChange(change);
			return;
		}
		applyRowChange(change);
	};

	const applyRowChange = (change: Exclude<PullChange, ListChange | FileChange>): void => {
		if (change.kind === 'upsert-drawing') {
			upsert(change);
			return;
		}
		if (change.kind === 'adopt-version') {
			const drawing = requireDrawing(change.id);
			drawings.set(drawing.id, {
				...drawing,
				remoteId: change.remote.remoteId,
				remoteVersion: change.remote.version,
				...(change.syncedHash === undefined ? {} : { syncedHash: change.syncedHash }),
			});
			// The row stays put; the file's whereabouts are still news.
			originIsNow(change.id, change.remote.path);
			return;
		}
		if (change.kind === 'move-drawing') {
			const drawing = requireDrawing(change.id);
			ensureFolderChain(parentPath(change.path));
			drawings.set(drawing.id, {
				...drawing,
				path: change.path,
				remoteId: change.remote.remoteId,
				remoteVersion: change.remote.version,
				...(change.syncedHash === undefined ? {} : { syncedHash: change.syncedHash }),
			});
			// And its queued ops, as `move-folder` and `displace-drawing` do.
			rebaseOps(drawing.id, drawing.path, change.path);
			return;
		}
		if (change.kind === 'delete-drawing' || change.kind === 'detach-drawing') {
			deleteOrDetach(change);
			return;
		}
		if (change.kind === 'ensure-folder') {
			ensureFolder(change);
			return;
		}
		if (change.kind === 'move-folder') {
			applyFolderMove(change.from, change.to, change.remoteId);
			return;
		}
		if (change.kind === 'displace-drawing') {
			// Contents and dirty flag untouched: the drawing is only being moved out
			// of the way, and it is the user's writing.
			const drawing = drawings.get(change.id);
			if (drawing === undefined) {
				anomalies.push(`displace-drawing for unknown drawing ${change.id}`);
				return;
			}
			ensureFolderChain(parentPath(change.path));
			drawings.set(drawing.id, { ...drawing, path: change.path });
			// And the drawing's own queued ops, as `move-folder` does. A queued
			// `move` is the user's rename, and its target is the path the remote
			// has just taken: left alone it conflicts for ever, and the ordered
			// queue strands everything behind it.
			rebaseOps(drawing.id, drawing.path, change.path);
			return;
		}
		if (change.kind === 'reupload-drawing') {
			reuploadDrawing(change.id);
			return;
		}
		if (change.kind === 'reupload-folder') {
			reuploadFolder(change.path);
			return;
		}
		if (change.kind === 'delete-folder') {
			if (normalizePath(change.path) === ROOT) {
				anomalies.push('delete-folder for the root');
				return;
			}
			// The contract forgives a path with no folder at it — a batch the
			// store rejects is retried for ever — but an engine that says it
			// twice is still wrong, so it is recorded like the other no-ops.
			if (!folders.has(change.path)) {
				anomalies.push(`delete-folder for unknown folder ${change.path}`);
				return;
			}
			// Everything beneath it, not just the row itself: a folder that is
			// gone remotely cannot leave its subfolders behind, and it cannot
			// leave its drawings floating at paths whose folder no longer exists.
			const gone = [...folders.values()].filter((folder) =>
				isWithin(folder.path, change.path)
			);
			for (const folder of gone) folders.delete(folder.path);
			// Except the ones the engine has spared: their files are not in the
			// folder at all, because the rename that puts them there is still
			// queued here. And the same rule applied to the queue as it stands
			// now, which is the backstop the contract asks of a store that holds
			// the queue: the engine read it when the batch was decided.
			const keep = new Set([
				...(change.keep ?? []),
				...[
					...[...ops.values()]
						.sort((one, two) => one.seq - two.seq)
						.reduce<Map<string, string>>(
							(map, op) =>
								op.op !== 'move' || map.has(op.drawingId)
									? map
									: map.set(op.drawingId, op.path),
							new Map()
						),
				].flatMap(([drawingId, from]) =>
					!isWithin(from, change.path) &&
					(change.was === undefined || !isWithin(from, change.was))
						? [drawingId]
						: []
				),
			]);
			const inside = [...drawings.values()].filter(
				(drawing) => isWithin(drawing.path, change.path) && !keep.has(drawing.id)
			);
			for (const drawing of inside) detachOrDelete(drawing);
			deleteFilesUnder(change);
			return;
		}
		applyConflict(change.resolution);
	};

	const applyFolderMove = (from: string, to: string, remoteId?: string): void => {
		for (const folder of [...folders.values()]) {
			if (!isWithin(folder.path, from)) continue;
			folders.delete(folder.path);
			const path = rebasePath(folder.path, from, to);
			folders.set(path, {
				path,
				...(folder.path === from && remoteId !== undefined
					? { remoteId }
					: folder.remoteId === undefined
						? {}
						: { remoteId: folder.remoteId }),
			});
		}
		// Drawings move with the folder even when dirty: the move is metadata and
		// cannot conflict with an edit to the contents (docs/ARCHITECTURE.md §7).
		for (const drawing of [...drawings.values()]) {
			if (isWithin(drawing.path, from)) {
				drawings.set(drawing.id, { ...drawing, path: rebasePath(drawing.path, from, to) });
			}
		}
		// Files, bound and pending: an id-only feed names none of them.
		for (const file of [...files.values()]) {
			if (isWithin(file.path, from)) {
				files.set(file.id, { ...file, path: rebasePath(file.path, from, to) });
			}
		}
		// The files listed as unreadable too: an id-only feed says the folder
		// moved and nothing about what is in it.
		for (const file of [...unreadable.values()]) {
			if (isWithin(file.path, from)) {
				unreadable.set(file.remoteId, { ...file, path: rebasePath(file.path, from, to) });
			}
		}
		// And so do the ops that name them, or a queued write would land at a
		// path that no longer exists.
		for (const op of [...ops.values()]) {
			ops.set(
				op.seq,
				repathed(op, (path) => (isWithin(path, from) ? rebasePath(path, from, to) : path))
			);
		}
	};

	/** The `rmdir`s over `path`, behind the op just queued to take the file out of it. */
	const rmdirsBehind = (path: string): void => {
		const fold = (each: string): string => foldName(normalizePath(each));
		[...ops.values()]
			.filter((op) => op.op === 'rmdir' && isWithin(fold(path), fold(op.path)))
			.sort((a, b) => a.seq - b.seq)
			.forEach(({ seq, ...op }) => {
				ops.delete(seq);
				queue(op);
			});
	};

	const settleUpload = (outcome: Extract<OpOutcome, { kind: 'uploaded' }>): void => {
		const file = files.get(outcome.fileId);
		// Deleted while its bytes were on the way: what they made goes too.
		if (file === undefined) {
			queue({
				op: 'delete-file',
				path: outcome.remote.path,
				remoteId: outcome.remote.remoteId,
			});
			rmdirsBehind(outcome.remote.path);
			return;
		}
		refuseTwin(file.id, outcome.remote.remoteId);
		const moved = file.path !== outcome.sentAs;
		files.set(file.id, {
			...file,
			path: moved ? file.path : outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
			size: outcome.remote.size ?? file.size,
		});
		releaseBytes(file.id, outcome.remote.version);
		if (moved) {
			queue({
				op: 'move-file',
				fileId: file.id,
				path: outcome.remote.path,
				targetPath: file.path,
			});
			rmdirsBehind(outcome.remote.path);
		}
	};

	const settleFileMove = (
		outcome: Extract<OpOutcome, { kind: 'moved-file' }>,
		withdrawn: boolean
	): void => {
		const file = files.get(outcome.fileId);
		if (file === undefined) return;
		refuseTwin(file.id, outcome.remote.remoteId);
		// A move leaves the bytes as they were, whatever the version says —
		// unless it landed on another file and took that one for its own,
		// whose bytes nobody here has read, and whose version can be the
		// same string as the one these were cached under.
		const same = outcome.remote.remoteId === file.remoteId;
		const kept = validBytes(file);
		files.set(file.id, {
			...file,
			path: withdrawn ? file.path : outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
		});
		const cached = held.get(file.id)?.pinned !== true;
		if (cached && !same) held.delete(file.id);
		if (cached && same && kept !== undefined) {
			held.set(file.id, { bytes: kept, version: outcome.remote.version });
		}
		fileOriginIsNow(file.id, outcome.remote.path);
		// Moved again while this one was on its way: the row stays where
		// the user put it, and the file is owed a move there from where it
		// landed — by the move that replaced this one, or by a new one.
		const queued = [...ops.values()].some(
			(op) => op.op === 'move-file' && op.fileId === file.id
		);
		if (withdrawn && !queued && file.path !== outcome.remote.path) {
			queue({
				op: 'move-file',
				fileId: file.id,
				path: outcome.remote.path,
				targetPath: file.path,
			});
		}
	};

	/**
	 * `withdrawn`: the op is gone from the queue, which only a later change of
	 * the user's does — a second move replaces a queued one, a delete withdraws
	 * an upload. What it did on the remote is recorded either way, as the app's
	 * store records it.
	 */
	const settle = (outcome: OpOutcome, withdrawn: boolean): void => {
		if (outcome.kind === 'done') return;
		// Only if the row is still at that path: the folder may have been
		// renamed or deleted here while the `mkdir` was at the network, and
		// the id belongs to the folder the provider made at the old name.
		if (outcome.kind === 'made-folder') {
			const folder = folders.get(outcome.path);
			if (folder !== undefined) {
				folders.set(outcome.path, { ...folder, remoteId: outcome.remote.remoteId });
			}
			return;
		}
		if (outcome.kind === 'purged') {
			drawings.delete(outcome.drawingId);
			return;
		}
		if (outcome.kind === 'uploaded') {
			settleUpload(outcome);
			return;
		}
		if (outcome.kind === 'moved-file') {
			settleFileMove(outcome, withdrawn);
			return;
		}
		if (outcome.kind === 'lost-file') {
			forgetFile(outcome.fileId);
			return;
		}
		const drawing = requireDrawing(outcome.drawingId);
		if (outcome.kind === 'moved') {
			drawings.set(drawing.id, {
				...drawing,
				path: withdrawn ? drawing.path : outcome.remote.path,
				remoteId: outcome.remote.remoteId,
				remoteVersion: outcome.remote.version,
			});
			// Renamed again while this move was on its way: the file is at the
			// name before, and the drawing moves there from it.
			if (withdrawn && drawing.path !== outcome.remote.path) {
				queue({
					op: 'move',
					drawingId: drawing.id,
					path: outcome.remote.path,
					targetPath: drawing.path,
				});
			}
			return;
		}
		drawings.set(drawing.id, {
			...drawing,
			path: outcome.remote.path,
			remoteId: outcome.remote.remoteId,
			remoteVersion: outcome.remote.version,
			// The remote holds these bytes whether or not the drawing still does.
			syncedHash: outcome.syncedHash,
			// Typed again while the request was in flight. The bytes on the
			// remote are not the bytes here, so the drawing is still dirty and the
			// next push has something to do.
			dirty: drawing.content !== outcome.content,
		});
	};

	const snapshot = () => ({
		drawings: new Map(drawings),
		files: new Map(files),
		held: new Map(held),
		folders: new Map(folders),
		ops: new Map(ops),
		unreadable: new Map(unreadable),
		cursor: state.get('cursor'),
	});

	const restore = (saved: ReturnType<typeof snapshot>): void => {
		drawings.clear();
		files.clear();
		held.clear();
		for (const [key, value] of saved.files) files.set(key, value);
		for (const [key, value] of saved.held) held.set(key, value);
		folders.clear();
		ops.clear();
		unreadable.clear();
		for (const [key, value] of saved.unreadable) unreadable.set(key, value);
		for (const [key, value] of saved.drawings) drawings.set(key, value);
		for (const [key, value] of saved.folders) folders.set(key, value);
		for (const [key, value] of saved.ops) ops.set(key, value);
		if (saved.cursor === undefined) state.delete('cursor');
		else state.set('cursor', saved.cursor);
	};

	return {
		cursor: () => Promise.resolve(state.get('cursor')),
		drawingById: (id) => Promise.resolve(drawings.get(id)),
		// As the web store: a drawing created at a name a tombstone still holds is
		// the answer, not the tombstone.
		drawingByPath: (path) =>
			Promise.resolve(
				[...drawings.values()].find(
					(drawing) =>
						drawing.path === path &&
						![...ops.values()].some(
							(op) => op.op === 'delete' && op.drawingId === drawing.id
						)
				) ?? drawingAt(path)
			),
		drawingByRemoteId: (remoteId) =>
			Promise.resolve(
				[...drawings.values()].find((drawing) => drawing.remoteId === remoteId)
			),
		allDrawings: () => Promise.resolve([...drawings.values()]),
		drawingsUnder: (folderPath) =>
			Promise.resolve(
				[...drawings.values()].filter((drawing) => isWithin(drawing.path, folderPath))
			),
		folderByRemoteId: (remoteId) =>
			Promise.resolve([...folders.values()].find((folder) => folder.remoteId === remoteId)),
		folderByPath: (path) => Promise.resolve(folders.get(path)),
		foldersWithRemote: () =>
			Promise.resolve(
				[...folders.values()].filter((folder) => folder.remoteId !== undefined)
			),
		unreadable: () => Promise.resolve([...unreadable.values()]),
		fileById: (id) => Promise.resolve(files.get(id)),
		fileByRemoteId: (remoteId) =>
			Promise.resolve([...files.values()].find((file) => file.remoteId === remoteId)),
		allFiles: () => Promise.resolve([...files.values()]),
		filesUnder: (folderPath) =>
			Promise.resolve([...files.values()].filter((file) => isWithin(file.path, folderPath))),
		fileBytes: (id) => {
			const file = files.get(id);
			// A copy, as a database would hand back: the caller's to keep.
			return Promise.resolve(file === undefined ? undefined : validBytes(file)?.slice());
		},

		applyChanges: (batch: PullBatch) => {
			const before = snapshot();
			try {
				if (flags.get('break') === true) {
					flags.delete('break');
					throw new Error('store write failed');
				}
				for (const change of batch.changes) applyChange(change);
				if (batch.cursor !== undefined) state.set('cursor', batch.cursor);
			} catch (error) {
				// All or nothing, cursor included — the promise the engine is
				// relying on when it hands over a batch and a cursor together.
				restore(before);
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			return Promise.resolve();
		},

		pendingOps: () => Promise.resolve([...ops.values()].sort((a, b) => a.seq - b.seq)),
		opBySeq: (seq) => Promise.resolve(ops.get(seq)),
		completeOp: (seq, outcome) => {
			// Gone is not an error: a change the user made while the op was in
			// flight withdrew it (`settle`).
			const withdrawn = !ops.has(seq);
			const before = snapshot();
			try {
				settle(outcome, withdrawn);
			} catch (error) {
				restore(before);
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			ops.delete(seq);
			return Promise.resolve();
		},
		failOp: (seq, error) => {
			const op = ops.get(seq);
			if (op === undefined) return Promise.reject(new Error(`no op ${String(seq)}`));
			ops.set(seq, { ...op, attempts: op.attempts + 1, lastError: error });
			return Promise.resolve();
		},
		resolveConflict: (seq, resolution) => {
			// A withdrawn op is allowed: the user can delete the drawing while its
			// write is at the network, and a tombstone owes the remote its
			// delete and nothing else, so the write's queue row goes. The
			// resolution still lands, and makes no copy for a drawing that is gone.
			const before = snapshot();
			try {
				applyConflict(resolution);
			} catch (error) {
				// One transaction, as `applyChanges` is: a refused resolution leaves
				// no half of itself behind.
				restore(before);
				return Promise.reject(error instanceof Error ? error : new Error(String(error)));
			}
			ops.delete(seq);
			return Promise.resolve();
		},

		drawings: () => [...drawings.values()].sort((a, b) => a.path.localeCompare(b.path)),
		files: () => [...files.values()].sort((a, b) => a.path.localeCompare(b.path)),
		heldBytes: (id) => held.get(id),
		putFile: (file, bytes) => {
			ensureFolderChain(parentPath(file.path));
			files.set(file.id, file);
			if (bytes !== undefined) held.set(file.id, bytes);
		},
		dropFile,
		folders: () => [...folders.values()].sort((a, b) => a.path.localeCompare(b.path)),
		ops: () => [...ops.values()].sort((a, b) => a.seq - b.seq),
		storedCursor: () => state.get('cursor'),
		put: (drawing) => {
			ensureFolderChain(parentPath(drawing.path));
			drawings.set(drawing.id, { dirty: false, ...drawing });
		},
		putFolder: (folder) => {
			ensureFolderChain(parentPath(folder.path));
			folders.set(folder.path, folder);
		},
		removeFolder: (path) => {
			folders.delete(path);
		},
		queue,
		unqueue: (seq) => {
			ops.delete(seq);
		},
		breakNextApply: () => {
			flags.set('break', true);
		},
		lastError: (seq) => ops.get(seq)?.lastError,
		anomalies: () => [...anomalies],
	};
};
