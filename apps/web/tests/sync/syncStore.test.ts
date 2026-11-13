import { conflictContent, DRAW_FORMAT, syncsHidden } from '@skysa/draw-core';
import { contentHash, type RemoteEntry } from '@skysa/storage';
import { createFakeProvider } from '@skysa/storage/testing';
import { createSyncEngine } from '@skysa/sync';
import { describeSyncStoreContract } from '@skysa/sync/testing';
import { describe, expect, it } from 'vitest';

// The suite lives beside the port it checks, in the kit's `@skysa/sync`, and is
// not a `*.test.ts` there so that it runs only where a store registers it. The
// kit cannot import this app, so this store registers here instead.
import type { DrawDatabase, OpQueueRecord } from '../../src/store/db.js';
import {
	createDrawing,
	deleteDrawing,
	drawingRecordFromFile,
	saveDrawing,
} from '../../src/store/drawings.js';
import { folderRow } from '../../src/store/folders.js';
import { queueRestore } from '../../src/store/queue.js';
import { rowsOf } from '../../src/store/rows.js';
import {
	createDexieSyncStore,
	type DexieSyncStoreOptions,
	UnboundConnectionError,
	UnverifiedResumeError,
} from '../../src/sync/store.js';
import { freshDatabase } from '../support/db.js';
import { drawingById, queuedRow, svgOf, updateDrawing } from '../support/drawingRows.js';

const CONNECTION = 'dropbox-1';

/**
 * A store for a connection the device is bound to — the only kind the app
 * makes, and the only kind that writes.
 */
const boundStore = async (db: DrawDatabase, options: DexieSyncStoreOptions) => {
	await db.syncState.put({ connectionId: options.connectionId, clientId: 'this-browser' });
	return createDexieSyncStore(db, options);
};

/** A connection's drawings, tombstones and all. */
const drawingsOf = (db: DrawDatabase, connectionId: string) =>
	rowsOf(db.drawings, connectionId).toArray();

/**
 * A deleted drawing the user's again, as an undo of the delete would make it:
 * live and owed a write, its delete withdrawn (`queueRestore`).
 */
const restored = (db: DrawDatabase, id: string) =>
	db.transaction('rw', db.drawings, db.opQueue, async () => {
		const row = await drawingById(db, id);
		if (row === undefined) throw new Error(`no drawing ${id}`);
		const back = { ...row, deletedLocally: 0 as const, dirty: 1 as const };
		await db.drawings.put(back);
		await queueRestore(db, back);
	});

const remote = (path: string, id = 'r1', version = 'v1'): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'file',
	version,
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

describeSyncStoreContract('Dexie', DRAW_FORMAT, async () => {
	const db = freshDatabase();
	const store = await boundStore(db, { connectionId: CONNECTION });
	return {
		store,
		seed: async (drawing) => {
			await db.drawings.put({
				...drawingRecordFromFile({
					id: drawing.id,
					connectionId: CONNECTION,
					path: drawing.path,
					source: drawing.content,
					hash: await contentHash(drawing.content),
					now: 0,
				}),
				...(drawing.remoteId === undefined ? {} : { remoteId: drawing.remoteId }),
				...(drawing.remoteVersion === undefined
					? {}
					: { remoteVersion: drawing.remoteVersion }),
				...(drawing.syncedHash === undefined ? {} : { syncedHash: drawing.syncedHash }),
				dirty: drawing.dirty === true ? 1 : 0,
			});
		},
		seedElsewhere: async (id) => {
			await db.drawings.put(
				drawingRecordFromFile({
					id,
					connectionId: 'elsewhere',
					path: 'theirs.svg',
					source: 'theirs\n',
					hash: await contentHash('theirs\n'),
					now: 0,
				})
			);
		},
		seedFolder: async (folder) => {
			await db.folders.put({ ...folderRow(CONNECTION, folder.path, 0), ...folder });
		},
		seedFile: async (file, held) => {
			await db.files.put({ connectionId: CONNECTION, ...file });
			if (held === undefined) return;
			await db.fileBytes.put({
				connectionId: CONNECTION,
				id: file.id,
				bytes: held.bytes.slice().buffer,
				...(held.version === undefined ? {} : { version: held.version }),
				pinned: held.pinned === true ? 1 : 0,
				lastUsedAt: 0,
			});
		},
		dropFile: async (id) => {
			await db.files.delete([CONNECTION, id]);
			await db.fileBytes.delete([CONNECTION, id]);
		},
		seedOp: async (op) => {
			// In the app a queued delete always comes with its tombstone:
			// `deleteDrawing` makes the one and the push queue the other.
			if (op.op === 'delete') {
				await updateDrawing(db, op.noteId, { deletedLocally: 1, dirty: 1 });
			}
			return db.opQueue.add({
				connectionId: CONNECTION,
				attempts: 0,
				queuedAt: 0,
				...queuedRow(op),
			});
		},
		withdrawOp: (seq) => db.opQueue.delete(seq),
	};
});

describe('the Dexie sync store, beyond the contract', () => {
	it('reads only the drawings beneath a folder, and none whose path only starts like it', async () => {
		// The engine asks once or more for every drawing a round names, and a read
		// of the whole table each time cost a round the drawings it moved times the
		// drawings held. `Work 2` and `Work.svg` sort just before `Work/`, and
		// `Workshop` just after where it ends.
		const db = freshDatabase();
		const read = { drawings: 0 };
		db.use({
			stack: 'dbcore',
			name: 'rowsRead',
			create: (down) => ({
				...down,
				table: (name) => {
					const table = down.table(name);
					if (name !== 'drawings') return table;
					return {
						...table,
						query: async (req) => {
							const answer = await table.query(req);
							read.drawings += answer.result.length;
							return answer;
						},
					};
				},
			}),
		});
		const store = await boundStore(db, { connectionId: CONNECTION });
		const seed = async (id: string, path: string, connectionId = CONNECTION) => {
			await db.drawings.put(
				drawingRecordFromFile({
					id,
					connectionId,
					path,
					source: 'x\n',
					hash: await contentHash('x\n'),
					now: 0,
				})
			);
		};
		await seed('n3', 'Work/a.svg');
		await seed('n1', 'Work/Deep/b.svg');
		await seed('n2', 'Work/c.svg');
		await seed('o1', 'Work 2/d.svg');
		await seed('o2', 'Work.svg');
		await seed('o3', 'Workshop/e.svg');
		await seed('o4', 'Work0/f.svg');
		await seed('o5', 'loose.svg');
		await seed('o6', 'Work/a.svg', 'elsewhere');
		await deleteDrawing(db, 'n2', { connectionId: CONNECTION });

		read.drawings = 0;
		const under = await store.notesUnder('Work');
		// In id order, as the whole-table read gave them; the tombstone too.
		expect(under.map((drawing) => drawing.id)).toEqual(['n1', 'n2', 'n3']);
		expect(read.drawings).toBe(3);

		expect((await store.notesUnder('Work/')).map((drawing) => drawing.id)).toEqual([
			'n1',
			'n2',
			'n3',
		]);
		expect((await store.notesUnder('Work/Deep')).map((drawing) => drawing.id)).toEqual(['n1']);
		expect(await store.notesUnder('Wor')).toEqual([]);
		expect((await store.notesUnder('')).map((drawing) => drawing.id).sort()).toEqual([
			'n1',
			'n2',
			'n3',
			'o1',
			'o2',
			'o3',
			'o4',
			'o5',
		]);
	});

	it('lists the files it could not read on the connection’s own row, and leaves the rest of the row alone', async () => {
		// The storage panel reads the row, so that is where the list has to be;
		// and the row is also the token, the root and the account's name, which a
		// careless `put` here would take with it.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await db.syncState.update(CONNECTION, { rootId: 'root', displayName: 'ada@example.com' });
		await db.syncState.put({ connectionId: 'elsewhere', clientId: 'this-browser' });
		const before = await db.syncState.get(CONNECTION);

		await store.applyChanges({
			changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'Work/old.svg' } }],
			cursor: 'c1',
		});

		expect(await db.syncState.get(CONNECTION)).toEqual({
			...before,
			cursor: 'c1',
			unreadable: [{ remoteId: 'r1', path: 'Work/old.svg' }],
		});
		expect((await db.syncState.get('elsewhere'))?.unreadable).toBeUndefined();

		await store.applyChanges({ changes: [{ kind: 'forget-unreadable', remoteId: 'r1' }] });

		// Absent, not empty: the row as it was before it ever listed one.
		expect(await db.syncState.get(CONNECTION)).toEqual({ ...before, cursor: 'c1' });
	});

	it('hands the engine a pulled file byte for byte, not re-serialized', async () => {
		// A file another tool wrote spells its markup its own way. Re-serializing
		// it would give the engine bytes the remote never had — a change nobody
		// made.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const file =
			"<?xml version='1.0'?>\r\n<svg xmlns='http://www.w3.org/2000/svg' ><title>Shopping</title>\r\n<rect/></svg>";

		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Shopping.svg',
					content: file,
					remote: remote('Shopping.svg'),
					syncedHash: 'hash',
				},
			],
		});

		expect((await store.noteById('n1'))?.content).toBe(file);
		const row = await drawingById(db, 'n1');
		expect(row?.title).toBe('Shopping');
		expect(row?.text).toBe(file);
		expect(row?.contentHash).toBe(await contentHash(file));
	});

	it('hands the engine what an edit here serialized to, not what was pulled', async () => {
		// The other half of the same field. A push that sent the pulled bytes
		// after the user edited would put the old drawing back on the remote.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'before\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
			],
		});

		await saveDrawing(db, 'n1', svgOf('after'), { connectionId: CONNECTION });

		const drawing = await store.noteById('n1');
		expect(drawing?.dirty).toBe(true);
		expect(drawing?.content).toBe((await drawingById(db, 'n1'))?.text);
		expect(drawing?.content).toContain('<desc>after</desc>');
	});

	it('answers for drawings the app created before anything was pulled', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const created = await createDrawing(db, { connectionId: CONNECTION, text: svgOf('hello') });

		expect((await store.noteById(created.id))?.content).toBe(created.text);
	});

	it('finds the live drawing at a path a tombstone still holds', async () => {
		// The app lets a new drawing take a name a deleted one has not given up yet.
		// A file arriving at that path written into the tombstone is purged with
		// it by the queued delete — taking the file on the remote too.
		//
		// Both orders, because IndexedDB hands the two rows back in the order of
		// their ids, and a store that took the first one would pass with the
		// tombstone sorting second.
		for (const [goneId, liveId] of [
			['a-gone', 'b-live'],
			['b-gone', 'a-live'],
		] as const) {
			const db = freshDatabase();
			const store = await boundStore(db, { connectionId: CONNECTION });
			const row = (id: string) =>
				drawingRecordFromFile({
					id,
					connectionId: CONNECTION,
					path: 'Plans.svg',
					source: 'x\n',
					hash: '',
					now: 0,
				});
			await db.drawings.bulkPut([
				{ ...row(goneId), remoteId: 'r1', deletedLocally: 1, dirty: 1 },
				row(liveId),
			]);

			expect((await store.noteByPath('Plans.svg'))?.id).toBe(liveId);
		}
	});

	it('lets a drawing created here take the name of one deleted but not yet pushed', async () => {
		// Which is how the app comes to hold two rows at one path at all.
		const db = freshDatabase();
		const gone = await createDrawing(db, { connectionId: CONNECTION, title: 'Plans' });
		await deleteDrawing(db, gone.id, { connectionId: CONNECTION });
		const live = await createDrawing(db, { connectionId: CONNECTION, title: 'Plans' });

		expect(live.path).toBe(gone.path);
	});

	it('keeps what a pull cannot know about a drawing it rewrites', async () => {
		// When it was first seen here, and above all
		// that the user deleted it: §7 has the delete win, and the op behind it
		// purges the row the pull wrote back.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'x\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
			],
		});
		await updateDrawing(db, 'n1', { createdAt: 42, deletedLocally: 1 });

		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'y\n',
					remote: remote('a.svg', 'r1', 'v2'),
					syncedHash: 'hash',
				},
			],
		});

		const row = await drawingById(db, 'n1');
		expect(row?.text).toBe('y\n');
		expect(row?.createdAt).toBe(42);
		expect(row?.deletedLocally).toBe(1);
	});

	it('leaves a drawing the user deleted to its delete, when a rescan asks for a reupload', async () => {
		// A tombstone is reported clean — `isDirty` says so, because reported
		// dirty it would meet a remote change as a conflict and come back in the
		// sidebar holding text the user deleted. So the engine names it for
		// reupload rather than `detach-drawing`, and forgetting the remote here
		// would take the `remoteId` its queued delete is addressed by: the
		// delete would purge the row with nothing removed, and the file would
		// come back on the next pull. It owes the remote its delete and nothing
		// else. There is no tombstone in the memory store, so this cannot live
		// in the shared contract.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'x\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
			],
		});
		await deleteDrawing(db, 'n1');
		const queued = await store.pendingOps();

		await store.applyChanges({ changes: [{ kind: 'reupload-note', id: 'n1' }] });

		const row = await drawingById(db, 'n1');
		expect(row?.deletedLocally).toBe(1);
		expect(row?.remoteId).toBe('r1');
		// And no write behind the delete: the ops are the ones the delete left.
		expect(await store.pendingOps()).toEqual(queued);
	});

	it('keeps a folder’s remote id when an ensure-folder does not carry one', async () => {
		const db = freshDatabase();
		// A clock that moves on every call, so a row written twice cannot keep its
		// first time by landing in the same millisecond.
		const clock = { at: 0 };
		const store = await boundStore(db, {
			connectionId: CONNECTION,
			now: () => {
				clock.at += 1;
				return clock.at;
			},
		});
		await store.applyChanges({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});

		const first = await db.folders.get([CONNECTION, 'Work']);

		await store.applyChanges({ changes: [{ kind: 'ensure-folder', path: 'Work' }] });

		expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
		expect((await db.folders.get([CONNECTION, 'Work']))?.createdAt).toBe(first?.createdAt);
	});

	it('makes no row for the app folder itself', async () => {
		// A row for the root is reconciled away after the next cursor reset as a
		// folder the scan did not mention — and every path is within the root.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [{ kind: 'ensure-folder', path: '', remoteId: 'root' }],
		});

		expect(await db.folders.count()).toBe(0);
	});

	it('does nothing for a folder deletion where it holds no folder', async () => {
		// The contract's promise, and the one a store that cascaded anyway would
		// break: the drawings here are not under a folder this store knows about.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await db.drawings.put({
			...drawingRecordFromFile({
				id: 'n1',
				connectionId: CONNECTION,
				path: 'Work/a.svg',
				source: 'x\n',
				hash: '',
				now: 0,
			}),
			remoteId: 'r1',
		});

		await store.applyChanges({
			changes: [{ kind: 'delete-folder', path: 'Work' }],
			cursor: 'c1',
		});

		expect(await store.noteById('n1')).toBeDefined();
		expect(await store.cursor()).toBe('c1');
	});

	it('refuses a conflict copy whose id is already a drawing, and changes nothing', async () => {
		// The engine promises a fresh id. Writing the copy over a drawing that holds
		// it would be losing one drawing to save another.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'mine\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
				{
					kind: 'upsert-note',
					id: 'n2',
					path: 'b.svg',
					content: 'other\n',
					remote: remote('b.svg', 'r2'),
					syncedHash: 'hash',
				},
			],
			cursor: 'c1',
		});

		await expect(
			store.applyChanges({
				changes: [
					{
						kind: 'conflict',
						resolution: {
							noteId: 'n1',
							remoteContent: 'theirs\n',
							remoteHash: 'hash',
							remote: remote('a.svg', 'r1', 'v2'),
							copyId: 'n2',
							copyPath: 'a (conflict).svg',
							copyContent: 'mine\n',
						},
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow();

		expect((await store.noteById('n1'))?.content).toBe('mine\n');
		expect((await store.noteById('n2'))?.content).toBe('other\n');
		expect(await store.cursor()).toBe('c1');
	});

	it('sees nothing that belongs to another connection', async () => {
		const db = freshDatabase();
		const mine = await boundStore(db, { connectionId: CONNECTION });
		const theirs = await boundStore(db, { connectionId: 'other' });
		await theirs.applyChanges({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.svg',
					content: 'x\n',
					remote: remote('Work/a.svg'),
					syncedHash: 'hash',
				},
			],
			cursor: 'theirs',
		});
		const other = await db.opQueue.add({
			connectionId: 'other',
			op: 'write',
			drawingId: 'n1',
			path: 'Work/a.svg',
			attempts: 0,
			queuedAt: 0,
		});

		expect(await mine.cursor()).toBeUndefined();
		expect(await mine.noteById('n1')).toBeUndefined();
		expect(await mine.noteByPath('Work/a.svg')).toBeUndefined();
		expect(await mine.noteByRemoteId('r1')).toBeUndefined();
		expect(await mine.allNotes()).toEqual([]);
		expect(await mine.notesUnder('')).toEqual([]);
		expect(await mine.folderByPath('Work')).toBeUndefined();
		expect(await mine.folderByRemoteId('f1')).toBeUndefined();
		expect(await mine.foldersWithRemote()).toEqual([]);
		expect(await mine.pendingOps()).toEqual([]);
		await expect(mine.failOp(other, 'nope')).rejects.toThrow();

		// And a change about a drawing it does not own leaves that drawing alone.
		await mine.applyChanges({
			changes: [
				{ kind: 'delete-note', id: 'n1' },
				{ kind: 'delete-folder', path: 'Work' },
			],
		});
		expect(await theirs.noteById('n1')).toBeDefined();
		expect(await theirs.folderByPath('Work')).toBeDefined();

		// Nor does a folder move of its own reach the other account's queue.
		await mine.applyChanges({
			changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive' }],
		});
		expect((await theirs.pendingOps()).map((op) => op.path)).toEqual(['Work/a.svg']);
		expect((await theirs.noteById('n1'))?.path).toBe('Work/a.svg');
	});

	it('keeps the client id a connection already has when it stores a cursor', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await db.syncState.put({
			connectionId: CONNECTION,
			clientId: 'this-browser',
			rootId: 'root',
		});

		await store.applyChanges({ changes: [], cursor: 'c1' });

		expect(await db.syncState.get(CONNECTION)).toEqual({
			connectionId: CONNECTION,
			clientId: 'this-browser',
			rootId: 'root',
			cursor: 'c1',
		});
	});
});

/** A store with one clean drawing pulled into it, as the engine would leave it. */
const pulled = async (content = 'x\n') => {
	const db = freshDatabase();
	const store = await boundStore(db, { connectionId: CONNECTION });
	await store.applyChanges({
		changes: [
			{
				kind: 'upsert-note',
				id: 'n1',
				path: 'a.svg',
				content,
				remote: remote('a.svg'),
				syncedHash: 'hash',
			},
		],
		cursor: 'c1',
	});
	return { db, store };
};

describe('a pull that lands after the user has typed', () => {
	// The engine reads the drawing clean, goes to the network, and hands the batch
	// over afterward. An autosave can land in that window.
	it('is refused rather than overwriting the edit and calling the drawing clean', async () => {
		const { db, store } = await pulled();
		await saveDrawing(db, 'n1', svgOf('typed meanwhile'), { connectionId: CONNECTION });

		await expect(
			store.applyChanges({
				changes: [
					{
						kind: 'upsert-note',
						id: 'n1',
						path: 'a.svg',
						content: 'v2\n',
						remote: remote('a.svg', 'r1', 'v2'),
						syncedHash: 'hash',
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow();

		const row = await drawingById(db, 'n1');
		expect(row?.text).toContain('typed meanwhile');
		expect(row?.dirty).toBe(1);
		expect(await store.cursor()).toBe('c1');
	});

	it('is refused rather than deleting the drawing that was typed into', async () => {
		const { db, store } = await pulled();
		await saveDrawing(db, 'n1', svgOf('typed meanwhile'), { connectionId: CONNECTION });

		await expect(
			store.applyChanges({ changes: [{ kind: 'delete-note', id: 'n1' }] })
		).rejects.toThrow();
		expect((await drawingById(db, 'n1'))?.text).toContain('typed meanwhile');
	});

	it('makes the conflict copy from what was typed, not from what was read', async () => {
		const { db, store } = await pulled();
		const before = (await store.noteById('n1'))?.content ?? '';
		await saveDrawing(db, 'n1', svgOf('typed meanwhile'), { connectionId: CONNECTION });

		await store.applyChanges({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n1',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('a.svg', 'r1', 'v2'),
						copyId: 'c1',
						copyPath: 'a (conflict).svg',
						copyContent: conflictContent(before, 'c1'),
					},
				},
			],
		});

		const copy = await drawingById(db, 'c1');
		expect(copy?.text).toBe(conflictContent(svgOf('typed meanwhile', 'n1'), 'c1'));
		// Hashed inside the transaction, since it was not known up front.
		expect(copy?.contentHash).toBe(await contentHash(copy?.text ?? ''));
	});
});

describe('another connection’s drawing under the same id', () => {
	it('is another row: a drawing written here under that id leaves it as it was', async () => {
		// Ids live in the file, so a folder reconnected under a new
		// connection while the old rows are still here names every one of them.
		// Keyed by id alone, this write either took the other drawing over, unpushed
		// edits and all, or had to be refused — and a refused batch is retried
		// for ever.
		const db = freshDatabase();
		const theirs = await createDrawing(db, { connectionId: 'other', text: svgOf('unpushed') });
		const store = await boundStore(db, { connectionId: CONNECTION });

		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: theirs.id,
					path: 'a.svg',
					content: 'remote\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
			],
		});

		expect(await db.drawings.get(['other', theirs.id])).toEqual(theirs);
		expect((await db.drawings.get([CONNECTION, theirs.id]))?.text).toBe('remote\n');
	});

	it('is left alone by every other change and outcome that names it', async () => {
		const db = freshDatabase();
		const theirs = await boundStore(db, { connectionId: 'other' });
		const mine = await boundStore(db, { connectionId: CONNECTION });
		await theirs.applyChanges({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.svg',
					content: 'x\n',
					remote: remote('Work/a.svg'),
					syncedHash: 'hash',
				},
			],
		});
		const seq = await db.opQueue.add({
			connectionId: 'other',
			op: 'delete',
			drawingId: 'n1',
			path: 'Work/a.svg',
			attempts: 0,
			queuedAt: 0,
		});

		await mine.applyChanges({
			changes: [
				{ kind: 'detach-note', id: 'n1' },
				{ kind: 'displace-note', id: 'n1', path: 'moved.svg' },
				{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f9' },
			],
		});
		await expect(mine.completeOp(seq, { kind: 'purged', noteId: 'n1' })).rejects.toThrow();
		await expect(
			mine.resolveConflict(seq, {
				noteId: 'n1',
				remoteContent: 'y\n',
				remoteHash: 'hash',
				remote: remote('Work/a.svg'),
				copyId: 'c1',
				copyPath: 'c.svg',
				copyContent: conflictContent('x\n', 'c1'),
			})
		).rejects.toThrow();

		const drawing = await theirs.noteById('n1');
		expect(drawing?.path).toBe('Work/a.svg');
		expect(drawing?.remoteId).toBe('r1');
		expect((await theirs.folderByPath('Work'))?.remoteId).toBe('f1');
		expect(await theirs.folderByPath('Archive')).toBeUndefined();

		// Even an op of this connection's own that names the other's drawing.
		const own = await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'delete',
			drawingId: 'n1',
			path: 'Work/a.svg',
			attempts: 0,
			queuedAt: 0,
		});
		await mine.completeOp(own, { kind: 'purged', noteId: 'n1' });
		expect(await theirs.noteById('n1')).toMatchObject({ remoteId: 'r1', dirty: false });
		expect((await theirs.pendingOps()).map((op) => op.seq)).toEqual([seq]);
		expect(await mine.opBySeq(seq)).toBeUndefined();
		expect(await theirs.opBySeq(seq)).toMatchObject({ seq, op: 'delete' });
	});
});

describe('two connected sources holding one drawing id', () => {
	// Reached with no mistake on the user's part: connect X, disconnect, connect
	// Y answering "copy" — the rows keep their ids, so Y's files carry them —
	// and connect X again as a second source. Or one folder in two clouds.
	const twoSources = async () => {
		const db = freshDatabase();
		const theirs = await createDrawing(db, {
			connectionId: 'c-y',
			text: svgOf('unpushed in y'),
		});
		const store = await boundStore(db, { connectionId: 'c-x' });
		const provider = createFakeProvider();
		await provider.ensureRoot();
		const engine = createSyncEngine({
			document: DRAW_FORMAT,
			syncsHidden,
			provider,
			store,
			now: () => new Date('2026-09-15T14:32:00Z'),
		});
		const file = svgOf('as x has it', theirs.id);
		const entry = await provider.write('a.svg', file, {});
		return { db, theirs, store, provider, engine, file, entry };
	};

	it('pulls the file under the id it names, and leaves the other source’s drawing alone', async () => {
		const { db, theirs, store, engine, file, entry } = await twoSources();

		const result = await engine.pull();

		expect(result.status).toBe('ok');
		expect(await store.cursor()).toBeDefined();
		expect(await db.drawings.get(['c-y', theirs.id])).toEqual(theirs);
		expect(theirs.dirty).toBe(1);
		const mine = await drawingsOf(db, 'c-x');
		expect(mine).toHaveLength(1);
		// The same id, as the file says: two sources, two drawings, one name each.
		expect(mine[0]?.id).toBe(theirs.id);
		expect(mine[0]?.remoteId).toBe(entry.remoteId);
		expect(mine[0]?.text).toBe(file);

		const again = await engine.pull();
		expect(again.status).toBe('ok');
		expect(await drawingsOf(db, 'c-x')).toEqual(mine);
		expect(await db.drawings.count()).toBe(2);
	});

	it('is not in the way of a drawing the other source has deleted and not yet purged', async () => {
		const { db, theirs, engine } = await twoSources();
		await deleteDrawing(db, theirs.id, { connectionId: 'c-y' });
		const tombstone = await db.drawings.get(['c-y', theirs.id]);
		expect(tombstone?.deletedLocally).toBe(1);

		expect((await engine.pull()).status).toBe('ok');

		expect(await db.drawings.get(['c-y', theirs.id])).toEqual(tombstone);
		expect(await drawingsOf(db, 'c-x')).toHaveLength(1);
	});

	it('keeps the id in the file across an edit, which no longer flips between the two', async () => {
		const { db, theirs, provider, engine } = await twoSources();
		await engine.pull();

		await saveDrawing(db, theirs.id, svgOf('edited in x'), { connectionId: 'c-x' });
		expect((await engine.sync()).status).toBe('ok');

		expect(provider.contentAt('a.svg')).toContain(`draw:id="${theirs.id}"`);
		expect(provider.contentAt('a.svg')).toContain('edited in x');
		expect((await db.drawings.get(['c-x', theirs.id]))?.dirty).toBe(0);
		expect(await db.drawings.get(['c-y', theirs.id])).toEqual(theirs);
	});
});

describe('a drawing deleted here', () => {
	it('stays deleted when the remote changed it meanwhile, end to end', async () => {
		// `deleteDrawing` marks the row dirty. Handed to the engine that way, a
		// remote change is a conflict, and its copy is a new live drawing holding
		// the text the user deleted — back in the sidebar and on the remote.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const provider = createFakeProvider();
		await provider.ensureRoot();
		const engine = createSyncEngine({
			document: DRAW_FORMAT,
			syncsHidden,
			provider,
			store,
			now: () => new Date('2026-09-15T14:32:00Z'),
		});
		const entry = await provider.write('a.svg', svgOf('one', 'n1'), {});
		expect((await engine.sync()).status).toBe('ok');
		const [drawing] = await drawingsOf(db, CONNECTION);
		if (drawing === undefined) throw new Error('the pulled drawing is missing');

		await deleteDrawing(db, drawing.id, { connectionId: CONNECTION });
		await provider.write('a.svg', svgOf('theirs', 'n1'), { expectedVersion: entry.version });

		const result = await engine.sync();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(await db.drawings.count()).toBe(0);
		expect(provider.contentAt('a.svg')).toBeUndefined();
	});

	it('is kept, cut loose from its file, when restored before its delete landed', async () => {
		const { db, store } = await pulled();
		await deleteDrawing(db, 'n1');
		// Read by the engine, and at the network, when the user restores it.
		const [remove] = await store.pendingOps();
		await restored(db, 'n1');

		await store.completeOp(remove?.seq ?? -1, { kind: 'purged', noteId: 'n1' });

		const row = await drawingById(db, 'n1');
		expect(row?.deletedLocally).toBe(0);
		expect(row?.remoteId).toBeUndefined();
		expect(row?.dirty).toBe(1);
		// The file is gone, so the drawing is owed one: exactly one.
		expect(await store.pendingOps()).toMatchObject([{ op: 'write', noteId: 'n1' }]);
	});

	it('goes when the remote deletes it too', async () => {
		// Marked dirty by `deleteDrawing`, clean to the engine — so the engine
		// decides a plain delete, and a store that checked the raw flag would
		// refuse that batch on every pull, for ever.
		const { db, store } = await pulled();
		await deleteDrawing(db, 'n1');

		await store.applyChanges({ changes: [{ kind: 'delete-note', id: 'n1' }], cursor: 'c2' });

		expect(await drawingById(db, 'n1')).toBeUndefined();
		expect(await store.cursor()).toBe('c2');
	});

	it('makes no conflict copy when a write queued before the delete meets a remote change', async () => {
		// The push side of the delete winning. The write reaches the provider
		// first, finds the file changed, and the conflict lands on a drawing that
		// has been deleted since. A copy would be a live drawing holding the text
		// the user deleted, queued to be written back to the remote.
		//
		// The delete also withdraws every write queued for the drawing, this one
		// included — it is at the network, so only its queue row goes. So the
		// resolution arrives for an op that is no longer queued, which is the
		// other half of what this pins.
		const { db, store } = await pulled();
		await saveDrawing(db, 'n1', svgOf('edited then deleted'), { connectionId: CONNECTION });
		const [write] = await store.pendingOps();
		const read = (await store.noteById('n1'))?.content ?? '';
		// A second write, owed to an edit made while the first was in flight.
		await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'write',
			drawingId: 'n1',
			path: 'a.svg',
			attempts: 0,
			queuedAt: 0,
		});
		await deleteDrawing(db, 'n1');
		const remove = (await db.opQueue.toArray()).find((op) => op.op === 'delete')?.seq;

		await store.resolveConflict(write?.seq ?? -1, {
			noteId: 'n1',
			remoteContent: 'theirs\n',
			remoteHash: 'hash',
			remote: remote('a.svg', 'r1', 'v2'),
			copyId: 'c1',
			copyPath: 'a (conflict).svg',
			copyContent: conflictContent(read, 'c1'),
		});

		expect(await drawingById(db, 'c1')).toBeUndefined();
		expect((await store.pendingOps()).map((op) => op.seq)).toEqual([remove]);
		const row = await drawingById(db, 'n1');
		expect(row?.deletedLocally).toBe(1);
		expect(row?.remoteVersion).toBe('v2');
	});

	it('goes with its folder when the folder is deleted remotely', async () => {
		// Clean to the engine, so clean to the cascade too. Kept as though it
		// held unpushed writing, it would be detached and left behind — a live
		// row for a drawing the user deleted, with nothing left to purge it.
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' },
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'Work/a.svg',
					content: 'x\n',
					remote: remote('Work/a.svg'),
					syncedHash: 'hash',
				},
			],
		});
		await deleteDrawing(db, 'n1');

		await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

		expect(await drawingById(db, 'n1')).toBeUndefined();
	});

	it('is clean as far as a pull is concerned, and written back clean', async () => {
		const { db, store } = await pulled();
		await deleteDrawing(db, 'n1');
		expect((await store.noteById('n1'))?.dirty).toBe(false);

		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'v2\n',
					remote: remote('a.svg', 'r1', 'v2'),
					syncedHash: 'hash',
				},
			],
		});

		const row = await drawingById(db, 'n1');
		expect(row?.dirty).toBe(0);
		expect(row?.deletedLocally).toBe(1);
	});
});

describe('where a change puts a drawing', () => {
	it('makes the folders above every path a change puts a drawing at', async () => {
		const { db, store } = await pulled();
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n2',
					path: 'b.svg',
					content: 'b\n',
					remote: remote('b.svg', 'r2'),
					syncedHash: 'hash',
				},
				{
					kind: 'upsert-note',
					id: 'n3',
					path: 'c.svg',
					content: 'c\n',
					remote: remote('c.svg', 'r3'),
					syncedHash: 'hash',
				},
				{
					kind: 'move-note',
					id: 'n1',
					path: 'Moved/a.svg',
					remote: remote('Moved/a.svg'),
				},
				{ kind: 'displace-note', id: 'n2', path: 'Displaced/b.svg' },
				{ kind: 'ensure-folder', path: 'Deep/Er/Est', remoteId: 'f1' },
			],
		});
		await updateDrawing(db, 'n3', { dirty: 1 });
		const content = (await store.noteById('n3'))?.content ?? '';
		await store.applyChanges({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n3',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('Remote/c.svg', 'r3', 'v2'),
						copyId: 'copy',
						copyPath: 'Copies/c (conflict).svg',
						copyContent: conflictContent(content, 'copy'),
					},
				},
			],
		});

		const folders = (await db.folders.toArray()).map((folder) => folder.path).sort();
		expect(folders).toEqual([
			'Copies',
			'Deep',
			'Deep/Er',
			'Deep/Er/Est',
			'Displaced',
			'Moved',
			'Remote',
		]);
		// The remote takes the path it claims.
		expect((await store.noteById('n3'))?.path).toBe('Remote/c.svg');
	});

	it('keeps what the app knows about a drawing the remote wins a conflict over', async () => {
		const { db, store } = await pulled();
		await updateDrawing(db, 'n1', { createdAt: 42 });
		await saveDrawing(db, 'n1', svgOf('mine'), { connectionId: CONNECTION });
		const content = (await store.noteById('n1'))?.content ?? '';

		await store.applyChanges({
			changes: [
				{
					kind: 'conflict',
					resolution: {
						noteId: 'n1',
						remoteContent: 'theirs\n',
						remoteHash: 'hash',
						remote: remote('a.svg', 'r1', 'v2'),
						copyId: 'copy',
						copyPath: 'a (conflict).svg',
						copyContent: conflictContent(content, 'copy'),
					},
				},
			],
		});

		const row = await drawingById(db, 'n1');
		expect(row?.createdAt).toBe(42);
		expect(row?.dirty).toBe(0);
	});

	it('records where a move landed, and a moved folder’s new remote id', async () => {
		const { db, store } = await pulled();
		const seq = await db.opQueue.add({
			connectionId: CONNECTION,
			op: 'move',
			drawingId: 'n1',
			path: 'a.svg',
			targetPath: 'b.svg',
			attempts: 0,
			queuedAt: 0,
		});
		await store.completeOp(seq, {
			kind: 'moved',
			noteId: 'n1',
			remote: remote('b.svg', 'r1', 'v2'),
		});
		expect((await store.noteById('n1'))?.path).toBe('b.svg');

		await store.applyChanges({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});
		await store.applyChanges({
			changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f2' }],
		});
		expect((await store.folderByPath('Archive'))?.remoteId).toBe('f2');
	});

	it('writes nothing for a connection the device has let go of', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [{ kind: 'ensure-folder', path: 'Work', remoteId: 'f1' }],
		});
		await db.syncState.clear();

		await expect(
			store.applyChanges({
				changes: [
					{
						kind: 'upsert-note',
						id: 'n1',
						path: 'Work/a.svg',
						content: 'x\n',
						remote: remote('Work/a.svg'),
						syncedHash: 'hash',
					},
				],
				cursor: 'c2',
			})
		).rejects.toThrow(UnboundConnectionError);

		expect(await db.syncState.count()).toBe(0);
		expect(await db.drawings.count()).toBe(0);
	});

	it('deletes nothing for a resumed connection until its remote is checked', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		await store.applyChanges({
			changes: [
				{
					kind: 'upsert-note',
					id: 'n1',
					path: 'a.svg',
					content: 'x\n',
					remote: remote('a.svg'),
					syncedHash: 'hash',
				},
			],
		});
		// What a scan of an emptied app folder would say, before `verifyResume`.
		await db.syncState.update(CONNECTION, { resumeUnverified: true });

		await expect(
			store.applyChanges({ changes: [{ kind: 'delete-note', id: 'n1' }], cursor: 'c2' })
		).rejects.toThrow(UnverifiedResumeError);

		expect(await db.drawings.count()).toBe(1);
		expect((await db.syncState.get(CONNECTION))?.cursor).toBeUndefined();
	});
});

describe('a queued op read back (skysa-notes #447)', () => {
	/** A row as the queue stores it, written straight to the table. */
	const queued = async (db: DrawDatabase, row: Record<string, unknown>): Promise<number> =>
		db.opQueue.add({
			connectionId: CONNECTION,
			attempts: 0,
			queuedAt: 0,
			...row,
		} as unknown as OpQueueRecord);

	it('reads every kind as 1.0 queued it as the op it is', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const rows = [
			{ op: 'write', drawingId: 'n1', path: 'a.svg' },
			{ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' },
			{ op: 'delete', drawingId: 'n2', path: 'c.svg' },
			{ op: 'mkdir', path: 'Work' },
			{ op: 'rmdir', path: 'Old', remoteId: 'f1' },
			{ op: 'rmdir', path: 'Never' },
			{ op: 'upload', fileId: 'x1', path: 'a.png' },
			{ op: 'upload', fileId: 'x2', path: 'b.png', copyOf: 'r9' },
			{ op: 'move-file', fileId: 'x1', path: 'a.png', targetPath: 'Trips/a.png' },
			{ op: 'delete-file', path: 'c.png', remoteId: 'r3' },
		];
		for (const row of rows) await queued(db, { ...row, lastError: 'kept', attempts: 2 });

		const ops = await store.pendingOps();

		// Under the port's names: a row's `drawingId` is the op's `noteId` (`QueuedOp`).
		expect(ops).toEqual(
			rows.map(({ drawingId, ...row }: Record<string, unknown>, at) => ({
				...row,
				...(drawingId === undefined ? {} : { noteId: drawingId }),
				seq: at + 1,
				attempts: 2,
			}))
		);
	});

	it('reads a row that fits no kind as malformed, and the rest as they are', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, { connectionId: CONNECTION });
		const lost = await queued(db, { op: 'move', drawingId: 'n1', path: 'a.svg', attempts: 1 });
		const later = await queued(db, { op: 'teleport', path: 'b.svg' });
		await queued(db, { op: 'write', drawingId: 'n1', path: 'a.svg' });

		const ops = await store.pendingOps();

		expect(ops).toEqual([
			{
				op: 'malformed',
				seq: lost,
				path: 'a.svg',
				attempts: 1,
				problem: expect.stringContaining('targetPath') as unknown,
			},
			{
				op: 'malformed',
				seq: later,
				path: 'b.svg',
				attempts: 0,
				problem: expect.stringContaining('teleport') as unknown,
			},
			{ op: 'write', seq: later + 1, noteId: 'n1', path: 'a.svg', attempts: 0 },
		]);
		expect(await store.opBySeq(lost)).toMatchObject({ op: 'malformed' });
		// Kept, for the engine to fail and the user to be told of.
		expect(await db.opQueue.count()).toBe(3);
	});
});
