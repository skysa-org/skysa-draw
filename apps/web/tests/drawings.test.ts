import { emptyDrawing, readDrawingId, readDrawingTitle, withDrawingId } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import { LOCAL_CONNECTION_ID } from '../src/store/db.js';
import {
	createDrawing,
	deleteDrawing,
	getDrawing,
	renameDrawing,
	saveDrawing,
} from '../src/store/drawings.js';
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
		expect(made.connectionId).toBe(LOCAL_CONNECTION_ID);
		expect(await db.opQueue.toArray()).toMatchObject([
			{ op: 'write', drawingId: made.id, path: 'floor-plan.svg' },
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

	it('takes a filename chosen from the names in the folder, as a conflict copy is named', async () => {
		const db = freshDatabase();
		await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		const offered: string[][] = [];
		const copy = await createDrawing(db, {
			title: 'Plan (conflict)',
			folderPath: 'Work',
			filename: (taken) => {
				offered.push([...taken]);
				return 'plan (conflict).svg';
			},
		});
		expect(offered).toEqual([['plan.svg']]);
		expect(copy.path).toBe('Work/plan (conflict).svg');
		expect(copy.title).toBe('Plan (conflict)');
	});
});

describe('saveDrawing', () => {
	it('keeps the text and queues one write however many saves come', async () => {
		const db = freshDatabase();
		const now = clock();
		const made = await createDrawing(db, { title: 'A', now });
		await db.opQueue.clear();

		const edited = emptyDrawing({ id: made.id, title: 'A', size: { width: 10, height: 10 } });
		expect(await saveDrawing(db, made.id, edited, now)).toBe('saved');
		expect(await saveDrawing(db, made.id, `${edited}\n`, { now })).toBe('saved');

		const row = await getDrawing(db, made.id);
		expect(row?.text).toBe(`${edited}\n`);
		expect(row?.dirty).toBe(1);
		expect(row?.updatedAt).toBeGreaterThan(made.updatedAt);
		expect(await db.opQueue.toArray()).toMatchObject([{ op: 'write', drawingId: made.id }]);
	});

	it('writes the drawing’s own id into text that carries another, and ignores a save of the same text', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'A' });
		const before = await getDrawing(db, made.id);
		expect(await saveDrawing(db, made.id, made.text)).toBe('unchanged');
		expect(await getDrawing(db, made.id)).toEqual(before);

		await saveDrawing(db, made.id, emptyDrawing({ id: 'other-id' }));
		expect(readDrawingId((await getDrawing(db, made.id))?.text ?? '')).toBe(made.id);
	});

	it('refuses a save made against text the row no longer holds, and writes nothing', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'A' });
		const theirs = emptyDrawing({ id: made.id, title: 'Theirs' });
		const mine = emptyDrawing({ id: made.id, title: 'Mine' });
		// Another tab, or a pull, changed the row since the editor loaded it.
		expect(await saveDrawing(db, made.id, theirs)).toBe('saved');
		const before = await getDrawing(db, made.id);
		const queued = await db.opQueue.toArray();

		expect(await saveDrawing(db, made.id, mine, { expected: made.text })).toBe('changed');
		expect(await saveDrawing(db, made.id, mine, { expected: made.contentHash })).toBe(
			'changed'
		);
		expect(await getDrawing(db, made.id)).toEqual(before);
		expect(await db.opQueue.toArray()).toEqual(queued);
	});

	it('takes a save made against the text the row holds, by text or by hash, or any of several', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'A' });
		const first = emptyDrawing({ id: made.id, title: 'One' });
		const second = emptyDrawing({ id: made.id, title: 'Two' });
		const third = emptyDrawing({ id: made.id, title: 'Three' });

		expect(await saveDrawing(db, made.id, first, { expected: made.text })).toBe('saved');
		const saved = await getDrawing(db, made.id);
		expect(await saveDrawing(db, made.id, second, { expected: saved?.contentHash })).toBe(
			'saved'
		);
		// A save of the editor's own still on its way when the next was made.
		expect(await saveDrawing(db, made.id, third, { expected: [first, second] })).toBe('saved');
		expect((await getDrawing(db, made.id))?.text).toBe(third);
		// The same text is no change, whatever it was expected against.
		expect(await saveDrawing(db, made.id, third, { expected: 'nothing like it' })).toBe(
			'unchanged'
		);
	});

	it('throws for a drawing that is gone or deleted', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'A' });
		await deleteDrawing(db, made.id);
		await expect(saveDrawing(db, made.id, emptyDrawing({ id: made.id }))).rejects.toThrow();
		await expect(saveDrawing(db, 'no-such', emptyDrawing({ id: 'no-such' }))).rejects.toThrow();
	});
});

describe('renameDrawing', () => {
	it('changes the title in the file and the filename, and queues the move', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Old' });
		await createDrawing(db, { title: 'New' });
		// As the provider has it, so a move is owed to it.
		await db.drawings.update([LOCAL_CONNECTION_ID, made.id], { remoteId: 'r1', dirty: 0 });
		await db.opQueue.clear();

		await renameDrawing(db, made.id, 'New');

		const row = await getDrawing(db, made.id);
		expect(row?.title).toBe('New');
		expect(row?.path).toBe('new-2.svg');
		expect(readDrawingTitle(row?.text ?? '')).toBe('New');
		expect(readDrawingId(row?.text ?? '')).toBe(made.id);
		expect(await db.opQueue.toArray()).toMatchObject([
			{ op: 'move', drawingId: made.id, path: 'old.svg', targetPath: 'new-2.svg' },
			{ op: 'write', drawingId: made.id, path: 'new-2.svg' },
		]);
	});

	it('keeps the same filename for the same slug, and does nothing for a blank title', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Plan' });
		await db.opQueue.clear();
		await renameDrawing(db, made.id, 'PLAN');
		expect((await getDrawing(db, made.id))?.path).toBe('plan.svg');
		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['write']);

		await renameDrawing(db, made.id, '   ');
		expect((await getDrawing(db, made.id))?.title).toBe('PLAN');
	});

	it('keeps a title as the file has it, so one of nothing XML holds is blank', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: ' Plan\u0007 ' });
		expect([made.title, readDrawingTitle(made.text)]).toEqual(['Plan', 'Plan']);

		expect(await renameDrawing(db, made.id, '\u0007￿')).toBeUndefined();
		const kept = await getDrawing(db, made.id);
		expect([kept?.title, readDrawingTitle(kept?.text ?? '')]).toEqual(['Plan', 'Plan']);

		const renamed = await renameDrawing(db, made.id, 'New\u0001');
		expect([renamed?.title, readDrawingTitle(renamed?.text ?? '')]).toEqual(['New', 'New']);

		// Made with nothing XML holds, its title is blank, as one made with a
		// blank title is, which the list shows as untitled in its own words.
		for (const title of ['\u0007', '']) {
			const untitled = await createDrawing(db, { title });
			expect([untitled.title, readDrawingTitle(untitled.text)]).toEqual(['', undefined]);
		}
	});
});

describe('deleteDrawing', () => {
	it('keeps a tombstone until the delete is pushed, its write withdrawn', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Gone' });
		await deleteDrawing(db, made.id);
		expect(await getDrawing(db, made.id)).toMatchObject({ deletedLocally: 1, dirty: 1 });
		// One the provider never had is purged by that push, with nothing sent.
		expect(await db.opQueue.toArray()).toMatchObject([{ op: 'delete', drawingId: made.id }]);
	});

	it('queues a delete for one the provider holds', async () => {
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Synced' });
		await db.drawings.update([LOCAL_CONNECTION_ID, made.id], { remoteId: 'r1', dirty: 0 });
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
			'mkdir',
			'mkdir',
			'mkdir',
		]);
	});
});
