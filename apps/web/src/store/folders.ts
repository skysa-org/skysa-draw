import { foldName, joinPath, parentPath, ROOT, sanitizeFolderName } from '@skysa/draw-core';
import Dexie from 'dexie';

import { type DrawDatabase, type FolderRecord, LOCAL_CONNECTION_ID } from './db.js';

/**
 * Folders are the provider's folders: a path, made on the provider at the next
 * push, with the drawings in it under its path (docs/ARCHITECTURE.md §3).
 */

/** Every folder of a connection, by path. */
export const foldersOf = async (
	db: DrawDatabase,
	connectionId = LOCAL_CONNECTION_ID
): Promise<FolderRecord[]> =>
	[
		...(await db.folders
			.where('[connectionId+path]')
			.between([connectionId, Dexie.minKey], [connectionId, Dexie.maxKey])
			.toArray()),
	].sort((a, b) => a.path.localeCompare(b.path));

/**
 * A folder named as the user typed, less what would break a path
 * (`sanitizeFolderName`). A name already in the parent, however it is cased, is
 * refused: two folders a provider cannot tell apart are one folder to it.
 */
export const createFolder = async (
	db: DrawDatabase,
	name: string,
	{
		parentPath: parent = ROOT,
		connectionId = LOCAL_CONNECTION_ID,
		unnamed,
		now = Date.now,
	}: { parentPath?: string; connectionId?: string; unnamed?: string; now?: () => number } = {}
): Promise<FolderRecord | undefined> => {
	const cleaned = sanitizeFolderName(name, unnamed);
	const path = joinPath(parent, cleaned);
	return db.transaction('rw', db.folders, db.drawings, db.opQueue, async () => {
		const siblings = await foldersOf(db, connectionId);
		const taken = siblings.some(
			(folder) =>
				parentPath(folder.path) === parent && foldName(folder.path) === foldName(path)
		);
		if (taken) return undefined;
		const at = now();
		const record: FolderRecord = {
			id: crypto.randomUUID(),
			connectionId,
			path,
			name: cleaned,
			createdAt: at,
		};
		await db.folders.add(record);
		await db.opQueue.add({
			connectionId,
			op: 'createFolder',
			path,
			createdAt: at,
			attempts: 0,
		});
		return record;
	});
};
