import { createSyncEngine } from '@skysa/draw-core';
import { createFakeProvider } from '@skysa/draw-core/testing';
import { describe, expect, it } from 'vitest';

import { bindConnection, verifyResume } from '../../src/store/connection.js';
import type { DrawDatabase, DrawingRecord } from '../../src/store/db.js';
import {
	createDrawing,
	deleteDrawing,
	drawingRecordFromFile,
	renameDrawing,
	saveDrawing,
} from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { MAX_OP_ATTEMPTS, queueUpload, queueWrite } from '../../src/store/queue.js';
import {
	countOf,
	isEmpty,
	movable,
	seenIn,
	unseenIn,
	type Unsynced,
	unsyncedIn,
} from '../../src/store/unsynced.js';
import { createDexieSyncStore } from '../../src/sync/store.js';
import { freshDatabase } from '../support/db.js';
import { fileAdded, folderOf, importedFile, svgOf } from '../support/drawingRows.js';

/**
 * What a source holds that its remote has not been sent. Made with the app's
 * own writers wherever there is one, so that what is asserted is the state the
 * app really leaves behind and not one a test imagined.
 */

const CONNECTION = 'dropbox-1';
const OTHER = 'gdrive-2';
const scope = { connectionId: CONNECTION };

/** A drawing as a pull leaves it: clean, with a file on the remote, and nothing queued. */
const pushedDrawing = (
	db: DrawDatabase,
	path: string,
	options: { connectionId?: string; id?: string } = {}
): Promise<DrawingRecord> =>
	importedFile(db, {
		connectionId: options.connectionId ?? CONNECTION,
		path,
		source: `# ${path}\n`,
		...(options.id === undefined ? {} : { id: options.id }),
		remoteId: `r-${options.connectionId ?? CONNECTION}-${path}`,
		remoteVersion: 'v1',
	});

/** Every category by the paths in it, which is what a person would check by. */
const summary = (unsynced: Unsynced) => ({
	drawings: unsynced.drawings.map((drawing) => drawing.path).sort(),
	renames: unsynced.renames.map((drawing) => drawing.path).sort(),
	deletes: unsynced.deletes.map((drawing) => drawing.path).sort(),
	folders: unsynced.folders.map((folder) => folder.path).sort(),
	rmdirs: unsynced.rmdirs.map((op) => op.path).sort(),
	files: unsynced.files.map((file) => file.path).sort(),
	portable: unsynced.portable.map((file) => file.path).sort(),
	linked: unsynced.linked.map((file) => file.path).sort(),
	blocked: unsynced.blocked,
});

const NOTHING = {
	drawings: [],
	renames: [],
	deletes: [],
	folders: [],
	rmdirs: [],
	files: [],
	portable: [],
	linked: [],
	blocked: false,
};

/** A remote, and an engine for `connectionId` against it: the app's own push, not a stand-in. */
const remoteFor = async (db: DrawDatabase, connectionId: string) => {
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engineFor = (id: string) =>
		createSyncEngine({ provider: fake, store: createDexieSyncStore(db, { connectionId: id }) });
	return { fake, engineFor, sync: () => engineFor(connectionId).sync() };
};

describe('what a source holds that its remote has not been sent', () => {
	it('is nothing for a connection with no rows at all', async () => {
		const db = freshDatabase();

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
		expect(movable(unsynced)).toBe(0);
	});

	it('is nothing for drawings and folders the remote already has', async () => {
		const db = freshDatabase();
		await pushedDrawing(db, 'a.svg');
		await pushedDrawing(db, 'work/b.svg');
		await db.folders.put(
			folderOf({ ...scope, path: 'work', remoteId: 'r-work', createdAt: 1 })
		);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
	});

	it('counts a pushed drawing that has been edited since', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		await saveDrawing(db, drawing.id, svgOf('# a.svg\n\nmore\n'), scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, drawings: ['a.svg'] });
		expect(unsynced.drawings[0]?.dirty).toBe(1);
		expect(isEmpty(unsynced)).toBe(false);
	});

	it('counts a drawing that has never been pushed', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			drawings: [drawing.path],
		});
	});

	it('counts a clean, pushed drawing that has a write queued', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		await queueWrite(db, drawing);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(unsynced.drawings[0]?.dirty).toBe(0);
		expect(summary(unsynced)).toEqual({ ...NOTHING, drawings: ['a.svg'] });
	});

	it('counts a clean, pushed drawing with only a move queued as a rename', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		// Straight onto the queue and the row: `renameDrawing` also writes the title
		// into the file, which is an edit, and the case here is a move alone — a
		// drawing carried along by a folder's rename.
		await db.drawings.update([CONNECTION, drawing.id], { path: 'work/a.svg' });
		await db.opQueue.add({
			...scope,
			op: 'move',
			drawingId: drawing.id,
			path: 'a.svg',
			targetPath: 'work/a.svg',
			attempts: 0,
			queuedAt: 1,
		});

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, renames: ['work/a.svg'] });
		expect(isEmpty(unsynced)).toBe(false);
		// Nothing of it can go to another source: the file is in this one.
		expect(movable(unsynced)).toBe(0);
	});

	it('counts a renamed drawing whose text changed with it as a drawing, once', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		const renamed = await renameDrawing(db, drawing.id, 'Better name', scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect((await db.opQueue.toArray()).map((op) => op.op).sort()).toEqual(['move', 'write']);
		expect(summary(unsynced)).toEqual({ ...NOTHING, drawings: [renamed?.path] });
	});

	it('counts a deleted drawing the remote still has as a delete', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		await deleteDrawing(db, drawing.id, scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, deletes: ['a.svg'] });
		expect(movable(unsynced)).toBe(0);
	});

	it('owes nothing for a deleted drawing the remote never had', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Never sent' });
		await deleteDrawing(db, drawing.id, scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		// The tombstone is still there, and so is its queued delete.
		expect(await db.drawings.where('connectionId').equals(CONNECTION).count()).toBe(1);
		expect(summary(unsynced)).toEqual(NOTHING);
		expect(isEmpty(unsynced)).toBe(true);
	});

	it('does not count an edited tombstone as a drawing', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db, 'a.svg');
		await saveDrawing(db, drawing.id, svgOf('# a.svg\n\nlast words\n'), scope);
		await deleteDrawing(db, drawing.id, scope);

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			deletes: ['a.svg'],
		});
	});

	it('counts a conflict copy', async () => {
		const db = freshDatabase();
		await pushedDrawing(db, 'a.svg');
		// As `resolveConflict` in `sync/store.ts` writes one: a new row from the
		// local text, dirty, with no file of its own yet and a write queued.
		const path = 'a (conflict 2026-09-19 10.00.00).svg';
		await db.drawings.add({
			...drawingRecordFromFile({
				id: 'copy-1',
				connectionId: CONNECTION,
				path,
				source: '# a.svg\n\nmine\n',
				hash: 'h',
				now: 1,
			}),
			dirty: 1,
		});
		await db.opQueue.add({
			...scope,
			op: 'write',
			drawingId: 'copy-1',
			path,
			attempts: 0,
			queuedAt: 1,
		});

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, drawings: [path] });
		expect(movable(unsynced)).toBe(1);
	});

	it('counts a folder the remote has never been told of', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', scope);

		const unsynced = await unsyncedIn(db, CONNECTION);

		expect(summary(unsynced)).toEqual({ ...NOTHING, folders: ['Work'] });
		expect(movable(unsynced)).toBe(1);
	});

	describe('a folder that came into being around a drawing', () => {
		// `createDrawing`, and in skysa-notes a move and a restore, make the
		// folder row and queue no `mkdir`: the engine makes the directory when
		// the drawing's op finds no parent, and reports no id for it.
		const movedIntoNewFolder = async () => {
			const db = freshDatabase();
			await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
			const remote = await remoteFor(db, CONNECTION);
			const drawing = await createDrawing(db, {
				...scope,
				folderPath: 'Projects/2026',
				title: 'Plan',
				text: svgOf('one\n'),
			});
			return { db, remote, drawing };
		};

		it('is unsent while the drawing that implies it has not been pushed there', async () => {
			const { db } = await movedIntoNewFolder();

			expect((await db.opQueue.toArray()).filter((op) => op.op === 'mkdir')).toEqual([]);
			expect(summary(await unsyncedIn(db, CONNECTION))).toMatchObject({
				drawings: ['Projects/2026/plan.svg'],
				folders: ['Projects', 'Projects/2026'],
			});
		});

		it('is not unsent once that push has landed, though its row still has no id', async () => {
			const { db, remote } = await movedIntoNewFolder();

			await remote.sync();

			// The premise: the directory is on the remote, and the row does not say so.
			expect(remote.fake.contentAt('Projects/2026/plan.svg')).toContain('one');
			expect(await db.opQueue.count()).toBe(0);
			expect((await db.folders.get([CONNECTION, 'Projects/2026']))?.remoteId).toBeUndefined();
			expect((await db.folders.get([CONNECTION, 'Projects']))?.remoteId).toBeUndefined();

			const unsynced = await unsyncedIn(db, CONNECTION);
			expect(summary(unsynced)).toEqual(NOTHING);
			expect(isEmpty(unsynced)).toBe(true);
		});

		it('is unsent again when the only drawing that proved it is edited, and not when one of two is', async () => {
			const { db, remote, drawing } = await movedIntoNewFolder();
			const second = await createDrawing(db, {
				...scope,
				folderPath: 'Projects',
				title: 'Other',
			});
			await remote.sync();
			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);

			// `Projects` still has `other.svg` to show for itself; `2026` has nothing.
			await saveDrawing(db, drawing.id, svgOf('two\n'), scope);
			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
				...NOTHING,
				drawings: ['Projects/2026/plan.svg'],
				folders: ['Projects/2026'],
			});

			await saveDrawing(db, second.id, svgOf('two\n'), scope);
			expect(summary(await unsyncedIn(db, CONNECTION)).folders).toEqual([
				'Projects',
				'Projects/2026',
			]);
		});

		it('is not proved by a drawing whose move into it is still owed', async () => {
			const db = freshDatabase();
			const drawing = await pushedDrawing(db, 'a.svg');
			await db.drawings.update([CONNECTION, drawing.id], { path: 'New/a.svg' });
			await db.folders.put(folderOf({ ...scope, path: 'New', createdAt: 1 }));
			await db.opQueue.add({
				...scope,
				op: 'move',
				drawingId: drawing.id,
				path: 'a.svg',
				targetPath: 'New/a.svg',
				attempts: 0,
				queuedAt: 1,
			});

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
				...NOTHING,
				renames: ['New/a.svg'],
				folders: ['New'],
			});
		});

		it('is proved by a drawing under another spelling of its name', async () => {
			const db = freshDatabase();
			await pushedDrawing(db, 'work/a.svg');
			await db.folders.put(folderOf({ ...scope, path: 'Work', createdAt: 1 }));

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);
		});
	});

	it('counts an empty folder with no id even once its mkdir has left the queue', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', scope);
		await db.opQueue.clear();

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			folders: ['Work'],
		});
	});

	it('counts a folder the remote has that still has a mkdir queued', async () => {
		const db = freshDatabase();
		await db.folders.put(
			folderOf({ ...scope, path: 'Work', remoteId: 'r-work', createdAt: 1 })
		);
		await db.opQueue.add({ ...scope, op: 'mkdir', path: 'Work', attempts: 0, queuedAt: 1 });

		expect(summary(await unsyncedIn(db, CONNECTION))).toEqual({
			...NOTHING,
			folders: ['Work'],
		});
	});

	describe('a file beside a drawing', () => {
		const attached = async (db: DrawDatabase) => {
			await pushedDrawing(db, 'Work/a.svg');
			return fileAdded(db, {
				...scope,
				path: 'Work/a.png',
				bytes: new TextEncoder().encode('a').buffer,
			});
		};

		it('counts one added here and not uploaded: its bytes are nowhere else', async () => {
			const db = freshDatabase();
			const added = await attached(db);

			const unsynced = await unsyncedIn(db, CONNECTION);

			expect(summary(unsynced)).toEqual({
				...NOTHING,
				files: [added.path],
				portable: [added.path],
			});
			expect(countOf(unsynced)).toBe(1);
			expect(isEmpty(unsynced)).toBe(false);
		});

		it('counts a copy owed from the remote, and says no other account can be sent it', async () => {
			const db = freshDatabase();
			// A drawing's move copied a file this device never downloaded: the
			// upload is to read it from the remote (`copyOf`).
			const copy = { ...scope, id: 'c', path: 'Play/a.png', size: 1 };
			await db.files.put(copy);
			await queueUpload(db, copy, 'rf');

			const unsynced = await unsyncedIn(db, CONNECTION);

			expect(summary(unsynced)).toEqual({ ...NOTHING, files: [copy.path] });
			expect(isEmpty(unsynced)).toBe(false);
			expect(movable(unsynced)).toBe(0);
		});

		it('counts nothing for one the remote has, nor for its queued move', async () => {
			const db = freshDatabase();
			await db.files.put({ ...scope, id: 'f', path: 'a.png', remoteId: 'rf', size: 1 });
			await db.opQueue.add({
				...scope,
				op: 'move-file',
				fileId: 'f',
				path: 'old.png',
				targetPath: 'a.png',
				attempts: 0,
				queuedAt: 0,
			});

			expect(isEmpty(await unsyncedIn(db, CONNECTION))).toBe(true);
		});

		it("counts nothing of another source's", async () => {
			const db = freshDatabase();
			await attached(db);

			expect(isEmpty(await unsyncedIn(db, OTHER))).toBe(true);
		});

		it('tells a file added since the list was made from one on it', async () => {
			const db = freshDatabase();
			const seen = seenIn(await unsyncedIn(db, CONNECTION));
			await attached(db);
			const now = await unsyncedIn(db, CONNECTION);

			expect(unseenIn(now, seen)).toBe(true);
			expect(unseenIn(now, seenIn(now))).toBe(false);
		});
	});

	describe('blocked', () => {
		const stuckWrite = async (db: DrawDatabase, attempts: number) => {
			const drawing = await createDrawing(db, { ...scope, title: 'Stuck' });
			await db.opQueue
				.where('drawingId')
				.equals(drawing.id)
				.modify({ attempts, lastError: 'the provider said no' });
		};

		it('is said once an op is out of attempts, by the rule the scheduler uses', async () => {
			const db = freshDatabase();
			await stuckWrite(db, MAX_OP_ATTEMPTS);

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(true);
		});

		it('is not said of an op that has failed and still has attempts left', async () => {
			const db = freshDatabase();
			await stuckWrite(db, MAX_OP_ATTEMPTS - 1);

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);
		});

		it('follows the limit the scheduler was given', async () => {
			const db = freshDatabase();
			await stuckWrite(db, 3);

			expect((await unsyncedIn(db, CONNECTION, { maxAttempts: 3 })).blocked).toBe(true);
			expect((await unsyncedIn(db, CONNECTION, { maxAttempts: 4 })).blocked).toBe(false);
		});

		it('agrees with the engine, which sends the drawing queued behind such an rmdir', async () => {
			const db = freshDatabase();
			await db.syncState.put({ connectionId: CONNECTION, clientId: 'this-browser' });
			const remote = await remoteFor(db, CONNECTION);
			await db.opQueue.add({
				...scope,
				op: 'rmdir',
				path: 'Old',
				remoteId: 'r-old',
				attempts: MAX_OP_ATTEMPTS,
				queuedAt: 1,
			});
			const drawing = await createDrawing(db, { ...scope, title: 'Behind it' });
			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);

			const outcome = await createSyncEngine({
				provider: remote.fake,
				store: createDexieSyncStore(db, scope),
				maxAttempts: MAX_OP_ATTEMPTS,
			}).sync();

			expect(outcome.status).not.toBe('blocked');
			expect(remote.fake.contentAt(drawing.path)).toBeDefined();
		});

		it("is not said because another source's op is stuck", async () => {
			const db = freshDatabase();
			await createDrawing(db, { ...scope, title: 'Fine' });
			const other = await createDrawing(db, { connectionId: OTHER, title: 'Stuck' });
			await db.opQueue
				.where('drawingId')
				.equals(other.id)
				.modify({ attempts: MAX_OP_ATTEMPTS });

			expect((await unsyncedIn(db, CONNECTION)).blocked).toBe(false);
			expect((await unsyncedIn(db, OTHER)).blocked).toBe(true);
		});
	});

	describe('with another source holding drawings of the same ids', () => {
		it("does not take the other source's queued move for a rename here", async () => {
			const db = freshDatabase();
			await pushedDrawing(db, 'a.svg', { id: 'same-id' });
			await pushedDrawing(db, 'b.svg', { connectionId: OTHER, id: 'same-id' });
			await db.opQueue.add({
				connectionId: OTHER,
				op: 'move',
				drawingId: 'same-id',
				path: 'a.svg',
				targetPath: 'b.svg',
				attempts: 0,
				queuedAt: 1,
			});

			expect(summary(await unsyncedIn(db, CONNECTION))).toEqual(NOTHING);
			expect(summary(await unsyncedIn(db, OTHER))).toEqual({
				...NOTHING,
				renames: ['b.svg'],
			});
		});
	});

	describe('a connection resumed and not yet verified', () => {
		const ACCOUNT = { provider: 'dropbox', accountId: 'dbid:1' } as const;

		/**
		 * Synced with an account, and then marked as a resume nobody has checked.
		 *
		 * Set on the row rather than arrived at, because the road there is long: a
		 * source is only resumed with rows still naming files when it was detached
		 * holding some, and clean ones among them only when it was detached while
		 * already unverified (`detach.test.ts` has that road). What is asked here
		 * is what the flag means to `unsyncedIn`, whichever way it came to be set.
		 */
		const resumed = async () => {
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });
			const remote = await remoteFor(db, 'dropbox-1');
			await createFolder(db, 'Work');
			await createDrawing(db, { folderPath: 'Work', title: 'Plan', text: svgOf('# Plan\n') });
			await createDrawing(db, { title: 'Loose', text: svgOf('# Loose\n') });
			await remote.sync();
			await remote.sync();
			// Everything sent, by every rule above.
			expect({ ...(await unsyncedIn(db, 'dropbox-1')), unverified: undefined }).toEqual({
				...NOTHING,
				unverified: undefined,
			});
			await db.syncState.update('dropbox-1', { resumeUnverified: true });
			return { db, remote };
		};

		it('counts every drawing and folder, clean and linked as they look, and says why', async () => {
			const { db } = await resumed();
			// The rows really do look sent: that is the danger.
			const rows = await db.drawings.where('connectionId').equals('dropbox-1').toArray();
			expect(rows.map((drawing) => [drawing.dirty, drawing.remoteId !== undefined])).toEqual([
				[0, true],
				[0, true],
			]);
			expect(await db.opQueue.count()).toBe(0);
			expect((await db.syncState.get('dropbox-1'))?.resumeUnverified).toBe(true);

			const unsynced = await unsyncedIn(db, 'dropbox-1');

			expect(summary(unsynced)).toEqual({
				...NOTHING,
				drawings: ['Work/plan.svg', 'loose.svg'],
				folders: ['Work'],
			});
			expect(unsynced.unverified).toBe(true);
			expect(isEmpty(unsynced)).toBe(false);
			// Both drawings, and not the folder: one of the drawings is inside it, so
			// it goes wherever that drawing goes and is not a second thing to count
			// (`countedFolders`). Every number the user is shown uses this rule.
			expect(movable(unsynced)).toBe(2);
		});

		it('counts nothing once the remote has been found to hold the files', async () => {
			const { db, remote } = await resumed();

			expect(await verifyResume(db, 'dropbox-1', remote.fake)).toBe('resumed');

			const unsynced = await unsyncedIn(db, 'dropbox-1');
			expect(summary(unsynced)).toEqual(NOTHING);
			expect(unsynced.unverified).toBe(false);
			expect(isEmpty(unsynced)).toBe(true);
		});

		it('is not said of a connection that was never resumed', async () => {
			const db = freshDatabase();
			await bindConnection(db, { connectionId: 'dropbox-1', ...ACCOUNT });

			expect((await unsyncedIn(db, 'dropbox-1')).unverified).toBe(false);
			expect((await unsyncedIn(db, 'never-bound')).unverified).toBe(false);
		});
	});

	it('can be asked inside the transaction that will act on the answer', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });

		const tables = [db.drawings, db.folders, db.opQueue, db.syncState, db.files, db.fileBytes];
		const paths = await db.transaction('rw', tables, async () => {
			const unsynced = await unsyncedIn(db, CONNECTION);
			await db.drawings.bulkDelete(
				unsynced.drawings.map((each) => [each.connectionId, each.id])
			);
			return unsynced.drawings.map((each) => each.path);
		});

		expect(paths).toEqual([drawing.path]);
		expect(await db.drawings.count()).toBe(0);
	});
});
