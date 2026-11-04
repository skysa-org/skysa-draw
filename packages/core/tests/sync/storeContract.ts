import { describe, expect, it } from 'vitest';

import type { RemoteEntry } from '../../src/providers/types.js';
import { conflictContent } from '../../src/sync/document.js';
import type {
	NewSyncOp,
	SyncDrawing,
	SyncFile,
	SyncFolder,
	SyncStore,
} from '../../src/sync/store.js';
import { svg } from './kit/drawings.js';

/**
 * What any `SyncStore` has to do, whatever it is built on. The engine's
 * correctness rests on promises the port makes but the type cannot state — that
 * a pull batch commits all at once, that a folder move drags the queued ops
 * with it, that a drawing stays dirty if it changed while it was being pushed —
 * and an implementation that quietly drops one of them loses an edit somewhere
 * far away from itself.
 *
 * Deliberately not a `*.test.ts`: `vitest.config.ts` collects only those, so
 * this runs where it is registered rather than twice.
 */

export interface StoreHarness {
	store: SyncStore;
	/** Seed a drawing directly, bypassing the engine. */
	seed: (
		drawing: Omit<SyncDrawing, 'dirty'> & Partial<Pick<SyncDrawing, 'dirty'>>
	) => void | Promise<void>;
	/**
	 * Put a drawing under this id where the store cannot show it to the engine:
	 * another connection's, on a device that holds more than one.
	 */
	seedElsewhere: (id: string) => void | Promise<void>;
	seedFolder: (folder: SyncFolder) => void | Promise<void>;
	/**
	 * Seed a file row, and the bytes held for it: `pinned` until they are
	 * uploaded, or cached under `version`.
	 */
	seedFile: (
		file: SyncFile,
		bytes?: { bytes: Uint8Array<ArrayBuffer>; version?: string; pinned?: boolean }
	) => void | Promise<void>;
	/** Take a file row away, as the user deleting it does. */
	dropFile: (id: string) => void | Promise<void>;
	/** Queue an op and return the seq it was given. */
	seedOp: (op: NewSyncOp) => number | Promise<number>;
	/** Take a queued op back out, as a later change of the user's does. */
	withdrawOp: (seq: number) => void | Promise<void>;
}

const remote = (path: string, id = 'r1', version = 'v1'): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'file',
	version,
	modifiedAt: '2026-01-01T00:00:00.000Z',
	size: 1,
});

const folder = (path: string, id: string): RemoteEntry => ({
	remoteId: id,
	path,
	kind: 'folder',
	version: 'v1',
	modifiedAt: '2026-01-01T00:00:00.000Z',
});

export const describeSyncStoreContract = (
	name: string,
	create: () => StoreHarness | Promise<StoreHarness>
): void => {
	describe(`SyncStore contract: ${name}`, () => {
		const harness = create;

		describe('an id another connection holds too', () => {
			// The id a file arrives claiming is whatever its `draw:id` says, and
			// the same folder in two accounts is enough for two connections to
			// hold one. An id names a drawing within its connection.
			it('shows the engine nothing of the other drawing', async () => {
				const { store, seedElsewhere } = await harness();
				await seedElsewhere('n1');
				expect(await store.drawingById('n1')).toBeUndefined();
				expect(await store.allDrawings()).toEqual([]);
			});

			it('takes a drawing of its own under that id, and the batch with it', async () => {
				const { store, seedElsewhere } = await harness();
				await seedElsewhere('n1');
				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('x\n'),
							remote: remote('a.svg'),
							syncedHash: 'h1',
						},
					],
					cursor: 'c1',
				});
				expect(await store.cursor()).toBe('c1');
				expect((await store.drawingById('n1'))?.path).toBe('a.svg');
			});
		});

		describe('the bytes a drawing last synced', () => {
			// What tells a remote rename from a remote edit on a provider whose
			// version changes on a move. A store that drops it is correct in every
			// other way and hands the user a conflict copy for every such rename.
			const hashOf = async (store: SyncStore, id: string) =>
				(await store.drawingById(id))?.syncedHash;

			it('reads back what was seeded', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('x\n'),
					remoteId: 'r1',
					syncedHash: 'h1',
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
			});

			it('records it with a drawing a pull brings in', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('x\n'),
							remote: remote('a.svg'),
							syncedHash: 'h1',
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
			});

			it('replaces it when a version or move names one, and keeps it when not', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('x\n'),
					remoteId: 'r1',
					syncedHash: 'h1',
					dirty: true,
				});
				await seed({
					id: 'n2',
					path: 'b.svg',
					content: svg('y\n'),
					remoteId: 'r2',
					syncedHash: 'h2',
				});

				await store.applyChanges({
					changes: [
						{ kind: 'adopt-version', id: 'n1', remote: remote('a.svg', 'r1', 'v2') },
						{
							kind: 'move-drawing',
							id: 'n2',
							path: 'c.svg',
							remote: remote('c.svg', 'r2', 'v2'),
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h1');
				expect(await hashOf(store, 'n2')).toBe('h2');

				await store.applyChanges({
					changes: [
						{
							kind: 'adopt-version',
							id: 'n1',
							remote: remote('a.svg', 'r1', 'v3'),
							syncedHash: 'h3',
						},
						{
							kind: 'move-drawing',
							id: 'n2',
							path: 'd.svg',
							remote: remote('d.svg', 'r2', 'v3'),
							syncedHash: 'h4',
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('h3');
				expect(await hashOf(store, 'n2')).toBe('h4');
				// And an edit waiting to go out is still waiting.
				expect((await store.drawingById('n1'))?.dirty).toBe(true);
			});

			it('takes the remote\u2019s with the remote\u2019s bytes in a conflict, and gives the copy none', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					syncedHash: 'old',
					dirty: true,
				});
				await store.applyChanges({
					changes: [
						{
							kind: 'conflict',
							resolution: {
								drawingId: 'n1',
								remoteContent: svg('theirs\n'),
								remoteHash: 'theirs',
								remote: remote('a.svg', 'r1', 'v2'),
								copyId: 'c1',
								copyPath: 'a (conflict).svg',
								copyContent: conflictContent(svg('mine\n'), 'c1'),
							},
						},
					],
				});
				expect(await hashOf(store, 'n1')).toBe('theirs');
				expect(await hashOf(store, 'c1')).toBeUndefined();
			});

			it('records what a push sent, even when the drawing has moved on since', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('x and more\n'),
					syncedHash: 'old',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.completeOp(seq, {
					kind: 'pushed',
					drawingId: 'n1',
					remote: remote('a.svg', 'r1', 'v2'),
					content: svg('x\n'),
					syncedHash: 'sent',
				});
				expect(await hashOf(store, 'n1')).toBe('sent');
			});

			it('forgets it with the remote, when a drawing is detached or its folder goes', async () => {
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('x\n'),
					remoteId: 'r1',
					syncedHash: 'h1',
					dirty: true,
				});
				await seed({
					id: 'n2',
					path: 'Work/b.svg',
					content: svg('y\n'),
					remoteId: 'r2',
					syncedHash: 'h2',
					dirty: true,
				});

				await store.applyChanges({
					changes: [
						{ kind: 'detach-drawing', id: 'n1' },
						{ kind: 'delete-folder', path: 'Work' },
					],
				});
				expect(await hashOf(store, 'n1')).toBeUndefined();
				expect(await hashOf(store, 'n2')).toBeUndefined();
			});
		});

		describe('reading', () => {
			it('still answers for a drawing whose delete is still queued', async () => {
				// The op carries only a `drawingId`, and the `remoteId` it needs to
				// remove the file lives on the row. A store that hid the row the
				// moment the user pressed delete would have the engine find
				// nothing, finish the op as though there were nothing to send,
				// and leave the file on the remote for ever.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({ op: 'delete', drawingId: 'n1', path: 'a.svg' });

				expect((await store.drawingById('n1'))?.remoteId).toBe('r1');
				// Every read, not just this one. A store with a `deleted` flag
				// and filtered indexes satisfies `drawingById` alone and still
				// loses a drawing the first time one is deleted here and edited on
				// another device: the pull cannot see the row, mints a second
				// drawing at that path, and the queued delete removes the file that
				// was just imported.
				expect((await store.drawingByPath('a.svg'))?.id).toBe('n1');
				expect((await store.drawingByRemoteId('r1'))?.id).toBe('n1');
				expect((await store.allDrawings()).map((drawing) => drawing.id)).toContain('n1');
				expect((await store.drawingsUnder('')).map((drawing) => drawing.id)).toContain(
					'n1'
				);

				// And it goes when the op says the remote copy is gone, not before.
				await store.completeOp(seq, { kind: 'purged', drawingId: 'n1' });
				expect(await store.drawingById('n1')).toBeUndefined();
				expect(await store.drawingByPath('a.svg')).toBeUndefined();
			});

			it('finds a drawing by id, path and remote id', async () => {
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), remoteId: 'r1' });

				expect((await store.drawingById('n1'))?.path).toBe('a.svg');
				expect((await store.drawingByPath('a.svg'))?.id).toBe('n1');
				expect((await store.drawingByRemoteId('r1'))?.id).toBe('n1');
			});

			it('answers undefined rather than throwing for something absent', async () => {
				const { store } = await harness();

				expect(await store.drawingById('nope')).toBeUndefined();
				expect(await store.drawingByPath('nope.svg')).toBeUndefined();
				expect(await store.drawingByRemoteId('nope')).toBeUndefined();
				expect(await store.folderByRemoteId('nope')).toBeUndefined();
			});

			it('lists every drawing in the store for the root', async () => {
				// The root is asked for by name — every loose drawing's parent is
				// the root — and an implementation that reads `folderPath` as a
				// prefix and answers `startsWith(folderPath + '/')` returns
				// nothing for it. A conflict copy at the root then stops
				// avoiding names already taken and overwrites the copy there.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'loose.svg', content: svg('x\n') });
				await seed({ id: 'n2', path: 'Work/a.svg', content: svg('x\n') });

				const under = await store.drawingsUnder('');
				expect(under.map((drawing) => drawing.id).sort()).toEqual(['n1', 'n2']);
			});

			it('lists drawings beneath a folder at every depth', async () => {
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n') });
				await seed({ id: 'n2', path: 'Work/Deep/b.svg', content: svg('x\n') });
				await seed({ id: 'n3', path: 'Other/c.svg', content: svg('x\n') });

				const under = await store.drawingsUnder('Work');
				expect(under.map((drawing) => drawing.id).sort()).toEqual(['n1', 'n2']);
			});

			it('finds a folder by path and by remote id', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });

				expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
				expect((await store.folderByRemoteId('f1'))?.path).toBe('Work');
				expect(await store.folderByPath('Nope')).toBeUndefined();
			});

			it('lists only the folders that have reached the remote', async () => {
				// What a rescan reconciles against. A folder created here and not
				// pushed yet was never in the scan, so treating it as missing
				// would delete a folder the moment the cursor died.
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Fresh' });

				expect((await store.foldersWithRemote()).map((folder) => folder.path)).toEqual([
					'Work',
				]);
			});

			it('records a folder’s id when its mkdir lands', async () => {
				// Until this, only a pull ever set one, so a folder made here
				// had no id until the remote reported it back — and an `rmdir`
				// queued for it in between could name no folder.
				const { store, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work' });
				const seq = await seedOp({ op: 'mkdir', path: 'Work' });

				await store.completeOp(seq, {
					kind: 'made-folder',
					path: 'Work',
					remote: folder('Work', 'f9'),
				});

				expect((await store.folderByPath('Work'))?.remoteId).toBe('f9');
				expect(await store.opBySeq(seq)).toBeUndefined();
			});

			it('leaves a folder the mkdir’s path no longer names alone', async () => {
				// Renamed here while the `mkdir` was at the network: the id is
				// the folder at the old name, which the rename's own `mkdir` and
				// `rmdir` are about. Written onto the row that is there now, the
				// folder would point at a directory it is not in.
				const { store, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Later' });
				const seq = await seedOp({ op: 'mkdir', path: 'Work' });

				await store.completeOp(seq, {
					kind: 'made-folder',
					path: 'Work',
					remote: folder('Work', 'f9'),
				});

				expect(await store.folderByPath('Work')).toBeUndefined();
				expect((await store.folderByPath('Later'))?.remoteId).toBeUndefined();
			});

			it('hands the engine an rmdir with the id it was queued with', async () => {
				// The row is gone by the time it runs — that is what it is for —
				// so the op is the only thing that says which folder it means.
				const { store, seedOp } = await harness();
				const seq = await seedOp({ op: 'rmdir', path: 'Work', remoteId: 'f1' });

				const ops = await store.pendingOps();
				expect(ops).toMatchObject([{ op: 'rmdir', path: 'Work', remoteId: 'f1' }]);
				expect(await store.opBySeq(seq)).toMatchObject({ remoteId: 'f1' });
			});

			it('has no cursor before the first pull', async () => {
				const { store } = await harness();
				expect(await store.cursor()).toBeUndefined();
			});
		});

		describe('applyChanges', () => {
			it('stores a new drawing and the cursor together', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('x\n'),
							remote: remote('a.svg'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				expect((await store.drawingByPath('a.svg'))?.content).toBe(svg('x\n'));
				expect((await store.drawingByPath('a.svg'))?.dirty).toBe(false);
				expect(await store.cursor()).toBe('c1');
			});

			it('leaves the cursor alone when the batch does not carry one', async () => {
				// How a full scan applies its pages: the scan is one logical
				// batch, and a cursor written halfway through claims a scan that
				// has not finished.
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('x\n'),
							remote: remote('a.svg'),
							syncedHash: 'hash',
						},
					],
				});

				expect(await store.drawingByPath('a.svg')).toBeDefined();
				expect(await store.cursor()).toBeUndefined();
			});

			it('writes an updated drawing under the id the engine names', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('old\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
				});
				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('new\n'),
							remote: remote('a.svg', 'r1', 'v2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				const drawing = await store.drawingByPath('a.svg');
				expect(drawing?.id).toBe('n1');
				expect(drawing?.content).toBe(svg('new\n'));
				expect(drawing?.remoteVersion).toBe('v2');
			});

			it('adopts a version without touching anything else', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('x\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyChanges({
					changes: [
						{ kind: 'adopt-version', id: 'n1', remote: remote('a.svg', 'r1', 'v2') },
					],
					cursor: 'c1',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.remoteVersion).toBe('v2');
				expect(drawing?.content).toBe(svg('x\n'));
				expect(drawing?.dirty).toBe(true);
			});

			it('forgets the remote but keeps the drawing when it is detached', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyChanges({
					changes: [{ kind: 'detach-drawing', id: 'n1' }],
					cursor: 'c1',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.content).toBe(svg('mine\n'));
				expect(drawing?.remoteId).toBeUndefined();
				expect(drawing?.remoteVersion).toBeUndefined();
				expect(drawing?.dirty).toBe(true);
			});

			it('sends a clean drawing back up rather than losing it, when the scan may have', async () => {
				// `reupload-drawing`, for the rescan the provider warns about. The
				// drawing has to end up owed a write and bound to nothing: a write
				// against a `remoteVersion` for a file that is not there is
				// refused, and a kept `syncedHash` says these bytes are already
				// up, so nothing would ever send them.
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					syncedHash: 'h1',
				});

				await store.applyChanges({
					changes: [{ kind: 'reupload-drawing', id: 'n1' }],
					cursor: 'c1',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.content).toBe(svg('mine\n'));
				expect(drawing?.dirty).toBe(true);
				expect(drawing?.remoteId).toBeUndefined();
				expect(drawing?.remoteVersion).toBeUndefined();
				expect(drawing?.syncedHash).toBeUndefined();
				expect(
					(await store.pendingOps()).map((op) => ({ op: op.op, path: op.path }))
				).toEqual([{ op: 'write', path: 'a.svg' }]);
			});

			it('makes a folder the scan may have lost again, taking nothing with it', async () => {
				// `reupload-folder` never cascades — that is the whole point.
				// The drawings under it are each named by their own change.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });

				await store.applyChanges({
					changes: [{ kind: 'reupload-folder', path: 'Work' }],
					cursor: 'c1',
				});

				// The row stays; only its file is forgotten. And it drops out of
				// `foldersWithRemote`, which is what stops the *next* scan
				// reconciling it away as a folder the remote no longer has.
				expect((await store.folderByPath('Work'))?.remoteId).toBeUndefined();
				expect(await store.foldersWithRemote()).toEqual([]);
				// Untouched: it was not named, so it keeps the file it has.
				expect((await store.drawingById('n1'))?.remoteId).toBe('r1');
				expect(
					(await store.pendingOps()).map((op) => ({ op: op.op, path: op.path }))
				).toEqual([{ op: 'mkdir', path: 'Work' }]);
			});

			it('forgives a reupload for something it does not have', async () => {
				// A batch is decided before it is applied, and one the store
				// rejects is retried for ever, since the cursor moves with it.
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{ kind: 'reupload-drawing', id: 'nope' },
						{ kind: 'reupload-folder', path: 'Gone' },
					],
					cursor: 'c1',
				});
				expect(await store.cursor()).toBe('c1');
				expect(await store.pendingOps()).toEqual([]);
			});

			it('takes the contents of a folder with it when the folder is deleted', async () => {
				// The engine sends one `delete-folder` and nothing else, because a
				// provider that reports only the folder gives it nothing else to
				// send. A store that deleted just the row would leave every drawing
				// inside it at a path with no folder — invisible in the sidebar,
				// and still claiming a remote file that no longer exists.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Work/Deep', remoteId: 'f2' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });
				await seed({
					id: 'n2',
					path: 'Work/Deep/b.svg',
					content: svg('x\n'),
					remoteId: 'r2',
				});
				await seed({ id: 'n3', path: 'Other/c.svg', content: svg('x\n'), remoteId: 'r3' });

				await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				expect(await store.folderByPath('Work')).toBeUndefined();
				expect(await store.folderByPath('Work/Deep')).toBeUndefined();
				expect(await store.drawingById('n1')).toBeUndefined();
				expect(await store.drawingById('n2')).toBeUndefined();
				expect(await store.drawingById('n3')).toBeDefined();
			});

			it('leaves the drawings a cascade names alone, remote and all', async () => {
				// The drawing is in `Work` because the user moved it there, and the
				// rename has not been pushed: its file is still at `a.svg`, which
				// the folder's deletion says nothing about. Taking the row would
				// lose a drawing the remote still holds — nothing mentions that
				// file again, so only a re-scan would find it.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });
				await seed({ id: 'n2', path: 'Work/b.svg', content: svg('x\n'), remoteId: 'r2' });

				await store.applyChanges({
					changes: [{ kind: 'delete-folder', path: 'Work', keep: ['n1', 'nope'] }],
				});

				const kept = await store.drawingById('n1');
				expect(kept?.path).toBe('Work/a.svg');
				expect(kept?.remoteId).toBe('r1');
				expect(kept?.dirty).toBe(false);
				expect(await store.drawingById('n2')).toBeUndefined();
			});

			it('spares a drawing whose queued rename the batch had not seen', async () => {
				// The engine reads the queue when it decides the batch; the
				// batch lands later, here. A drawing the user moved into the
				// folder in between is named by no `keep`, and its file is
				// still at the path the queued `move` gives — outside the
				// folder, untouched by its deletion.
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });
				await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'Work/a.svg',
				});

				await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				expect((await store.drawingById('n1'))?.remoteId).toBe('r1');
			});

			it('takes one whose queued rename leaves its file inside the folder', async () => {
				// Renamed within the folder, or into it from a subfolder: the
				// file goes with the directory like any other.
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/b.svg', content: svg('x\n'), remoteId: 'r1' });
				await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'Work/a.svg',
					targetPath: 'Work/b.svg',
				});

				await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				expect(await store.drawingById('n1')).toBeUndefined();
			});

			it('takes one whose file was inside the folder under its old name', async () => {
				// The batch renamed the folder and then deleted it, so the
				// path the change names is not the one the file sits under.
				//
				// Hand-built: a real batch orders the `move-folder` first, and
				// applying it rebases the queued op, so the store would see the
				// origin already spelled `Plans/...`. The engine needs `was`
				// because the queue it reads is frozen before the batch; this
				// pins the store's own rule, which does not depend on what else
				// the batch carries or on the order it arrives in.
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Plans', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Plans/b.svg', content: svg('x\n'), remoteId: 'r1' });
				await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'Work/a.svg',
					targetPath: 'Plans/b.svg',
				});

				await store.applyChanges({
					changes: [{ kind: 'delete-folder', path: 'Plans', was: 'Work' }],
				});

				expect(await store.drawingById('n1')).toBeUndefined();
			});

			it('points a queued rename’s origin at where a pull says the file is', async () => {
				// The origin is where the file was when the user renamed it, and
				// it is what says whether a folder deletion is about that file.
				// Another device moving the drawing — here, an `upsert-drawing` that
				// edits and moves it at once — makes it stale, and a stale one
				// spares a drawing whose file has in fact gone with the folder.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'b.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'b.svg',
				});

				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'Work/a.svg',
							content: svg('theirs\n'),
							remote: remote('Work/a.svg', 'r1', 'v2'),
							syncedHash: 'h2',
						},
					],
				});

				const op = await store.opBySeq(seq);
				expect(op?.path).toBe('Work/a.svg');
				// The name the user chose is not what this is about.
				expect(op).toMatchObject({ targetPath: 'b.svg' });
			});

			it('points it there for a version the pull only adopts', async () => {
				// The branch a drawing with a queued rename actually takes when the
				// remote moves its file: the row stays where the user put it,
				// and the file is somewhere else again.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'b.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'b.svg',
				});

				await store.applyChanges({
					changes: [
						{
							kind: 'adopt-version',
							id: 'n1',
							remote: remote('Work/a.svg', 'r1', 'v2'),
						},
					],
				});

				expect((await store.opBySeq(seq))?.path).toBe('Work/a.svg');
				expect((await store.drawingById('n1'))?.path).toBe('b.svg');
			});

			it('keeps an edited drawing when its folder is deleted remotely', async () => {
				// Never lose user data (CLAUDE.md). The folder is gone, but the
				// edit in it was never anywhere else, so the drawing survives as a
				// local one rather than following the folder into the bin.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({
					id: 'n1',
					path: 'Work/a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					dirty: true,
				});

				await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				const drawing = await store.drawingById('n1');
				expect(drawing?.content).toBe(svg('mine\n'));
				expect(drawing?.remoteId).toBeUndefined();
				expect(drawing?.dirty).toBe(true);
			});

			it('makes the folders above a drawing that has none', async () => {
				// The engine emits `ensure-folder` only for folders the remote
				// reported, and a feed that mentions a file without its parent
				// is ordinary. A drawing at a path with no folder behind it is
				// invisible in the sidebar and still holding its name.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n') });

				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n2',
							path: 'Work/Meetings/b.svg',
							content: svg('deep\n'),
							remote: remote('Work/Meetings/b.svg', 'r2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				expect((await store.drawingsUnder('Work')).map((drawing) => drawing.id)).toEqual([
					'n2',
				]);
				expect(await store.folderByPath('Work')).toBeDefined();
				expect(await store.folderByPath('Work/Meetings')).toBeDefined();
			});

			it('keeps a folder its id over an ensure-folder that names none', async () => {
				// The engine puts a row back over the drawings a cascade kept,
				// without an id, and a folder moved onto that path in the same
				// batch already has one. Forgotten, the deletion of that folder
				// by id finds nothing, and the folder stays for ever.
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });

				await store.applyChanges({
					changes: [{ kind: 'ensure-folder', path: 'Work' }],
					cursor: 'c1',
				});

				expect((await store.folderByPath('Work'))?.remoteId).toBe('f1');
			});

			it('moves a displaced drawing without touching its contents', async () => {
				// It is only being got out of the way of a remote drawing landing
				// on its path. The text is the user's, it has never been
				// anywhere else, and it still needs pushing.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });

				await store.applyChanges({
					changes: [{ kind: 'displace-drawing', id: 'n1', path: 'a (conflict x).svg' }],
					cursor: 'c1',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.path).toBe('a (conflict x).svg');
				expect(drawing?.content).toBe(svg('mine\n'));
				expect(drawing?.dirty).toBe(true);
				expect(await store.drawingByPath('a.svg')).toBeUndefined();
			});

			it('holds two drawings at one path while a batch is mid-flight', async () => {
				// A drawing moving out of the way is a change of its own and can
				// come later in the batch. A unique index on `path` would reject
				// this and be retried for ever; making room by deleting what is
				// there takes that drawing's unpushed edits with it.
				const { store, seed } = await harness();
				await seed({ id: 'ours', path: 'a.svg', content: svg('mine\n'), dirty: true });
				await seed({
					id: 'theirs',
					path: 'b.svg',
					content: svg('theirs\n'),
					remoteId: 'r2',
				});

				await store.applyChanges({
					changes: [
						{
							kind: 'move-drawing',
							id: 'theirs',
							path: 'a.svg',
							remote: remote('a.svg', 'r2'),
						},
						{ kind: 'displace-drawing', id: 'ours', path: 'a (conflict x).svg' },
					],
					cursor: 'c1',
				});

				expect((await store.drawingByPath('a.svg'))?.id).toBe('theirs');
				expect((await store.drawingById('ours'))?.content).toBe(svg('mine\n'));
			});

			it('does not make room for an upsert by deleting what is there', async () => {
				// The drawing at that path is about to be moved by a change further
				// down the batch. Deleting it to clear the way takes its unpushed
				// edits with it — and that is the shape of a store that "helps"
				// by enforcing one row per path.
				const { store, seed } = await harness();
				await seed({ id: 'ours', path: 'a.svg', content: svg('mine\n'), dirty: true });
				await seed({
					id: 'theirs',
					path: 'b.svg',
					content: svg('theirs\n'),
					remoteId: 'r2',
				});

				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'theirs',
							path: 'a.svg',
							content: svg('theirs\n'),
							remote: remote('a.svg', 'r2'),
							syncedHash: 'hash',
						},
						{ kind: 'displace-drawing', id: 'ours', path: 'a (conflict x).svg' },
					],
					cursor: 'c1',
				});

				expect((await store.drawingById('ours'))?.content).toBe(svg('mine\n'));
				expect((await store.drawingById('ours'))?.path).toBe('a (conflict x).svg');
				expect((await store.drawingByPath('a.svg'))?.id).toBe('theirs');
			});

			it('points a displaced drawing\u2019s queued ops at where it went', async () => {
				// A queued `move` is the user's rename, and its target is the
				// path the remote has just taken. Left pointing there it
				// conflicts on every push and can never succeed — and since the
				// queue is ordered and a dead op stops the drain, every later op
				// for every other drawing is stranded behind it.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'Groceries.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
				});
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'Untitled.svg',
					targetPath: 'Groceries.svg',
				});

				await store.applyChanges({
					changes: [
						{ kind: 'displace-drawing', id: 'n1', path: 'Groceries (conflict x).svg' },
					],
					cursor: 'c1',
				});

				const op = (await store.pendingOps()).find((each) => each.seq === seq);
				expect(op).toMatchObject({ targetPath: 'Groceries (conflict x).svg' });
			});

			it('leaves another drawing\u2019s ops alone when one is displaced', async () => {
				// Somebody else queued to move into that path is not resolved by
				// this: their op still has a race to lose, and rewriting it would
				// send their drawing somewhere the user never asked for.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('mine\n') });
				await seed({ id: 'n2', path: 'b.svg', content: svg('theirs\n'), remoteId: 'r2' });
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n2',
					path: 'b.svg',
					targetPath: 'a.svg',
				});

				await store.applyChanges({
					changes: [{ kind: 'displace-drawing', id: 'n1', path: 'a (conflict x).svg' }],
					cursor: 'c1',
				});

				const op = (await store.pendingOps()).find((each) => each.seq === seq);
				expect(op).toMatchObject({ targetPath: 'a.svg' });
			});

			it('accepts a displacement of a drawing that is already gone', async () => {
				// Same reasoning as the deletes: a batch the store rejects is
				// retried for ever, because the cursor moves only with it.
				const { store } = await harness();

				await store.applyChanges({
					changes: [{ kind: 'displace-drawing', id: 'nobody', path: 'x.svg' }],
					cursor: 'c1',
				});

				expect(await store.cursor()).toBe('c1');
			});

			it('accepts a delete for a drawing that is already gone', async () => {
				// A provider that reports a folder deletion recursively names the
				// folder and then everything that was in it, and the folder took
				// them already. A store that rejected would fail the batch, and
				// the cursor moves only with the batch — so the same batch would
				// be retried for ever and the user's sync would never recover.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });

				await store.applyChanges({
					changes: [
						{ kind: 'delete-folder', path: 'Work' },
						{ kind: 'delete-drawing', id: 'n1' },
						{ kind: 'detach-drawing', id: 'n1' },
					],
					cursor: 'c1',
				});

				expect(await store.drawingById('n1')).toBeUndefined();
				expect(await store.cursor()).toBe('c1');
			});

			it('applies the changes in the order they are given', async () => {
				// The engine reaches every decision against the store as it was
				// and relies on them being carried out one after another. A
				// store that grouped by kind to batch its writes — all the
				// deletes, then all the puts — would drop the drawing this batch
				// re-establishes, and would look perfectly reasonable doing it.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('old\n'), remoteId: 'r1' });

				await store.applyChanges({
					changes: [
						{ kind: 'delete-drawing', id: 'n1' },
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'a.svg',
							content: svg('new\n'),
							remote: remote('a.svg', 'r2'),
							syncedHash: 'hash',
						},
					],
					cursor: 'c1',
				});

				expect((await store.drawingById('n1'))?.content).toBe(svg('new\n'));
			});

			it('leaves one row at a path an upsert names', async () => {
				// Two drawings at one path is a row the sidebar shows twice and two
				// queued writes racing for one file. The drawing the engine names
				// ends up there; whatever was there before has moved.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('old\n'), remoteId: 'r1' });

				await store.applyChanges({
					changes: [
						{
							kind: 'upsert-drawing',
							id: 'n1',
							path: 'b.svg',
							content: svg('moved\n'),
							remote: remote('b.svg', 'r1'),
							syncedHash: 'hash',
						},
					],
				});

				expect(await store.drawingByPath('a.svg')).toBeUndefined();
				expect((await store.drawingByPath('b.svg'))?.id).toBe('n1');
			});

			it('accepts a delete for a folder that is not there', async () => {
				// Same reasoning as the delete of a drawing that is already gone: a
				// batch that rejects is a batch that is retried for ever.
				const { store } = await harness();

				await store.applyChanges({
					changes: [{ kind: 'delete-folder', path: 'Nowhere' }],
					cursor: 'c1',
				});

				expect(await store.cursor()).toBe('c1');
			});

			describe('a decision about a drawing edited since it was made', () => {
				// The engine reads a drawing, goes to the network for the remote
				// file, and only then hands over the batch. What the user typed in
				// between is in the store and nowhere else.
				const edited = {
					id: 'n1',
					path: 'a.svg',
					content: svg('typed since\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				};

				it('refuses an upsert, rather than overwriting it and calling it clean', async () => {
					const { store, seed } = await harness();
					await seed(edited);

					await expect(
						store.applyChanges({
							changes: [
								{
									kind: 'upsert-drawing',
									id: 'n1',
									path: 'a.svg',
									content: svg('remote\n'),
									remote: remote('a.svg', 'r1', 'v2'),
									syncedHash: 'hash',
								},
							],
							cursor: 'c1',
						})
					).rejects.toThrow();

					const drawing = await store.drawingById('n1');
					expect(drawing?.content).toBe(svg('typed since\n'));
					expect(drawing?.dirty).toBe(true);
					expect(await store.cursor()).toBeUndefined();
				});

				it('refuses a delete', async () => {
					const { store, seed } = await harness();
					await seed(edited);

					await expect(
						store.applyChanges({
							changes: [{ kind: 'delete-drawing', id: 'n1' }],
							cursor: 'c1',
						})
					).rejects.toThrow();

					expect((await store.drawingById('n1'))?.content).toBe(svg('typed since\n'));
				});

				it('makes a conflict copy from the drawing as it stands, not as it was read', async () => {
					// No refusal: the drawing is dirty either way, and refusing would stall
					// every pull for as long as someone keeps typing into it.
					const { store, seed } = await harness();
					await seed(edited);

					await store.applyChanges({
						changes: [
							{
								kind: 'conflict',
								resolution: {
									drawingId: 'n1',
									remoteContent: svg('theirs\n'),
									remoteHash: 'hash',
									remote: remote('a.svg', 'r1', 'v2'),
									copyId: 'c1',
									copyPath: 'a (conflict).svg',
									copyContent: conflictContent(
										svg('what the engine read\n'),
										'c1'
									),
								},
							},
						],
						cursor: 'c1',
					});

					expect((await store.drawingById('c1'))?.content).toBe(
						conflictContent(svg('typed since\n'), 'c1')
					);
				});
			});

			it('rolls the whole batch back when part of it fails', async () => {
				// The cursor and the changes it describes are one promise. A
				// cursor stored ahead of its batch skips work that never
				// happened, and nothing ever asks for it again.
				const { store, seed } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), remoteId: 'r1' });
				await store.applyChanges({ changes: [], cursor: 'c1' });

				await expect(
					store.applyChanges({
						changes: [
							{
								kind: 'upsert-drawing',
								id: 'n2',
								path: 'b.svg',
								content: svg('y\n'),
								remote: remote('b.svg', 'r2'),
								syncedHash: 'hash',
							},
							// Nothing has this id, so a store that checks its
							// inputs rejects — which is the point.
							{ kind: 'adopt-version', id: 'missing', remote: remote('b.svg', 'r2') },
						],
						cursor: 'c2',
					})
				).rejects.toThrow();

				expect(await store.cursor()).toBe('c1');
				expect(await store.drawingByPath('b.svg')).toBeUndefined();
			});
		});

		describe('the files that could not be read', () => {
			// A notice for the user and nothing more, which is why it is worth
			// holding to a contract: nothing else would ever notice it was wrong.
			const listed = async (store: SyncStore): Promise<string[]> =>
				(await store.unreadable()).map((file) => `${file.remoteId} ${file.path}`).sort();

			/** Fails the batch it is put in: nothing has this id. */
			const refused = {
				kind: 'adopt-version',
				id: 'missing',
				remote: remote('missing.svg', 'r9'),
			} as const;

			it('is empty for a store that has been told of none', async () => {
				const { store } = await harness();
				expect(await store.unreadable()).toEqual([]);
			});

			it('lists a file with the batch that found it, cursor and all', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } }],
					cursor: 'c1',
				});
				expect(await store.unreadable()).toEqual([{ remoteId: 'r1', path: 'a.svg' }]);
				expect(await store.cursor()).toBe('c1');
			});

			it('lists one with no cursor in the batch, as a scan’s pages and a push have none', async () => {
				const { store } = await harness();
				await store.applyChanges({ changes: [], cursor: 'c1' });
				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } }],
				});
				expect(await listed(store)).toEqual(['r1 a.svg']);
				expect(await store.cursor()).toBe('c1');
			});

			it('keeps where a drawing of the user’s went, and moves no drawing itself', async () => {
				// `movedAside` is the panel's to say. The drawing it names is moved by
				// the `displace-drawing` in front of this change, not by this.
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{
							kind: 'unreadable',
							file: {
								remoteId: 'r1',
								path: 'a.svg',
								movedAside: ['a (conflict).svg', 'a (conflict)-2.svg'],
							},
						},
					],
				});
				expect(await store.unreadable()).toEqual([
					{
						remoteId: 'r1',
						path: 'a.svg',
						movedAside: ['a (conflict).svg', 'a (conflict)-2.svg'],
					},
				]);
				expect(await store.allDrawings()).toEqual([]);
			});

			it('drops it when the file is listed again without one', async () => {
				// One record per file, replaced whole: the engine carries forward
				// what it means to keep (`leaveUnread`), and the store never
				// merges — a store that did could not be told to stop saying it.
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{
							kind: 'unreadable',
							file: {
								remoteId: 'r1',
								path: 'a.svg',
								movedAside: ['a (conflict).svg'],
							},
						},
					],
				});

				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'b.svg' } }],
				});

				expect(await store.unreadable()).toEqual([{ remoteId: 'r1', path: 'b.svg' }]);
			});

			it('keeps one record per file: the same id again is the file renamed', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'b.svg' } },
					],
				});
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'renamed.svg' } },
					],
				});
				expect(await listed(store)).toEqual(['r1 renamed.svg', 'r2 b.svg']);
			});

			it('keeps two files at one path apart, since the id is what names a file', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'a.svg' } },
					],
				});
				expect(await listed(store)).toEqual(['r1 a.svg', 'r2 a.svg']);
			});

			it('forgets a file by its id, and only that one', async () => {
				const { store } = await harness();
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'b.svg' } },
					],
				});
				await store.applyChanges({
					changes: [{ kind: 'forget-unreadable', remoteId: 'r1' }],
					cursor: 'c1',
				});
				expect(await listed(store)).toEqual(['r2 b.svg']);
				expect(await store.cursor()).toBe('c1');
			});

			it('takes a forget for a file it never listed, and the batch with it', async () => {
				// Same reasoning as the deletes: a batch the store rejects is
				// retried for ever, since the cursor moves only with it.
				const { store } = await harness();
				await store.applyChanges({
					changes: [{ kind: 'forget-unreadable', remoteId: 'never' }],
					cursor: 'c1',
				});
				expect(await store.unreadable()).toEqual([]);
				expect(await store.cursor()).toBe('c1');
			});

			it('applies them in the order given', async () => {
				// A move told as a deletion and then an entry: forgotten, then
				// listed again where it went.
				const { store } = await harness();
				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } }],
				});
				await store.applyChanges({
					changes: [
						{ kind: 'forget-unreadable', remoteId: 'r1' },
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'b.svg' } },
					],
				});
				expect(await listed(store)).toEqual(['r1 b.svg']);
			});

			it('lists nothing from a batch that is refused', async () => {
				// The list would otherwise name a file from a batch whose cursor
				// never moved, which the next pull decides all over again.
				const { store } = await harness();
				await store.applyChanges({ changes: [], cursor: 'c1' });

				await expect(
					store.applyChanges({
						changes: [
							{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } },
							refused,
						],
						cursor: 'c2',
					})
				).rejects.toThrow();

				expect(await store.unreadable()).toEqual([]);
				expect(await store.cursor()).toBe('c1');
			});

			it('forgets nothing in a batch that is refused, and leaves a rebased path where it was', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'Work/b.svg' } },
					],
					cursor: 'c1',
				});

				await expect(
					store.applyChanges({
						changes: [
							{ kind: 'forget-unreadable', remoteId: 'r1' },
							{ kind: 'move-folder', from: 'Work', to: 'Archive' },
							refused,
						],
						cursor: 'c2',
					})
				).rejects.toThrow();

				expect(await listed(store)).toEqual(['r1 a.svg', 'r2 Work/b.svg']);
				expect(await store.cursor()).toBe('c1');
			});

			it('carries the files under a folder along when it moves, and no others', async () => {
				// A feed that reports by id says the folder moved and nothing of
				// what is in it, so nothing else would ever correct these paths.
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Work/Old', remoteId: 'f2' });
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'Work/a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'Work/Old/b.svg' } },
						// A sibling whose name only starts the same way.
						{ kind: 'unreadable', file: { remoteId: 'r3', path: 'Workshop.svg' } },
					],
				});

				await store.applyChanges({
					changes: [
						{ kind: 'move-folder', from: 'Work', to: 'Archive/Work', remoteId: 'f1' },
					],
				});

				expect(await listed(store)).toEqual([
					'r1 Archive/Work/a.svg',
					'r2 Archive/Work/Old/b.svg',
					'r3 Workshop.svg',
				]);
			});

			it('forgets the files under a folder that is deleted, and no others', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seedFolder({ path: 'Work/Old', remoteId: 'f2' });
				await store.applyChanges({
					changes: [
						{ kind: 'unreadable', file: { remoteId: 'r1', path: 'Work/a.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r2', path: 'Work/Old/b.svg' } },
						{ kind: 'unreadable', file: { remoteId: 'r3', path: 'Workshop.svg' } },
					],
				});

				await store.applyChanges({ changes: [{ kind: 'delete-folder', path: 'Work' }] });

				expect(await listed(store)).toEqual(['r3 Workshop.svg']);
			});

			it('forgets them under a folder it holds no row for, and takes the batch', async () => {
				// The files are gone with the directory whether or not this device
				// ever made a folder of it.
				const { store } = await harness();
				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'Work/a.svg' } }],
				});

				await store.applyChanges({
					changes: [{ kind: 'delete-folder', path: 'Work' }],
					cursor: 'c1',
				});

				expect(await store.unreadable()).toEqual([]);
				expect(await store.cursor()).toBe('c1');
			});

			it('leaves every drawing and folder as it was', async () => {
				// A record is about a file the store holds no row for. One that
				// reached for a drawing at the same path would be reaching for the
				// user's own, never pushed, which the engine moves aside itself.
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('mine\n'), dirty: true });
				const before = await store.allDrawings();

				await store.applyChanges({
					changes: [{ kind: 'unreadable', file: { remoteId: 'r1', path: 'Work/a.svg' } }],
				});
				await store.applyChanges({
					changes: [{ kind: 'forget-unreadable', remoteId: 'r1' }],
				});

				expect(await store.allDrawings()).toEqual(before);
				expect((await store.folderByPath('Work'))?.path).toBe('Work');
			});
		});

		describe('a folder move', () => {
			it('carries the drawings and the queued ops with it', async () => {
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), dirty: true });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });

				await store.applyChanges({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.drawingById('n1'))?.path).toBe('Archive/a.svg');
				// An op left naming the old path writes to somewhere that no
				// longer exists — and on a provider that creates missing parents,
				// resurrects the folder the user just moved.
				const ops = await store.pendingOps();
				expect(ops.find((op) => op.seq === seq)?.path).toBe('Archive/a.svg');
			});

			it('carries a remotely moved drawing’s queued ops with it', async () => {
				// `move-drawing` moves a drawing just as surely as `move-folder` does,
				// and an op left aimed at the path the drawing has left fails on
				// every attempt — which stops the ordered queue for every drawing,
				// not only this one.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'renamed.svg',
				});

				await store.applyChanges({
					changes: [
						{
							kind: 'move-drawing',
							id: 'n1',
							path: 'b.svg',
							remote: remote('b.svg', 'r1'),
						},
					],
					cursor: 'c1',
				});

				const moved = (await store.pendingOps()).find((op) => op.seq === seq);
				expect(moved?.path).toBe('b.svg');
			});

			it('carries a queued move’s target with it too', async () => {
				// `targetPath` is the half that says where the drawing is going, and
				// a store that rebases only `path` leaves the move aimed at a
				// folder that no longer exists. It then fails on every attempt,
				// and the ordered queue strands every op behind it — for every
				// drawing, not just this one.
				const { store, seed, seedFolder, seedOp } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'Work/a.svg',
					targetPath: 'Work/renamed.svg',
				});

				await store.applyChanges({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				const moved = (await store.pendingOps()).find((op) => op.seq === seq);
				expect(moved?.path).toBe('Archive/a.svg');
				expect(moved).toMatchObject({ targetPath: 'Archive/renamed.svg' });
			});

			it('does not clean a dirty drawing on the way', async () => {
				const { store, seed, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await seed({ id: 'n1', path: 'Work/a.svg', content: svg('mine\n'), dirty: true });

				await store.applyChanges({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.drawingById('n1'))?.dirty).toBe(true);
				expect((await store.drawingById('n1'))?.content).toBe(svg('mine\n'));
			});

			it('can be found again by its remote id afterwards', async () => {
				const { store, seedFolder } = await harness();
				await seedFolder({ path: 'Work', remoteId: 'f1' });
				await store.applyChanges({
					changes: [{ kind: 'move-folder', from: 'Work', to: 'Archive', remoteId: 'f1' }],
					cursor: 'c1',
				});

				expect((await store.folderByRemoteId('f1'))?.path).toBe('Archive');
			});
		});

		describe('a conflict', () => {
			const resolution = {
				drawingId: 'n1',
				remoteContent: svg('theirs\n'),
				remoteHash: 'hash',
				remote: remote('a.svg', 'r1', 'v2'),
				copyId: 'c1',
				copyPath: 'a (conflict 2026-09-15T14-32).svg',
				copyContent: conflictContent(svg('mine\n'), 'c1'),
			};

			it('gives the remote the path and the local edit a drawing of its own', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyChanges({
					changes: [{ kind: 'conflict', resolution }],
					cursor: 'x',
				});

				expect((await store.drawingById('n1'))?.content).toBe(svg('theirs\n'));
				expect((await store.drawingById('n1'))?.dirty).toBe(false);
				expect((await store.drawingById('c1'))?.content).toBe(
					conflictContent(svg('mine\n'), 'c1')
				);
				expect((await store.drawingById('c1'))?.dirty).toBe(true);
			});

			it('queues the copy, because it exists nowhere else yet', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyChanges({
					changes: [{ kind: 'conflict', resolution }],
					cursor: 'x',
				});

				const ops = await store.pendingOps();
				expect(ops.map((op) => op.path)).toContain('a (conflict 2026-09-15T14-32).svg');
			});

			it('drops the write the losing edit had queued', async () => {
				// That op carries the content the copy now holds, and the drawing
				// itself holds the remote's bytes. Replaying it writes the
				// remote's own content straight back to it under a new version,
				// which every other device pulls as a change that changed
				// nothing — and which can lose a race against a real edit made
				// between the two. The user's writing is not at risk: it is in
				// the copy, which is queued in its place.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });
				await store.applyChanges({
					changes: [{ kind: 'conflict', resolution }],
					cursor: 'x',
				});

				const ops = await store.pendingOps();
				expect(ops.some((op) => op.seq === seq)).toBe(false);
				expect(ops.map((op) => op.path)).toContain('a (conflict 2026-09-15T14-32).svg');
			});

			it('leaves the user’s rename queued', async () => {
				// The conflict rule is about content. A queued `move` is the
				// user's own rename of the drawing, and nothing about the remote
				// winning the path makes it wrong to ask for it.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'b.svg',
				});
				await store.applyChanges({
					changes: [{ kind: 'conflict', resolution }],
					cursor: 'x',
				});

				expect((await store.pendingOps()).some((op) => op.seq === seq)).toBe(true);
			});

			it('does not give the copy the remote the original had', async () => {
				const { store, seed } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				await store.applyChanges({
					changes: [{ kind: 'conflict', resolution }],
					cursor: 'x',
				});

				// Two drawings pointing at one remote file means the next push has
				// them overwrite each other for ever.
				expect((await store.drawingById('c1'))?.remoteId).toBeUndefined();
			});
		});

		describe('finishing an op', () => {
			it('records what landed and calls the drawing clean', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), dirty: true });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.completeOp(seq, {
					kind: 'pushed',
					drawingId: 'n1',
					remote: remote('a.svg', 'r9', 'v9'),
					content: svg('x\n'),
					syncedHash: 'hash',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.remoteId).toBe('r9');
				expect(drawing?.remoteVersion).toBe('v9');
				expect(drawing?.dirty).toBe(false);
				expect(await store.pendingOps()).toEqual([]);
			});

			it('leaves the drawing dirty when it changed while it was in flight', async () => {
				// The bytes that landed are not the bytes here. Calling this
				// clean is how the last thing the user typed disappears.
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x and more\n'), dirty: true });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.completeOp(seq, {
					kind: 'pushed',
					drawingId: 'n1',
					remote: remote('a.svg', 'r9', 'v9'),
					content: svg('x\n'),
					syncedHash: 'hash',
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.dirty).toBe(true);
				expect(drawing?.content).toBe(svg('x and more\n'));
				// The version still has to be adopted, or the next push sends an
				// expectation the remote has already moved past.
				expect(drawing?.remoteVersion).toBe('v9');
			});

			it('does not touch the dirty flag after a move', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'b.svg',
					content: svg('x\n'),
					remoteId: 'r1',
					dirty: true,
				});
				const seq = await seedOp({
					op: 'move',
					drawingId: 'n1',
					path: 'a.svg',
					targetPath: 'b.svg',
				});

				await store.completeOp(seq, {
					kind: 'moved',
					drawingId: 'n1',
					remote: remote('b.svg', 'r1', 'v2'),
				});

				const drawing = await store.drawingById('n1');
				expect(drawing?.dirty).toBe(true);
				expect(drawing?.remoteVersion).toBe('v2');
			});

			it('drops the tombstone once the delete has landed', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), remoteId: 'r1' });
				const seq = await seedOp({ op: 'delete', drawingId: 'n1', path: 'a.svg' });

				await store.completeOp(seq, { kind: 'purged', drawingId: 'n1' });

				expect(await store.drawingById('n1')).toBeUndefined();
				expect(await store.pendingOps()).toEqual([]);
			});

			it('counts a failure without losing the op', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), dirty: true });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.failOp(seq, 'offline');

				const ops = await store.pendingOps();
				expect(ops).toHaveLength(1);
				expect(ops[0]?.attempts).toBe(1);
			});

			it('hands back one queued op as it stands, and nothing once it is done', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({ id: 'n1', path: 'a.svg', content: svg('x\n'), dirty: true });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });
				await store.failOp(seq, 'offline');

				expect(await store.opBySeq(seq)).toMatchObject({ seq, op: 'write', attempts: 1 });
				await store.completeOp(seq, { kind: 'done' });
				expect(await store.opBySeq(seq)).toBeUndefined();
			});

			it('hands back queued ops in the order they were made', async () => {
				const { store, seedOp } = await harness();
				const first = await seedOp({ op: 'mkdir', path: 'Work' });
				const second = await seedOp({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });

				expect((await store.pendingOps()).map((op) => op.seq)).toEqual([first, second]);
			});
		});

		describe('resolveConflict', () => {
			it('leaves nothing behind when it refuses', async () => {
				// One transaction, like a pull batch: a copy id that is taken fails
				// the resolution after the drawing has already been rewritten, and the
				// rewrite must not survive it.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					dirty: true,
				});
				await seed({ id: 'c1', path: 'other.svg', content: svg('other\n') });
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await expect(
					store.resolveConflict(seq, {
						drawingId: 'n1',
						remoteContent: svg('theirs\n'),
						remoteHash: 'hash',
						remote: remote('a.svg', 'r1', 'v2'),
						copyId: 'c1',
						copyPath: 'a (conflict).svg',
						copyContent: conflictContent(svg('mine\n'), 'c1'),
					})
				).rejects.toThrow();

				expect((await store.drawingById('n1'))?.content).toBe(svg('mine\n'));
				expect((await store.drawingById('n1'))?.dirty).toBe(true);
				expect((await store.drawingById('c1'))?.content).toBe(svg('other\n'));
				expect((await store.pendingOps()).map((op) => op.seq)).toEqual([seq]);
			});

			it('makes the folders above the path the remote takes', async () => {
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.resolveConflict(seq, {
					drawingId: 'n1',
					remoteContent: svg('theirs\n'),
					remoteHash: 'hash',
					remote: remote('Moved/There/a.svg', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).svg',
					copyContent: conflictContent(svg('mine\n'), 'c1'),
				});

				expect(await store.folderByPath('Moved')).toBeDefined();
				expect(await store.folderByPath('Moved/There')).toBeDefined();
			});

			it('finishes the op in the same breath as the copy', async () => {
				// Replaying it would overwrite the remote with the bytes the user
				// has just been handed a copy of.
				const { store, seed, seedOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });

				await store.resolveConflict(seq, {
					drawingId: 'n1',
					remoteContent: svg('theirs\n'),
					remoteHash: 'hash',
					remote: remote('a.svg', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).svg',
					copyContent: conflictContent(svg('mine\n'), 'c1'),
				});

				const ops = await store.pendingOps();
				expect(ops.find((op) => op.seq === seq)).toBeUndefined();
				expect(ops.map((op) => op.path)).toEqual(['a (conflict).svg']);
				expect((await store.drawingById('n1'))?.content).toBe(svg('theirs\n'));
				expect((await store.drawingById('c1'))?.content).toBe(
					conflictContent(svg('mine\n'), 'c1')
				);
			});

			it('takes a resolution for an op withdrawn while it was at the network', async () => {
				// The user can delete the drawing while its write is out, and a
				// tombstone owes the remote its delete and nothing else, so the
				// write's queue row goes (`apps/web/src/store/queue.ts`). The
				// conflict the write met still has to land — refusing it would
				// fail the op and retry a write the queue no longer holds — and
				// `completeOp` and `failOp` already allow the same.
				const { store, seed, seedOp, withdrawOp } = await harness();
				await seed({
					id: 'n1',
					path: 'a.svg',
					content: svg('mine\n'),
					remoteId: 'r1',
					remoteVersion: 'v1',
					dirty: true,
				});
				const seq = await seedOp({ op: 'write', drawingId: 'n1', path: 'a.svg' });
				await withdrawOp(seq);

				await store.resolveConflict(seq, {
					drawingId: 'n1',
					remoteContent: svg('theirs\n'),
					remoteHash: 'hash',
					remote: remote('a.svg', 'r1', 'v2'),
					copyId: 'c1',
					copyPath: 'a (conflict).svg',
					copyContent: conflictContent(svg('mine\n'), 'c1'),
				});

				expect((await store.drawingById('n1'))?.content).toBe(svg('theirs\n'));
				expect((await store.drawingById('c1'))?.content).toBe(
					conflictContent(svg('mine\n'), 'c1')
				);
			});
		});

		describe('files beside drawings', () => {
			const BYTES = new Uint8Array([1, 2, 3]);
			const file = (path: string, id = 'f1', version = 'v1', size = 3): RemoteEntry => ({
				remoteId: id,
				path,
				kind: 'file',
				version,
				modifiedAt: '2026-01-01T00:00:00.000Z',
				size,
			});
			const bound = {
				id: 'x1',
				path: 'Trips/a.png',
				remoteId: 'f1',
				remoteVersion: 'v1',
				size: 3,
			};
			const pending = { id: 'x1', path: 'Trips/a.png', size: 3 };
			const opsOf = async (store: SyncStore) =>
				(await store.pendingOps()).map(({ seq: _seq, attempts: _attempts, ...op }) => op);

			it('reads a row by id and by remote id, and under its folders', async () => {
				const { store, seedFile } = await harness();
				await seedFile(bound);
				expect(await store.fileById('x1')).toEqual(bound);
				expect(await store.fileByRemoteId('f1')).toEqual(bound);
				expect(await store.allFiles()).toEqual([bound]);
				expect(await store.filesUnder('Trips')).toEqual([bound]);
				expect(await store.filesUnder('')).toEqual([bound]);
				expect(await store.filesUnder('Work')).toEqual([]);
			});

			it('carries a file op whole: the file it is about, and where its bytes are', async () => {
				const { store, seedOp } = await harness();
				await seedOp({ op: 'upload', fileId: 'x1', path: 'a.png', copyOf: 'f0' });
				await seedOp({
					op: 'move-file',
					fileId: 'x2',
					path: 'b.png',
					targetPath: 'c/b.png',
				});
				await seedOp({ op: 'delete-file', path: 'd.png', remoteId: 'f3' });
				expect(await opsOf(store)).toEqual([
					{ op: 'upload', fileId: 'x1', path: 'a.png', copyOf: 'f0' },
					{ op: 'move-file', fileId: 'x2', path: 'b.png', targetPath: 'c/b.png' },
					{ op: 'delete-file', path: 'd.png', remoteId: 'f3' },
				]);
			});

			describe('the bytes held for a file', () => {
				it('are handed back while held for an upload, whatever version they carry', async () => {
					const { store, seedFile } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					expect(await store.fileBytes('x1')).toEqual(BYTES);
				});

				it('are handed back from the cache only under the version the row is bound to', async () => {
					// The file changed since, or another took its name — or, on
					// OneDrive, it was only renamed, and the version moved anyway.
					const { store, seedFile } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					await seedFile(
						{ ...bound, id: 'x2', path: 'b.png', remoteId: 'f2' },
						{
							bytes: BYTES,
							version: 'v0',
						}
					);
					expect(await store.fileBytes('x1')).toEqual(BYTES);
					expect(await store.fileBytes('x2')).toBeUndefined();
					expect(await store.fileBytes('nope')).toBeUndefined();
				});
			});

			describe('a file a pull brings in', () => {
				it('is put whole, bound to the remote, with the folders above it', async () => {
					const { store } = await harness();
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png'),
							},
						],
						cursor: 'c1',
					});
					expect(await store.fileById('x1')).toEqual(bound);
					expect(await store.folderByPath('Trips')).toBeDefined();
					expect(await store.cursor()).toBe('c1');
				});

				it('leaves bytes cached under the version it had behind', async () => {
					const { store, seedFile } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png', 'f1', 'v2'),
							},
						],
					});
					expect((await store.fileById('x1'))?.remoteVersion).toBe('v2');
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it('binds a pending file it adopts, keeps its bytes, and withdraws its upload', async () => {
					const { store, seedFile, seedOp } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					await seedOp({ op: 'upload', fileId: 'x1', path: 'Trips/a.png' });
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png'),
								adopt: true,
							},
						],
					});
					expect(await store.fileById('x1')).toEqual(bound);
					expect(await store.fileBytes('x1')).toEqual(BYTES);
					expect(await store.pendingOps()).toEqual([]);
					// Kept as the remote version's, not held: a newer one leaves them.
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png', 'f1', 'v2'),
							},
						],
					});
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it('is refused over a pending file it does not adopt, and the batch with it', async () => {
					const { store, seedFile } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					await expect(
						store.applyChanges({
							changes: [
								{
									kind: 'upsert-file',
									fileId: 'x1',
									path: 'Trips/a.png',
									remote: file('Trips/a.png'),
								},
							],
							cursor: 'c1',
						})
					).rejects.toThrow();
					expect(await store.fileById('x1')).toEqual(pending);
					expect(await store.cursor()).toBeUndefined();
				});

				it('is passed over while the user has a delete of it queued', async () => {
					// The row went when the user deleted it; the op is all that says so.
					// Not refused: a delete stuck at the network would otherwise stop
					// every pull that mentioned the file, and every drawing's with it.
					const { store, seedOp } = await harness();
					await seedOp({ op: 'delete-file', path: 'Trips/a.png', remoteId: 'f1' });
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png'),
							},
						],
						cursor: 'c1',
					});
					expect(await store.fileById('x1')).toBeUndefined();
					expect(await store.cursor()).toBe('c1');
				});

				it.each([
					['a file that is bound already', { ...bound, remoteVersion: 'v0' }, 3],
					['a pending file somewhere else', { ...pending, path: 'Work/a.png' }, 3],
					['a pending file of another size', { ...pending, size: 500 }, 3],
					['nothing at all', undefined, 3],
				])('is refused as an adoption of %s', async (_what, row, size) => {
					// Adopted, the user's bytes would stop being held for an upload
					// and pass for a cached copy of a file they are not.
					const { store, seedFile } = await harness();
					if (row !== undefined) await seedFile(row, { bytes: BYTES, pinned: true });
					await expect(
						store.applyChanges({
							changes: [
								{
									kind: 'upsert-file',
									fileId: 'x1',
									path: 'Trips/a.png',
									remote: file('Trips/a.png', 'f1', 'v1', size),
									adopt: true,
								},
							],
						})
					).rejects.toThrow();
					expect(await store.fileById('x1')).toEqual(row);
				});

				it.each([
					['Trips/a.png', 'Trips/a.png'],
					['Old/a.png', 'Old/a.png'],
					['Work/a.png', 'Trips/a.png'],
				])(
					'keeps a file where the user moved it, put at %s, and its queued move starting at %s',
					async (put, there) => {
						// The move has not gone yet: the file is still on the remote at
						// its old name — or at one another device gave it — and this
						// one stays at the name the user chose, or the next file to
						// arrive there is taken for new rather than set aside.
						const { store, seedFile, seedOp } = await harness();
						await seedFile({ ...bound, path: 'Work/a.png' });
						await seedOp({
							op: 'move-file',
							fileId: 'x1',
							path: 'Trips/a.png',
							targetPath: 'Work/a.png',
						});
						await store.applyChanges({
							changes: [
								{
									kind: 'upsert-file',
									fileId: 'x1',
									path: put,
									remote: file(there, 'f1', 'v2'),
								},
							],
						});
						expect(await store.fileById('x1')).toEqual({
							...bound,
							path: 'Work/a.png',
							remoteVersion: 'v2',
						});
						expect(await opsOf(store)).toEqual([
							{
								op: 'move-file',
								fileId: 'x1',
								path: there,
								targetPath: 'Work/a.png',
							},
						]);
					}
				);
			});

			it('moves a pending file aside, with its queued upload', async () => {
				const { store, seedFile, seedOp } = await harness();
				await seedFile(pending, { bytes: BYTES, pinned: true });
				await seedOp({ op: 'upload', fileId: 'x1', path: 'Trips/a.png' });
				await store.applyChanges({
					changes: [
						{ kind: 'displace-file', fileId: 'x1', path: 'Trips/a (conflict).png' },
						{ kind: 'displace-file', fileId: 'nope', path: 'b.png' },
					],
				});
				expect(await store.fileById('x1')).toEqual({
					...pending,
					path: 'Trips/a (conflict).png',
				});
				expect(await opsOf(store)).toEqual([
					{ op: 'upload', fileId: 'x1', path: 'Trips/a (conflict).png' },
				]);
			});

			it('moves a pending file aside into a folder it makes', async () => {
				const { store, seedFile } = await harness();
				await seedFile(pending, { bytes: BYTES, pinned: true });
				await store.applyChanges({
					changes: [
						{ kind: 'displace-file', fileId: 'x1', path: 'New/a (conflict).png' },
					],
				});
				expect(await store.folderByPath('New')).toBeDefined();
			});

			describe('a file a pull takes, that an upload copies', () => {
				// Moved with a drawing into a folder while another drawing kept linking
				// it, and not held here: the copy was to read the file's bytes from
				// the remote, which has just said it is gone. Whatever is held here
				// of them is all that is left of the copy.
				const copying = async (cachedAs = 'v1') => {
					const h = await harness();
					await h.seedFolder({ path: 'Trips', remoteId: 'd1' });
					await h.seedFile(bound, { bytes: BYTES, version: cachedAs });
					await h.seedFile({ id: 'x2', path: 'Work/a.png', size: 3 });
					await h.seedOp({
						op: 'upload',
						fileId: 'x2',
						path: 'Work/a.png',
						copyOf: 'f1',
					});
					return h;
				};
				const copy = { op: 'upload', fileId: 'x2', path: 'Work/a.png' };

				it.each([
					{ kind: 'delete-file' as const, fileId: 'x1' },
					{ kind: 'reupload-file' as const, fileId: 'x1' },
					{ kind: 'delete-folder' as const, path: 'Trips' },
				])('hands its bytes to the copy, on a $kind', async (change) => {
					const { store } = await copying();
					await store.applyChanges({ changes: [change] });
					expect(await store.fileBytes('x2')).toEqual(BYTES);
					expect(
						(await opsOf(store)).find((op) => 'fileId' in op && op.fileId === 'x2')
					).toEqual(copy);
				});

				it('hands over nothing that is not the file as it is now', async () => {
					const { store } = await copying('v0');
					await store.applyChanges({ changes: [{ kind: 'delete-file', fileId: 'x1' }] });
					expect(await store.fileBytes('x2')).toBeUndefined();
					expect(await opsOf(store)).toEqual([{ ...copy, copyOf: 'f1' }]);
				});
			});

			it.each([
				{ kind: 'delete-file' as const, fileId: 'x1' },
				{ kind: 'reupload-file' as const, fileId: 'x1' },
				{ kind: 'delete-folder' as const, path: 'Trips' },
			])('withdraws the move queued for a file that a $kind takes', async (change) => {
				const { store, seedFolder, seedFile, seedOp } = await harness();
				await seedFolder({ path: 'Trips', remoteId: 'd1' });
				await seedFile({ ...bound, path: 'Trips/b.png' }, { bytes: BYTES, version: 'v1' });
				await seedOp({
					op: 'move-file',
					fileId: 'x1',
					path: 'Trips/a.png',
					targetPath: 'Trips/b.png',
				});
				await store.applyChanges({ changes: [change] });
				expect((await opsOf(store)).filter((op) => op.op === 'move-file')).toEqual([]);
			});

			describe('a file gone remotely', () => {
				it('takes the row and its bytes', async () => {
					const { store, seedFile } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					await store.applyChanges({
						changes: [
							{ kind: 'delete-file', fileId: 'x1' },
							{ kind: 'delete-file', fileId: 'nope' },
						],
					});
					expect(await store.fileById('x1')).toBeUndefined();
					// Back under the version its bytes were cached at, with none.
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png'),
							},
						],
					});
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it("is refused for a pending file, which was never the remote's", async () => {
					const { store, seedFile } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					await expect(
						store.applyChanges({ changes: [{ kind: 'delete-file', fileId: 'x1' }] })
					).rejects.toThrow();
					expect(await store.fileBytes('x1')).toEqual(BYTES);
				});
			});

			describe('a file a rescan did not return, its own copy maybe what lost it', () => {
				it('goes back up from the bytes held here', async () => {
					const { store, seedFile } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					await store.applyChanges({
						changes: [
							{ kind: 'reupload-file', fileId: 'x1' },
							{ kind: 'reupload-file', fileId: 'nope' },
						],
					});
					expect(await store.fileById('x1')).toEqual(pending);
					expect(await store.fileBytes('x1')).toEqual(BYTES);
					expect(await opsOf(store)).toEqual([
						{ op: 'upload', fileId: 'x1', path: 'Trips/a.png' },
					]);
				});

				it('is pending all the same where there is nothing here to send', async () => {
					// Its upload finds that out, and the row goes then (`lost-file`):
					// the engine, which cannot see the bytes, has to know what the row
					// is after this.
					const { store, seedFile } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v0' });
					await store.applyChanges({
						changes: [{ kind: 'reupload-file', fileId: 'x1' }],
					});
					expect(await store.fileById('x1')).toEqual(pending);
					expect(await store.fileBytes('x1')).toBeUndefined();
					expect(await opsOf(store)).toEqual([
						{ op: 'upload', fileId: 'x1', path: 'Trips/a.png' },
					]);
				});

				it('is adopted by the same file arriving later in the batch, bytes or none', async () => {
					const { store, seedFile } = await harness();
					await seedFile(bound);
					const arrived = file('Trips/a.png', 'f2', 'w1');
					await store.applyChanges({
						changes: [
							{ kind: 'reupload-file', fileId: 'x1' },
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: arrived,
								adopt: true,
							},
						],
					});
					expect(await store.fileById('x1')).toMatchObject({ remoteId: 'f2' });
					expect(await store.pendingOps()).toEqual([]);
				});
			});

			it('moves the files under a folder that moved, and their queued ops', async () => {
				const { store, seedFolder, seedFile, seedOp } = await harness();
				await seedFolder({ path: 'Trips', remoteId: 'd1' });
				await seedFile(bound);
				await seedFile(
					{ id: 'x2', path: 'Trips/b.png', size: 3 },
					{ bytes: BYTES, pinned: true }
				);
				await seedOp({ op: 'upload', fileId: 'x2', path: 'Trips/b.png' });
				await seedOp({
					op: 'move-file',
					fileId: 'x1',
					path: 'Trips/a.png',
					targetPath: 'Trips/sub/a.png',
				});
				await store.applyChanges({
					changes: [
						{ kind: 'move-folder', from: 'Trips', to: 'Holidays', remoteId: 'd1' },
					],
				});
				expect((await store.allFiles()).map((each) => each.path).sort()).toEqual([
					'Holidays/a.png',
					'Holidays/b.png',
				]);
				expect(await opsOf(store)).toEqual([
					{ op: 'upload', fileId: 'x2', path: 'Holidays/b.png' },
					{
						op: 'move-file',
						fileId: 'x1',
						path: 'Holidays/a.png',
						targetPath: 'Holidays/sub/a.png',
					},
				]);
			});

			describe('a folder gone remotely', () => {
				it('takes the bound files under it and their bytes, and leaves a pending one', async () => {
					const { store, seedFolder, seedFile } = await harness();
					await seedFolder({ path: 'Trips', remoteId: 'd1' });
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					await seedFile(
						{ id: 'x2', path: 'Trips/sub/b.png', size: 3 },
						{ bytes: BYTES, pinned: true }
					);
					await seedFile({
						id: 'x3',
						path: 'Work/c.png',
						remoteId: 'f3',
						remoteVersion: 'v1',
						size: 3,
					});
					await store.applyChanges({
						changes: [{ kind: 'delete-folder', path: 'Trips' }],
					});
					expect((await store.allFiles()).map((each) => each.id).sort()).toEqual([
						'x2',
						'x3',
					]);
					expect(await store.fileBytes('x2')).toEqual(BYTES);
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png'),
							},
						],
					});
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it('spares a file the engine names, and one whose queued move says it is outside', async () => {
					// Moved in here by the user, and still where it was on the remote
					// until that move runs: the folder going says nothing about it.
					const { store, seedFolder, seedFile, seedOp } = await harness();
					await seedFolder({ path: 'Trips', remoteId: 'd1' });
					await seedFile(bound);
					await seedFile({
						id: 'x2',
						path: 'Trips/b.png',
						remoteId: 'f2',
						remoteVersion: 'v1',
						size: 3,
					});
					await seedFile({
						id: 'x3',
						path: 'Trips/c.png',
						remoteId: 'f3',
						remoteVersion: 'v1',
						size: 3,
					});
					await seedOp({
						op: 'move-file',
						fileId: 'x2',
						path: 'Work/b.png',
						targetPath: 'Trips/b.png',
					});
					await seedOp({
						op: 'move-file',
						fileId: 'x3',
						path: 'Trips/old/c.png',
						targetPath: 'Trips/c.png',
					});
					await store.applyChanges({
						changes: [
							{ kind: 'delete-folder', path: 'Trips', keepFiles: ['x1', 'nope'] },
						],
					});
					expect((await store.allFiles()).map((each) => each.id).sort()).toEqual([
						'x1',
						'x2',
					]);
				});

				it('takes a file whose queued move started inside, under the name it had', async () => {
					// Renamed from `Old` in this batch: a move from inside `Old` is a
					// move from inside the folder that is going.
					const { store, seedFolder, seedFile, seedOp } = await harness();
					await seedFolder({ path: 'Trips', remoteId: 'd1' });
					await seedFile({ ...bound, path: 'Trips/b.png' });
					await seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Old/a.png',
						targetPath: 'Trips/b.png',
					});
					await store.applyChanges({
						changes: [{ kind: 'delete-folder', path: 'Trips', was: 'Old' }],
					});
					expect(await store.allFiles()).toEqual([]);
				});

				it('goes by the first move queued for a file, which is where it is', async () => {
					const { store, seedFolder, seedFile, seedOp } = await harness();
					await seedFolder({ path: 'Trips', remoteId: 'd1' });
					await seedFile({ ...bound, path: 'Trips/c.png' });
					await seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Work/a.png',
						targetPath: 'Trips/b.png',
					});
					await seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Trips/b.png',
						targetPath: 'Trips/c.png',
					});
					await store.applyChanges({
						changes: [{ kind: 'delete-folder', path: 'Trips' }],
					});
					expect((await store.allFiles()).map((each) => each.id)).toEqual(['x1']);
				});
			});

			describe('an upload that landed', () => {
				it("binds the file, and keeps its bytes as that version's", async () => {
					const { store, seedFile, seedOp } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					const seq = await seedOp({ op: 'upload', fileId: 'x1', path: 'Trips/a.png' });
					await store.completeOp(seq, {
						kind: 'uploaded',
						fileId: 'x1',
						remote: file('Trips/a.png'),
						sentAs: 'Trips/a.png',
					});
					expect(await store.fileById('x1')).toEqual(bound);
					expect(await store.fileBytes('x1')).toEqual(BYTES);
					expect(await store.pendingOps()).toEqual([]);
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								remote: file('Trips/a.png', 'f1', 'v2'),
							},
						],
					});
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it('takes the name the remote gave it, where that is not the one asked for', async () => {
					const { store, seedFile, seedOp } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					const seq = await seedOp({ op: 'upload', fileId: 'x1', path: 'Trips/a.png' });
					await store.completeOp(seq, {
						kind: 'uploaded',
						fileId: 'x1',
						remote: file('Trips/a (conflict).png'),
						sentAs: 'Trips/a.png',
					});
					expect((await store.fileById('x1'))?.path).toBe('Trips/a (conflict).png');
				});

				it('takes the size the remote says it is', async () => {
					const { store, seedFile, seedOp } = await harness();
					await seedFile(pending, { bytes: BYTES, pinned: true });
					const seq = await seedOp({ op: 'upload', fileId: 'x1', path: 'Trips/a.png' });
					await store.completeOp(seq, {
						kind: 'uploaded',
						fileId: 'x1',
						remote: file('Trips/a.png', 'f1', 'v1', 5),
						sentAs: 'Trips/a.png',
					});
					expect((await store.fileById('x1'))?.size).toBe(5);
				});

				it('takes the file after a row the user moved while it was on its way', async () => {
					const { store, seedFile, seedOp } = await harness();
					await seedFile(
						{ ...pending, path: 'Work/a.png' },
						{ bytes: BYTES, pinned: true }
					);
					const seq = await seedOp({ op: 'upload', fileId: 'x1', path: 'Work/a.png' });
					await store.completeOp(seq, {
						kind: 'uploaded',
						fileId: 'x1',
						remote: file('Trips/a.png'),
						sentAs: 'Trips/a.png',
					});
					expect(await store.fileById('x1')).toEqual({ ...bound, path: 'Work/a.png' });
					expect(await opsOf(store)).toEqual([
						{
							op: 'move-file',
							fileId: 'x1',
							path: 'Trips/a.png',
							targetPath: 'Work/a.png',
						},
					]);
				});

				it.each([
					['', false],
					[', and the delete withdrew it', true],
				])(
					'owes the remote a delete of a file the user deleted while it was on its way%s',
					async (_how, withdraw) => {
						// Withdrawn is how the app's queue does it: a file never sent
						// owes the remote nothing, so its delete takes the upload.
						const { store, seedFile, seedOp, dropFile, withdrawOp } = await harness();
						await seedFile(pending, { bytes: BYTES, pinned: true });
						const seq = await seedOp({
							op: 'upload',
							fileId: 'x1',
							path: 'Trips/a.png',
						});
						await dropFile('x1');
						if (withdraw) await withdrawOp(seq);
						await store.completeOp(seq, {
							kind: 'uploaded',
							fileId: 'x1',
							remote: file('Trips/a.png'),
							sentAs: 'Trips/a.png',
						});
						expect(await store.allFiles()).toEqual([]);
						expect(await opsOf(store)).toEqual([
							{ op: 'delete-file', path: 'Trips/a.png', remoteId: 'f1' },
						]);
					}
				);

				it.each([
					['deleted', true],
					['moved', false],
				])(
					'puts the rmdirs over a file %s while it was on its way behind what that owes',
					async (_how, deleted) => {
						// Its folder was let go meanwhile, and its `rmdir` queued first.
						// Run first, it would find the file and leave the directory.
						const { store, seedFile, seedOp, dropFile } = await harness();
						const at = deleted ? 'Trips/a.png' : 'Work/a.png';
						await seedFile({ ...pending, path: at }, { bytes: BYTES, pinned: true });
						const seq = await seedOp({ op: 'upload', fileId: 'x1', path: at });
						await seedOp({ op: 'rmdir', path: 'trips' });
						await seedOp({ op: 'rmdir', path: 'Other' });
						if (deleted) await dropFile('x1');
						await store.completeOp(seq, {
							kind: 'uploaded',
							fileId: 'x1',
							remote: file('Trips/a.png'),
							sentAs: 'Trips/a.png',
						});
						expect(await opsOf(store)).toEqual([
							{ op: 'rmdir', path: 'Other' },
							deleted
								? { op: 'delete-file', path: 'Trips/a.png', remoteId: 'f1' }
								: {
										op: 'move-file',
										fileId: 'x1',
										path: 'Trips/a.png',
										targetPath: 'Work/a.png',
									},
							{ op: 'rmdir', path: 'trips' },
						]);
					}
				);

				it("is refused for a row it would make another's file", async () => {
					// Two rows on one file, which only an engine that lost track
					// makes. Letting either go would take a link with it; the
					// upload is tried again, and finds its own way.
					const { store, seedFile, seedOp } = await harness();
					const mine = { id: 'x2', path: 'Work/a.png', size: 3 };
					await seedFile(bound);
					await seedFile(mine, { bytes: BYTES, pinned: true });
					const seq = await seedOp({ op: 'upload', fileId: 'x2', path: 'Work/a.png' });
					await expect(
						store.completeOp(seq, {
							kind: 'uploaded',
							fileId: 'x2',
							remote: file('Trips/a.png'),
							sentAs: 'Trips/a.png',
						})
					).rejects.toThrow();
					expect(await store.fileById('x2')).toEqual(mine);
					expect(await store.fileBytes('x2')).toEqual(BYTES);
					expect(await opsOf(store)).toEqual([
						{ op: 'upload', fileId: 'x2', path: 'Work/a.png' },
					]);
				});
			});

			it('records where a moved file landed, and keeps its bytes under the new version', async () => {
				const { store, seedFile, seedOp } = await harness();
				await seedFile(bound, { bytes: BYTES, version: 'v1' });
				const seq = await seedOp({
					op: 'move-file',
					fileId: 'x1',
					path: 'Trips/a.png',
					targetPath: 'Work/a.png',
				});
				await store.completeOp(seq, {
					kind: 'moved-file',
					fileId: 'x1',
					remote: file('Work/a.png', 'f1', 'v2'),
				});
				expect(await store.fileById('x1')).toEqual({
					...bound,
					path: 'Work/a.png',
					remoteVersion: 'v2',
				});
				expect(await store.fileBytes('x1')).toEqual(BYTES);
			});

			describe('a moved file', () => {
				const moving = async (bytes: {
					bytes: Uint8Array<ArrayBuffer>;
					version?: string;
					pinned?: boolean;
				}) => {
					const h = await harness();
					await h.seedFile(bound, bytes);
					const seq = await h.seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Trips/a.png',
						targetPath: 'Work/a.png',
					});
					await h.store.completeOp(seq, {
						kind: 'moved-file',
						fileId: 'x1',
						remote: file('Work/a.png', 'f1', 'v2'),
					});
					return h.store;
				};

				it('does not make stale bytes current by moving them', async () => {
					const store = await moving({ bytes: BYTES, version: 'v0' });
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				describe('moved again while its move was on the way', () => {
					// The app's queue replaces a queued move rather than adding a
					// second, so the move at the network is withdrawn and its
					// outcome arrives for an op no longer queued. The file is where
					// that move put it; the row is where the user has put it since.
					const movedAgain = async (now: string, replaced: boolean) => {
						const { store, seedFile, seedOp, withdrawOp } = await harness();
						await seedFile({ ...bound, path: now }, { bytes: BYTES, version: 'v1' });
						const sent = await seedOp({
							op: 'move-file',
							fileId: 'x1',
							path: 'Trips/a.png',
							targetPath: 'Work/a.png',
						});
						await withdrawOp(sent);
						if (replaced) {
							await seedOp({
								op: 'move-file',
								fileId: 'x1',
								path: 'Trips/a.png',
								targetPath: now,
							});
						}
						await store.completeOp(sent, {
							kind: 'moved-file',
							fileId: 'x1',
							remote: file('Work/a.png', 'f1', 'v2'),
						});
						return {
							file: await store.fileById('x1'),
							bytes: await store.fileBytes('x1'),
							ops: await opsOf(store),
						};
					};

					it('keeps the row where the user put it, and starts the move that replaced it from where it landed', async () => {
						const { file: row, bytes, ops } = await movedAgain('Home/a.png', true);
						expect(row).toEqual({ ...bound, path: 'Home/a.png', remoteVersion: 'v2' });
						expect(bytes).toEqual(BYTES);
						expect(ops).toEqual([
							{
								op: 'move-file',
								fileId: 'x1',
								path: 'Work/a.png',
								targetPath: 'Home/a.png',
							},
						]);
					});

					it('owes the file a move of its own where nothing replaced the one that went', async () => {
						const { file: row, ops } = await movedAgain('Home/a.png', false);
						expect(row?.path).toBe('Home/a.png');
						expect(ops).toEqual([
							{
								op: 'move-file',
								fileId: 'x1',
								path: 'Work/a.png',
								targetPath: 'Home/a.png',
							},
						]);
					});

					it('owes nothing where the user put it back where it landed', async () => {
						const { file: row, ops } = await movedAgain('Work/a.png', false);
						expect(row?.path).toBe('Work/a.png');
						expect(ops).toEqual([]);
					});
				});

				it('takes no bytes to another file it took for its own', async () => {
					// Landed on the same picture another device put there, and
					// took it: those bytes were never read here, and its version
					// can be the very string these were cached under.
					const { store, seedFile, seedOp } = await harness();
					await seedFile(bound, { bytes: BYTES, version: 'v1' });
					const seq = await seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Trips/a.png',
						targetPath: 'Work/a.png',
					});
					await store.completeOp(seq, {
						kind: 'moved-file',
						fileId: 'x1',
						remote: file('Work/a.png', 'f9', 'v1'),
					});
					expect(await store.fileById('x1')).toEqual({
						...bound,
						path: 'Work/a.png',
						remoteId: 'f9',
					});
					expect(await store.fileBytes('x1')).toBeUndefined();
				});

				it('keeps bytes held for an upload held, not cached', async () => {
					const store = await moving({ bytes: BYTES, pinned: true });
					await store.applyChanges({
						changes: [
							{
								kind: 'upsert-file',
								fileId: 'x1',
								path: 'Work/a.png',
								remote: file('Work/a.png', 'f1', 'v3'),
							},
						],
					});
					expect(await store.fileBytes('x1')).toEqual(BYTES);
				});

				it("is refused for a row it would make another's file", async () => {
					const { store, seedFile, seedOp } = await harness();
					const other = { ...bound, id: 'x2', path: 'Work/a.png', remoteId: 'f2' };
					await seedFile(bound);
					await seedFile(other);
					const seq = await seedOp({
						op: 'move-file',
						fileId: 'x1',
						path: 'Trips/a.png',
						targetPath: 'Work/b.png',
					});
					await expect(
						store.completeOp(seq, {
							kind: 'moved-file',
							fileId: 'x1',
							remote: file('Work/a.png', 'f2'),
						})
					).rejects.toThrow();
					expect(await store.allFiles()).toEqual(expect.arrayContaining([bound, other]));
				});
			});

			it('lets a file go that had nothing to upload, and anything held for it', async () => {
				const { store, seedFile, seedOp } = await harness();
				await seedFile(pending, { bytes: BYTES, version: 'v1' });
				const seq = await seedOp({
					op: 'upload',
					fileId: 'x1',
					path: 'Trips/a.png',
					copyOf: 'f0',
				});
				await store.completeOp(seq, { kind: 'lost-file', fileId: 'x1' });
				expect(await store.allFiles()).toEqual([]);
				expect(await store.pendingOps()).toEqual([]);
				// Back, bound at the version those bytes were: none are left to find.
				await seedFile(bound);
				expect(await store.fileBytes('x1')).toBeUndefined();
			});

			it('takes a refused batch back whole, files and bytes included', async () => {
				const { store, seedFile } = await harness();
				await seedFile(bound, { bytes: BYTES, version: 'v1' });
				await seedFile(
					{ id: 'x2', path: 'b.png', size: 3 },
					{ bytes: BYTES, pinned: true }
				);
				await expect(
					store.applyChanges({
						changes: [
							{ kind: 'delete-file', fileId: 'x1' },
							{ kind: 'delete-file', fileId: 'x2' },
						],
						cursor: 'c1',
					})
				).rejects.toThrow();
				expect(await store.fileById('x1')).toEqual(bound);
				expect(await store.fileBytes('x1')).toEqual(BYTES);
				expect(await store.cursor()).toBeUndefined();
			});
		});
	});
};
