import { DRAW_FORMAT, syncsHidden } from '@skysa/draw-core';
import { isHidden, type StorageProvider } from '@skysa/storage';
import { createFakeProvider, type FakeProvider } from '@skysa/storage/testing';
import { createSyncEngine } from '@skysa/sync';
import { describe, expect, it } from 'vitest';

import type { DrawDatabase, OpQueueRecord } from '../../src/store/db.js';
import {
	createDrawing,
	deleteDrawing,
	drawingFile,
	getDrawing,
	renameDrawing,
	saveDrawing,
} from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { rowsOf } from '../../src/store/rows.js';
import { isLive } from '../../src/store/rowStates.js';
import { createDexieSyncStore, type DexieSyncStoreOptions } from '../../src/sync/store.js';
import { freshDatabase } from '../support/db.js';
import { importedFile, lazily, svgOf, updateDrawing } from '../support/drawingRows.js';

const CONNECTION = 'dropbox-1';
const scope = { connectionId: CONNECTION };

/**
 * A store for a connection the device is bound to — the only kind the app
 * makes, and the only kind that writes.
 */
const boundStore = async (db: DrawDatabase, options: DexieSyncStoreOptions) => {
	await db.syncState.put({ connectionId: options.connectionId, clientId: 'this-browser' });
	return createDexieSyncStore(db, options);
};

/** The queue as the engine would read it, without the bookkeeping. */
const queued = async (db: DrawDatabase) =>
	(await db.opQueue.orderBy('seq').toArray()).map((op: OpQueueRecord) => ({
		op: op.op,
		path: op.path,
		...(op.drawingId === undefined ? {} : { drawingId: op.drawingId }),
		...(op.targetPath === undefined ? {} : { targetPath: op.targetPath }),
		...(op.remoteId === undefined ? {} : { remoteId: op.remoteId }),
	}));

/** A drawing the remote already has, so that renaming it has a file to move. */
const pushedDrawing = async (db: DrawDatabase, path = 'a.svg') => {
	const drawing = await importedFile(db, { ...scope, path, source: '# A\n' });
	await updateDrawing(db, drawing.id, { remoteId: `r-${drawing.id}`, remoteVersion: 'v1' });
	return drawing;
};

describe('the push queue a local change leaves behind', () => {
	it('queues a write for a new drawing', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });

		expect(await queued(db)).toEqual([
			{ op: 'write', path: drawing.path, drawingId: drawing.id },
		]);
	});

	it('queues one write however many edits land before it runs', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db);

		await saveDrawing(db, drawing.id, svgOf('# A\n\none\n'), scope);
		await saveDrawing(db, drawing.id, svgOf('# A\n\ntwo\n'), scope);

		expect(await queued(db)).toEqual([{ op: 'write', path: 'a.svg', drawingId: drawing.id }]);
	});

	it('queues a move from where the remote has it to where it is now', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db);

		const renamed = await renameDrawing(db, drawing.id, 'B', scope);

		expect(await queued(db)).toContainEqual({
			op: 'move',
			path: 'a.svg',
			targetPath: renamed?.path,
			drawingId: drawing.id,
		});
	});

	it('replaces a queued move on a second rename, keeping where the file is', async () => {
		const db = freshDatabase();
		const drawing = await pushedDrawing(db);

		await renameDrawing(db, drawing.id, 'B', scope);
		const twice = await renameDrawing(db, drawing.id, 'C', scope);

		const moves = (await queued(db)).filter((op) => op.op === 'move');
		expect(moves).toEqual([
			{ op: 'move', path: 'a.svg', targetPath: twice?.path, drawingId: drawing.id },
		]);
	});

	it('does not move a drawing the remote has never had', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });

		const renamed = await renameDrawing(db, drawing.id, 'Other', scope);

		// The write creates the file wherever the drawing is when it runs.
		expect(await queued(db)).toEqual([
			{ op: 'write', path: drawing.path, drawingId: drawing.id },
		]);
		expect(renamed?.path).not.toBe(drawing.path);
	});

	it('queues one delete, and withdraws the write it makes pointless', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });

		await deleteDrawing(db, drawing.id, scope);
		await deleteDrawing(db, drawing.id, scope);

		// A tombstone owes the remote its delete and nothing else — the rule
		// `queueWrite` already applied from the other end. Sending the write
		// first would create the file only to remove it, and a file at that
		// path is what another device's drawing binds to instead of making one of
		// its own: the delete then takes that drawing too (`soak.test.ts`).
		expect((await queued(db)).map((op) => op.op)).toEqual(['delete']);
	});

	it('keeps a move queued before the delete, and withdraws only the write', async () => {
		// The write is withdrawn because a tombstone owes the remote nothing but
		// its delete. The move is not: the file is still at the name it had, and
		// the delete names the drawing's path. Every provider the app syncs to
		// deletes by id, so it would survive the loss — but the queue should not
		// be the thing that decides that, and a rename left unsent is a file at
		// a name no device believes in.
		const db = freshDatabase();
		const drawing = await pushedDrawing(db);
		await db.opQueue.clear();
		await renameDrawing(db, drawing.id, 'Later', scope);

		const renamed = await getDrawing(db, drawing.id, scope);
		if (renamed === undefined) throw new Error('no drawing');
		await deleteDrawing(db, drawing.id, scope);

		expect((await queued(db)).map((op) => op.op)).toEqual(['move', 'delete']);
	});

	it('queues a mkdir for every folder a new one brings into being, outermost first', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', scope);

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('queues nothing when a folder cannot be created', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', scope);

		expect(await createFolder(db, 'Work', scope)).toBeUndefined();

		expect(await queued(db)).toEqual([{ op: 'mkdir', path: 'Work' }]);
	});

	it('queues a mkdir for each connection a folder of one name is made under', async () => {
		const db = freshDatabase();
		await createFolder(db, 'Work', scope);
		await createFolder(db, 'Work', { connectionId: 'onedrive-1' });

		const ops = await db.opQueue.toArray();
		expect(ops.map((op) => [op.op, op.connectionId])).toEqual([
			['mkdir', CONNECTION],
			['mkdir', 'onedrive-1'],
		]);
	});
});

// ---------------------------------------------------------------------------

/** The app's writers, the Dexie store and the engine, over the fake provider. */
const connected = async () => {
	const db = freshDatabase();
	const store = await boundStore(db, scope);
	const fake = createFakeProvider();
	await fake.ensureRoot();
	const engineOver = (provider: StorageProvider) =>
		createSyncEngine({
			document: DRAW_FORMAT,
			syncsHidden,
			provider,
			store,
			now: () => new Date('2026-09-16T10:00:00Z'),
		});
	return { db, store, fake, engine: engineOver(fake), engineOver };
};

/** Every file on the remote, by path, leaving out the app's own. */
const remoteFiles = (fake: FakeProvider) =>
	Object.fromEntries(
		fake
			.snapshot()
			.filter((entry) => entry.kind === 'file' && !isHidden(entry.path))
			.map((entry) => [entry.path, fake.contentAt(entry.path)])
	);

/** Every live drawing of the connection. */
const liveDrawings = (db: DrawDatabase) => rowsOf(db.drawings, CONNECTION).filter(isLive).toArray();

/** Every live drawing, by path, as the file it should be. */
const localFiles = async (db: DrawDatabase) =>
	Object.fromEntries((await liveDrawings(db)).map((drawing) => [drawing.path, drawing.text]));

/** Both sides agree, and nothing is left to send. */
const expectMirrored = async (db: DrawDatabase, fake: FakeProvider) => {
	expect(remoteFiles(fake)).toEqual(await localFiles(db));
	expect(await db.opQueue.count()).toBe(0);
	expect((await liveDrawings(db)).filter((drawing) => drawing.dirty === 1)).toEqual([]);
};

/**
 * The provider, with `action` run the first time `operation` has reached the
 * remote and before the engine hears back: the user carrying on while a
 * request is in flight.
 */
const inFlight = (
	fake: FakeProvider,
	operation: 'write' | 'move' | 'delete',
	action: () => Promise<unknown>
): StorageProvider => {
	const fired = new Set<string>();
	const once = async () => {
		if (fired.has(operation)) return;
		fired.add(operation);
		await action();
	};
	return {
		...fake,
		write: async (path, content, options) => {
			const entry = await fake.write(path, content, options);
			if (operation === 'write') await once();
			return entry;
		},
		move: async (entry, target) => {
			const moved = await fake.move(entry, target);
			if (operation === 'move') await once();
			return moved;
		},
		delete: async (entry) => {
			await fake.delete(entry);
			if (operation === 'delete') await once();
		},
	};
};

describe('local changes, pushed', () => {
	it('writes a drawing renamed before its first push once, at its final name', async () => {
		const { db, fake, engine } = await connected();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });
		await renameDrawing(db, drawing.id, 'Roadmap', scope);

		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(fake.callLog().filter((call) => call.op === 'write')).toHaveLength(1);
		expect(fake.callLog().filter((call) => call.op === 'move')).toEqual([]);
	});

	it('makes no conflict copy for a new drawing at the name of one just deleted', async () => {
		const { db, fake, engine } = await connected();
		const old = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n\nold\n'),
		});
		await engine.sync();

		await deleteDrawing(db, old.id, scope);
		const fresh = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n\nnew\n'),
		});
		const result = await engine.sync();

		expect(result).toMatchObject({ status: 'ok', conflicts: [] });
		await expectMirrored(db, fake);
		expect(Object.values(remoteFiles(fake))).toEqual([
			drawingFile((await getDrawing(db, fresh.id, scope))!),
		]);
	});
});

describe('local changes made while a push is in flight', () => {
	it('keeps an edit typed while its write was on the way, and sends it next', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n\none\n'),
		});
		const engine = engineOver(
			inFlight(fake, 'write', () =>
				saveDrawing(db, drawing.id, svgOf('# Plan\n\ntwo\n'), scope)
			)
		);

		await engine.sync();

		const row = await getDrawing(db, drawing.id, scope);
		expect(row?.dirty).toBe(1);
		expect(row?.remoteId).toBeDefined();
		expect(await db.opQueue.count()).toBe(1);

		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);
		expect(fake.contentAt(drawing.path)).toContain('two');
	});

	it('moves a drawing renamed while the write creating it was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });
		const engine = engineOver(
			inFlight(fake, 'write', () => renameDrawing(db, drawing.id, 'Roadmap', scope))
		);

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['roadmap.svg']);
	});

	it('moves a drawing renamed while an earlier write was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });
		await engineOver(fake).sync();
		await saveDrawing(db, drawing.id, svgOf('# Plan\n\nmore\n'), scope);
		const engine = engineOver(
			inFlight(fake, 'write', () => renameDrawing(db, drawing.id, 'Roadmap', scope))
		);

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['roadmap.svg']);
	});

	it('follows a drawing renamed again while its move was on the way', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, { ...scope, title: 'Plan' });
		await engineOver(fake).sync();
		await renameDrawing(db, drawing.id, 'Roadmap', scope);
		const engine = engineOver(
			inFlight(fake, 'move', () => renameDrawing(db, drawing.id, 'Vision', scope))
		);

		await engine.sync();
		expect((await getDrawing(db, drawing.id, scope))?.path).toBe('vision.svg');
		expect((await engine.sync()).status).toBe('ok');

		await expectMirrored(db, fake);
		expect(Object.keys(remoteFiles(fake))).toEqual(['vision.svg']);
	});

	it('still removes the file when the write creating it was in flight as the delete came', async () => {
		// The delicate half of withdrawing the write: it is already at the
		// network, so only its queue row goes. `settle` still records the
		// `remoteId` the write earned onto the tombstone, which is the id this
		// delete is addressed by — without it the delete would purge the row
		// with nothing removed, and the file would come back on the next pull
		// as a drawing the user deleted.
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		const engine = engineOver(
			inFlight(fake, 'write', () => deleteDrawing(db, drawing.id, scope))
		);

		await engine.sync();
		expect((await engine.sync()).status).toBe('ok');

		expect(remoteFiles(fake)).toEqual({});
		expect(await getDrawing(db, drawing.id, scope)).toBeUndefined();
		expect(await db.opQueue.count()).toBe(0);
	});

	it('sends only the delete for a drawing edited and then deleted', async () => {
		// The edit queued a write; the delete withdraws it. Sending it first
		// would put bytes on the remote that the user has just thrown away, and
		// then remove them — and where the drawing was never pushed at all, the
		// file it creates is one another device's drawing can bind to.
		const { db, fake, engine } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		await engine.sync();
		await saveDrawing(db, drawing.id, svgOf('# Plan\n\nthrown away\n'), scope);
		await deleteDrawing(db, drawing.id, scope);

		await engine.sync();

		expect(fake.callLog().filter((call) => call.op === 'write')).toHaveLength(1);
		expect(remoteFiles(fake)).toEqual({});
		expect(await getDrawing(db, drawing.id, scope)).toBeUndefined();
	});
});

/** What is queued, as `op path`, with ` (lazy)` after a lazy write, in order. */
const queuedOps = async (db: DrawDatabase): Promise<string[]> =>
	(await db.opQueue.orderBy('seq').toArray()).map(
		(op) => `${op.op} ${op.path}${op.lazy === true ? ' (lazy)' : ''}`
	);

describe('a lazy write, and an edit’s (§7, "When a push goes")', () => {
	// This app queues no write lazily; an app whose changes come every few
	// seconds does, and the queue keeps the rules for both (`queueWrite`).
	it('queues a lazy change lazily, once however many there are', async () => {
		const { db, engine } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		await engine.sync();

		await lazily(db, drawing.id, svgOf('# Plan\n\none\n'));
		await lazily(db, drawing.id, svgOf('# Plan\n\ntwo\n'));

		expect(await queuedOps(db)).toEqual([`write ${drawing.path} (lazy)`]);
	});

	it('puts an edit’s write in place of a lazy one, at the back of the queue', async () => {
		const { db, fake, engine } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		const other = await createDrawing(db, {
			...scope,
			title: 'Other',
			text: svgOf('# Other\n'),
		});
		await engine.sync();
		await lazily(db, drawing.id, svgOf('# Plan\n\none\n'));
		await lazily(db, other.id, svgOf('# Other\n\none\n'));

		await saveDrawing(db, drawing.id, svgOf('# Plan\n\ntwo\n'), scope);

		expect(await queuedOps(db)).toEqual([
			`write ${other.path} (lazy)`,
			`write ${drawing.path}`,
		]);
		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);
		expect(fake.contentAt(drawing.path)).toContain('two');
	});

	it('leaves an edit’s write as it is when a lazy change follows it', async () => {
		const { db, engine } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		await engine.sync();
		await saveDrawing(db, drawing.id, svgOf('# Plan\n\none\n'), scope);

		await lazily(db, drawing.id, svgOf('# Plan\n\ntwo\n'));

		expect(await queuedOps(db)).toEqual([`write ${drawing.path}`]);
	});

	it('owes a lazy write for a lazy change made while the last one’s was on its way', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		await engineOver(fake).sync();
		await lazily(db, drawing.id, svgOf('# Plan\n\none\n'));
		const engine = engineOver(
			inFlight(fake, 'write', () => lazily(db, drawing.id, svgOf('# Plan\n\ntwo\n')))
		);

		await engine.sync();

		expect(await queuedOps(db)).toEqual([`write ${drawing.path} (lazy)`]);
		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);
		expect(fake.contentAt(drawing.path)).toContain('two');
	});

	it('sends an edit made while a lazy write was on its way, and not lazily', async () => {
		const { db, fake, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n'),
		});
		await engineOver(fake).sync();
		await lazily(db, drawing.id, svgOf('# Plan\n\none\n'));
		const engine = engineOver(
			inFlight(fake, 'write', () =>
				saveDrawing(db, drawing.id, svgOf('# Plan\n\ntwo\n'), scope)
			)
		);

		await engine.sync();

		expect(await queuedOps(db)).toEqual([`write ${drawing.path}`]);
		expect((await engine.sync()).status).toBe('ok');
		await expectMirrored(db, fake);
		expect(fake.contentAt(drawing.path)).toContain('two');
	});
});

describe('an op the user has moved on from, settled', () => {
	it('leaves a queued move where it stands behind the write it follows', async () => {
		const db = freshDatabase();
		const store = await boundStore(db, scope);
		const drawing = await pushedDrawing(db);
		await saveDrawing(db, drawing.id, svgOf('# A\n\nmore\n'), scope);
		const renamed = await renameDrawing(db, drawing.id, 'B', scope);
		const [write, move] = await store.pendingOps();

		await store.completeOp(write!.seq, {
			kind: 'pushed',
			noteId: drawing.id,
			// Where the write found the file, which is not where the drawing is.
			remote: {
				remoteId: renamed?.remoteId ?? '',
				path: 'a.svg',
				kind: 'file',
				version: 'v2',
				modifiedAt: '2026-09-16T10:00:00.000Z',
				size: 1,
			},
			content: renamed?.text ?? '',
			syncedHash: 'hash',
		});

		expect((await store.pendingOps()).map((op) => op.seq)).toEqual([move!.seq]);
	});
});

/** The provider, with `after` run once the pull has read its last page: another device, between our pull and our push. */
const afterPull = (fake: FakeProvider, after: () => Promise<unknown>): StorageProvider => {
	const done = new Set<boolean>();
	return {
		...fake,
		changes: async (cursor) => {
			const page = await fake.changes(cursor);
			if (!done.has(true) && !page.more) {
				done.add(true);
				await after();
			}
			return page;
		},
	};
};

/** Every drawing's text, on the remote and here. */
const everywhere = async (db: DrawDatabase, fake: FakeProvider) => [
	...Object.values(remoteFiles(fake)),
	...(await db.drawings.toArray()).map((drawing) => drawing.text),
];

describe('a queue that has moved on by the time it is sent', () => {
	it('keeps an edit another device made to a drawing renamed here since the pull', async () => {
		const { db, fake, engine, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n\nmine\n'),
		});
		await engine.sync();
		await engine.sync();
		const version = (await getDrawing(db, drawing.id, scope))?.remoteVersion;

		await renameDrawing(db, drawing.id, 'Roadmap', scope);
		const first = await engineOver(
			afterPull(fake, () =>
				fake.write('plan.svg', svgOf('THEIRS', drawing.id), { expectedVersion: version })
			)
		).sync();
		const settled = await engine.sync();
		await engine.sync();

		// Met in the round that sent the move, or the one after it.
		expect([...first.conflicts, ...settled.conflicts]).not.toEqual([]);
		const texts = await everywhere(db, fake);
		expect(texts.some((text) => text?.includes('THEIRS'))).toBe(true);
		expect(texts.some((text) => text?.includes('mine'))).toBe(true);
		await expectMirrored(db, fake);
	});

	it('does not take over a file another device put at the name a drawing was renamed to', async () => {
		const { db, fake, engine, engineOver } = await connected();
		const drawing = await createDrawing(db, {
			...scope,
			title: 'Plan',
			text: svgOf('# Plan\n\nmine\n'),
		});
		await engine.sync();
		await engine.sync();

		await renameDrawing(db, drawing.id, 'Roadmap', scope);
		await engineOver(
			afterPull(fake, () =>
				fake.write('roadmap.svg', svgOf('OTHER DRAWING', 'other-drawing'), {})
			)
		).sync();
		await engine.sync();
		await engine.sync();

		const row = await getDrawing(db, drawing.id, scope);
		expect(row?.text).toContain('mine');
		expect(fake.contentAt('roadmap.svg')).toBe(svgOf('OTHER DRAWING', 'other-drawing'));
		expect(fake.contentAt('plan.svg')).toBeUndefined();
		await expectMirrored(db, fake);
	});
});

describe('a drawing deleted before its write was ever sent', () => {
	it('withdraws the write, so nothing is created for the delete to remove', async () => {
		// The write and the delete would otherwise both run: the file is made
		// and taken away again. On its own that is only waste — but a file at
		// that path is what another device's drawing binds to instead of making
		// one of its own, and the delete then takes that drawing away too. A
		// tombstone owes the remote its delete and nothing else.
		const db = freshDatabase();
		const drawing = await createDrawing(db, { connectionId: CONNECTION, title: 'Plans' });
		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['write']);

		await deleteDrawing(db, drawing.id, scope);

		expect((await db.opQueue.toArray()).map((op) => op.op)).toEqual(['delete']);
	});

	it('still queues the delete for a drawing the remote already has', async () => {
		const db = freshDatabase();
		const drawing = await createDrawing(db, { connectionId: CONNECTION, title: 'Plans' });
		await updateDrawing(db, drawing.id, { remoteId: 'r1', remoteVersion: 'v1' });
		const withFile = await getDrawing(db, drawing.id, scope);
		if (withFile === undefined) throw new Error('no drawing');

		await deleteDrawing(db, drawing.id, scope);

		const ops = await db.opQueue.toArray();
		expect(ops.map((op) => op.op)).toEqual(['delete']);
		expect(ops[0]?.drawingId).toBe(drawing.id);
	});
});

describe('a drawing deleted before its write was ever sent, on two devices', () => {
	/**
	 * The same defect as above, reaching the other device: the interleaving is
	 * set here rather than raced for, so this device's write creates the file,
	 * the other device's push lands while it is there, and this device's delete
	 * follows.
	 *
	 * What that costs the other device depends on what the engine makes of a
	 * path it finds occupied, and the worst of it is not what this reproduces.
	 * Here their drawing survives under a conflict name: a copy of a file nobody
	 * conflicted over, for the user to tidy up. In the soak's seed 39 — a
	 * longer run — no copy is made, their drawing
	 * goes with the file, and it is gone from both devices. That seed is the
	 * loss; this is the guard that holds the mechanism still whatever the
	 * engine decides afterward, and fails, deterministically, on a withdrawn
	 * write that runs anyway.
	 */
	const twoDevices = async () => {
		const fake = createFakeProvider();
		await fake.ensureRoot();
		const mine = freshDatabase();
		const theirs = freshDatabase();
		const mineStore = await boundStore(mine, scope);
		const theirsStore = await boundStore(theirs, scope);
		const now = () => new Date('2026-09-16T10:00:00Z');
		return { fake, mine, theirs, mineStore, theirsStore, now };
	};

	it('leaves the other device’s drawing where it is', async () => {
		const { fake, mine, theirs, mineStore, theirsStore, now } = await twoDevices();
		await createDrawing(theirs, {
			...scope,
			title: 'Plans',
			text: svgOf('# Plans\n\nkeep me\n'),
		});
		const dropped = await createDrawing(mine, {
			...scope,
			title: 'Plans',
			text: svgOf('# Plans\n\nno\n'),
		});
		await deleteDrawing(mine, dropped.id);

		const other = createSyncEngine({
			document: DRAW_FORMAT,
			syncsHidden,
			provider: fake,
			store: theirsStore,
			now,
		});
		// Their push happens while my file is at the path, if mine ever puts
		// one there — which is the whole question.
		const engine = createSyncEngine({
			document: DRAW_FORMAT,
			syncsHidden,
			provider: inFlight(fake, 'write', () => other.push()),
			store: mineStore,
			now,
		});
		await engine.push();
		await other.sync();
		await engine.sync();

		// Their drawing, at their name, on the remote and on both devices — mine
		// having pulled it, since my own drawing at that name is the one I threw
		// away.
		expect(Object.keys(remoteFiles(fake))).toEqual(['plans.svg']);
		expect(fake.contentAt('plans.svg')).toContain('keep me');
		expect(Object.keys(await localFiles(theirs))).toEqual(['plans.svg']);
		expect(Object.keys(await localFiles(mine))).toEqual(['plans.svg']);
		expect(await localFiles(mine)).toEqual(await localFiles(theirs));
	});
});
