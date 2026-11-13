import { parentPath, ROOT } from '@skysa/storage';
import { describe, expect, it } from 'vitest';

import {
	bindConnection,
	detachConnection,
	moveUnsyncedTo,
	showConnection,
} from '../../src/store/connection.js';
import {
	type DrawDatabase,
	type DrawingRecord,
	drawingRef,
	LOCAL_CONNECTION_ID,
} from '../../src/store/db.js';
import { createDrawing, deleteDrawing, saveDrawing } from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { foldPath } from '../../src/store/naming.js';
import { queueMove, queueWrite } from '../../src/store/queue.js';
import { type Seen, seenIn, unsyncedIn } from '../../src/store/unsynced.js';
import { holdCredential } from '../support/connection.js';
import { freshDatabase } from '../support/db.js';
import {
	drawingById,
	folderOf,
	importedFile,
	svgOf,
	updateDrawing,
} from '../support/drawingRows.js';

/**
 * Taking what one source never sent into another one (docs/ARCHITECTURE.md §10).
 *
 * The only operation in the app that carries a user's writing from one storage
 * account into another, so what it takes, what it leaves and what it says about
 * either is the whole subject here. It moves what could be anywhere — the drawings
 * the remote never had in full, and the folders around them — as new writing;
 * it leaves everything that is about the account being left; and it can reach
 * only what the user was shown (`seen`).
 */

const ADA = { connectionId: 'c-ada', provider: 'dropbox', accountId: 'dbid:ada' } as const;
const BOB = { connectionId: 'c-bob', provider: 'onedrive', accountId: 'ms:bob' } as const;
const ada = { connectionId: ADA.connectionId };
const bob = { connectionId: BOB.connectionId };

/** Bob's source live, Ada's still connected: the caller decides when it goes. */
const twoSources = async () => {
	const db = freshDatabase();
	await bindConnection(db, BOB);
	await holdCredential(db, BOB.connectionId);
	await bindConnection(db, ADA);
	await holdCredential(db, ADA.connectionId);
	await db.syncState.update(ADA.connectionId, { cursor: 'cursor-1', rootId: 'root-1' });
	return db;
};

/** A drawing as a pull leaves it: clean, with a file, nothing queued. */
const pushed = async (
	db: DrawDatabase,
	path: string,
	connectionId: string = ADA.connectionId
): Promise<DrawingRecord> => {
	const folder = parentPath(path);
	if (folder !== ROOT) {
		await db.folders.put(
			folderOf({ connectionId, path: folder, remoteId: `f:${folder}`, createdAt: 0 })
		);
	}
	return importedFile(db, {
		connectionId,
		path,
		source: `# ${path}\n`,
		remoteId: `r:${connectionId}:${path}`,
		remoteVersion: 'v1',
	});
};

/** Ada's source, let go, holding whatever `hold` put in it. */
const detached = async (db: DrawDatabase) => {
	expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);
	return seenIn(await unsyncedIn(db, ADA.connectionId));
};

const pathsUnder = async (db: DrawDatabase, connectionId: string) =>
	(await db.drawings.where('connectionId').equals(connectionId).toArray())
		.filter((drawing) => drawing.deletedLocally === 0)
		.map((drawing) => drawing.path)
		.sort();

const foldersUnder = async (db: DrawDatabase, connectionId: string) =>
	(await db.folders.where('connectionId').equals(connectionId).toArray())
		.map((folder) => folder.path)
		.sort();

const opsUnder = async (db: DrawDatabase, connectionId: string) =>
	(await db.opQueue.where('connectionId').equals(connectionId).sortBy('seq')).map(
		(op) => `${op.op} ${op.targetPath ?? op.path}`
	);

const moving = (db: DrawDatabase, seen: Seen) =>
	moveUnsyncedTo(db, { connectionId: ADA.connectionId, target: BOB.connectionId, seen });

describe('moving what a source never sent into another source', () => {
	it('takes the drawings as new writing, and leaves the source behind for good', async () => {
		const db = await twoSources();
		// Edited since it was pushed: the file is on Ada's remote in an older
		// version, and the edit is nowhere.
		const edited = await pushed(db, 'edited.svg');
		await updateDrawing(db, edited.id, { syncedHash: 'hash-1' });
		await saveDrawing(db, edited.id, svgOf('# edited\n\nmore\n'), ada);
		// Never pushed at all.
		await createDrawing(db, {
			...ada,
			title: 'Fresh',
			text: svgOf('# Fresh\n\nnew\n'),
		});
		const before = await drawingById(db, edited.id);
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		const landed = await drawingById(db, edited.id);
		expect(landed?.connectionId).toBe(BOB.connectionId);
		// Bob's storage has never heard of it: no file, no version, no agreement
		// about either, and owed a write.
		expect(landed?.remoteId).toBeUndefined();
		expect(landed?.remoteVersion).toBeUndefined();
		expect(landed?.syncedHash).toBeUndefined();
		expect(landed?.dirty).toBe(1);
		// The bytes it had, so the engine sends the file the user drew.
		expect(landed?.text).toBe(before?.text);
		expect(landed?.createdAt).toBe(before?.createdAt);
		expect(await opsUnder(db, BOB.connectionId)).toEqual([
			'write edited.svg',
			'write fresh.svg',
		]);
		// And Ada's source is gone entirely: rows, ops, row and credential.
		expect(await db.drawings.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.opQueue.where('connectionId').equals(ADA.connectionId).count()).toBe(0);
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
		expect(await db.credentials.get(ADA.connectionId)).toBeUndefined();
		expect(await db.drawings.where('connectionId').equals(LOCAL_CONNECTION_ID).count()).toBe(0);
	});

	it('carries the folders the drawings are in, and asks Bob only for the ones he lacks', async () => {
		const db = await twoSources();
		// Bob already has a folder of this name, in his own spelling.
		await db.folders.put(
			folderOf({ ...bob, path: 'Work', remoteId: 'f:bob:work', createdAt: 0 })
		);
		// Ada's: one the remote never made, and one it did, each holding an
		// unsent drawing.
		await createFolder(db, 'work', ada);
		await createDrawing(db, { ...ada, folderPath: 'work', title: 'Plan' });
		await db.folders.put(
			folderOf({ ...ada, path: 'Sent', remoteId: 'f:ada:sent', createdAt: 0 })
		);
		await createDrawing(db, { ...ada, folderPath: 'Sent', title: 'Draft' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		// One folder, in Bob's spelling, with the drawing in it.
		expect(await foldersUnder(db, BOB.connectionId)).toEqual(['Sent', 'Work']);
		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['Sent/draft.svg', 'Work/plan.svg']);
		// Bob already has `Work`; `Sent` is a directory he has never heard of.
		const sent = await db.folders.get([BOB.connectionId, 'Sent']);
		expect(sent?.remoteId).toBeUndefined();
		expect(await opsUnder(db, BOB.connectionId)).toEqual([
			'mkdir Sent',
			'write Sent/draft.svg',
			'write Work/plan.svg',
		]);
	});

	it('finds a free name where the target has that file already, compared as a provider would', async () => {
		const db = await twoSources();
		await db.folders.put(
			folderOf({ ...bob, path: 'Work', remoteId: 'f:bob:work', createdAt: 0 })
		);
		await pushed(db, 'Work/plan.svg', BOB.connectionId);
		await createFolder(db, 'work', ada);
		const mine = await createDrawing(db, { ...ada, folderPath: 'work', title: 'PLAN' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		const landed = await drawingById(db, mine.id);
		// One directory on every provider, and two files in it.
		expect(parentPath(landed?.path ?? '')).toBe('Work');
		expect(foldPath(landed?.path ?? '')).not.toBe('work/plan.svg');
		expect(await pathsUnder(db, BOB.connectionId)).toHaveLength(2);
	});

	it('keeps a drawing written into since the list was made, and the source around it', async () => {
		const db = await twoSources();
		const listed = await createDrawing(db, { ...ada, title: 'Listed' });
		const seen = await detached(db);
		// Another tab, while the question was open: a chapter into a listed drawing,
		// and a drawing the list never had.
		await saveDrawing(db, listed.id, svgOf('# Listed\n\nan hour of work\n'), ada);
		const late = await createDrawing(db, { ...ada, title: 'Late' });

		expect(await moving(db, seen)).toBe('detached');

		// Neither moved, and neither let go: the user answered about a list that
		// did not stand for either of them.
		expect((await drawingById(db, listed.id))?.connectionId).toBe(ADA.connectionId);
		expect((await drawingById(db, listed.id))?.text).toContain('# Listed\n\nan hour of work\n');
		expect((await drawingById(db, late.id))?.connectionId).toBe(ADA.connectionId);
		expect(await db.drawings.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('moves what was shown and keeps what was not, where the source holds both', async () => {
		const db = await twoSources();
		const shown = await createDrawing(db, { ...ada, title: 'Shown' });
		const seen = await detached(db);
		const late = await createDrawing(db, {
			...ada,
			title: 'Late',
			text: svgOf('# Late\n\ntyped\n'),
		});

		expect(await moving(db, seen)).toBe('detached');

		expect((await drawingById(db, shown.id))?.connectionId).toBe(BOB.connectionId);
		expect((await drawingById(db, late.id))?.connectionId).toBe(ADA.connectionId);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['late.svg']);
		expect(await opsUnder(db, BOB.connectionId)).toEqual(['write shown.svg']);
		// The one left still owes Ada's remote its write, for when it comes back.
		expect(await opsUnder(db, ADA.connectionId)).toEqual(['write late.svg']);
	});

	it('leaves every other source exactly as it was', async () => {
		const db = await twoSources();
		const theirs = await createDrawing(db, {
			...bob,
			title: 'Theirs',
			text: svgOf('# Theirs\n'),
		});
		await updateDrawing(db, theirs.id, { remoteId: 'r:bob:theirs', dirty: 0 });
		await db.opQueue.where('drawingId').equals(theirs.id).delete();
		// A third source, which is nobody's business here.
		await bindConnection(db, { connectionId: 'c-third', provider: 'gdrive', accountId: 'g:1' });
		await holdCredential(db, 'c-third');
		const third = await createDrawing(db, {
			connectionId: 'c-third',
			title: 'Third',
			text: svgOf('# Third\n'),
		});
		await showConnection(db, ADA.connectionId);
		await createDrawing(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('released');

		expect((await drawingById(db, theirs.id))?.remoteId).toBe('r:bob:theirs');
		expect((await drawingById(db, theirs.id))?.dirty).toBe(0);
		expect((await drawingById(db, third.id))?.connectionId).toBe('c-third');
		expect(await opsUnder(db, 'c-third')).toEqual(['write third.svg']);
		expect(await db.credentials.get('c-third')).toBeDefined();
		expect((await db.syncState.get('c-third'))?.detached).toBeUndefined();
	});

	it('drops what the source owed its own remote, and owes Bob a write instead', async () => {
		const db = await twoSources();
		// Clean, pushed, and still owed a write: the op is addressed to Ada's
		// file, which Bob's account does not have.
		const owed = await pushed(db, 'owed.svg');
		await queueWrite(db, owed);
		const seen = await detached(db);
		const wasQueued = await db.opQueue
			.where('connectionId')
			.equals(ADA.connectionId)
			.primaryKeys();

		expect(await moving(db, seen)).toBe('released');

		const ops = await db.opQueue.toArray();
		expect(ops).toHaveLength(1);
		expect(ops[0]?.connectionId).toBe(BOB.connectionId);
		// A fresh op, not the old one re-pointed at another account.
		expect(wasQueued).not.toContain(ops[0]?.seq);
	});

	it('refuses a list with nothing in it that a move is for, rather than discarding it', async () => {
		const db = await twoSources();
		// Everything unsent here is about a file only Ada's account has: a rename
		// it never heard of, and a delete it can never be told about now. There is
		// nothing to carry, so "Move" would be a discard of both under a button
		// that says otherwise.
		const renamed = await pushed(db, 'renamed.svg');
		await updateDrawing(db, renamed.id, { path: 'moved.svg' });
		await queueMove(db, (await drawingById(db, renamed.id))!, 'renamed.svg');
		const doomed = await pushed(db, 'doomed.svg');
		await deleteDrawing(db, doomed.id, ada);
		const seen = await detached(db);

		expect(await moving(db, seen)).toBe('nothing-to-move');

		// Nothing touched, on either side: the source is still here holding both.
		expect(await db.drawings.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
		expect((await drawingById(db, renamed.id))?.path).toBe('moved.svg');
		expect((await drawingById(db, doomed.id))?.deletedLocally).toBe(1);
	});

	it('refuses to move a source whose files have not been checked against its remote', async () => {
		const db = await twoSources();
		// A whole library, pushed and clean, resumed from an earlier bind. Until
		// `verifyResume` has looked for the files, "clean, with a remote id" is a
		// memory and every row reads as unsent (`Unsynced.unverified`) — and a
		// move made on that would copy the lot into a stranger's account.
		await pushed(db, 'one.svg');
		await pushed(db, 'two.svg');
		await db.syncState.update(ADA.connectionId, { resumeUnverified: true });
		const seen = await detached(db);
		expect((await unsyncedIn(db, ADA.connectionId)).unverified).toBe(true);

		expect(await moving(db, seen)).toBe('unverified');

		expect(await db.drawings.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['one.svg', 'two.svg']);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('keeps a drawing an editor still holds text for, rather than moving half of it', async () => {
		const db = await twoSources();
		const going = await createDrawing(db, { ...ada, title: 'Going' });
		const held = await createDrawing(db, {
			...ada,
			title: 'Held',
			text: svgOf('# Held\n\nrow\n'),
		});
		const seen = await detached(db);

		// A save of `held` that the store would not take, found by the settle
		// immediately before this: the row is not the whole of what was written.
		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen,
				holding: new Set([drawingRef(held)]),
			})
		).toBe('holding');

		expect((await drawingById(db, going.id))?.connectionId).toBe(BOB.connectionId);
		// Left where its editor can still write into it, under a source that stays.
		expect((await drawingById(db, held.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('refuses a target that is not a connected source, and touches nothing', async () => {
		const db = await twoSources();
		const mine = await createDrawing(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await detachConnection(db, { connectionId: BOB.connectionId });

		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: BOB.connectionId,
				seen,
			})
		).toBe('no-target');
		expect(
			await moveUnsyncedTo(db, {
				connectionId: ADA.connectionId,
				target: LOCAL_CONNECTION_ID,
				seen,
			})
		).toBe('no-target');

		expect((await drawingById(db, mine.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('refuses a source another tab has connected again, credential and all', async () => {
		const db = await twoSources();
		const mine = await createDrawing(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await holdCredential(db, ADA.connectionId);
		await bindConnection(db, ADA);

		expect(await moving(db, seen)).toBe('reconnected');

		expect((await drawingById(db, mine.id))?.connectionId).toBe(ADA.connectionId);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeUndefined();
		expect(await db.credentials.get(ADA.connectionId)).toBeDefined();
	});

	it('says a source another tab let go of first is released, and moves nothing', async () => {
		const db = await twoSources();
		await createDrawing(db, { ...ada, title: 'Mine' });
		const seen = await detached(db);
		await db.drawings.where('connectionId').equals(ADA.connectionId).delete();
		await db.syncState.delete(ADA.connectionId);

		expect(await moving(db, seen)).toBe('released');
		expect(await db.drawings.where('connectionId').equals(BOB.connectionId).count()).toBe(0);
	});
});
