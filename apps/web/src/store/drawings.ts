import {
	cleanDrawingTitle,
	emptyDrawing,
	isDrawingText,
	readDrawingId,
	readDrawingTitle,
	titleFromFilename,
	uniqueFilename,
	withDrawingTitle,
} from '@skysa/draw-core';
import { basename, joinPath, parentPath, replaceBasename, ROOT } from '@skysa/storage';
import Dexie from 'dexie';

import {
	activeConnectionId,
	type ConnectionScope,
	type DrawDatabase,
	type DrawingKey,
	type DrawingRecord,
} from './db.js';
import { deletedHere } from './deletedHere.js';
import { digestText } from './digest.js';
import { ensureFolder } from './folders.js';
import { foldPath } from './naming.js';
import { queueDelete, queueMove, queueWrite } from './queue.js';
import { rowsOf } from './rows.js';
import { isLive, isTombstone } from './rowStates.js';
import { writerTables } from './scopes.js';

/**
 * What the app does to drawings, each a transaction over the rows and the op
 * queue together, so the queue never says something the rows do not
 * (docs/ARCHITECTURE.md §7). skysa-notes' `store/notes.ts`, for a file that
 * is its own text: there is no frontmatter to serialize from parts, so the row
 * holds the file byte for byte and a push sends exactly that.
 *
 * The one rule that governs this module: a drawing becomes dirty only on a real
 * user edit. Loading, importing, or re-serializing a drawing must never set the
 * flag, or the app would rewrite files it was only ever asked to display.
 */

/** The file for a drawing, exactly: the row's text (`DrawingRecord.text`). */
export const drawingFile = (drawing: DrawingRecord): string => drawing.text;

/** What a drawing is called by its text: its `<title>`, or its filename's stem. */
const titleOf = (text: string, path: string): string =>
	readDrawingTitle(text) ?? titleFromFilename(basename(path));

/**
 * The names a new or renamed drawing in `folderPath` must not take: every live
 * drawing's beside it, and every folder's. Folded, as the providers compare,
 * so a folder spelled `Archive` where this one says `archive` is one directory.
 * A tombstone's name is free at once, so a drawing made at the name of one
 * just deleted is two rows at one path until the delete is sent, as notes'
 * `takenNamesIn` has it.
 */
const takenNamesIn = async (
	db: DrawDatabase,
	connectionId: string,
	folderPath: string,
	exceptId?: string
): Promise<string[]> => {
	const folder = foldPath(folderPath);
	const [drawings, folders] = await Promise.all([
		rowsOf(db.drawings, connectionId).toArray(),
		rowsOf(db.folders, connectionId).toArray(),
	]);
	return [...drawings.filter((drawing) => isLive(drawing) && drawing.id !== exceptId), ...folders]
		.filter((row) => foldPath(parentPath(row.path)) === folder)
		.map((row) => basename(row.path));
};

/**
 * A drawing's key: the source named, or the one showing, and its id within it.
 * An id names a drawing only inside its source — two connected sources can
 * hold a file with one id each — so every lookup says which. Asked inside the
 * writer's own transaction, like `activeConnectionId` itself and for its reason.
 */
const keyFor = async (
	db: DrawDatabase,
	id: string,
	scope: ConnectionScope = {}
): Promise<DrawingKey> => [scope.connectionId ?? (await activeConnectionId(db)), id];

/** A drawing by id, in the source named or the one showing; tombstones included. */
export const getDrawing = async (
	db: DrawDatabase,
	id: string,
	scope: ConnectionScope = {}
): Promise<DrawingRecord | undefined> => db.drawings.get(await keyFor(db, id, scope));

/** The live row, or why there is none to write into. */
const liveRow = async (db: DrawDatabase, key: DrawingKey): Promise<DrawingRecord> => {
	const row = await db.drawings.get(key);
	// A save the delete beat is not a save: the editor keeps its edits as
	// unsaved, and the conflict rule finds them (`useOpenDrawing`).
	if (row === undefined || isTombstone(row)) throw new Error(`no drawing ${key[1]}`);
	return row;
};

export interface NewDrawing {
	title?: string;
	folderPath?: string;
	/** The source to make it in; the one showing where none is named. */
	connectionId?: string;
	/** A file brought in from elsewhere, given this app's id if it has none. */
	text?: string;
	id?: string;
	/**
	 * The file's name, chosen from the names the folder already has, where it
	 * is not the title's slug: a conflict copy's, beside the drawing it came
	 * from (`conflictPath`, docs/ARCHITECTURE.md §7, "Conflict rule").
	 */
	filename?: (taken: readonly string[]) => string;
	now?: () => number;
}

/**
 * A new drawing in `folderPath`: an empty canvas, or `text` brought in from a
 * file. Its filename is the title's slug, kept unique in the folder; its id is
 * written into the file, so every device knows it by the same one. A user
 * action, so it starts dirty and is owed a write.
 *
 * One transaction: the filename is chosen from the names already taken, and a
 * second "New drawing" between that read and the `add` would choose the very
 * same name. Two rows at one path is one file on the remote and a drawing lost.
 */
export const createDrawing = async (
	db: DrawDatabase,
	{
		title,
		folderPath = ROOT,
		connectionId,
		text,
		id = crypto.randomUUID(),
		filename,
		now = Date.now,
	}: NewDrawing = {}
): Promise<DrawingRecord> => {
	if (text !== undefined && !isDrawingText(text)) {
		throw new RangeError('not an SVG document');
	}
	const given = text === undefined ? undefined : readDrawingId(text);
	const ownId = given ?? id;
	// A title given is kept as the file has it: what XML has no place for left
	// out, and trimmed. A blank one stays blank, and is shown as untitled.
	const named =
		title === undefined
			? ((text === undefined ? undefined : readDrawingTitle(text)) ?? 'Untitled')
			: cleanDrawingTitle(title);
	const { hash, text: content } =
		text === undefined
			? await digestText(emptyDrawing({ id: ownId, title }))
			: await digestText(text, ownId);
	return db.transaction('rw', writerTables(db), async () => {
		const source = connectionId ?? (await activeConnectionId(db));
		const taken = await takenNamesIn(db, source, folderPath);
		const path = joinPath(folderPath, filename?.(taken) ?? uniqueFilename(named, taken));
		const at = now();
		const record: DrawingRecord = {
			id: ownId,
			connectionId: source,
			path,
			title: named,
			text: content,
			contentHash: hash,
			dirty: 1,
			deletedLocally: 0,
			createdAt: at,
			updatedAt: at,
		};
		if (folderPath !== ROOT) await ensureFolder(db, folderPath, { connectionId: source, now });
		await db.drawings.add(record);
		await queueWrite(db, record);
		return record;
	});
};

/**
 * What a save came to: written; the same text the row holds already, so
 * nothing to write; or refused, because the row has changed since the text
 * the save was made against, and writing would lose that change.
 */
export type SaveOutcome = 'saved' | 'unchanged' | 'changed';

export interface SaveOptions extends ConnectionScope {
	/**
	 * What the save was made against: the texts, or their `contentHash`es, the
	 * editor last loaded or saved. With it the save is a compare-and-set: a row
	 * that holds none of them has been changed from elsewhere since — a pull,
	 * another tab — and nothing is written (`changed`), so the editor can keep
	 * its edits beside it by the conflict rule (docs/ARCHITECTURE.md §7,
	 * "Conflict rule"). More than one, because a save of the editor's own may
	 * still be on its way to the row when the next is made. Without it the
	 * save writes over whatever the row holds.
	 */
	expected?: string | readonly string[];
	now?: () => number;
}

const heldBy = (row: DrawingRecord, expected: string | readonly string[]): boolean =>
	(typeof expected === 'string' ? [expected] : expected).some(
		(each) => each === row.text || each === row.contentHash
	);

/**
 * The drawing's text as the editor left it, with the drawing's own id written
 * in whatever the text carried. A save of the same text is ignored, and so it
 * never makes a drawing dirty; one `write` waits per drawing however many
 * saves come, and the push sends what the row holds then.
 *
 * The id is written in and the hash computed before the transaction opens,
 * off the page's thread for a big text (`digestText`), and the row is read
 * and compared inside it, so a change that lands between the two is seen.
 * The text stored is the file the digest hands back: held one byte to a
 * character where it can be, which IndexedDB writes and reads back many
 * times faster.
 * A function for `options` is the clock, as the fourth argument once was.
 */
export const saveDrawing = async (
	db: DrawDatabase,
	id: string,
	text: string,
	options: SaveOptions | (() => number) = {}
): Promise<SaveOutcome> => {
	const {
		expected,
		now = Date.now,
		...scope
	} = typeof options === 'function' ? { now: options } : options;
	const { hash, text: content } = await digestText(text, id);
	return db.transaction('rw', writerTables(db), async (): Promise<SaveOutcome> => {
		const row = await liveRow(db, await keyFor(db, id, scope));
		if (row.contentHash === hash) return 'unchanged';
		if (expected !== undefined && !heldBy(row, expected)) return 'changed';
		const saved: DrawingRecord = {
			...row,
			text: content,
			title: titleOf(content, row.path),
			contentHash: hash,
			dirty: 1,
			updatedAt: now(),
		};
		await db.drawings.put(saved);
		await queueWrite(db, saved);
		return 'saved';
	});
};

/**
 * A new title: into the file's `<title>`, and into the filename as its slug,
 * kept unique in the folder. The id in the file is what keeps it the same
 * drawing to every other device. A `move` is queued where the name changed and
 * the provider has the file, and a `write` either way.
 *
 * Read, changed and written in one transaction, the digest held inside it by
 * `Dexie.waitFor`: worked out from a read before it, a save that landed in
 * between would be written over with the text as it was.
 * Answers the renamed row, or nothing for a blank title, which changes
 * nothing.
 */
export const renameDrawing = async (
	db: DrawDatabase,
	id: string,
	title: string,
	options: (ConnectionScope & { now?: () => number }) | (() => number) = {}
): Promise<DrawingRecord | undefined> => {
	const { now = Date.now, ...scope } = typeof options === 'function' ? { now: options } : options;
	// As the file has it, so a title of nothing XML holds is a blank one.
	const trimmed = cleanDrawingTitle(title);
	if (trimmed === '') return undefined;
	return db.transaction('rw', writerTables(db), async () => {
		const current = await liveRow(db, await keyFor(db, id, scope));
		const retitled = withDrawingTitle(current.text, trimmed);
		const others = await takenNamesIn(db, current.connectionId, parentPath(current.path), id);
		const path = replaceBasename(current.path, uniqueFilename(trimmed, others));
		// A promise already started, never `() => …`: `waitFor` runs a function
		// outside the very transaction it is here to hold.
		const { hash, text: content } = await Dexie.waitFor(digestText(retitled));
		const renamed: DrawingRecord = {
			...current,
			title: trimmed,
			path,
			text: content,
			contentHash: hash,
			dirty: hash === current.contentHash ? current.dirty : 1,
			updatedAt: now(),
		};
		await db.drawings.put(renamed);
		if (path !== current.path) await queueMove(db, renamed, current.path);
		if (hash !== current.contentHash) await queueWrite(db, renamed);
		return renamed;
	});
};

/**
 * Gone from the user's sight now, and from the provider at the next push. The
 * row survives as a tombstone until sync has pushed the delete, so the
 * deletion is not lost if the app is closed before it reaches the provider;
 * the op that pushes it lands in the same transaction. A drawing the provider
 * never had is purged by that push too, with nothing sent. Asking for a
 * drawing that is already deleted, or not there, changes nothing.
 */
export const deleteDrawing = async (
	db: DrawDatabase,
	id: string,
	options: (ConnectionScope & { now?: () => number }) | (() => number) = {}
): Promise<void> => {
	const { now = Date.now, ...scope } = typeof options === 'function' ? { now: options } : options;
	await db.transaction('rw', writerTables(db), async () => {
		const row = await db.drawings.get(await keyFor(db, id, scope));
		if (row === undefined || isTombstone(row)) return;
		const deleted: DrawingRecord = { ...row, deletedLocally: 1, dirty: 1, updatedAt: now() };
		await db.drawings.put(deleted);
		await queueDelete(db, deleted);
		await deletedHere.add(db, row);
	});
};

/** The live drawings directly in a folder of the source showing, newest change first. */
export const drawingsIn = async (
	db: DrawDatabase,
	folderPath: string,
	connectionId?: string
): Promise<DrawingRecord[]> => {
	const source = connectionId ?? (await activeConnectionId(db));
	return (await rowsOf(db.drawings, source).toArray())
		.filter((row) => isLive(row) && parentPath(row.path) === folderPath)
		.sort((a, b) => b.updatedAt - a.updatedAt);
};

export interface DrawingFileInput {
	id: string;
	connectionId: string;
	path: string;
	/** The file exactly as it exists remotely. */
	source: string;
	/** `contentHash(source)`, worked out by the caller before its transaction opened. */
	hash: string;
	/** The row this file replaces, if any. */
	existing?: DrawingRecord;
	now: number;
}

/**
 * A clean drawing record read from a file, with nothing remote on it yet.
 *
 * Synchronous, with the hash passed in, so a caller applying many files in one
 * transaction can digest them all before opening it: `crypto.subtle.digest` is
 * a promise Dexie did not make, and awaiting one inside a transaction commits
 * it early.
 *
 * What a drawing keeps from the row it replaces is what the file does not say:
 * when it was first seen here, and whether the user has deleted it — a delete
 * here outranks a change there (§7). An SVG says nothing about when it was
 * edited, so a file that is the one the row already has keeps the row's time,
 * and any other is edited now.
 */
export const drawingRecordFromFile = (input: DrawingFileInput): DrawingRecord => {
	const { existing } = input;
	return {
		id: input.id,
		connectionId: input.connectionId,
		path: input.path,
		title: titleOf(input.source, input.path),
		text: input.source,
		contentHash: input.hash,
		dirty: 0,
		deletedLocally: existing?.deletedLocally ?? 0,
		createdAt: existing?.createdAt ?? input.now,
		updatedAt:
			existing !== undefined && existing.contentHash === input.hash
				? existing.updatedAt
				: input.now,
	};
};
