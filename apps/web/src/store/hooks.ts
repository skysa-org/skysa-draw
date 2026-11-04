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

/**
 * A drawing by its id: `loading` until the store has answered for this id,
 * then the row, or `missing` where there is none. The answer carries the id it
 * is for, since a live query keeps its last answer while the next one is
 * asked: the drawing before this one is not this one, and neither is its
 * absence.
 */
export const useDrawing = (id: string): DrawingRecord | 'loading' | 'missing' => {
	const db = useDb();
	const answer = useLiveQuery(
		async () => ({ id, row: await db.drawings.get(id) }),
		[db, id],
		undefined
	);
	if (answer?.id !== id) return 'loading';
	return answer.row ?? 'missing';
};
