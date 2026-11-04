import {
	basename,
	contentHash,
	isDrawingText,
	parentPath,
	readDrawingId,
	withDrawingId,
} from '@skysa/draw-core';

import {
	activeConnectionId,
	type DrawDatabase,
	type DrawingRecord,
	type FileRecord,
	type FolderRecord,
} from '../../src/store/db.js';
import { drawingRecordFromFile } from '../../src/store/drawings.js';
import { foldersOf } from '../../src/store/folders.js';
import { queueUpload } from '../../src/store/queue.js';
import { rowsOf } from '../../src/store/rows.js';
import { isLive } from '../../src/store/rowStates.js';

/**
 * A drawing's row by its id alone, for tests that hold one database and never two
 * drawings of one id. The app cannot ask this way: a drawing is keyed by its
 * connection and its id, and a test that moves rows between connections would
 * otherwise have to know where each had got to before it could look.
 */
export const drawingById = (db: DrawDatabase, id: string): Promise<DrawingRecord | undefined> =>
	db.drawings.where('id').equals(id).first();

export const updateDrawing = async (
	db: DrawDatabase,
	id: string,
	changes: Partial<DrawingRecord>
): Promise<void> => {
	await db.drawings.where('id').equals(id).modify(changes);
};

/**
 * A drawing's text for a test that only needs one drawing to differ from
 * another: an SVG whose description is `words`, with the id written in where
 * one is given. A file the engine can read as a drawing, as a note's test
 * would have used a line of text.
 */
export const svgOf = (words: string, id?: string): string => {
	const text = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${words}</desc></svg>\n`;
	return id === undefined ? text : withDrawingId(text, id);
};

/** A folder's row written straight to the table, given the device-local id and name every row has. */
export const folderOf = (row: Omit<FolderRecord, 'id' | 'name'>): FolderRecord => ({
	id: crypto.randomUUID(),
	name: basename(row.path),
	...row,
});

/**
 * A file read in from outside the sync, as skysa-notes' `importNoteFile` reads
 * one: a clean row, under the id the file names or a new one written into it,
 * with nothing queued. Text that is not an SVG is made one around it
 * (`svgOf`), so a test can still tell two files apart by their words.
 */
export const importedFile = async (
	db: DrawDatabase,
	input: Readonly<{
		connectionId?: string;
		path: string;
		source: string;
		id?: string;
		remoteId?: string;
		remoteVersion?: string;
	}>
): Promise<DrawingRecord> => {
	const connectionId = input.connectionId ?? (await activeConnectionId(db));
	const named = isDrawingText(input.source) ? readDrawingId(input.source) : undefined;
	const id = input.id ?? named ?? crypto.randomUUID();
	const source = isDrawingText(input.source)
		? withDrawingId(input.source, id)
		: svgOf(input.source, id);
	const row: DrawingRecord = {
		...drawingRecordFromFile({
			id,
			connectionId,
			path: input.path,
			source,
			hash: await contentHash(source),
			existing: await db.drawings.get([connectionId, id]),
			now: Date.now(),
		}),
		...(input.remoteId === undefined ? {} : { remoteId: input.remoteId }),
		...(input.remoteVersion === undefined ? {} : { remoteVersion: input.remoteVersion }),
	};
	await db.drawings.put(row);
	return row;
};

/**
 * A file added beside the drawings here and not uploaded yet: its row, its
 * bytes held until they are up, and its upload queued. What adding an
 * attachment will do (docs/ARCHITECTURE.md §10).
 */
export const fileAdded = async (
	db: DrawDatabase,
	input: { connectionId: string; path: string; bytes: ArrayBuffer }
): Promise<FileRecord> => {
	const file: FileRecord = {
		connectionId: input.connectionId,
		id: crypto.randomUUID(),
		path: input.path,
		size: input.bytes.byteLength,
	};
	await db.transaction('rw', db.files, db.fileBytes, db.opQueue, async () => {
		await db.files.add(file);
		await db.fileBytes.add({
			connectionId: file.connectionId,
			id: file.id,
			bytes: input.bytes,
			pinned: 1,
			lastUsedAt: 0,
		});
		await queueUpload(db, file);
	});
	return file;
};

/**
 * A source's drawings, as skysa-notes' `listNotes` lists them for its tests:
 * the live ones unless deleted ones are asked for, in one folder where one is
 * named, the last made first.
 */
export const listDrawings = async (
	db: DrawDatabase,
	options: Readonly<{
		connectionId?: string;
		folderPath?: string;
		includeDeleted?: boolean;
	}> = {}
): Promise<DrawingRecord[]> => {
	const connectionId = options.connectionId ?? (await activeConnectionId(db));
	return (await rowsOf(db.drawings, connectionId).toArray())
		.filter((drawing) => options.includeDeleted === true || isLive(drawing))
		.filter(
			(drawing) =>
				options.folderPath === undefined || parentPath(drawing.path) === options.folderPath
		)
		.sort((a, b) => b.createdAt - a.createdAt || a.path.localeCompare(b.path));
};

/** A source's folders by path, as skysa-notes' `folderTree` names them. */
export const folderTree = async (
	db: DrawDatabase,
	options: Readonly<{ connectionId?: string }> = {}
): Promise<string[]> => (await foldersOf(db, options.connectionId)).map((folder) => folder.path);
