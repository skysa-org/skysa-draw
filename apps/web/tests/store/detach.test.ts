import { parentPath, ROOT } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import {
	bindConnection,
	connectedSources,
	detachConnection,
	releaseConnection,
} from '../../src/store/connection.js';
import { credentialFor } from '../../src/store/credentials.js';
import {
	ACTIVE_CONNECTION_KEY,
	activeConnectionId,
	type DrawDatabase,
	type DrawingRecord,
	LOCAL_CONNECTION_ID,
} from '../../src/store/db.js';
import { createDrawing, deleteDrawing, getDrawing, saveDrawing } from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { goneSources } from '../../src/store/goneSources.js';
import { movedRows } from '../../src/store/movedRows.js';
import { countOf, isEmpty, type Seen, seenIn, unsyncedIn } from '../../src/store/unsynced.js';
import { createDexieSyncStore, UnboundConnectionError } from '../../src/sync/store.js';
import { holdCredential } from '../support/connection.js';
import { freshDatabase } from '../support/db.js';
import { folderOf, importedFile, svgOf } from '../support/drawingRows.js';

/**
 * Letting a source go. The remote is the source of truth, so what it has leaves
 * the device; what it was never sent stays, under the source it was written in,
 * detached and in sight; and nothing a disconnect does fills the device's own
 * pile or reaches another account (docs/ARCHITECTURE.md §6, §10).
 */

const ADA = { connectionId: 'c-ada', provider: 'dropbox', accountId: 'dbid:ada' } as const;
const BOB = { connectionId: 'c-bob', provider: 'dropbox', accountId: 'dbid:bob' } as const;
const ada = { connectionId: ADA.connectionId };

/** Ada's source, live: bound, holding a credential, a cursor, a root and a token. */
const connected = async () => {
	const db = freshDatabase();
	await bindConnection(db, { ...ADA, displayName: 'ada@example.com' });
	await holdCredential(db, ADA.connectionId);
	await db.syncState.update(ADA.connectionId, {
		cursor: 'cursor-1',
		rootId: 'root-1',
		lastSyncAt: 5,
		accessToken: 'token-1',
		accessTokenExpiresAt: 10,
	});
	return db;
};

/**
 * A drawing as a pull leaves it: clean, with a file on the remote, and nothing
 * queued — in a folder, where it has one, that the pull named too.
 */
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

const pathsUnder = async (db: DrawDatabase, connectionId: string) =>
	(await db.drawings.where('connectionId').equals(connectionId).toArray())
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

/** What the user was shown of a source: everything it holds, as it stands now. */
const shownNow = async (db: DrawDatabase, connectionId: string = ADA.connectionId): Promise<Seen> =>
	seenIn(await unsyncedIn(db, connectionId));

const NOTHING_SEEN: Seen = {
	drawings: new Map(),
	folders: new Set(),
	rmdirs: new Set(),
	files: new Set(),
};

describe('letting a source go', () => {
	it('removes what the remote has, and the source with it when that is everything', async () => {
		const db = await connected();
		await pushed(db, 'Work/plan.svg');
		await pushed(db, 'loose.svg');
		// A tombstone that never had a file owes nothing, and a stuck op left over
		// for a row long purged stands for nothing the user made.
		const never = await createDrawing(db, { ...ada, title: 'Never' });
		await deleteDrawing(db, never.id, ada);
		await db.opQueue.add({
			...ada,
			op: 'write',
			drawingId: 'purged-long-ago',
			path: 'purged.svg',
			attempts: 99,
			lastError: 'boom',
			queuedAt: 0,
		});
		expect(isEmpty(await unsyncedIn(db, ADA.connectionId))).toBe(true);

		expect(await detachConnection(db, { connectionId: ADA.connectionId })).toBe(true);

		expect(await db.drawings.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);
		expect(await credentialFor(db, ADA.connectionId)).toBeUndefined();
		expect(await db.prefs.get(ACTIVE_CONNECTION_KEY)).toBeUndefined();
		expect(await activeConnectionId(db)).toBe(LOCAL_CONNECTION_ID);
	});

	it('leaves the source detached: named as it was, reaching nothing, still in front', async () => {
		const db = await connected();
		await createDrawing(db, { ...ada, title: 'Unsent' });
		const before = await db.syncState.get(ADA.connectionId);
		const started = Date.now();

		await detachConnection(db, { connectionId: ADA.connectionId });

		const state = await db.syncState.get(ADA.connectionId);
		expect(state).toEqual({
			connectionId: ADA.connectionId,
			provider: 'dropbox',
			accountId: 'dbid:ada',
			displayName: 'ada@example.com',
			clientId: before?.clientId,
			detached: { at: state?.detached?.at, reason: 'revoked' },
		});
		expect(state?.detached?.at).toBeGreaterThanOrEqual(started);
		expect(await credentialFor(db, ADA.connectionId)).toBeUndefined();
		// The user is looking at what they have to decide about.
		expect(await activeConnectionId(db)).toBe(ADA.connectionId);

		// Let go again — another tab reconciling — it is what it was, time included.
		await detachConnection(db, { connectionId: ADA.connectionId, reason: 'interrupted' });
		expect(await db.syncState.get(ADA.connectionId)).toEqual(state);
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['unsent.svg']);
	});

	it('keeps everything while a resumed source has not been verified', async () => {
		const db = await connected();
		await pushed(db, 'Work/plan.svg');
		await pushed(db, 'loose.svg');
		await db.syncState.update(ADA.connectionId, { resumeUnverified: true });

		await detachConnection(db, { connectionId: ADA.connectionId });

		// Clean and linked as they look, nobody has found their files: a memory.
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['Work/plan.svg', 'loose.svg']);
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Work']);
		// And still said to be, so that nothing later counts them as safely sent.
		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			resumeUnverified: true,
			detached: { reason: 'revoked' },
		});
		expect((await unsyncedIn(db, ADA.connectionId)).drawings).toHaveLength(2);
	});

	it('touches nothing of another source, and never fills the device’s own pile', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		await holdCredential(db, BOB.connectionId);
		await pushed(db, 'Work/his.svg', BOB.connectionId);
		const hisUnsent = await createDrawing(db, { connectionId: BOB.connectionId, title: 'His' });
		// The same id in both, as a folder copied between two accounts has.
		await db.drawings.add({ ...hisUnsent, connectionId: ADA.connectionId, path: 'hers.svg' });
		await pushed(db, 'Work/hers-sent.svg');
		const bobBefore = {
			drawings: await db.drawings.where('connectionId').equals(BOB.connectionId).toArray(),
			folders: await db.folders.where('connectionId').equals(BOB.connectionId).toArray(),
			ops: await db.opQueue.where('connectionId').equals(BOB.connectionId).toArray(),
			state: await db.syncState.get(BOB.connectionId),
		};

		// In turn, which is what used to fill one pile with two accounts' drawings.
		await detachConnection(db, { connectionId: ADA.connectionId });

		expect(await db.drawings.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.drawings
		);
		expect(await db.folders.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.folders
		);
		expect(await db.opQueue.where('connectionId').equals(BOB.connectionId).toArray()).toEqual(
			bobBefore.ops
		);
		expect(await db.syncState.get(BOB.connectionId)).toEqual(bobBefore.state);
		expect(await credentialFor(db, BOB.connectionId)).toBeDefined();
		// Bob's is the source showing, and stays so.
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);

		await detachConnection(db, { connectionId: BOB.connectionId });

		// Each kept its own, under its own name.
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['hers.svg']);
		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['his.svg']);
		expect(await pathsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await foldersUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
		expect(await opsUnder(db, LOCAL_CONNECTION_ID)).toEqual([]);
	});

	it('changes nothing when it did not happen', async () => {
		const db = await connected();
		const sent = await pushed(db, 'sent.svg');

		expect(
			await detachConnection(db, { connectionId: ADA.connectionId, ifUnchangedSince: -1 })
		).toBe(false);

		expect(await getDrawing(db, sent.id, ada)).toBeDefined();
		expect(goneSources.recall(ADA.connectionId)).toBeUndefined();
	});

	it('is refused by the sync store from then on, as a source that has gone is', async () => {
		const db = await connected();
		await createDrawing(db, { ...ada, title: 'Unsent' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		const store = createDexieSyncStore(db, ada);

		// A run that was at the network when the source was let go, landing now:
		// it would bring back what was just removed, and put a cursor on the row.
		await expect(
			store.applyChanges({
				changes: [
					{
						kind: 'upsert-drawing',
						id: 'n1',
						path: 'back.svg',
						content: 'x\n',
						remote: {
							remoteId: 'r:back',
							path: 'back.svg',
							kind: 'file',
							version: 'v1',
							modifiedAt: '2026-01-01T00:00:00.000Z',
							size: 2,
						},
						syncedHash: 'hash',
					},
				],
				cursor: 'cursor-2',
			})
		).rejects.toThrow(UnboundConnectionError);

		expect((await db.syncState.get(ADA.connectionId))?.cursor).toBeUndefined();
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(['unsent.svg']);
	});

	it('is listed for what it is, and what it holds counted apart', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		await createFolder(db, 'New', ada);
		await createDrawing(db, { ...ada, folderPath: 'New', title: 'One' });
		await createDrawing(db, { ...ada, title: 'Two' });
		await detachConnection(db, { connectionId: ADA.connectionId });

		expect(await connectedSources(db)).toEqual([
			{
				connectionId: ADA.connectionId,
				provider: 'dropbox',
				accountId: 'dbid:ada',
				displayName: 'ada@example.com',
				active: false,
				detached: true,
			},
			{
				connectionId: BOB.connectionId,
				provider: 'dropbox',
				accountId: 'dbid:bob',
				// A live source says when it was bound, which is what puts the
				// tabs in the order the user made them. Ada's went with her
				// binding, which is why she has none here.
				boundAt: expect.any(Number) as number,
				active: true,
			},
		]);
		// The two drawings. The folder goes up with the drawing inside it.
		expect(countOf(await unsyncedIn(db, ADA.connectionId))).toBe(2);
	});

	it('is listed without a read of its drawings, which every sync run would repeat', async () => {
		const db = await connected();
		await bindConnection(db, BOB);
		await createDrawing(db, { ...ada, title: 'One' });
		await createDrawing(db, { ...ada, title: 'Two' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		const read: string[] = [];
		const reading = (drawing: DrawingRecord) => {
			read.push(drawing.connectionId);
			return drawing;
		};
		db.drawings.hook('reading', reading);
		try {
			expect((await connectedSources(db)).map((source) => source.connectionId)).toContain(
				ADA.connectionId
			);
		} finally {
			db.drawings.hook('reading').unsubscribe(reading);
		}

		expect(read).toEqual([]);
	});
});

describe('discarding what a detached source holds', () => {
	const detachedWith = async (titles: readonly string[]) => {
		const db = await connected();
		await pushed(db, 'sent.svg');
		const drawings = await titles.reduce<Promise<DrawingRecord[]>>(
			async (sofar, title) => [...(await sofar), await createDrawing(db, { ...ada, title })],
			Promise.resolve([])
		);
		await detachConnection(db, { connectionId: ADA.connectionId });
		return { db, drawings };
	};

	it('takes everything, the source included, when all of it was shown', async () => {
		const { db, drawings } = await detachedWith(['One', 'Two']);
		await createFolder(db, 'Empty', ada);

		const seen = await shownNow(db);
		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		expect(outcome).toBe('released');
		expect(await db.drawings.count()).toBe(0);
		expect(await db.folders.count()).toBe(0);
		expect(await db.opQueue.count()).toBe(0);
		expect(await db.syncState.count()).toBe(0);
		expect(await db.prefs.get(ACTIVE_CONNECTION_KEY)).toBeUndefined();
		expect(drawings).toHaveLength(2);
	});

	it('never reaches text the user was not shown: it is kept, and the source stays', async () => {
		const { db, drawings } = await detachedWith(['One', 'Two']);
		const seen = await shownNow(db);
		// Another tab, after the list was put in front of the user.
		await createFolder(db, 'Late', ada);
		const late = await createDrawing(db, { ...ada, folderPath: 'Late', title: 'Typed since' });
		// And into a drawing that *was* on the list — the same drawing, by name, but
		// not as it was shown: a chapter the user never saw go on the list.
		await saveDrawing(db, drawings[0]!.id, svgOf('# One\n\nan hour of work\n'), ada);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		expect(outcome).toBe('detached');
		expect(await pathsUnder(db, ADA.connectionId)).toEqual(
			[late.path, drawings[0]!.path].sort()
		);
		expect((await db.drawings.get([ADA.connectionId, drawings[0]!.id]))?.text).toContain(
			'# One\n\nan hour of work\n'
		);
		expect(await db.drawings.get([ADA.connectionId, drawings[1]!.id])).toBeUndefined();
		expect(await foldersUnder(db, ADA.connectionId)).toEqual(['Late']);
		expect(await opsUnder(db, ADA.connectionId)).toEqual(
			expect.arrayContaining([
				'mkdir Late',
				`write ${late.path}`,
				`write ${drawings[0]!.path}`,
			])
		);
		expect((await db.syncState.get(ADA.connectionId))?.detached).toBeDefined();
	});

	it('discards nothing at all when nothing was shown', async () => {
		const { db, drawings } = await detachedWith(['One']);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen: NOTHING_SEEN,
		});

		expect(outcome).toBe('detached');
		expect(await db.drawings.get([ADA.connectionId, drawings[0]!.id])).toEqual(drawings[0]);
	});

	it('refuses a source that has been connected again meanwhile', async () => {
		const { db, drawings } = await detachedWith(['One']);
		const seen = await shownNow(db);
		// Another tab, while the question was open.
		await holdCredential(db, ADA.connectionId);
		await bindConnection(db, ADA);
		const state = await db.syncState.get(ADA.connectionId);

		const outcome = await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen,
		});

		// Live, and left alone: its rows are the remote's now, and taking them
		// with the credential would strand the connection on the server.
		expect(outcome).toBe('reconnected');
		expect(await db.drawings.get([ADA.connectionId, drawings[0]!.id])).toEqual(drawings[0]);
		expect(await db.syncState.get(ADA.connectionId)).toEqual(state);
		expect(await credentialFor(db, ADA.connectionId)).toBeDefined();
	});

	it('leaves every other source exactly as it was', async () => {
		const { db, drawings } = await detachedWith(['One']);
		await bindConnection(db, BOB);
		const his = await createDrawing(db, { connectionId: BOB.connectionId, title: 'His' });
		// Same id, other source: a `seen` that named it by id alone would reach it.
		await db.drawings.add({
			...drawings[0]!,
			connectionId: BOB.connectionId,
			path: 'copy.svg',
		});

		await releaseConnection(db, {
			connectionId: ADA.connectionId,
			unsynced: 'discard',
			seen: await shownNow(db),
		});

		expect(await pathsUnder(db, BOB.connectionId)).toEqual(['copy.svg', his.path].sort());
		expect(await db.syncState.get(BOB.connectionId)).toBeDefined();
		expect(await opsUnder(db, BOB.connectionId)).toEqual([`write ${his.path}`]);
	});
});

describe('connecting again after a source was detached', () => {
	/** Ada's source detached, holding one edited drawing that was pushed and one that never was. */
	const detached = async () => {
		const db = await connected();
		await pushed(db, 'sent.svg');
		const edited = await pushed(db, 'Work/edited.svg');
		await saveDrawing(db, edited.id, svgOf('# edited\n\nmore\n'), ada);
		const fresh = await createDrawing(db, { ...ada, title: 'Fresh' });
		await detachConnection(db, { connectionId: ADA.connectionId });
		const ops = await opsUnder(db, ADA.connectionId);
		return { db, edited, fresh, ops };
	};

	it('under the same connection id: live again where it stands, and unverified', async () => {
		const { db, edited, fresh, ops } = await detached();
		const clientId = (await db.syncState.get(ADA.connectionId))?.clientId;

		await bindConnection(db, ADA);

		const state = await db.syncState.get(ADA.connectionId);
		expect(state?.detached).toBeUndefined();
		// A kept row still names a file, so the remote is looked at before any scan.
		expect(state?.resumeUnverified).toBe(true);
		expect(state?.cursor).toBeUndefined();
		expect(state).toMatchObject({ displayName: 'ada@example.com', clientId });
		expect(await db.drawings.get([ADA.connectionId, edited.id])).toMatchObject({
			remoteId: edited.remoteId,
			remoteVersion: 'v1',
			dirty: 1,
		});
		expect(await db.drawings.get([ADA.connectionId, fresh.id])).toBeDefined();
		// What was queued is still queued, once: nothing is owed twice.
		expect(await opsUnder(db, ADA.connectionId)).toEqual(ops);
		expect(await activeConnectionId(db)).toBe(ADA.connectionId);
	});

	it('under the same id with nothing linked: nothing to verify', async () => {
		const db = await connected();
		const fresh = await createDrawing(db, { ...ada, title: 'Fresh' });
		// From before writers queued anything: kept, and owed a write all the same.
		await db.opQueue.clear();
		await detachConnection(db, { connectionId: ADA.connectionId });

		await bindConnection(db, ADA);

		expect((await db.syncState.get(ADA.connectionId))?.resumeUnverified).toBeUndefined();
		expect(await opsUnder(db, ADA.connectionId)).toEqual([`write ${fresh.path}`]);
	});

	it('under a new id for the same account: the rows go home, and the old source goes', async () => {
		const { db, edited, fresh, ops } = await detached();

		await bindConnection(db, { ...ADA, connectionId: 'c-ada-2' });

		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
		expect(await pathsUnder(db, ADA.connectionId)).toEqual([]);
		expect(await foldersUnder(db, ADA.connectionId)).toEqual([]);
		expect(await opsUnder(db, ADA.connectionId)).toEqual([]);
		expect(await db.drawings.get(['c-ada-2', edited.id])).toMatchObject({
			remoteId: edited.remoteId,
			remoteVersion: 'v1',
			dirty: 1,
			path: 'Work/edited.svg',
		});
		expect(await db.drawings.get(['c-ada-2', fresh.id])).toBeDefined();
		expect(await foldersUnder(db, 'c-ada-2')).toEqual(['Work']);
		expect(await opsUnder(db, 'c-ada-2')).toEqual(ops);
		const state = await db.syncState.get('c-ada-2');
		expect(state?.resumeUnverified).toBe(true);
		expect(state?.detached).toBeUndefined();
		expect(await activeConnectionId(db)).toBe('c-ada-2');
	});

	it('into the same account already live under another id: its rows yield to the pulled ones', async () => {
		const db = await connected();
		const edited = await pushed(db, 'edited.svg');
		await saveDrawing(db, edited.id, svgOf('# edited\n\nmine, here\n'), ada);
		const renamed = await pushed(db, 'renamed.svg');
		await db.opQueue.add({
			...ada,
			op: 'move',
			drawingId: renamed.id,
			path: 'renamed.svg',
			targetPath: 'moved.svg',
			attempts: 0,
			queuedAt: 0,
		});
		await db.drawings.update([ADA.connectionId, renamed.id], { path: 'moved.svg' });
		const doomed = await pushed(db, 'doomed.svg');
		await deleteDrawing(db, doomed.id, ada);
		await detachConnection(db, { connectionId: ADA.connectionId });
		// The same account, connected again under a new id in another tab, which
		// has since pulled the same three files; this tab's bind lands after.
		const AGAIN = { ...ADA, connectionId: 'c-ada-2' };
		await db.syncState.put({ ...AGAIN, clientId: 'client', cursor: 'cursor-2' });
		// The same drawings, as the pull under the new id left them: same id, same
		// file, a newer version.
		const later = async (drawing: DrawingRecord, path: string): Promise<DrawingRecord> => {
			const row: DrawingRecord = {
				...drawing,
				connectionId: AGAIN.connectionId,
				path,
				text: svgOf(`# ${path}\n\nchanged there\n`, drawing.id),
				dirty: 0,
				deletedLocally: 0,
				remoteVersion: 'v2',
			};
			await db.drawings.put(row);
			return row;
		};
		const theirs = {
			edited: await later(edited, 'edited.svg'),
			renamed: await later(renamed, 'renamed.svg'),
			doomed: await later(doomed, 'doomed.svg'),
		};

		await bindConnection(db, AGAIN);

		// One row per file. The pulled row is the file's, untouched.
		expect(await db.drawings.get([AGAIN.connectionId, edited.id])).toEqual(theirs.edited);
		expect(await db.drawings.get([AGAIN.connectionId, renamed.id])).toEqual(theirs.renamed);
		expect(await db.drawings.get([AGAIN.connectionId, doomed.id])).toEqual(theirs.doomed);
		// The edit survives beside it, as a conflict copy: fresh id, no file,
		// owed a write; and an editor still open on it is pointed at the copy.
		const rows = await db.drawings.where('connectionId').equals(AGAIN.connectionId).toArray();
		const copy = rows.find((drawing) => drawing.text.includes('# edited\n\nmine, here\n'));
		expect(copy).toMatchObject({ dirty: 1, deletedLocally: 0 });
		expect(copy?.id).not.toBe(edited.id);
		expect(copy?.remoteId).toBeUndefined();
		expect(copy?.path).toMatch(/^edited \(conflict .*\)\.svg$/);
		expect(movedRows.whereNow(edited)).toEqual([AGAIN.connectionId, copy?.id]);
		// The rename and the delete held no text, and are dropped in favour of
		// the file as it is; an editor on either lands on the pulled row.
		expect(rows).toHaveLength(4);
		expect(await opsUnder(db, AGAIN.connectionId)).toEqual([`write ${copy?.path ?? ''}`]);
		expect(movedRows.whereNow(renamed)).toEqual([AGAIN.connectionId, renamed.id]);
		expect(movedRows.whereNow(doomed)).toEqual([AGAIN.connectionId, doomed.id]);
		expect(await db.syncState.get(ADA.connectionId)).toBeUndefined();
	});

	it('another account absorbs nothing: the detached source stays exactly as it is', async () => {
		const { db, ops } = await detached();
		const before = {
			drawings: await db.drawings.where('connectionId').equals(ADA.connectionId).toArray(),
			folders: await db.folders.where('connectionId').equals(ADA.connectionId).toArray(),
			state: await db.syncState.get(ADA.connectionId),
		};

		await bindConnection(db, BOB);

		expect(await db.drawings.where('connectionId').equals(ADA.connectionId).toArray()).toEqual(
			before.drawings
		);
		expect(await db.folders.where('connectionId').equals(ADA.connectionId).toArray()).toEqual(
			before.folders
		);
		expect(await db.syncState.get(ADA.connectionId)).toEqual(before.state);
		expect(await opsUnder(db, ADA.connectionId)).toEqual(ops);
		// Bob's source is new and empty, and nothing is owed to it.
		expect(await pathsUnder(db, BOB.connectionId)).toEqual([]);
		expect(await opsUnder(db, BOB.connectionId)).toEqual([]);
		expect((await db.syncState.get(BOB.connectionId))?.resumeUnverified).toBeUndefined();
		// Connecting is choosing: Bob's is in front, Ada's still listed behind it.
		expect(await activeConnectionId(db)).toBe(BOB.connectionId);
		expect((await connectedSources(db)).map((source) => source.connectionId)).toEqual([
			ADA.connectionId,
			BOB.connectionId,
		]);
	});

	it('nor does an account the server does not name', async () => {
		const { db } = await detached();

		await bindConnection(db, { connectionId: 'c-unnamed', provider: 'dropbox' });

		expect(await db.syncState.get(ADA.connectionId)).toMatchObject({
			detached: { reason: 'revoked' },
		});
		expect(await pathsUnder(db, 'c-unnamed')).toEqual([]);
	});
});
