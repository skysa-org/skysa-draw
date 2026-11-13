import { useLiveQuery } from 'dexie-react-hooks';

import { useDb } from './database.js';
import type { DrawingRecord, FolderRecord } from './db.js';
import { drawingsIn, getDrawing } from './drawings.js';
import { foldersOf } from './folders.js';
import { isLive } from './rowStates.js';

/**
 * The store as the screens read it: live queries, re-run when the rows they
 * read change, in this tab or another. `undefined` until the first answer.
 * Each reads the source the app is showing (`activeConnectionId`), so a
 * switch of source, from this tab or another, re-runs them.
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
 * A drawing by its id, in the source showing: `loading` until the store has
 * answered for this id, then the row, or `missing` where there is none or it
 * is deleted here and only waiting for its delete to be sent. The answer
 * carries the id it is for, since a live query keeps its last answer while
 * the next one is asked: the drawing before this one is not this one, and
 * neither is its absence.
 */
export const useDrawing = (id: string): DrawingRecord | 'loading' | 'missing' => {
	const db = useDb();
	const answer = useLiveQuery(
		async () => ({ id, row: await getDrawing(db, id) }),
		[db, id],
		undefined
	);
	if (answer?.id !== id) return 'loading';
	return foundOf(answer.row);
};

/**
 * A row as `useDrawing` answers it once the store has: `missing` where there
 * is none, or it is deleted here and only waiting for its delete to be sent.
 */
export const foundOf = (row: DrawingRecord | undefined): DrawingRecord | 'missing' =>
	row !== undefined && isLive(row) ? row : 'missing';
