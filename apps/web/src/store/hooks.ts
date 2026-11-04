import { useLiveQuery } from 'dexie-react-hooks';

import { useDb } from './database.js';
import type { DrawingRecord, FolderRecord } from './db.js';
import { drawingsIn } from './drawings.js';
import { foldersOf } from './folders.js';

/**
 * The store as the screens read it: live queries, re-run when the rows they
 * read change, in this tab or another. `undefined` until the first answer.
 */

export const useFolders = (): FolderRecord[] | undefined => {
	const db = useDb();
	return useLiveQuery(() => foldersOf(db), [db]);
};

export const useDrawings = (folderPath: string): DrawingRecord[] | undefined => {
	const db = useDb();
	return useLiveQuery(() => drawingsIn(db, folderPath), [db, folderPath]);
};

export const useDrawing = (id: string | undefined): DrawingRecord | undefined => {
	const db = useDb();
	return useLiveQuery(async () => (id === undefined ? undefined : db.drawings.get(id)), [db, id]);
};
