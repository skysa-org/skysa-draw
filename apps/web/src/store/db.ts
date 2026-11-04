import Dexie, { type Table } from 'dexie';

/**
 * The local store. The app boots and renders from here before any network call,
 * and every read and write works offline; sync is a separate concern layered on
 * top (docs/ARCHITECTURE.md §7). The shape follows skysa-notes' store, so the
 * sync engine ported from it finds what it expects
 * (docs/decisions/0002-carried-over-from-skysa-notes.md).
 */

/**
 * IndexedDB cannot index a boolean, and the sync engine needs to find dirty
 * drawings by index rather than by scanning every row. 0/1 it is.
 */
type Flag = 0 | 1;

/**
 * Until a storage account is connected, every row belongs to this stand-in
 * connection. The column exists from the start so attaching a real connection
 * is a data migration rather than a schema change.
 */
export const LOCAL_CONNECTION_ID = 'local';

export interface DrawingRecord {
	/** Local UUID. Stable across renames and moves, and written into the file as `draw:id`. */
	id: string;
	connectionId: string;
	/** POSIX path relative to the app root, including the `.svg` extension. */
	path: string;
	/** What the drawing is called: its `<title>`, or its filename's stem. */
	title: string;
	/** The SVG document, whole. The source of truth for the drawing. */
	text: string;
	/** Provider file id. Absent until the drawing has been pushed. */
	remoteId?: string;
	/** Opaque provider version: etag, rev, headRevisionId. Compare only. */
	remoteVersion?: string;
	/** SHA-256 of `text` as this row and its remote file last agreed on it. */
	syncedHash?: string;
	/** SHA-256 of `text` as it is now. Equal to `syncedHash` when nothing is unsent. */
	contentHash: string;
	/** Unsent local edits. Indexed with the connection, so a push finds them. */
	dirty: Flag;
	createdAt: number;
	updatedAt: number;
}

export interface FolderRecord {
	id: string;
	connectionId: string;
	/** POSIX path relative to the app root. */
	path: string;
	/** The last segment of `path`, as the user typed it. */
	name: string;
	remoteId?: string;
	createdAt: number;
}

type OpKind =
	'create' | 'write' | 'move' | 'delete' | 'createFolder' | 'moveFolder' | 'deleteFolder';

/**
 * What the device has done that the provider has not been told: one row per
 * change, in order, for the sync engine to drain. A write is coalesced with a
 * pending one for the same drawing (`store/drawings.ts`); every other kind is
 * kept as it came.
 */
interface OpRecord {
	id?: number;
	connectionId: string;
	op: OpKind;
	drawingId?: string;
	path: string;
	toPath?: string;
	createdAt: number;
	attempts: number;
}

interface PrefRecord {
	key: string;
	value: unknown;
}

export interface DrawDatabase extends Dexie {
	drawings: Table<DrawingRecord, string>;
	folders: Table<FolderRecord, string>;
	opQueue: Table<OpRecord, number>;
	prefs: Table<PrefRecord, string>;
}

export const createDatabase = (name: string): DrawDatabase => {
	const made = new Dexie(name) as DrawDatabase;
	// Version 1. A later build adds a version with its own `stores()` and an
	// `upgrade()`, and never edits this one: Dexie replays them in order on a
	// device that is behind.
	made.version(1).stores({
		drawings: 'id, [connectionId+path], [connectionId+dirty], updatedAt',
		folders: 'id, [connectionId+path]',
		opQueue: '++id, connectionId, drawingId',
		prefs: 'key',
	});
	return made;
};

/**
 * The app's own database. The name is data identity, not brand: a deployment
 * that renames the app keeps it, or every drawing already on the device would
 * stop being found (`brand.ts`).
 */
export const db = createDatabase('skysa-draw');
