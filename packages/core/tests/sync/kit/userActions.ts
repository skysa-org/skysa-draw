import type { SyncDrawing } from '../../../src/sync/store.js';
import type { MemoryStore } from '../memoryStore.js';

/**
 * What the web app's `store/queue.ts` leaves in the store when the user acts,
 * at its simplest: the row changed and the op queued. `overProviders.test.ts`
 * models more of it — moves folded into one, folders made on the way —
 * for devices left to act at random.
 */

/** The user's edit. */
export const editHere = (store: MemoryStore, drawing: SyncDrawing, content: string): void => {
	store.put({ ...drawing, content, dirty: true });
	store.queue({ op: 'write', drawingId: drawing.id, path: drawing.path });
};

/** The user's rename of a drawing that has a file. */
export const renameHere = (store: MemoryStore, drawing: SyncDrawing, to: string): void => {
	store.put({ ...drawing, path: to });
	store.queue({ op: 'move', drawingId: drawing.id, path: drawing.path, targetPath: to });
};
