import {
	contentHash,
	emptyDrawing,
	isDrawingText,
	joinPath,
	parentPath,
	readDrawingId,
	readDrawingTitle,
	replaceBasename,
	ROOT,
	titleFromFilename,
	uniqueFilename,
	withDrawingId,
	withDrawingTitle,
} from '@skysa/draw-core';
import Dexie from 'dexie';

import { type DrawDatabase, type DrawingRecord, LOCAL_CONNECTION_ID } from './db.js';

/**
 * What the app does to drawings, each a transaction over the rows and the op
 * queue together, so the queue never says something the rows do not
 * (docs/ARCHITECTURE.md §7).
 */

/** The names in a folder, for `uniqueFilename`: every drawing's, every folder's. */
const namesIn = async (
	db: DrawDatabase,
	connectionId: string,
	folderPath: string
): Promise<string[]> => {
	const drawings = await db.drawings
		.where('[connectionId+path]')
		.between([connectionId, Dexie.minKey], [connectionId, Dexie.maxKey])
		.toArray();
	const folders = await db.folders
		.where('[connectionId+path]')
		.between([connectionId, Dexie.minKey], [connectionId, Dexie.maxKey])
		.toArray();
	return [...drawings, ...folders]
		.filter((row) => parentPath(row.path) === folderPath)
		.map((row) => row.path.slice(folderPath === ROOT ? 0 : folderPath.length + 1));
};

/**
 * A `write` for the drawing, unless one (or the `create` that will send the
 * same text) is waiting already: the push sends what the row holds then.
 */
const queueWriteOnce = async (
	db: DrawDatabase,
	connectionId: string,
	drawingId: string,
	path: string,
	at: number
): Promise<void> => {
	const pending = await db.opQueue
		.where('drawingId')
		.equals(drawingId)
		.filter((op) => op.op === 'write' || op.op === 'create')
		.count();
	if (pending > 0) return;
	await db.opQueue.add({
		connectionId,
		op: 'write',
		drawingId,
		path,
		createdAt: at,
		attempts: 0,
	});
};

export interface NewDrawing {
	title?: string;
	folderPath?: string;
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
 * written into the file, so every device knows it by the same one.
 */
export const createDrawing = async (
	db: DrawDatabase,
	{
		title,
		folderPath = ROOT,
		connectionId = LOCAL_CONNECTION_ID,
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
	const named = title ?? (text === undefined ? undefined : readDrawingTitle(text)) ?? 'Untitled';
	const content =
		text === undefined ? emptyDrawing({ id: ownId, title }) : withDrawingId(text, ownId);
	const hash = await contentHash(content);
	return db.transaction('rw', db.drawings, db.folders, db.opQueue, async () => {
		const taken = await namesIn(db, connectionId, folderPath);
		const path = joinPath(folderPath, filename?.(taken) ?? uniqueFilename(named, taken));
		const at = now();
		const record: DrawingRecord = {
			id: ownId,
			connectionId,
			path,
			title: named,
			text: content,
			contentHash: hash,
			dirty: 1,
			createdAt: at,
			updatedAt: at,
		};
		await db.drawings.add(record);
		await db.opQueue.add({
			connectionId,
			op: 'create',
			drawingId: ownId,
			path,
			createdAt: at,
			attempts: 0,
		});
		return record;
	});
};

/** The drawing's text as the editor left it. */
export const saveDrawing = async (
	db: DrawDatabase,
	id: string,
	text: string,
	now: () => number = Date.now
): Promise<void> => {
	const content = withDrawingId(text, id);
	const hash = await contentHash(content);
	await db.transaction('rw', db.drawings, db.opQueue, async () => {
		const row = await db.drawings.get(id);
		if (row === undefined) throw new Error(`no drawing ${id}`);
		if (row.contentHash === hash) return;
		await db.drawings.update(id, {
			text: content,
			title: readDrawingTitle(content) ?? titleFromFilename(row.path),
			contentHash: hash,
			dirty: 1,
			updatedAt: now(),
		});
		await queueWriteOnce(db, row.connectionId, id, row.path, now());
	});
};

/**
 * A new title: into the file's `<title>`, and into the filename as its slug,
 * kept unique in the folder. The id in the file is what keeps it the same
 * drawing to every other device.
 */
export const renameDrawing = async (
	db: DrawDatabase,
	id: string,
	title: string,
	now: () => number = Date.now
): Promise<void> => {
	const trimmed = title.trim();
	if (trimmed === '') return;
	// Hashed outside the transaction: Web Crypto is a wait IndexedDB does not
	// hold a transaction open across, so the text is settled first and the
	// rows are read and written in one go after.
	const row = await db.drawings.get(id);
	if (row === undefined) throw new Error(`no drawing ${id}`);
	const content = withDrawingTitle(row.text, trimmed);
	const hash = await contentHash(content);
	await db.transaction('rw', db.drawings, db.folders, db.opQueue, async () => {
		const current = await db.drawings.get(id);
		if (current === undefined) return;
		const folder = parentPath(current.path);
		const others = (await namesIn(db, current.connectionId, folder)).filter(
			(name) => joinPath(folder, name) !== current.path
		);
		const path = replaceBasename(current.path, uniqueFilename(trimmed, others));
		const at = now();
		await db.drawings.update(id, {
			title: trimmed,
			path,
			text: content,
			contentHash: hash,
			dirty: 1,
			updatedAt: at,
		});
		if (path !== current.path) {
			await db.opQueue.add({
				connectionId: current.connectionId,
				op: 'move',
				drawingId: id,
				path: current.path,
				toPath: path,
				createdAt: at,
				attempts: 0,
			});
		}
		await queueWriteOnce(db, current.connectionId, id, path, at);
	});
};

/** Gone from this device now, and from the provider at the next push. */
export const deleteDrawing = async (
	db: DrawDatabase,
	id: string,
	now: () => number = Date.now
): Promise<void> => {
	await db.transaction('rw', db.drawings, db.opQueue, async () => {
		const row = await db.drawings.get(id);
		if (row === undefined) return;
		await db.drawings.delete(id);
		// Nothing the provider has not seen needs taking back from it.
		const unsent = await db.opQueue.where('drawingId').equals(id).toArray();
		await db.opQueue.bulkDelete(unsent.flatMap((op) => (op.id === undefined ? [] : [op.id])));
		if (row.remoteId !== undefined || unsent.every((op) => op.op !== 'create')) {
			await db.opQueue.add({
				connectionId: row.connectionId,
				op: 'delete',
				drawingId: id,
				path: row.path,
				createdAt: now(),
				attempts: 0,
			});
		}
	});
};

/** The drawings directly in a folder, newest change first. */
export const drawingsIn = async (
	db: DrawDatabase,
	folderPath: string,
	connectionId = LOCAL_CONNECTION_ID
): Promise<DrawingRecord[]> =>
	(
		await db.drawings
			.where('[connectionId+path]')
			.between([connectionId, Dexie.minKey], [connectionId, Dexie.maxKey])
			.toArray()
	)
		.filter((row) => parentPath(row.path) === folderPath)
		.sort((a, b) => b.updatedAt - a.updatedAt);
