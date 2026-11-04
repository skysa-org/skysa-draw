import { emptyDrawing, readDrawingId, readDrawingTitle, withDrawingId } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import { createDrawing, deleteDrawing, renameDrawing, saveDrawing } from '../src/store/drawings.js';
import { createFolder, foldersOf } from '../src/store/folders.js';
import { freshDatabase } from './support/db.js';

const AT = Date.parse('2026-11-03T12:00:00Z');
const clock = (start = AT) => {
	const ticks = { at: start };
	return () => {
		ticks.at += 1000;
		return ticks.at;
	};
};

describe('createDrawing', () => {
	it('makes an empty drawing with its id and title in the file, named by its slug', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Floor Plan', now: clock() });

		expect(made.path).toBe('floor-plan.svg');
		expect(made.title).toBe('Floor Plan');
		expect(readDrawingId(made.text)).toBe(made.id);
		expect(readDrawingTitle(made.text)).toBe('Floor Plan');
		expect(made.dirty).toBe(1);
		expect(await db.opQueue.toArray()).toMatchObject([
			{ op: 'create', drawingId: made.id, path: 'floor-plan.svg' },
		]);
	});

	it('keeps filenames unique in a folder, as a file manager does', async () => {
		const db = freshDatabase();
		const first = await createDrawing(db, { title: 'Sketch' });
		const second = await createDrawing(db, { title: 'sketch' });
		const folder = await createFolder(db, 'Work');
		const inside = await createDrawing(db, { title: 'Sketch', folderPath: folder?.path });

		expect(first.path).toBe('sketch.svg');
		expect(second.path).toBe('sketch-2.svg');
		expect(inside.path).toBe('Work/sketch.svg');
	});

	it('takes a file from elsewhere, giving it an id only where it has none', async () => {
		const db = freshDatabase();
		const foreign = '<svg xmlns="http://www.w3.org/2000/svg"><title>Logo</title><rect/></svg>';
		const given = await createDrawing(db, { text: foreign });
		expect(given.title).toBe('Logo');
		expect(given.path).toBe('logo.svg');
		expect(readDrawingId(given.text)).toBe(given.id);

		const own = withDrawingId(foreign, 'abc-123');
		const kept = await createDrawing(db, { text: own, title: 'Mine' });
		expect(kept.id).toBe('abc-123');
		expect(kept.text).toBe(own);

		await expect(createDrawing(db, { text: '<html/>' })).rejects.toThrow(RangeError);
	});
});

describe('saveDrawing', () => {
	it('keeps the text and queues one write however many saves come', async () => {
		const db = freshDatabase();
		const now = clock();
		const made = await createDrawing(db, { title: 'A', now });
		await db.opQueue.clear();

		const edited = emptyDrawing({ id: made.id, title: 'A', size: { width: 10, height: 10 } });
		await saveDrawing(db, made.id, edited, now);
		await saveDrawing(db, made.id, `${edited}\n`, now);

		const row = await db.drawings.get(made.id);
		expect(row?.text).toBe(`${edited}\n`);
		expect(row?.dirty).toBe(1);
		expect(row?.updatedAt).toBeGreaterThan(made.updatedAt);
		expect(await db.opQueue.toArray()).toMatchObject([{ op: 'write', drawingId: made.id }]);
	});

	it('writes the drawing’s own id into text that carries another, and ignores a save of the same text', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'A' });
		const before = await db.drawings.get(made.id);
		await saveDrawing(db, made.id, made.text);
		expect(await db.drawings.get(made.id)).toEqual(before);

		await saveDrawing(db, made.id, emptyDrawing({ id: 'other-id' }));
		expect(readDrawingId((await db.drawings.get(made.id))?.text ?? '')).toBe(made.id);
	});
});

describe('renameDrawing', () => {
	it('changes the title in the file and the filename, and queues the move', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Old' });
		await createDrawing(db, { title: 'New' });
		await db.opQueue.clear();

		await renameDrawing(db, made.id, 'New');

		const row = await db.drawings.get(made.id);
		expect(row?.title).toBe('New');
		expect(row?.path).toBe('new-2.svg');
		expect(readDrawingTitle(row?.text ?? '')).toBe('New');
		expect(readDrawingId(row?.text ?? '')).toBe(made.id);
		expect(await db.opQueue.toArray()).toMatchObject([
			{ op: 'move', drawingId: made.id, path: 'old.svg', toPath: 'new-2.svg' },
			{ op: 'write', drawingId: made.id, path: 'new-2.svg' },
		]);
	});

	it('keeps the same filename for the same slug, and does nothing for a blank title', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Plan' });
		await db.opQueue.clear();
		await renameDrawing(db, made.id, 'PLAN');
		expect((await db.drawings.get(made.id))?.path).toBe('plan.svg');
		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['write']);

		await renameDrawing(db, made.id, '   ');
		expect((await db.drawings.get(made.id))?.title).toBe('PLAN');
	});
});

describe('deleteDrawing', () => {
	it('drops a drawing the provider never saw with everything queued for it', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Gone' });
		await deleteDrawing(db, made.id);
		expect(await db.drawings.get(made.id)).toBeUndefined();
		expect(await db.opQueue.toArray()).toEqual([]);
	});

	it('queues a delete for one the provider holds', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Synced' });
		await db.drawings.update(made.id, { remoteId: 'r1', dirty: 0 });
		await db.opQueue.clear();
		await deleteDrawing(db, made.id);
		expect(await db.opQueue.toArray()).toMatchObject([{ op: 'delete', path: 'synced.svg' }]);
		await expect(deleteDrawing(db, made.id)).resolves.toBeUndefined();
	});
});

describe('createFolder', () => {
	it('keeps the name as typed, less what breaks a path, and refuses a name taken', async () => {
		const db = freshDatabase();
		expect((await createFolder(db, ' Work: Q3? '))?.path).toBe('Work Q3');
		expect(await createFolder(db, 'work q3')).toBeUndefined();
		expect((await createFolder(db, 'Inside', { parentPath: 'Work Q3' }))?.path).toBe(
			'Work Q3/Inside'
		);
		expect((await createFolder(db, '///', { unnamed: 'Ohne Titel' }))?.name).toBe('Ohne Titel');
		expect((await foldersOf(db)).map((folder) => folder.path)).toEqual([
			'Ohne Titel',
			'Work Q3',
			'Work Q3/Inside',
		]);
		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual([
			'createFolder',
			'createFolder',
			'createFolder',
		]);
	});
});
