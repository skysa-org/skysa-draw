import {
	basename,
	joinPath,
	normalizePath,
	parentPath,
	ROOT,
	sanitizeFolderName,
} from '@skysa/draw-core';

import { activeConnectionId, type DrawDatabase, type FolderRecord } from './db.js';
import { foldPath } from './naming.js';
import { queueMkdir } from './queue.js';
import { rowsOf } from './rows.js';
import { isLive } from './rowStates.js';
import { writerTables } from './scopes.js';

/**
 * Folders are the provider's folders: a path, made on the provider at the next
 * push, with the drawings in it under its path (docs/ARCHITECTURE.md §3). The
 * root itself is never stored as a row — it is the empty path. Ported from
 * skysa-notes' `store/folders.ts` with what the app uses so far; its moves and
 * deletes come with the screens that ask for them.
 */

/** Every ancestor of a path, outermost first, excluding the root. */
const ancestorsOf = (path: string): string[] =>
	normalizePath(path)
		.split('/')
		.filter((segment) => segment !== '')
		.reduce<string[]>(
			(paths, segment) => [...paths, joinPath(paths.at(-1) ?? '', segment)],
			[]
		);

/**
 * Every path that is a folder as far as the sidebar is concerned: the folder
 * rows, plus the folder part of every live drawing's path. A drawing pulled
 * from a provider can arrive without a row of its own, so a question about "is
 * there already a folder here" that reads only the rows gets the wrong answer
 * for exactly the folders the app did not create itself. A tombstone draws no
 * folder: counted, it would keep its folder's name reserved until the delete
 * reaches the remote.
 */
const folderPaths = async (db: DrawDatabase, connectionId: string): Promise<string[]> => {
	const [folders, drawings] = await Promise.all([
		rowsOf(db.folders, connectionId).toArray(),
		rowsOf(db.drawings, connectionId).toArray(),
	]);
	const implied = drawings
		.filter(isLive)
		.flatMap((drawing) => ancestorsOf(parentPath(drawing.path)));
	return [...new Set([...folders.map((folder) => folder.path), ...implied])];
};

/**
 * The spelling `existing` already uses for `path`, or `path` unchanged when it
 * names nothing yet. So a caller that asks for `work` when the store holds
 * `Work` gets `Work`, and nothing downstream has to fold to stay consistent
 * with a check that already did.
 */
const spellingOf = (path: string, existing: readonly string[]): string => {
	const wanted = foldPath(path);
	return existing.find((each) => foldPath(each) === wanted) ?? path;
};

/** A folder's row, as every writer makes one. */
export const folderRow = (connectionId: string, path: string, createdAt: number): FolderRecord => ({
	id: crypto.randomUUID(),
	connectionId,
	path,
	name: basename(path),
	createdAt,
});

/**
 * Create a folder and any missing parents, rows only: the write of a drawing
 * in it makes it on the provider, and `createFolder` queues a `mkdir` for an
 * empty one. Idempotent. Inside the caller's transaction.
 */
export const ensureFolder = async (
	db: DrawDatabase,
	path: string,
	{ connectionId, now = Date.now }: { connectionId: string; now?: () => number }
): Promise<FolderRecord[]> => {
	const existing = new Set(
		(await rowsOf(db.folders, connectionId).toArray()).map((folder) => folder.path)
	);
	const at = now();
	const created = ancestorsOf(path)
		.filter((folderPath) => !existing.has(folderPath))
		.map((folderPath) => folderRow(connectionId, folderPath, at));
	if (created.length > 0) await db.folders.bulkPut(created);
	return created;
};

/** Every folder of a connection, the one showing where none is named, by path. */
export const foldersOf = async (
	db: DrawDatabase,
	connectionId?: string
): Promise<FolderRecord[]> => {
	const source = connectionId ?? (await activeConnectionId(db));
	return [...(await rowsOf(db.folders, source).toArray())].sort((a, b) =>
		a.path.localeCompare(b.path)
	);
};

/**
 * A folder named as the user typed, less what would break a path
 * (`sanitizeFolderName`). A name already in the parent, however it is cased, is
 * refused, and answered as `undefined`: two folders a provider cannot tell
 * apart are one folder to it. The check and the create are one step, and a
 * `mkdir` is queued for each folder made, outermost first.
 */
export const createFolder = async (
	db: DrawDatabase,
	name: string,
	{
		parentPath: parent = ROOT,
		connectionId,
		unnamed,
		now = Date.now,
	}: { parentPath?: string; connectionId?: string; unnamed?: string; now?: () => number } = {}
): Promise<FolderRecord | undefined> => {
	const cleaned = sanitizeFolderName(name, unnamed);
	return db.transaction('rw', writerTables(db), async () => {
		const source = connectionId ?? (await activeConnectionId(db));
		// Every folder the sidebar shows, which is not the same as every folder
		// row: a drawing can arrive from a sync with no row for its folder.
		const existing = await folderPaths(db, source);
		// And the spelling the store already uses for the parent: handed `work`
		// where the store holds `Work`, the folded check passes `work/Meetings`
		// and the row `work` would be written beside `Work`.
		const path = joinPath(spellingOf(parent, existing), cleaned);
		const wanted = foldPath(path);
		if (existing.some((folder) => foldPath(folder) === wanted)) return undefined;
		const made = await ensureFolder(db, path, { connectionId: source, now });
		await made.reduce<Promise<void>>(async (pending, folder) => {
			await pending;
			await queueMkdir(db, source, folder.path);
		}, Promise.resolve());
		return db.folders.get([source, path]);
	});
};
