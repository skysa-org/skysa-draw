import type { CredentialRecord } from '@skysa/client';
import type { ProviderKind } from '@skysa/protocol';
import type { NewSyncOp, SyncOperation } from '@skysa/sync';
import Dexie, { type Table } from 'dexie';

import { letGoWhenFrozen } from './frozenTab.js';
import { watchForHeldUp } from './heldUp.js';
import { isLiveSource } from './rowStates.js';
import { watchForNewerTab } from './staleTab.js';

/**
 * The local store. The app boots and renders from here before any network call,
 * and every read and write works offline; sync is a separate concern layered on
 * top (docs/ARCHITECTURE.md §7). The shape began as skysa-notes' store, less
 * the tables only notes has (the clipboard, the pictures' smaller copies, the
 * key file and the keys for secrets;
 * docs/decisions/0002-carried-over-from-skysa-notes.md). The kit reaches it
 * through ports: the engine's `SyncStore` (`sync/store.ts`), the client's
 * (`sync/dexiePorts.ts`), and the `credentials` table, which the client's
 * connect, credential and relay calls take as a `CredentialStore`
 * (docs/decisions/0005-on-the-kit.md).
 */

/**
 * IndexedDB cannot index a boolean, and the sync engine needs to find dirty
 * drawings by index rather than by scanning every row. 0/1 it is.
 */
type Flag = 0 | 1;

/**
 * Until a storage account is connected, every row belongs to this stand-in
 * connection. The column exists from the start so attaching a real connection
 * is a data migration (`store/connection.ts`) rather than a schema change.
 */
export const LOCAL_CONNECTION_ID = 'local';

export interface DrawingRecord {
	/** UUID. Stable across renames and moves, and written into the file as `draw:id`. */
	id: string;
	connectionId: string;
	/** POSIX path relative to the app root, including the `.svg` extension. */
	path: string;
	/** What the drawing is called: its `<title>`, or its filename's stem. */
	title: string;
	/**
	 * The SVG document, whole and byte for byte: what a pull brought in, or
	 * what the last edit here wrote. The source of truth for the drawing, and
	 * what the sync engine is handed: a file another tool made keeps every
	 * byte of its own until the user edits it (`CLAUDE.md`).
	 */
	text: string;
	/** Provider file id. Absent until the drawing has been pushed. */
	remoteId?: string;
	/** Opaque provider version: etag, rev, headRevisionId. Compare only. */
	remoteVersion?: string;
	/**
	 * SHA-256 of the file as this drawing and its remote file last agreed on it —
	 * pulled or pushed — unlike `contentHash`, which follows every edit. Only the
	 * sync store writes it; see `SyncNote.syncedHash` in `@skysa/sync`.
	 * Absent reads as "cannot say".
	 */
	syncedHash?: string;
	/** SHA-256 of `text` as it is now. */
	contentHash: string;
	/** Set only by a real user edit, never by load or re-serialization. */
	dirty: Flag;
	/** Tombstone: kept until the delete has been pushed, so sync can replay it. */
	deletedLocally: Flag;
	createdAt: number;
	updatedAt: number;
}

export interface FolderRecord {
	/**
	 * A name for the row on this device, for a list's key. Not the row's key,
	 * which is its connection and its path, and never synced.
	 */
	id: string;
	connectionId: string;
	/** POSIX path relative to the app root. The root itself is not stored. */
	path: string;
	/** The last segment of `path`, as the user typed it. */
	name: string;
	remoteId?: string;
	createdAt: number;
}

export interface SyncStateRecord {
	connectionId: string;
	provider?: ProviderKind;
	/**
	 * The provider's id for the account this connection is to, once the API has
	 * named it. Kept per connection: with several sources connected at once
	 * there is no single "the account", and this is what says whose files a
	 * source's drawings are — which a reconnect asks of a detached source, to
	 * know whether the rows it kept are going home (`bindingMode` in
	 * `store/connection.ts`).
	 */
	accountId?: string;
	/**
	 * What the server calls the account — an email address, for the most part —
	 * as it last said it (`rememberAccount` in `store/connection.ts`). Kept here
	 * so that a source can still be named once the server will no longer answer
	 * for it. A label and nothing else; `accountId` is what says whose files
	 * these are.
	 */
	displayName?: string;
	/**
	 * What the *user* calls this source, where they have said. Their word beats
	 * every derived name (`tabName` in `sync/account.ts`), and clearing it puts
	 * the derived one back rather than leaving the tab blank. This device only.
	 */
	label?: string;
	/** Opaque provider cursor; persisted only after a batch commits. */
	cursor?: string;
	rootId?: string;
	lastSyncAt?: number;
	/** Random per browser install, reported in the marker file for debugging. */
	clientId: string;
	/**
	 * The provider access token `apps/api` last minted, so a reload does not
	 * need a round trip. Short-lived; never a refresh token, which never leaves
	 * the server. Never in localStorage (`CLAUDE.md`).
	 */
	accessToken?: string;
	/** Epoch milliseconds. */
	accessTokenExpiresAt?: number;
	/**
	 * Resumed with rows that still name remote files, and not yet checked
	 * against the remote (`verifyResume` in `store/connection.ts`). The sync
	 * store writes nothing for the connection until it is.
	 */
	resumeUnverified?: true;
	/**
	 * When this connection was last bound (`bindConnection`), so that what a tab
	 * remembers about the connection as it was — a drawing deleted here, whose
	 * row a save must not bring back (`store/deletedHere.ts`) — can be told from
	 * what it remembers about an earlier binding of the same id.
	 */
	boundAt?: number;
	/**
	 * The device no longer reaches this source, and it is still here because it
	 * holds something its remote was never sent (`detachConnection` in
	 * `store/connection.ts`). It syncs nothing, has no credential, cursor, root
	 * or token, and can still be shown and written in.
	 *
	 * `disconnected`: the user let it go, here. `revoked`: the server stopped
	 * answering for the connection. `interrupted`: the row had already gone
	 * when a save from another tab arrived for one of its drawings, and was
	 * made again to hold it (skysa-notes' `ensureDetached`; not made here yet).
	 */
	detached?: Detached;
	/**
	 * The files in this source the engine could not read as a drawing, which it
	 * leaves alone and the storage panel lists. Beside the cursor, because they
	 * are written with it, so the list never names a file from a batch that did
	 * not land. A notice and nothing else.
	 */
	unreadable?: { remoteId: string; path: string; movedAside?: string[] }[];
	/**
	 * Bound for the first time and not yet through its first sync: the import
	 * the user watches and can cancel. Set by `bindConnection` for a source it
	 * has not seen, cleared by `finishImport` once a pull has reached the end
	 * and a push has gone through the queue, and the whole source thrown away
	 * by `abandonImport` on a cancel.
	 */
	importing?: Importing;
}

interface Importing {
	/**
	 * The app is held while the import runs, and nothing can be written in the
	 * source meanwhile. The pile is kept as it was until the import finishes,
	 * which is what a cancel goes back to.
	 */
	lock: boolean;
	/** The source that was in front before, which a cancel puts back. */
	returnTo: string;
}

export interface Detached {
	/** Epoch milliseconds. */
	at: number;
	reason: 'disconnected' | 'revoked' | 'interrupted';
}

// A credential this device holds is a row of `credentials`, defined beside the
// functions over it, which are the kit's (`@skysa/client`).
export { type CredentialRecord, PENDING_CREDENTIAL_ID } from '@skysa/client';

/**
 * App-wide settings. A table rather than `localStorage` because the store is
 * already here, and it works the same in a test as in the browser.
 */
interface PreferenceRecord {
	key: string;
	value: string;
}

/**
 * A file beside a drawing that is not one: one row for every such file the
 * remote has, and for every file added here and not yet uploaded (no
 * `remoteId`). Its bytes, where the device holds them, are in `fileBytes`.
 * `SyncFile` in `@skysa/sync` (the kit's `packages/sync/src/store.ts`) says
 * what each kind of row may and may not have done to it.
 */
export interface FileRecord {
	connectionId: string;
	id: string;
	path: string;
	remoteId?: string;
	remoteVersion?: string;
	/** In bytes. */
	size: number;
}

/**
 * A file's bytes, where this device holds them: held until they are uploaded
 * (`pinned`), which nothing may evict, or cached under the remote version they
 * were read at, which the cache's budget may.
 *
 * An `ArrayBuffer` and not a `Blob`: a `Blob` does not survive the structured
 * clone the tests' IndexedDB makes of it.
 */
export interface FileBytesRecord {
	connectionId: string;
	id: string;
	bytes: ArrayBuffer;
	/** The remote version these bytes are, for cached ones. */
	version?: string;
	/** 1 while the bytes exist nowhere else. A number: IndexedDB indexes no boolean. */
	pinned: 0 | 1;
	/** For evicting the least recently used of the cached ones. */
	lastUsedAt: number;
}

export interface OpQueueRecord {
	seq?: number;
	connectionId: string;
	/** The kinds of op the queue holds: the kit's (`@skysa/sync`), so a new one is a row the app can store. */
	op: SyncOperation;
	drawingId?: string;
	/** For a file's ops, the file. */
	fileId?: string;
	path: string;
	/** For `move`, where the entry is going. */
	targetPath?: string;
	/**
	 * For `rmdir`, the folder's `remoteId` when it was queued. The row it came
	 * from is gone by then, and without the id the engine will not touch the
	 * path. For `delete-file`, the same.
	 */
	remoteId?: string;
	/** For an `upload` whose bytes this device does not hold, a file that has them. */
	copyOf?: string;
	attempts: number;
	lastError?: string;
	queuedAt: number;
	/**
	 * A write to be sent with the next sync rather than straight after
	 * (`queueWrite`'s `timing`). Set on writes only, and on none in this app.
	 */
	lazy?: true;
}

/** An op as a row holds it: `noteId` is `drawingId` (`QueuedOp`). */
type AsRow<Op> = Op extends { noteId: string } ? Omit<Op, 'noteId'> & { drawingId: string } : Op;

/**
 * An op to queue, as the queue's rows hold it: the kit's (`NewSyncOp`), whose
 * `noteId` is its word for any app's document, under the name this table has
 * always given it, and its index is on, `drawingId` (skysa-notes' record 0018).
 * The store reads a row back under the kit's names (`toSyncOp`).
 */
export type QueuedOp = AsRow<NewSyncOp>;

export type DrawDatabase = Dexie & {
	drawings: Table<DrawingRecord, DrawingKey>;
	folders: Table<FolderRecord, FolderKey>;
	syncState: Table<SyncStateRecord, string>;
	opQueue: Table<OpQueueRecord, number>;
	prefs: Table<PreferenceRecord, string>;
	credentials: Table<CredentialRecord, string>;
	files: Table<FileRecord, FileKey>;
	fileBytes: Table<FileBytesRecord, FileKey>;
};

/** A drawing's primary key: the source it belongs to, then its id within it. */
export type DrawingKey = [connectionId: string, id: string];

/** A file's primary key, in `files` and `fileBytes`: its source, then its id. */
export type FileKey = [connectionId: string, id: string];

/** A folder's primary key: its source, then its path. */
export type FolderKey = [connectionId: string, path: string];

export const drawingKey = (drawing: Pick<DrawingRecord, 'connectionId' | 'id'>): DrawingKey => [
	drawing.connectionId,
	drawing.id,
];

/**
 * The same, as a string: for a `Map`, a `Set`, a React `key`. An id on its own
 * names a drawing only inside its source, so state held by bare id is state
 * two sources' drawings can share by accident.
 */
export const drawingRef = (drawing: Pick<DrawingRecord, 'connectionId' | 'id'>): string =>
	JSON.stringify(drawingKey(drawing));

/** Whether a `drawingRef` names a drawing of this connection. */
export const refIn = (ref: string, connectionId: string): boolean =>
	ref.startsWith(`${JSON.stringify([connectionId]).slice(0, -1)},`);

/**
 * Built without subclassing Dexie: the table properties are declared through the
 * cast instead, which keeps this module free of `this` and classes.
 */
export const createDatabase = (name: string): DrawDatabase => {
	const made = new Dexie(name) as DrawDatabase;

	// Version 1, and the only one. It has been rewritten in place for the sync
	// engine's port, which no upgrade path is owed for: version 1 has never
	// shipped (no release, no tag), so no device holds the earlier shape. From
	// the first release on, a later build adds a version with its own
	// `stores()` and an `upgrade()`, and never edits this one: Dexie replays
	// them in order on a device that is behind.
	//
	// `[connectionId+path]` is deliberately not declared `&` unique. A
	// tombstone keeps its path until its delete has been pushed, so a drawing
	// created at a name a deleted one still holds is two rows at one key, by
	// design; and a pull batch passes through states where two drawings
	// briefly share a path, which a unique index would reject, failing the
	// batch for ever (`PullChange` in `@skysa/sync`). No
	// live drawing is knowingly put where another one is, and that is kept by
	// the writers (`freeName`/`freePath` in `store/naming.ts`).
	//
	// A drawing is keyed by its connection *and* its id: two connected sources
	// can each hold a file with one id, whenever a folder has been copied from
	// one account to another, since the id travels in the file. Each source is
	// its own silo (docs/ARCHITECTURE.md §6).
	//
	// Files beside drawings are keyed the same way, found by path and by remote
	// id within a connection, and their bytes are apart from the rows, so that
	// listing a folder's files never reads 25 MB, indexed by what eviction
	// asks: the cached ones, least recently used first.
	made.version(1).stores({
		drawings:
			'[connectionId+id], id, connectionId, path, [connectionId+path], dirty, deletedLocally, updatedAt, remoteId',
		folders: '[connectionId+path], connectionId, path',
		syncState: 'connectionId',
		opQueue: '++seq, connectionId, drawingId, path, fileId',
		prefs: 'key',
		credentials: 'id',
		files: '[connectionId+id], connectionId, [connectionId+path], [connectionId+remoteId]',
		fileBytes: '[connectionId+id], connectionId, [pinned+lastUsedAt]',
	});
	return made;
};

/**
 * What the tab watches `db` for, set up before it opens. Only the app's own
 * database is watched: the frozen-tab watch adds a listener to `document`, and
 * a database made for a test would leave one behind it for every one made.
 * Returns the way to stop watching.
 */
export const watchTab = (watched: Dexie): (() => void) => {
	// A build with a later version opening this database in another tab must
	// find this tab stopped rather than still writing (`store/staleTab.ts`).
	watchForNewerTab(watched);
	// Whether another tab is holding this one up, for the sync's status to say
	// (`store/heldUp.ts`).
	watchForHeldUp(watched);
	// And a frozen tab must not hold reads open that every other tab then waits
	// behind (`store/frozenTab.ts`).
	return letGoWhenFrozen(watched);
};

/**
 * Which connected source the app is showing and writing to, or
 * `LOCAL_CONNECTION_ID` while there is none.
 *
 * An explicit, persisted choice: a device may hold several connected sources at
 * once, each its own silo — its own drawings, its own queue, its own credential
 * — and the app shows one at a time (docs/ARCHITECTURE.md §6). A preference
 * naming a source that has since been disconnected must not strand the app on
 * a connection with no rows.
 *
 * Every reader and writer in `store/` that is not told a connection asks this,
 * and the writers ask inside their own transaction: asked outside, a drawing
 * created while an account is being connected could be written under the
 * connection its rows have just been moved off, where nothing shows or syncs
 * it.
 */
export const ACTIVE_CONNECTION_KEY = 'sync.activeConnection';

export const activeConnectionId = async (
	db: Pick<DrawDatabase, 'syncState' | 'prefs'>
): Promise<string> => {
	// Two keyed reads on the ordinary path, and the whole table only where there
	// is no usable preference: a `syncState.toArray()` here would put every live
	// query over drawings into that table's observability set, and each sync
	// run, which writes a cursor to it, would re-run every query on the screen.
	const chosen = (await db.prefs.get(ACTIVE_CONNECTION_KEY))?.value;
	// The device's own pile can be chosen by name: it has no row to check, and
	// it is chosen exactly so that a source made again behind it cannot take the
	// screen from it (`reason: 'interrupted'`).
	if (chosen === LOCAL_CONNECTION_ID) return chosen;
	if (chosen !== undefined && (await db.syncState.get(chosen)) !== undefined) return chosen;
	// No choice recorded, or one that names a source this device no longer has:
	// the first *live* one, since a detached source is kept only for what it
	// never sent; still ahead of the device's own pile, since with nothing else
	// connected it is what there is to show.
	const states = await db.syncState.toArray();
	const first = states.find(isLiveSource) ?? states[0];
	return first?.connectionId ?? LOCAL_CONNECTION_ID;
};

/**
 * Which source a store call is about. Every reader and writer that takes one
 * acts on the source showing (`activeConnectionId`) where it does not say.
 */
export interface ConnectionScope {
	connectionId?: string;
}

/**
 * The app's own database. The name is data identity, not brand: a deployment
 * that renames the app keeps it, or every drawing already on the device would
 * stop being found (docs/ARCHITECTURE.md §8, "Brand").
 */
export const db = createDatabase('skysa-draw');
watchTab(db);
