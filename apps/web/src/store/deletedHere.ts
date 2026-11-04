import { type DrawDatabase, drawingRef } from './db.js';

/**
 * The drawings deleted from this tab, by id, for as long as the tab lives.
 *
 * One question is asked of it. An edit saved against a row that has gone is
 * normally an edit to a drawing a sync deleted, and the drawing is brought back
 * holding it (`saveDrawingBody`). But the row of a drawing deleted *here* goes the
 * same way — sync pushes the delete and purges the tombstone within seconds —
 * and an edit still held for it, because its save had been failing, would then
 * bring back a drawing the user deleted, and on the provider too. The tombstone
 * said which of the two it was; once it has been purged only this does.
 *
 * Only that: a delete the user made. A row a disconnect removed because the
 * remote has it is not one (`detachConnection` marks nothing here), and an edit
 * still held for such a row is kept, under its source, as an unsent drawing.
 *
 * A mark is about the source as it was bound when the drawing was deleted
 * (`SyncStateRecord.boundAt`). Bound again — let go and reconnected — the
 * source is pulled afresh, and a drawing the remote still has under that id is
 * not the one the user deleted before but one another device restored, or one
 * the delete never reached; an edit to it that finds it gone later is kept. A
 * tab that did not see the reconnect asks the same question of the same row,
 * so every tab's marks go stale together.
 *
 * In memory and per tab because the held edits are: they do not outlive the tab
 * either. A drawing deleted in one tab while another holds a failing edit to it is
 * not covered.
 */
const marks = new Map<string, number | undefined>();

type Named = Readonly<{ connectionId: string; id: string }>;

type Scope = Pick<DrawDatabase, 'syncState'>;

const boundAt = async (db: Scope, drawing: Named): Promise<number | undefined> =>
	(await db.syncState.get(drawing.connectionId))?.boundAt;

export const deletedHere = {
	/** Inside the caller's transaction, which has to cover `syncState`. */
	add: async (db: Scope, drawing: Named): Promise<void> => {
		marks.set(drawingRef(drawing), await boundAt(db, drawing));
	},
	/** On undo: from here on a vanished row is a drawing to bring back again. */
	delete: (drawing: Named): void => {
		marks.delete(drawingRef(drawing));
	},
	/** Whether the drawing was deleted here, under the binding its source has now. */
	has: async (db: Scope, drawing: Named): Promise<boolean> => {
		const ref = drawingRef(drawing);
		return marks.has(ref) && marks.get(ref) === (await boundAt(db, drawing));
	},
	/** Every mark gone, as a new page life starts. For tests, where a file is one page life. */
	clear: (): void => {
		marks.clear();
	},
};
