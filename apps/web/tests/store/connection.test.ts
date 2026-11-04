import { createSyncEngine, isHidden, NotFoundError } from '@skysa/draw-core';
import { createFakeProvider } from '@skysa/draw-core/testing';
import { describe, expect, it, vi } from 'vitest';

import {
	bindConnection,
	bindingCount,
	bindingMode,
	connectedSources,
	detachConnection,
	finishImport,
	RESUME_SAMPLE_COUNT,
	showConnection,
	verifyResume,
} from '../../src/store/connection.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	type DrawDatabase,
	type DrawingRecord,
	LOCAL_CONNECTION_ID,
} from '../../src/store/db.js';
import {
	createDrawing,
	deleteDrawing,
	renameDrawing,
	saveDrawing,
} from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { createDexieSyncStore } from '../../src/sync/store.js';
import { freshDatabase } from '../support/db.js';
import {
	drawingById,
	folderOf,
	folderTree,
	listDrawings,
	svgOf,
	updateDrawing,
} from '../support/drawingRows.js';

const DROPBOX = { connectionId: 'dropbox-1', provider: 'dropbox' } as const;

const queued = async (db: DrawDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op) => [op.connectionId, op.op, op.path]);

/** A device that has been used for a while with nothing connected. */
const usedLocally = async () => {
	const db = freshDatabase();
	await createFolder(db, 'Work');
	await createFolder(db, 'Inner', { parentPath: 'Work' });
	const plan = await createDrawing(db, {
		folderPath: 'Work',
		title: 'Plan',
		text: svgOf('# Plan\n'),
	});
	const deep = await createDrawing(db, { folderPath: 'Work/Inner', title: 'Deep' });
	return { db, plan, deep };
};

describe('the active connection', () => {
	it('is the local one until an account is bound', async () => {
		const db = freshDatabase();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);

		await bindConnection(db, DROPBOX);

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		expect((await db.syncState.get(DROPBOX.connectionId))?.provider).toBe('dropbox');
	});

	it('is what the store reads and writes when it is not told a connection', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);

		const drawing = await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		await createFolder(db, 'Play');

		expect(drawing.connectionId).toBe(DROPBOX.connectionId);
		expect((await listDrawings(db)).map((each) => each.id)).toEqual([drawing.id]);
		expect(await folderTree(db)).toEqual(['Play', 'Work']);
		expect(new Set((await db.opQueue.toArray()).map((op) => op.connectionId))).toEqual(
			new Set([DROPBOX.connectionId])
		);
	});
});

describe('binding a connection', () => {
	it('brings every drawing and folder on the device with it, and nothing stays behind', async () => {
		const { db, plan, deep } = await usedLocally();

		await bindConnection(db, DROPBOX);

		expect((await listDrawings(db)).map((drawing) => drawing.id).sort()).toEqual(
			[plan.id, deep.id].sort()
		);
		expect(await folderTree(db)).toEqual(['Work', 'Work/Inner']);
		// Kept while the import runs, for a cancel to go back to, and not
		// offered as a source of its own meanwhile.
		expect(await db.drawings.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(2);
		expect((await connectedSources(db)).map((source) => source.connectionId)).toEqual([
			DROPBOX.connectionId,
		]);

		await finishImport(db, DROPBOX.connectionId);

		expect(await db.drawings.where('connectionId').notEqual(DROPBOX.connectionId).count()).toBe(
			0
		);
		expect(await db.folders.where('connectionId').notEqual(DROPBOX.connectionId).count()).toBe(
			0
		);
		expect(await folderTree(db, { connectionId: LOCAL_CONNECTION_ID })).toEqual([]);
	});

	it('queues what the remote needs folder by folder, each made before what is in it', async () => {
		const { db, plan, deep } = await usedLocally();

		await bindConnection(db, DROPBOX);

		expect((await queued(db)).filter(([to]) => to === DROPBOX.connectionId)).toEqual([
			['dropbox-1', 'mkdir', 'Work'],
			['dropbox-1', 'write', plan.path],
			['dropbox-1', 'mkdir', 'Work/Inner'],
			['dropbox-1', 'write', deep.path],
		]);
	});

	it('marks every drawing as holding writing no remote has', async () => {
		const { db, plan } = await usedLocally();
		await updateDrawing(db, plan.id, { dirty: 0 });

		await bindConnection(db, DROPBOX);

		expect((await drawingById(db, plan.id))?.dirty).toBe(1);
	});

	it('leaves another source’s drawings exactly where they are', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const drawing = await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		await updateDrawing(db, drawing.id, {
			remoteId: 'id:1',
			remoteVersion: 'v1',
			syncedHash: 'h1',
			dirty: 0,
		});
		await db.syncState.update(DROPBOX.connectionId, { cursor: 'old-account-cursor' });

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });

		// This used to take the drawing with it, cut loose from its file and marked
		// as writing no remote had — which, connecting a second account, meant
		// copying one account's drawings into another's storage on the strength of a
		// consent screen. Each connected source is its own silo now: the drawing
		// stays where it is, still knowing its file, and the new source starts
		// empty (docs/ARCHITECTURE.md §6).
		const row = await drawingById(db, drawing.id);
		expect(row).toMatchObject({ connectionId: DROPBOX.connectionId, dirty: 0 });
		expect(row?.remoteId).toBe('id:1');
		expect(row?.remoteVersion).toBe('v1');
		expect(row?.syncedHash).toBe('h1');

		// And the source it came from is still a source, with its place in the
		// remote's history intact. Deleting its row would have stranded the drawing.
		const states = await db.syncState.toArray();
		expect(states.map((state) => state.connectionId).sort()).toEqual([
			DROPBOX.connectionId,
			'dropbox-2',
		]);
		expect(states.find((state) => state.connectionId === DROPBOX.connectionId)?.cursor).toBe(
			'old-account-cursor'
		);
		// The one just connected is the one shown, and it holds nothing yet.
		expect(await activeConnectionId(db)).toBe('dropbox-2');
		expect(await db.drawings.where('connectionId').equals('dropbox-2').count()).toBe(0);
	});

	it('drops the queue of the connection it replaces, once the import is done', async () => {
		const { db } = await usedLocally();
		expect((await db.opQueue.toArray()).length).toBeGreaterThan(0);

		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);

		expect(
			(await db.opQueue.toArray()).filter((op) => op.connectionId !== DROPBOX.connectionId)
		).toEqual([]);
	});

	it('drops a deleted drawing whose delete never reached a remote', async () => {
		const { db, plan } = await usedLocally();
		await deleteDrawing(db, plan.id);

		await bindConnection(db, DROPBOX);
		await finishImport(db, DROPBOX.connectionId);

		expect(await drawingById(db, plan.id)).toBeUndefined();
		expect((await db.opQueue.toArray()).filter((op) => op.drawingId === plan.id)).toEqual([]);
	});

	it('changes nothing when bound again, cursor and queue included', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);
		await db.syncState.update(DROPBOX.connectionId, { cursor: 'c1' });
		const drawings = await db.drawings.toArray();
		const ops = await db.opQueue.toArray();

		await bindConnection(db, DROPBOX);

		expect(await db.drawings.toArray()).toEqual(drawings);
		expect(await db.opQueue.toArray()).toEqual(ops);
		expect((await db.syncState.get(DROPBOX.connectionId))?.cursor).toBe('c1');
	});

	it('keeps the files a source lists as not UTF-8 text, bound again or beside a new source', async () => {
		// The list lives on the row a bind rewrites (`SyncStateRecord.unreadable`).
		// Dropped, the panel stops saying which files it is not showing until
		// something next names them — and the cursor kept beside it means nothing
		// will.
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const unreadable = [{ remoteId: 'id:9', path: 'Work/old.svg' }];
		await db.syncState.update(DROPBOX.connectionId, { cursor: 'c1', unreadable });

		await bindConnection(db, DROPBOX);

		expect((await db.syncState.get(DROPBOX.connectionId))?.unreadable).toEqual(unreadable);

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });

		expect((await db.syncState.get(DROPBOX.connectionId))?.unreadable).toEqual(unreadable);
		// Another account's files are not this one's: a new source lists none.
		expect((await db.syncState.get('dropbox-2'))?.unreadable).toBeUndefined();
	});

	it('keeps the install’s client id across connections', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const { clientId } = (await db.syncState.get(DROPBOX.connectionId))!;

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });

		expect((await db.syncState.get('dropbox-2'))?.clientId).toBe(clientId);
	});

	it('gives way when rows from two connections want one path', async () => {
		const db = freshDatabase();
		const local = await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		// On the device too, not on a connection of its own: rows under another
		// connection stay there now, so the only collision binding can meet is
		// between two spellings of a path the device itself holds.
		const stray = await createDrawing(db, {
			title: 'plan',
			folderPath: 'work',
		});
		const before = [local.text, stray.text];

		await bindConnection(db, DROPBOX);

		const paths = (await listDrawings(db)).map((drawing) => drawing.path.toLowerCase());
		expect(new Set(paths).size).toBe(2);
		// And one folder: `Work` and `work` are one directory on the remote.
		expect(await folderTree(db)).toHaveLength(1);
		expect([
			(await drawingById(db, local.id))?.text,
			(await drawingById(db, stray.id))?.text,
		]).toEqual(before);
	});

	it('keeps a folder spelled two ways one folder, with every drawing in it', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', { connectionId: 'stale' });
		const kept = await createDrawing(db, {
			connectionId: 'stale',
			folderPath: 'Work',
			title: 'Kept',
		});
		await createFolder(db, 'work');
		await createFolder(db, 'Inner', { parentPath: 'work' });
		const deep = await createDrawing(db, { folderPath: 'work/Inner', title: 'Deep' });
		// Pushed long ago: nothing is owed for what is already there.
		await db.opQueue.clear();

		await bindConnection(db, { connectionId: 'stale', provider: 'dropbox' });
		await finishImport(db, 'stale');

		expect(await folderTree(db)).toEqual(['Work', 'Work/Inner']);
		const moved = `Work/Inner/${deep.path.split('/').at(-1) ?? ''}`;
		expect((await drawingById(db, deep.id))?.path).toBe(moved);
		expect((await drawingById(db, kept.id))?.path).toBe(kept.path);
		expect(await queued(db)).toEqual([
			['stale', 'mkdir', 'Work/Inner'],
			['stale', 'write', moved],
		]);
	});

	it('does not move a drawing aside for a drawing that was deleted', async () => {
		const db = freshDatabase();
		const gone = await createDrawing(db, { connectionId: 'stale', title: 'Plan' });
		await deleteDrawing(db, gone.id, { connectionId: 'stale' });
		const moving = await createDrawing(db, { title: 'Plan' });

		await bindConnection(db, { connectionId: 'stale', provider: 'dropbox' });

		expect((await drawingById(db, moving.id))?.path).toBe(moving.path);
	});

	it('moves everything or nothing', async () => {
		const { db } = await usedLocally();
		const drawings = await db.drawings.toArray();
		const folders = await db.folders.toArray();
		const ops = await db.opQueue.toArray();
		// Fails after every row has been moved, at the last write of all.
		Object.assign(db.opQueue, {
			add: () => Promise.reject(new Error('quota exceeded')),
		});

		await expect(bindConnection(db, DROPBOX)).rejects.toThrow('quota exceeded');

		expect(await db.drawings.toArray()).toEqual(drawings);
		expect(await db.folders.toArray()).toEqual(folders);
		expect(await db.opQueue.toArray()).toEqual(ops);
		expect(await db.syncState.count()).toBe(0);
	});
});

describe('binding or letting go on a condition', () => {
	it('does nothing once the device has been bound or let go since', async () => {
		const { db, plan } = await usedLocally();
		const before = await bindingCount(db);
		// And back again: where it is now says nothing about what happened.
		await bindConnection(db, DROPBOX);
		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		await bindConnection(db, DROPBOX);
		const ops = await db.opQueue.toArray();

		expect(
			await bindConnection(db, {
				connectionId: 'dropbox-2',
				provider: 'dropbox',
				ifUnchangedSince: before,
			})
		).toBe(false);
		expect(
			await detachConnection(db, {
				connectionId: DROPBOX.connectionId,
				ifUnchangedSince: before,
			})
		).toBe(false);

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		expect((await db.syncState.get(DROPBOX.connectionId))?.detached).toBeUndefined();
		expect((await drawingById(db, plan.id))?.connectionId).toBe(DROPBOX.connectionId);
		expect(await db.opQueue.toArray()).toEqual(ops);
	});

	it('does it when the device still is', async () => {
		const { db } = await usedLocally();

		expect(
			await bindConnection(db, { ...DROPBOX, ifUnchangedSince: await bindingCount(db) })
		).toBe(true);
		expect(
			await detachConnection(db, {
				connectionId: DROPBOX.connectionId,
				ifUnchangedSince: await bindingCount(db),
			})
		).toBe(true);
		// Nothing of it was ever sent, so it is kept where it is, detached.
		expect((await db.syncState.get(DROPBOX.connectionId))?.detached).toBeDefined();
	});
});

describe('connecting an account', () => {
	it('remembers which account a source is to, on the source', async () => {
		const db = freshDatabase();

		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		expect((await db.syncState.get(DROPBOX.connectionId))?.accountId).toBe('dbid:1');

		// An account the API could not name belongs to nobody the device knows.
		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });
		expect((await db.syncState.get('dropbox-2'))?.accountId).toBeUndefined();
	});

	it('keeps both when a drawing from the device’s own pile meets one of its id, and what it owes follows', async () => {
		// One file read into two places: the id travels in the file, so a drawing
		// of the device's own can carry the id of one the source already holds.
		// A bind puts them under one connection, where a key can name only one.
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		await finishImport(db, DROPBOX.connectionId);
		const hers = await createDrawing(db, { title: 'Plan', text: svgOf('hers\n') });
		await updateDrawing(db, hers.id, { remoteId: 'ada:1', dirty: 0 });
		await db.opQueue.clear();
		await db.drawings.add({
			...hers,
			connectionId: LOCAL_CONNECTION_ID,
			path: 'mine.svg',
			text: svgOf('mine\n'),
		});

		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });

		const rows = await db.drawings.where('connectionId').equals(DROPBOX.connectionId).toArray();
		const says = (row: DrawingRecord, words: string) => row.text.includes(`<desc>${words}`);
		expect(rows.filter((row) => says(row, 'hers') || says(row, 'mine'))).toHaveLength(2);
		// The one already there keeps its id, and its file; the newcomer is
		// named again, and is owed a write under the name it has now.
		expect(rows.find((row) => says(row, 'hers'))).toMatchObject({
			id: hers.id,
			remoteId: 'ada:1',
		});
		const mine = rows.find((row) => says(row, 'mine'));
		expect(mine?.id).not.toBe(hers.id);
		expect(mine).toMatchObject({ path: 'mine.svg', dirty: 1 });
		expect((await db.opQueue.toArray()).map((op) => [op.op, op.drawingId])).toEqual([
			['write', mine?.id],
		]);
		expect(await db.drawings.count()).toBe(2);
	});

	it('refuses to show a source this device does not have, and keeps showing one it does', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		const drawing = await createDrawing(db, { title: 'Plan' });

		// A connection id from somewhere else — another tab's flow, a stale
		// deep link. Recorded, it would leave the app showing a source with no
		// rows, and every drawing written from then on filed under it: invisible,
		// and synced by nothing.
		expect(await showConnection(db, 'c-nowhere')).toBe(false);

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		expect((await listDrawings(db)).map((row) => row.id)).toEqual([drawing.id]);
	});

	it('falls back to a source it has when the recorded choice names one it does not', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		// What another tab disconnecting that source leaves behind, for a moment,
		// in a tab that recorded the choice before it went.
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'c-gone' });

		expect(await activeConnectionId(db)).toBe(DROPBOX.connectionId);
		// And with nothing at all connected, the device itself.
		await db.syncState.clear();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('falls back to a live source before a detached one, and to a detached one before the device', async () => {
		const db = freshDatabase();
		// Detached first, so it is the first row: the order IndexedDB hands the
		// rows back in must not be what decides.
		await bindConnection(db, { connectionId: 'a-detached', provider: 'dropbox' });
		await createDrawing(db, { title: 'Never sent' });
		await detachConnection(db, { connectionId: 'a-detached' });
		await bindConnection(db, { connectionId: 'b-live', provider: 'dropbox' });
		await bindConnection(db, { connectionId: 'c-live', provider: 'dropbox' });

		// The chosen source, whatever it is — a detached one included.
		await showConnection(db, 'a-detached');
		expect(await activeConnectionId(db)).toBe('a-detached');
		await showConnection(db, 'c-live');
		expect(await activeConnectionId(db)).toBe('c-live');

		// No usable choice: the first live source, not the first row.
		await db.prefs.delete(ACTIVE_CONNECTION_KEY);
		expect(await activeConnectionId(db)).toBe('b-live');
		await db.prefs.put({ key: ACTIVE_CONNECTION_KEY, value: 'c-gone' });
		expect(await activeConnectionId(db)).toBe('b-live');

		// No live source: the detached one, which is what there is to show.
		await db.syncState.bulkDelete(['b-live', 'c-live']);
		expect(await activeConnectionId(db)).toBe('a-detached');

		// Nothing at all: the device.
		await db.syncState.clear();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('lets go of a source that is not the one in front, and only that one', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		await bindConnection(db, {
			connectionId: 'c-bob',
			provider: 'dropbox',
			accountId: 'dbid:2',
		});
		const his = await createDrawing(db, { title: 'His' });
		await updateDrawing(db, his.id, { remoteId: 'bob:1', dirty: 0 });
		const before = await drawingById(db, his.id);
		const owed = await queued(db);

		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		// And one this device never had, which is already true and changes nothing.
		await detachConnection(db, { connectionId: 'c-stranger' });

		expect(await db.syncState.get(DROPBOX.connectionId)).toBeUndefined();
		expect(await activeConnectionId(db)).toBe('c-bob');
		expect((await db.prefs.get(ACTIVE_CONNECTION_KEY))?.value).toBe('c-bob');
		expect((await db.syncState.get('c-bob'))?.detached).toBeUndefined();
		expect(await drawingById(db, his.id)).toEqual(before);
		expect(await queued(db)).toEqual(owed);
	});

	it('sends a detached source home to its own account, and to no other', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		await createDrawing(db, { title: 'Plan' });
		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		const asked = { connectionId: 'dropbox-2', provider: 'dropbox' } as const;

		expect(await bindingMode(db, { ...asked, accountId: 'dbid:1' })).toEqual({
			mode: 'resume',
			from: [DROPBOX.connectionId],
		});
		// Another account, at the same provider or not, is a stranger to it.
		expect(await bindingMode(db, { ...asked, accountId: 'dbid:2' })).toEqual({
			mode: 'copy',
			from: [],
		});
		expect(
			await bindingMode(db, { ...asked, provider: 'onedrive', accountId: 'dbid:1' })
		).toEqual({ mode: 'copy', from: [] });
		// So is one the API does not name: it cannot be said to be anybody's.
		expect(await bindingMode(db, asked)).toEqual({ mode: 'copy', from: [] });
		// The same connection coming back moves nothing: its rows never left it.
		expect(await bindingMode(db, { ...DROPBOX, accountId: 'dbid:1' })).toEqual({
			mode: 'copy',
			from: [],
		});
		// And a source that is still live is nobody's to take, same account or not.
		await bindConnection(db, { connectionId: 'c-live', provider: 'dropbox', accountId: 'x' });
		expect(await bindingMode(db, { ...asked, accountId: 'x' })).toEqual({
			mode: 'copy',
			from: [],
		});
	});
});

describe('checking a resumed connection against its remote', () => {
	it('copies the drawings back into an app folder emptied while disconnected', async () => {
		const { db, fake, entryOf, reconnect } = await heldThenDisconnected();
		const drawings = (await listDrawings(db)).map((drawing) => [drawing.id, drawing.text]);
		await fake.delete(entryOf('Work'));

		const { verdict, outcome } = await reconnect();

		expect(verdict).toBe('copied');
		expect(outcome.conflicts).toEqual([]);
		expect((await listDrawings(db)).map((drawing) => [drawing.id, drawing.text])).toEqual(
			drawings
		);
		expect(filesOn(fake)).toHaveLength(2);
	});

	it('lets no sync write before it has looked', async () => {
		const { db, fake } = await heldThenDisconnected();
		await fake.delete(fake.snapshot().find((entry) => entry.path === 'Work')!);
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: 'dropbox-2' }),
		});

		expect((await engine.sync()).status).not.toBe('ok');

		expect(await listDrawings(db)).toHaveLength(2);
		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBe(true);
	});

	it('keeps waiting when the remote cannot be asked', async () => {
		const { db } = await heldThenDisconnected();
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const offline = { read: () => Promise.reject(new TypeError('offline')) };

		await expect(verifyResume(db, 'dropbox-2', offline)).rejects.toThrow('offline');

		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBe(true);
		expect((await listDrawings(db)).every((drawing) => drawing.remoteId !== undefined)).toBe(
			true
		);
	});

	it('cuts loose only the connection’s own rows, never another account’s', async () => {
		// The dangerous shape, and it needs no user mistake: the scheduler calls
		// `verifyResume` itself before the first sync of a resumed connection.
		const { db } = await heldThenDisconnected();
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		// A second source, connected alongside while the first is still waiting
		// to be verified.
		await bindConnection(db, { connectionId: 'c-cy', provider: 'dropbox', accountId: 'cy' });
		const theirs = await createDrawing(db, { connectionId: 'c-cy', title: 'Cy' });
		await updateDrawing(db, theirs.id, { remoteId: 'cy:1', dirty: 0 });
		const empty = { read: () => Promise.reject(new NotFoundError('gone')) };

		expect(await verifyResume(db, 'dropbox-2', empty)).toBe('copied');

		// Cy's drawing is untouched. Swept into the connection being copied, it
		// would be dirty, queued, and pushed into an account it has nothing to do
		// with — with nobody asked.
		const row = await drawingById(db, theirs.id);
		expect(row?.connectionId).toBe('c-cy');
		expect(row?.remoteId).toBe('cy:1');
		expect(row?.dirty).toBe(0);
		// It still owes the write it was created with, to its own source — never
		// to the connection that was being verified.
		expect((await queued(db)).filter((op) => op[2] === row?.path).map((op) => op[0])).toEqual([
			'c-cy',
		]);
		// And the connection that was verified really was cut loose.
		expect(
			(await db.drawings.where('connectionId').equals('dropbox-2').toArray()).every(
				(drawing) => drawing.remoteId === undefined && drawing.dirty === 1
			)
		).toBe(true);
	});

	it('keeps what the account is called, whichever way it answers', async () => {
		const { db, fake } = await heldThenDisconnected();
		await bindConnection(db, {
			connectionId: 'dropbox-2',
			...ACCOUNT,
			displayName: 'ada@example.com',
		});
		expect(await verifyResume(db, 'dropbox-2', fake)).toBe('resumed');
		expect((await db.syncState.get('dropbox-2'))?.displayName).toBe('ada@example.com');

		const copied = await heldThenDisconnected();
		await bindConnection(copied.db, {
			connectionId: 'dropbox-2',
			...ACCOUNT,
			displayName: 'ada@example.com',
		});
		const empty = { read: () => Promise.reject(new NotFoundError('gone')) };
		expect(await verifyResume(copied.db, 'dropbox-2', empty)).toBe('copied');
		expect((await copied.db.syncState.get('dropbox-2'))?.displayName).toBe('ada@example.com');
	});

	it('looks past a drawing deleted elsewhere for one that is still there', async () => {
		const { db, fake, plan, entryOf } = await heldThenDisconnected();
		// The most recently written, which is looked for first.
		await saveDrawing(db, plan.id, svgOf('# Plan\n\nnewest\n'));
		await fake.delete(entryOf(plan.path));
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		expect(await verifyResume(db, 'dropbox-2', fake)).toBe('resumed');
	});

	it('looks in every folder, not only the one in use, before deciding it is a new folder', async () => {
		const db = freshDatabase();
		await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: 'dropbox-1' }),
		});
		// Both inside one top-level folder, the way many people keep them.
		await createFolder(db, 'Work');
		await createFolder(db, 'Old', { parentPath: 'Work' });
		await createDrawing(db, { folderPath: 'Work/Old', title: 'Kept', text: svgOf('# Kept\n') });
		await createFolder(db, 'Project', { parentPath: 'Work' });
		await [...Array(RESUME_SAMPLE_COUNT + 1).keys()].reduce<Promise<void>>(
			async (pending, at) => {
				await pending;
				await createDrawing(db, {
					folderPath: 'Work/Project',
					title: `Step ${String(at)}`,
					text: svgOf('x\n'),
				});
			},
			Promise.resolve()
		);
		await engine.sync();
		await engine.sync();
		// Every one of them written in since and not sent, so every one is kept.
		await db.drawings.where('connectionId').equals('dropbox-1').modify({ dirty: 1 });
		await detachConnection(db, { connectionId: 'dropbox-1' });
		await fake.delete(fake.snapshot().find((entry) => entry.path === 'Work/Project')!);
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		expect(await verifyResume(db, 'dropbox-2', fake)).toBe('resumed');
	});

	it('passes over a file the provider will not read', async () => {
		const { db, fake, plan } = await heldThenDisconnected();
		await saveDrawing(db, plan.id, svgOf('# Plan\n\nnewest\n'));
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const restricted = {
			read: (ref: Parameters<typeof fake.read>[0]) =>
				ref.remoteId === plan.remoteId
					? Promise.reject(new Error('dropbox 409: path/restricted_content/'))
					: fake.read(ref),
		};

		expect(await verifyResume(db, 'dropbox-2', restricted)).toBe('resumed');
	});

	it('asks again later when nothing was found and some files could not be asked', async () => {
		const { db, fake, plan, entryOf } = await heldThenDisconnected();
		await fake.delete(entryOf('Work'));
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const flaky = {
			read: (ref: Parameters<typeof fake.read>[0]) =>
				ref.remoteId === plan.remoteId
					? Promise.reject(new TypeError('Failed to fetch'))
					: fake.read(ref),
		};

		await expect(verifyResume(db, 'dropbox-2', flaky)).rejects.toThrow('Failed to fetch');

		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBe(true);
		expect((await drawingById(db, plan.id))?.remoteId).toBe(plan.remoteId);
	});

	it('takes a file that is no longer UTF-8 text for one that is still there', async () => {
		// Every drawing's file re-saved by some other tool in its own encoding. Each
		// read fails the same way however often it is asked, so counted as "could
		// not be asked" the connection never verifies; and the files are there,
		// which is all this asks. The sync that follows lets go of the drawings.
		// Held, so that they are kept through the disconnect and there is a
		// resume to check: drawings the remote had in full went with the source.
		const { db, fake } = await heldThenDisconnected();
		fake.snapshot()
			.filter((entry) => entry.kind === 'file' && entry.path.endsWith('.svg'))
			.forEach((entry) => {
				fake.plantBytes(entry.path, new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
			});
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		expect(await verifyResume(db, 'dropbox-2', fake)).toBe('resumed');
		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBeUndefined();
	});

	it('has nothing to check on a connection bound by copying', async () => {
		const { db } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const read = vi.fn(() => Promise.reject(new Error('not asked')));

		expect((await db.syncState.get(DROPBOX.connectionId))?.resumeUnverified).toBeUndefined();
		expect(await verifyResume(db, DROPBOX.connectionId, { read })).toBe('verified');
		expect(read).not.toHaveBeenCalled();
	});

	it('stays unchecked when the same connection is bound again before it looks', async () => {
		const { db } = await heldThenDisconnected();
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBe(true);
	});

	it('answers for nothing when the source was let go and resumed again while it looked', async () => {
		const { db, fake } = await heldThenDisconnected();
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const slow = {
			read: async (ref: Parameters<typeof fake.read>[0]) => {
				await detachConnection(db, { connectionId: 'dropbox-2' });
				await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
				return fake.read(ref);
			},
		};

		expect(await verifyResume(db, 'dropbox-2', slow)).toBe('superseded');
		expect((await db.syncState.get('dropbox-2'))?.resumeUnverified).toBe(true);
	});

	it('answers for nothing when the source has been let go while it looked', async () => {
		const { db, fake } = await heldThenDisconnected();
		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
		const slow = {
			read: async (ref: Parameters<typeof fake.read>[0]) => {
				await detachConnection(db, { connectionId: 'dropbox-2' });
				return fake.read(ref);
			},
		};

		expect(await verifyResume(db, 'dropbox-2', slow)).toBe('superseded');
		// Detached, and still not vouched for: nothing it holds has been found.
		expect(await db.syncState.get('dropbox-2')).toMatchObject({
			detached: { reason: 'revoked' },
			resumeUnverified: true,
		});
	});
});

describe('resuming onto a connection that already has rows in the way', () => {
	it('copies a drawing that has to move, since its file is at the old path', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		const drawing = await createDrawing(db, { title: 'Plan', folderPath: 'Work' });
		await updateDrawing(db, drawing.id, { remoteId: 'id:1', remoteVersion: 'v1', dirty: 0 });
		await db.opQueue.clear();
		// Written in and never sent, so the disconnect keeps it, file and all.
		await saveDrawing(db, drawing.id, svgOf('# Plan\n\nedited\n'));
		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		expect((await drawingById(db, drawing.id))?.remoteId).toBe('id:1');
		const inTheWay = await createDrawing(db, {
			connectionId: 'dropbox-2',
			title: 'Plan',
			folderPath: 'Work',
		});
		await db.opQueue.where('drawingId').equals(inTheWay.id).delete();

		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		const row = await drawingById(db, drawing.id);
		expect(row?.connectionId).toBe('dropbox-2');
		expect(row?.path).not.toBe(drawing.path);
		expect(row?.remoteId).toBeUndefined();
		expect(row?.dirty).toBe(1);
		expect(await queued(db)).toEqual([['dropbox-2', 'write', row?.path]]);
	});

	it('copies a folder that has to be spelled another way', async () => {
		const db = freshDatabase();
		await bindConnection(db, { ...DROPBOX, accountId: 'dbid:1' });
		await createFolder(db, 'Work');
		await createFolder(db, 'Inner', { parentPath: 'Work' });
		await db.folders.update([DROPBOX.connectionId, 'Work'], { remoteId: 'folder:1' });
		await db.folders.update([DROPBOX.connectionId, 'Work/Inner'], { remoteId: 'folder:2' });
		await db.opQueue.clear();
		// A drawing in it that was never sent, which is what keeps the folders
		// above it on the device through the disconnect, still naming theirs.
		const drawing = await createDrawing(db, { folderPath: 'Work/Inner', title: 'Deep' });
		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		expect((await db.folders.get([DROPBOX.connectionId, 'Work/Inner']))?.remoteId).toBe(
			'folder:2'
		);
		await db.folders.put(folderOf({ connectionId: 'dropbox-2', path: 'work', createdAt: 0 }));

		await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });

		expect(await folderTree(db)).toEqual(['work', 'work/Inner']);
		expect((await db.folders.get(['dropbox-2', 'work/Inner']))?.remoteId).toBeUndefined();
		expect((await drawingById(db, drawing.id))?.path).toBe('work/Inner/deep.svg');
		expect(await queued(db)).toEqual([
			['dropbox-2', 'mkdir', 'work/Inner'],
			['dropbox-2', 'write', 'work/Inner/deep.svg'],
		]);
	});
});

/** Remote files a person would see, by path. */
const filesOn = (fake: ReturnType<typeof createFakeProvider>) =>
	fake
		.snapshot()
		.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
		.map((entry) => entry.path);

const ACCOUNT = { provider: 'dropbox', accountId: 'dbid:1' } as const;

interface Held {
	db: DrawDatabase;
	/** The first of the two drawings, as it stood once synced. */
	plan: DrawingRecord;
	other: DrawingRecord;
}

/**
 * Two drawings synced with an account, then disconnected — which deletes the
 * server's connection, so connecting the same account again gets a new id.
 *
 * `unsent` is what the device does between the last sync and the disconnect:
 * the only thing a disconnect keeps. With none, everything the source held is
 * on the remote and nothing of it stays here.
 */
const syncedThenDisconnected = async (
	unsent: (held: Held) => Promise<void> = () => Promise.resolve()
) => {
	const db = freshDatabase();
	await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engineFor = (connectionId: string) =>
		createSyncEngine({ provider: fake, store: createDexieSyncStore(db, { connectionId }) });
	await createFolder(db, 'Work');
	const made = await createDrawing(db, {
		folderPath: 'Work',
		title: 'Plan',
		text: svgOf('# Plan\n'),
	});
	const also = await createDrawing(db, {
		folderPath: 'Work',
		title: 'Other',
		text: svgOf('# Other\n'),
	});
	await engineFor('dropbox-1').sync();
	await engineFor('dropbox-1').sync();
	expect(await db.opQueue.count()).toBe(0);
	expect((await listDrawings(db)).filter((drawing) => drawing.dirty === 1)).toEqual([]);
	const plan = (await drawingById(db, made.id))!;
	const other = (await drawingById(db, also.id))!;
	await unsent({ db, plan, other });
	await detachConnection(db, { connectionId: 'dropbox-1' });

	const entryOf = (path: string) => fake.snapshot().find((entry) => entry.path === path)!;
	return {
		db,
		fake,
		plan,
		other,
		entryOf,
		reconnect: async () => {
			await bindConnection(db, { connectionId: 'dropbox-2', ...ACCOUNT });
			const verdict = await verifyResume(db, 'dropbox-2', fake);
			const calls = fake.callLog().length;
			const outcome = await engineFor('dropbox-2').sync();
			// And once more, for the echo of anything it pushed.
			await engineFor('dropbox-2').sync();
			return { outcome, verdict, calls: fake.callLog().slice(calls) };
		},
	};
};

/** The same, with both drawings written in since they were last sent: both are kept. */
const heldThenDisconnected = () =>
	syncedThenDisconnected(async ({ db, plan, other }) => {
		await saveDrawing(db, plan.id, svgOf('# Plan\n\nheld\n'));
		await saveDrawing(db, other.id, svgOf('# Other\n\nheld\n'));
	});

describe('connecting the same account again after a disconnect', () => {
	it('brings every drawing back, sending nothing, when nothing was left unsent', async () => {
		const { db, fake, plan, reconnect } = await syncedThenDisconnected();
		const files = filesOn(fake);
		// The remote has all of it, so none of it stays here.
		expect(await db.drawings.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);

		const { outcome, verdict, calls } = await reconnect();

		// Nothing was resumed, so there was nothing to check: a new connection.
		expect(verdict).toBe('verified');
		expect(outcome.conflicts).toEqual([]);
		expect(calls.filter((call) => call.op === 'write')).toEqual([]);
		expect(filesOn(fake)).toEqual(files);
		expect((await listDrawings(db)).map((drawing) => drawing.id)).toContain(plan.id);
		expect(await listDrawings(db)).toHaveLength(2);
		expect((await listDrawings(db)).filter((drawing) => drawing.dirty === 1)).toEqual([]);
	});

	it('sends what was written here and never sent, with no conflict copy', async () => {
		const { db, fake, plan, other, reconnect } = await syncedThenDisconnected(async (held) => {
			await saveDrawing(held.db, held.plan.id, svgOf('# Plan\n\nwritten and not sent\n'));
		});
		// Only what the remote lacks stayed: the edited drawing, still naming its file.
		expect(
			(await db.drawings.toArray()).map((drawing) => [drawing.id, drawing.remoteId])
		).toEqual([[plan.id, plan.remoteId]]);

		const { outcome, verdict } = await reconnect();

		expect(verdict).toBe('resumed');
		expect(outcome.conflicts).toEqual([]);
		expect(fake.contentAt(plan.path)).toContain('written and not sent');
		expect((await drawingById(db, plan.id))?.text).toContain('written and not sent');
		// And the one that was removed is back, from the first full scan.
		expect((await listDrawings(db)).map((drawing) => drawing.id).sort()).toEqual(
			[plan.id, other.id].sort()
		);
		expect(filesOn(fake)).toHaveLength(2);
	});

	it('goes on writing in the detached source, and sends that too', async () => {
		const { db, fake, plan, reconnect } = await syncedThenDisconnected(async (held) => {
			await saveDrawing(held.db, held.plan.id, svgOf('# Plan\n\nbefore\n'));
		});
		// Still the source showing, so this is where writing goes.
		expect(await activeConnectionId(db)).toBe('dropbox-1');
		await saveDrawing(db, plan.id, svgOf('# Plan\n\nbefore, and after\n'));
		await createFolder(db, 'Later');
		const made = await createDrawing(db, {
			folderPath: 'Later',
			title: 'New',
			text: svgOf('# New\n'),
		});

		const { outcome } = await reconnect();

		expect(outcome.conflicts).toEqual([]);
		expect(fake.contentAt(plan.path)).toContain('before, and after');
		expect(fake.contentAt(made.path)).toBe((await drawingById(db, made.id))?.text);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.drawings.where('connectionId').equals('dropbox-1').count()).toBe(0);
	});

	it('takes what was written elsewhere while disconnected, with no conflict copy', async () => {
		const { db, fake, plan, entryOf, reconnect } = await syncedThenDisconnected();
		await fake.write(plan.path, plan.text.replace('# Plan', '# Plan\n\nfrom elsewhere'), {
			expectedVersion: entryOf(plan.path).version,
		});

		const { outcome } = await reconnect();

		expect(outcome.conflicts).toEqual([]);
		expect((await drawingById(db, plan.id))?.text).toContain('from elsewhere');
		expect(await listDrawings(db)).toHaveLength(2);
		expect(filesOn(fake)).toHaveLength(2);
	});

	it('follows a rename made elsewhere, rather than keeping both', async () => {
		const { db, fake, plan, entryOf, reconnect } = await syncedThenDisconnected(
			async (held) => {
				await saveDrawing(held.db, held.plan.id, svgOf('# Plan\n\nheld\n'));
			}
		);
		await fake.move(entryOf(plan.path), 'Work/Renamed.svg');

		await reconnect();

		expect((await drawingById(db, plan.id))?.path).toBe('Work/Renamed.svg');
		expect(fake.contentAt('Work/Renamed.svg')).toContain('held');
		expect(await listDrawings(db)).toHaveLength(2);
		expect(filesOn(fake)).toHaveLength(2);
	});

	it('lets a drawing deleted elsewhere go', async () => {
		const { db, fake, plan, entryOf, reconnect } = await syncedThenDisconnected();
		await fake.delete(entryOf(plan.path));

		await reconnect();

		expect((await listDrawings(db)).map((drawing) => drawing.id)).not.toContain(plan.id);
		expect(filesOn(fake)).toHaveLength(1);
	});

	it('deletes the file of a drawing deleted here, whose delete was never sent', async () => {
		const { db, fake, plan, reconnect } = await syncedThenDisconnected(async (held) => {
			await deleteDrawing(held.db, held.plan.id);
		});
		// The tombstone is what is owed, and it is all that stayed.
		expect(
			(await db.drawings.toArray()).map((drawing) => [drawing.id, drawing.deletedLocally])
		).toEqual([[plan.id, 1]]);

		await reconnect();

		expect(fake.contentAt(plan.path)).toBeUndefined();
		expect(await drawingById(db, plan.id)).toBeUndefined();
		expect(filesOn(fake)).toHaveLength(1);
		expect(await listDrawings(db)).toHaveLength(1);
	});

	it('moves the file of a drawing renamed here, whose rename was never sent', async () => {
		const { db, fake, plan, reconnect } = await syncedThenDisconnected(async (held) => {
			await renameDrawing(held.db, held.plan.id, 'Renamed');
		});
		const renamed = (await drawingById(db, plan.id))!;
		expect(renamed.path).not.toBe(plan.path);

		const { outcome } = await reconnect();

		expect(outcome.conflicts).toEqual([]);
		expect(filesOn(fake)).toContain(renamed.path);
		expect(filesOn(fake)).not.toContain(plan.path);
		expect(await listDrawings(db)).toHaveLength(2);
	});

	it('sends a drawing and a folder that never reached the remote, queued or not', async () => {
		const { db, fake, reconnect } = await syncedThenDisconnected(async (held) => {
			await createFolder(held.db, 'Unqueued');
			await createDrawing(held.db, {
				folderPath: 'Work',
				title: 'Unqueued',
				text: svgOf('# U\n'),
			});
			// Rows from before local writers queued anything have nothing queued.
			await held.db.opQueue.clear();
		});
		const made = (await db.drawings.toArray()).find((drawing) => drawing.title === 'Unqueued')!;

		await reconnect();

		expect(fake.snapshot().map((entry) => entry.path)).toContain('Unqueued');
		expect(fake.contentAt(made.path)).toBe((await drawingById(db, made.id))?.text);
	});

	it('sends a drawing and a folder made and never sent', async () => {
		const { db, fake, reconnect } = await syncedThenDisconnected(async (held) => {
			await createFolder(held.db, 'Later');
			await createDrawing(held.db, {
				folderPath: 'Later',
				title: 'New',
				text: svgOf('# New\n'),
			});
		});
		const made = (await db.drawings.toArray()).find((drawing) => drawing.title === 'New')!;

		await reconnect();

		expect(fake.contentAt(made.path)).toBe((await drawingById(db, made.id))?.text);
		expect(await db.opQueue.count()).toBe(0);
	});
});

describe('a sync still at the network when the connection changes', () => {
	/** An engine for `connectionId` whose pull waits until `release` is called. */
	const heldPull = async (db: DrawDatabase, connectionId: string) => {
		const fake = createFakeProvider();
		await fake.ensureRoot();
		await fake.createFolder('Arrived');
		await fake.write('Arrived/new.svg', svgOf('New', 'arrived'), {});
		const gate = new Map<'release', () => void>();
		const held = new Promise<void>((resolve) => gate.set('release', resolve));
		const engine = createSyncEngine({
			provider: {
				...fake,
				changes: async (cursor) => {
					await held;
					return fake.changes(cursor);
				},
			},
			store: createDexieSyncStore(db, { connectionId }),
		});
		const running = engine.pull().catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { release: () => gate.get('release')?.(), running };
	};

	it('brings nothing back after a disconnect that left the source detached', async () => {
		const { db, plan, deep } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const { release, running } = await heldPull(db, DROPBOX.connectionId);

		// Nothing of it was ever sent, so the source stays, detached — and the
		// store refuses a detached source as it refuses one that has gone.
		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		release();
		await running;

		const state = await db.syncState.get(DROPBOX.connectionId);
		expect(state?.detached).toBeDefined();
		expect(state?.cursor).toBeUndefined();
		expect((await listDrawings(db)).map((drawing) => drawing.id).sort()).toEqual(
			[plan.id, deep.id].sort()
		);
		expect((await db.drawings.toArray()).map((drawing) => drawing.path)).not.toContain(
			'Arrived/new.svg'
		);
		expect((await db.folders.toArray()).map((folder) => folder.path)).not.toContain('Arrived');
	});

	it('brings nothing back after a disconnect that let the source go entirely', async () => {
		const db = freshDatabase();
		await bindConnection(db, DROPBOX);
		const { release, running } = await heldPull(db, DROPBOX.connectionId);

		await detachConnection(db, { connectionId: DROPBOX.connectionId });
		release();
		await running;

		expect(await db.syncState.count()).toBe(0);
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
		expect(await db.drawings.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
	});

	it('lands on the source it was for when another is connected meanwhile', async () => {
		const { db, plan, deep } = await usedLocally();
		await bindConnection(db, DROPBOX);
		const { release, running } = await heldPull(db, DROPBOX.connectionId);

		await bindConnection(db, { connectionId: 'dropbox-2', provider: 'dropbox' });
		release();
		await running;

		// This used to be about damage control: the rows had been dragged onto the
		// new connection underneath the pull, so the pull's own writes had to be
		// refused or they would have landed in the wrong account. Sources are
		// independent now, so there is nothing to refuse — the pull finishes into
		// the source it was started for, which is still connected, and the source
		// the user has switched to is untouched by it.
		expect((await db.syncState.toArray()).map((state) => state.connectionId).sort()).toEqual([
			DROPBOX.connectionId,
			'dropbox-2',
		]);
		const onFirst = await db.drawings
			.where('connectionId')
			.equals(DROPBOX.connectionId)
			.toArray();
		expect(onFirst.map((drawing) => drawing.id)).toEqual(
			expect.arrayContaining([plan.id, deep.id])
		);
		// And what the pull was for actually arrived, rather than being thrown
		// away because the user looked at something else while it was in flight.
		expect(onFirst.map((drawing) => drawing.path)).toContain('Arrived/new.svg');
		expect(await db.drawings.where('connectionId').equals('dropbox-2').count()).toBe(0);
	});
});

describe('a device used before connecting, then connected', () => {
	it('puts every drawing and folder on the remote on its first sync', async () => {
		const { db } = await usedLocally();
		await createFolder(db, 'Empty');
		await bindConnection(db, DROPBOX);
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: DROPBOX.connectionId }),
		});

		expect((await engine.sync()).status).toBe('ok');
		// What the scheduler does once a first sync is through.
		await finishImport(db, DROPBOX.connectionId);

		const files = Object.fromEntries(
			fake
				.snapshot()
				.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
				.map((entry) => [entry.path, fake.contentAt(entry.path)])
		);
		expect(files).toEqual(
			Object.fromEntries(
				(await listDrawings(db)).map((drawing) => [drawing.path, drawing.text])
			)
		);
		expect(fake.snapshot().map((entry) => entry.path)).toContain('Empty');
		expect(await db.opQueue.count()).toBe(0);
		expect((await listDrawings(db)).filter((drawing) => drawing.dirty === 1)).toEqual([]);
	});

	it('keeps both when the remote already has a different version of a drawing', async () => {
		// The same drawing, synced from this device to an earlier connection and
		// edited since on another: the same id in the file, different words.
		const { db, plan } = await usedLocally();
		await saveDrawing(db, plan.id, svgOf('# Plan\n\nmine\n'));
		const fake = createFakeProvider();
		await fake.ensureRoot();
		await fake.createFolder('Work');
		const theirs = (await drawingById(db, plan.id))?.text.replace('mine', 'theirs') ?? '';
		await fake.write(plan.path, theirs, {});
		await bindConnection(db, DROPBOX);
		const engine = createSyncEngine({
			provider: fake,
			store: createDexieSyncStore(db, { connectionId: DROPBOX.connectionId }),
		});

		await engine.sync();
		await engine.sync();

		const texts = [
			...(await listDrawings(db)).map((drawing) => drawing.text),
			...fake.snapshot().map((entry) => fake.contentAt(entry.path)),
		];
		expect(texts.some((text) => text?.includes('mine'))).toBe(true);
		expect(texts.some((text) => text?.includes('theirs'))).toBe(true);
	});
});
