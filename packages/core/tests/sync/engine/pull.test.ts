import { describe, expect, it } from 'vitest';

import { emptyDrawing } from '../../../src/drawing/document.js';
import { contentHash } from '../../../src/hash.js';
import { createFakeProvider, type FakeProvider } from '../../../src/providers/fake.js';
import { AuthError, type ChangeEntry, type StorageProvider } from '../../../src/providers/types.js';
import type { SyncEngine } from '../../../src/sync/engine.js';
import type { SyncStore } from '../../../src/sync/store.js';
import { svg } from '../kit/drawings.js';
import { reporting } from '../kit/engine.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * A pull, and a sync, as a whole: a cursor that has died and the rescan
 * after it, a round over several pages, a pull that fails part-way, an
 * entry sent twice, a drawing that carries its own id, and a store that cannot
 * answer (`pull/run`, `pull/batch`). Then the bytes a drawing last synced, as a
 * pull, a push and a conflict each record them (`pull/drawings`, `push/drawings`,
 * `push/conflicts`). What every file in `engine/` is checking, and why the
 * answers are timid, is in `kit/world.ts`.
 */

const {
	world,
	copyId,
	engineWith,
	pullNow,
	pullPages,
	remoteFile,
	killTheCursor,
	drawingAt,
	folderPaths,
} = syncWorld();

describe('pull', () => {
	it('brings a new remote drawing into the store', async () => {
		await remoteFile('a.svg', svg('# Hello\n'));
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('# Hello\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(false);
	});

	it('creates the folder a drawing arrives in', async () => {
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('x\n'));
		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toContain('Work');
	});

	it('ignores the marker file', async () => {
		// `ensureRoot` already wrote `.drawapp.json`. Importing it as a drawing
		// would put the app's own bookkeeping in the user's drawing list, and push
		// it back mangled.
		await world.engine.pull();
		expect(world.store.drawings()).toEqual([]);
	});

	it('ignores a hidden drawing, extension or not', async () => {
		// Not the same check as the one above: `.drawapp.json` is also not
		// a drawing, so the extension alone would have turned that test green
		// with nothing watching hidden paths at all. Anything under a dot
		// segment is somebody's bookkeeping — a provider's, another tool's —
		// and the UI could not show it even if we imported it.
		await world.provider.createFolder('.trash');
		await remoteFile('.trash/deleted.svg', svg('x\n'));
		await remoteFile('.backup.svg', svg('y\n'));

		await world.engine.pull();

		expect(world.store.drawings()).toEqual([]);
	});

	it('ignores a file that is not a drawing', async () => {
		// The app owns the folder but not everything in it. Treating a PDF the
		// user dropped beside their drawings as a drawing would corrupt it on push.
		await remoteFile('photo.png', 'not really a png');
		await world.engine.pull();

		expect(world.store.drawings()).toEqual([]);
	});

	it('takes a drawing whose extension is shouted', async () => {
		// `Report.SVG` is what a Windows tool writes, and it is an SVG file.
		// Deciding otherwise here is not a small inconsistency: it is the reason
		// the fold in `conflictFilename` could never be reached by anything the
		// engine actually pulls, because no drawing could ever carry `.SVG`.
		await remoteFile('Report.SVG', svg('# Report\n'));
		await world.engine.pull();

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Report.SVG']);
	});

	it('overwrites a clean local drawing that changed remotely', async () => {
		const first = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(first),
		});
		await world.engine.pull();

		await world.provider.write('a.svg', svg('two\n'), { expectedVersion: first.version });
		await world.engine.pull();

		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
	});

	it('does nothing at all for a version it already has', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		const before = world.provider.callLog().filter((call) => call.op === 'read').length;
		await world.engine.pull();

		// Not even a read: the version is the whole answer, and fetching content
		// to discover nothing changed is the difference between a sync that
		// costs one request and one that costs a thousand.
		expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(before);
	});

	it('follows a remote rename', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		const moved = await world.provider.move(entry, 'b.svg');
		await world.engine.pull();

		// Whether a move changes the version is a provider's own business —
		// Dropbox's `rev` survives one, OneDrive's `eTag` does not — so the path
		// has to be followed on both routes through the decision, not just the
		// one where the version happens to be unchanged.
		expect(moved.version).not.toBe(entry.version);
		expect(drawingAt('b.svg')?.id).toBe('n1');
		expect(drawingAt('b.svg')?.remoteVersion).toBe(moved.version);
		expect(drawingAt('a.svg')).toBeUndefined();
		expect(world.store.drawings()).toHaveLength(1);
	});

	it('follows a rename that did not change the version, without re-reading', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		// The other half of the provider split above. A rename moves no bytes,
		// so a provider that keeps its version gives us nothing to fetch.
		const renamed = { ...entry, path: 'b.svg' };
		const reads = world.provider.callLog().filter((call) => call.op === 'read').length;
		await engineWith({ provider: reporting(world.provider, [renamed]) }).pull();

		expect(drawingAt('b.svg')?.id).toBe('n1');
		expect(world.provider.callLog().filter((call) => call.op === 'read')).toHaveLength(reads);
	});

	it('does not delete a drawing a move reported twice', async () => {
		// Dropbox and Graph report a move as a deletion of the old path plus an
		// entry at the new one. Acting on the deletion loses the drawing outright
		// when it is applied after the move — which is whichever order the
		// provider happened to list them in.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		const split = reporting(world.provider, [
			{ ...entry, path: 'b.svg' },
			{ path: 'a.svg', deleted: true, remoteId: entry.remoteId },
		]);
		await engineWith({ provider: split }).pull();

		expect(drawingAt('b.svg')?.content).toBe(svg('one\n'));
		expect(world.store.drawings()).toHaveLength(1);
	});

	it('deletes a clean local drawing that went away remotely', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		await world.provider.delete(entry);
		await world.engine.pull();

		expect(world.store.drawings()).toEqual([]);
	});

	it('keeps a dirty local drawing that went away remotely', async () => {
		// §7: remote deleted, local dirty → keep local and forget the remote, so
		// the next push re-creates it. Deleting it here would throw away an edit
		// the user made and never saw land.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			...boundTo(entry),
			dirty: true,
		});
		await world.engine.pull();

		await world.provider.delete(entry);
		await world.engine.pull();

		expect(drawingAt('a.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.remoteId).toBeUndefined();
		expect(drawingAt('a.svg')?.dirty).toBe(true);
	});

	it('adopts a new version when the bytes are the same', async () => {
		// Our own push coming back, or two devices that saved the same thing.
		// Leaving the old version here would send the next push an
		// `expectedVersion` the remote has moved past, and manufacture a
		// conflict over a file that already agrees with us.
		const first = await remoteFile('a.svg', svg('same\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('same\n'),
			...boundTo(first),
			dirty: true,
		});
		await world.engine.pull();
		const second = await world.provider.write('a.svg', svg('same\n'), {
			expectedVersion: first.version,
		});
		await world.engine.pull();

		expect(drawingAt('a.svg')?.remoteVersion).toBe(second.version);
		expect(world.store.drawings()).toHaveLength(1);
		// Adopting a version is bookkeeping and nothing more. Treating it as an
		// update would call the drawing clean, and the local edit it still has
		// queued would never be pushed.
		expect(drawingAt('a.svg')?.dirty).toBe(true);
	});

	it('persists the cursor only after the batch commits', async () => {
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const cursor = world.store.storedCursor();

		await remoteFile('b.svg', svg('two\n'));
		world.store.breakNextApply();
		// Reported, not thrown: a caller that forgot a `try` would otherwise take
		// the app down because a write failed once.
		const failed = await world.engine.pull();
		expect(failed.status).toBe('retry');
		expect(failed.error).toContain('store write failed');

		// The cursor must not have moved past work that was rolled back, or the
		// next pull would never hear about `b.svg` again.
		expect(world.store.storedCursor()).toBe(cursor);
		expect(drawingAt('b.svg')).toBeUndefined();

		await world.engine.pull();
		expect(drawingAt('b.svg')?.content).toBe(svg('two\n'));
	});

	it('does not move the cursor part-way through a full scan', async () => {
		// A scan is one logical batch. A cursor stored after its first page
		// claims a scan that never finished, and the pages after it — and every
		// deletion the scan would have proved — are never looked at again.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		world.store = createMemoryStore();
		world.engine = engineWith();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.write('b.svg', svg('2\n'), {});

		let pages = 0;
		const counted = {
			...world.provider,
			changes: async (cursor?: string) => {
				pages += 1;
				if (pages === 2) world.store.breakNextApply();
				return world.provider.changes(cursor);
			},
		};
		const failed = await engineWith({ provider: counted }).pull();
		expect(failed.status).toBe('retry');

		expect(world.store.storedCursor()).toBeUndefined();

		await world.engine.pull();
		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['a.svg', 'b.svg']);
	});

	it('drains every page before it finishes', async () => {
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		world.store = createMemoryStore();
		world.engine = engineWith();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.write('b.svg', svg('2\n'), {});
		await world.provider.write('c.svg', svg('3\n'), {});

		await world.engine.pull();

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual([
			'a.svg',
			'b.svg',
			'c.svg',
		]);
	});
});

describe('a drawing that carries its own id', () => {
	it('adopts the draw:id in the file rather than inventing one', async () => {
		// docs/ARCHITECTURE.md §3: the id in the file is what makes two devices agree
		// which drawing a file is. Inventing one instead means the same file is a
		// different drawing on every device, and every link between them breaks.
		await remoteFile('a.svg', emptyDrawing({ id: 'from-the-file', title: 'body' }));

		await world.engine.pull();

		expect(drawingAt('a.svg')?.id).toBe('from-the-file');
	});

	it('invents one for a file written by something else', async () => {
		await remoteFile('a.svg', svg('no id\n'));

		await world.engine.pull();

		expect(drawingAt('a.svg')?.id).toBe('copy-1');
	});

	it('writes the id it invents into nothing, so the drawing is not dirty from a load', async () => {
		// The file keeps its bytes until the user edits it (CLAUDE.md: a drawing
		// becomes dirty only on a user's edit), when the save writes the id in.
		await remoteFile('a.svg', svg('no id\n'));

		await world.engine.sync();

		expect(drawingAt('a.svg')).toMatchObject({ content: svg('no id\n'), dirty: false });
		expect(world.provider.contentAt('a.svg')).toBe(svg('no id\n'));
		expect(world.store.ops()).toEqual([]);
	});
});

describe('an entry the provider sent twice', () => {
	it('keeps two deletions that carry no id apart', async () => {
		// Deletions are keyed by path because that is all Dropbox's
		// `DeletedMetadata` carries. Keyed by the id they do not have, every
		// id-less deletion in a batch is the same key and all but the last are
		// dropped — so a drawing deleted remotely stays on the device for ever.
		const a = await remoteFile('a.svg', svg('a\n'));
		const b = await remoteFile('b.svg', svg('b\n'));
		await world.engine.pull();
		await world.provider.delete(a);
		await world.provider.delete(b);

		await pullNow([
			{ path: 'a.svg', deleted: true },
			{ path: 'b.svg', deleted: true },
		]);

		expect(world.store.drawings()).toEqual([]);
	});

	it('conflicts a drawing once, not once per mention', async () => {
		// Dropbox documents that a path may appear more than once in a batch and
		// that the last entry for it is the current state. Decided twice against
		// the same pre-batch store, one edited drawing produces two conflict copies
		// wanting the same path — which the store cannot keep apart, and the
		// push then writes one over the other and gives them one remote id.
		const entry = await remoteFile('a.svg', svg('theirs\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const changed = await world.provider.write('a.svg', svg('theirs\n'), {
			expectedVersion: entry.version,
		});

		const result = await pullNow([changed, changed]);

		expect(result.conflicts).toHaveLength(1);
		const copies = world.store
			.drawings()
			.filter((drawing) => drawing.path.includes('conflict'));
		expect(copies).toHaveLength(1);
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.ops()).toHaveLength(1);
	});

	it('takes the last word on a file, not the first', async () => {
		// Dropbox documents that the last entry for a path in a batch is the
		// current state. Keeping the first applies a version the remote has
		// already moved past, and the drawing is left holding bytes nobody has.
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const second = await world.provider.write('a.svg', svg('two\n'), {
			expectedVersion: entry.version,
		});
		const third = await world.provider.write('a.svg', svg('three\n'), {
			expectedVersion: second.version,
		});

		await pullNow([second, third]);

		expect(drawingAt('a.svg')?.content).toBe(svg('three\n'));
		expect(drawingAt('a.svg')?.remoteVersion).toBe(third.version);
	});

	it('keeps the new file when the delete of the old one comes last', async () => {
		// Two entries at one path, in the order that hurts: the drawing is pointed
		// at the new file by the first, and the second is about the file it used
		// to be. Folding the two together drops the new file; acting on the
		// deletion afterward deletes the drawing that was just imported.
		const first = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		await world.provider.delete(first);
		const second = await remoteFile('a.svg', svg('two\n'));

		const result = await pullNow([
			second,
			{ path: 'a.svg', deleted: true, remoteId: first.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
		expect(drawingAt('a.svg')?.id).toBe(before?.id);
	});

	it('keeps a delete and a create at one path apart', async () => {
		// Two entries for one path, but two things happening — not one thing
		// said twice. Folding them together would drop whichever came second.
		const first = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		await world.provider.delete(first);
		const second = await remoteFile('a.svg', svg('two\n'));

		await pullNow([{ path: 'a.svg', deleted: true, remoteId: first.remoteId }, second]);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
	});
});

describe('a store that cannot answer', () => {
	/** The memory store with one method replaced by a rejection. */
	const breaking = (method: keyof SyncStore): SyncEngine =>
		engineWith({
			store: {
				...world.store,
				[method]: () => Promise.reject(new Error(`${method} failed`)),
			},
		});

	it.each(['cursor', 'pendingOps', 'failOp'] as const)(
		'reports rather than throwing when %s fails',
		async (method) => {
			// §7 promises a store that cannot commit is answered with `retry`,
			// exactly as a provider that cannot. Reading the cursor and reading
			// the queue are store calls too, and they sit outside the loop that
			// used to carry the only `catch` — so a caller who took the promise
			// at its word would have the app die on them.
			await remoteFile('a.svg', svg('one\n'));
			world.store.put({ id: 'n1', path: 'b.svg', content: svg('x\n'), dirty: true });
			world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
			world.provider.setFault((call) =>
				call.op === 'write' ? new Error('offline') : undefined
			);

			const result = await breaking(method).sync();

			expect(result.status).toBe('retry');
			expect(result.error).toBeDefined();
		}
	);
});

describe('the bytes a drawing last synced', () => {
	const hashOf = (id: string) =>
		world.store.drawings().find((drawing) => drawing.id === id)?.syncedHash;

	it('are recorded when a pull brings a drawing in', async () => {
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		expect(drawingAt('a.svg')?.syncedHash).toBe(await contentHash(svg('one\n')));
	});

	it('are recorded when a push sends a drawing out', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const id = drawingAt('a.svg')?.id ?? '';
		world.store.put({ ...drawingAt('a.svg')!, content: svg('two\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: id, path: 'a.svg' });

		await world.engine.push();

		expect(world.provider.contentAt('a.svg')).toBe(svg('two\n'));
		expect(entry.version).not.toBe(drawingAt('a.svg')?.remoteVersion);
		expect(hashOf(id)).toBe(await contentHash(svg('two\n')));
	});

	it('are the remote\u2019s once a conflict hands the drawing its bytes', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const id = drawingAt('a.svg')?.id ?? '';
		world.store.put({ ...drawingAt('a.svg')!, content: svg('mine\n'), dirty: true });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });

		const result = await world.engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(hashOf(id)).toBe(await contentHash(svg('theirs\n')));
	});

	it('still make a remote edit a conflict, however the version moved', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		world.store.put({ ...drawingAt('a.svg')!, content: svg('mine\n'), dirty: true });
		const edited = await world.provider.write('a.svg', svg('theirs\n'), {
			expectedVersion: entry.version,
		});
		await world.provider.move(edited, 'b.svg');

		const result = await world.engine.pull();

		expect(result.conflicts).toHaveLength(1);
		expect(drawingAt('b.svg')?.content).toBe(svg('theirs\n'));
		expect(
			world.store.drawings().find((drawing) => drawing.content.includes('mine'))?.path
		).toContain('conflict');
	});

	it('let a new version of the same bytes through without a copy', async () => {
		// Written again with nothing changed — another device saving what it
		// had, or a provider rewriting metadata. Same path, same bytes, new
		// version: the local edit goes out against the version that is there.
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const id = drawingAt('a.svg')?.id ?? '';
		world.store.put({ ...drawingAt('a.svg')!, content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: id, path: 'a.svg' });
		const again = await world.provider.write('a.svg', svg('one\n'), {
			expectedVersion: entry.version,
		});

		const result = await world.engine.sync();

		expect(result.conflicts).toEqual([]);
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.remoteVersion).not.toBe(again.version);
		expect(world.provider.contentAt('a.svg')).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(false);
	});

	it('follow a remote rename that happened while a push was still queued', async () => {
		await world.provider.createFolder('Work');
		await world.provider.createFolder('Archive');
		const entry = await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const id = drawingAt('Work/a.svg')?.id ?? '';
		world.store.put({ ...drawingAt('Work/a.svg')!, content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: id, path: 'Work/a.svg' });
		await world.provider.move(entry, 'Archive/b.svg');

		const pulled = await world.engine.pull();

		expect(pulled.conflicts).toEqual([]);
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('Archive/b.svg')).toMatchObject({
			id,
			content: svg('mine\n'),
			dirty: true,
		});
		expect(world.store.ops()).toMatchObject([{ op: 'write', path: 'Archive/b.svg' }]);
	});

	it('are not taken from a read that answers with an older version', async () => {
		// The feed names the version that holds the remote edit; a read served
		// from somewhere stale answers with the bytes before it. Those bytes
		// match the hash, but they are not the version being adopted — taking
		// the shortcut would push the local edit over an edit nobody has seen.
		const entry = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const id = drawingAt('a.svg')?.id ?? '';
		world.store.put({ ...drawingAt('a.svg')!, content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: id, path: 'a.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });
		const stale: StorageProvider = {
			...world.provider,
			read: () => Promise.resolve({ content: svg('one\n'), version: entry.version }),
		};

		const pulled = await engineWith({ provider: stale }).pull();
		await world.engine.sync();

		expect(pulled.conflicts).toHaveLength(1);
		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
		expect(world.store.drawings().some((drawing) => drawing.content.includes('mine'))).toBe(
			true
		);
	});

	it('are kept when a drawing is let go of and bound again in one batch', async () => {
		// A folder deleted with a dirty drawing moved out of it first, on a
		// provider whose version survives a move: the deletion detaches the
		// drawing, which drops its hash, and the move binds it again without a
		// read. The bytes it synced have not changed, so neither has the hash.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		const drawing = drawingAt('Work/a.svg')!;
		world.store.put({ ...drawing, content: svg('mine\n'), dirty: true });
		const entries: ChangeEntry[] = [
			{ path: 'Work', deleted: true, remoteId: folder?.remoteId ?? '' },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			{ ...file, path: 'a.svg' },
		];

		await engineWith({ provider: reporting(world.provider, entries) }).pull();

		expect(drawingAt('a.svg')).toMatchObject({
			id: drawing.id,
			remoteId: file.remoteId,
			dirty: true,
		});
		expect(hashOf(drawing.id)).toBe(await contentHash(svg('one\n')));
	});
});

describe('a dead cursor', () => {
	it('re-scans instead of retrying it forever', async () => {
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('one\n'));
	});

	it('removes what the re-scan proves is gone', async () => {
		// A scan says what exists, never what was removed. Without reconciling,
		// every drawing deleted while the cursor was dead comes back.
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		killTheCursor();
		world.store.put({
			id: 'n2',
			path: 'ghost.svg',
			content: svg('gone\n'),
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
		});

		await world.engine.pull();

		expect(drawingAt('a.svg')).toBeDefined();
		expect(drawingAt('ghost.svg')).toBeUndefined();
	});

	it('removes a drawing it only moved aside, whose own file the scan did not find', async () => {
		// `b.svg` is moved onto `a.svg`'s name while the cursor is dead, and
		// `a.svg`'s file is deleted. The scan says nothing about that file — a
		// scan never says what was removed — and moving our drawing out of the way
		// for the newcomer is no word about it either. Kept on the strength of
		// the displacement, the row lives on with a dead `remoteId`, as a
		// conflict copy of a drawing that never conflicted.
		const one = await remoteFile('a.svg', svg('one\n'));
		const two = await remoteFile('b.svg', svg('two\n'));
		await world.engine.pull();
		const mine = drawingAt('a.svg')?.id;
		await world.provider.delete(one);
		await world.provider.move(two, 'a.svg');
		killTheCursor();

		await world.engine.pull();

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['a.svg']);
		expect(drawingAt('a.svg')?.remoteId).toBe(two.remoteId);
		expect(world.store.drawings().find((drawing) => drawing.id === mine)).toBeUndefined();
	});

	it('keeps one it moved aside whose own file the scan did find', async () => {
		// The converse, and the reason the question is asked of `seen` first:
		// two files swapping names is two displacements and no deletions.
		const one = await remoteFile('a.svg', svg('one\n'));
		const two = await remoteFile('b.svg', svg('two\n'));
		await world.engine.pull();
		await world.provider.move(one, 'c.svg');
		await world.provider.move(two, 'a.svg');
		killTheCursor();

		await world.engine.pull();

		expect(
			world.store
				.drawings()
				.map((drawing) => drawing.path)
				.sort()
		).toEqual(['a.svg', 'c.svg']);
		expect(drawingAt('c.svg')?.remoteId).toBe(one.remoteId);
		expect(drawingAt('a.svg')?.remoteId).toBe(two.remoteId);
	});

	it('keeps a dirty drawing it moved aside, with its edit', async () => {
		// Never lose user data: the file is gone, so the row is cut loose rather
		// than deleted, and the edit goes back up under the name it moved to.
		const one = await remoteFile('a.svg', svg('one\n'));
		const two = await remoteFile('b.svg', svg('two\n'));
		await world.engine.pull();
		const mine = drawingAt('a.svg')?.id ?? '';
		world.store.put({
			id: mine,
			path: 'a.svg',
			content: svg('edited\n'),
			...boundTo(one),
			dirty: true,
		});
		await world.provider.delete(one);
		await world.provider.move(two, 'a.svg');
		killTheCursor();

		await world.engine.pull();

		const kept = world.store.drawings().find((drawing) => drawing.id === mine);
		expect(kept?.content).toBe(svg('edited\n'));
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('removes a folder the re-scan proves is gone', async () => {
		// Folders too. A folder deleted while the cursor was dead is never
		// mentioned again by anything, so a scan that only reconciles drawings
		// leaves an empty row in the sidebar for ever.
		await world.provider.createFolder('Work');
		await world.engine.pull();
		killTheCursor();
		world.store.putFolder({ path: 'Ghost', remoteId: 'no-such-id' });

		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Work']);
	});

	describe('when the provider says its own copy may have lost something', () => {
		// Graph's `resyncChangesUploadDifferences`: "Upload any local items that
		// the service didn't return". A server-side restore is what answers it,
		// and the scan that follows looks exactly like one where the user
		// deleted everything — so trusting it deletes every clean drawing here too,
		// on every device, quietly. https://learn.microsoft.com/en-us/graph/api/driveitem-delta
		it('sends a clean drawing back up instead of deleting it', async () => {
			await remoteFile('a.svg', svg('one\n'));
			await world.engine.pull();
			const kept = drawingAt('a.svg');
			expect(kept?.dirty).toBeFalsy();
			killTheCursor(true);
			// The remote lost it; the store still points at the file it had.
			const file = remoteAt(world.provider, 'a.svg');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			// Still here, with its words, and owed a write.
			const drawing = drawingAt('a.svg');
			expect(drawing?.id).toBe(kept?.id);
			expect(drawing?.content).toBe(svg('one\n'));
			expect(drawing?.dirty).toBe(true);
			expect(drawing?.remoteId).toBeUndefined();
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.svg' },
			]);

			// And the push puts it back where it was.
			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('a.svg')).toBe(svg('one\n'));
		});

		it('makes a folder the scan did not return again, keeping what is in it', async () => {
			await world.provider.createFolder('Work');
			await remoteFile('Work/a.svg', svg('one\n'));
			await world.engine.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			// The folder is not deleted, and it does not cascade: the drawing
			// inside is sent back up, not taken away with the folder.
			expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
			expect(drawingAt('Work/a.svg')?.content).toBe(svg('one\n'));
			// In that order: the queue is ordered, and the write of a drawing in a
			// folder that is not there yet is only rescued by a round trip.
			expect(world.store.ops().map((op) => op.op)).toEqual(['mkdir', 'write']);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('Work/a.svg')).toBe(svg('one\n'));
		});

		it('makes every folder again, not the outermost one only', async () => {
			// The ordinary reset names the outermost folder alone and lets
			// `delete-folder` cascade over what is inside it. Nothing cascades
			// here — each folder needs its own `mkdir` — so naming only the
			// outermost leaves every nested one local-only, holding drawings whose
			// writes then have to make their parents by accident.
			await world.provider.createFolder('Work');
			await world.provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.svg', svg('one\n'));
			await world.engine.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(world.store.folders().map((each) => each.path)).toEqual(['Work', 'Work/Sub']);
			// Both, outermost first, and only then the drawing inside.
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'mkdir', path: 'Work' },
				{ op: 'mkdir', path: 'Work/Sub' },
				{ op: 'write', path: 'Work/Sub/a.svg' },
			]);

			expect((await world.engine.push()).status).toBe('ok');
			expect(world.provider.contentAt('Work/Sub/a.svg')).toBe(svg('one\n'));
		});

		it('makes the folders outermost first whatever order the store lists them in', async () => {
			// `foldersWithRemote` promises no order, and both stores answer
			// parent-first only by accident — one by its primary key, one by
			// insertion. So the test above cannot tell an engine that sorts
			// from a fixture that happened to be sorted. This one can.
			await world.provider.createFolder('Work');
			await world.provider.createFolder('Work/Sub');
			await remoteFile('Work/Sub/a.svg', svg('one\n'));
			const backward = {
				...world.store,
				foldersWithRemote: async () =>
					[...(await world.store.foldersWithRemote())].reverse(),
			};
			const engineOver = engineWith({ store: backward });
			await engineOver.pull();
			killTheCursor(true);
			const folder = remoteAt(world.provider, 'Work');
			if (folder === undefined) throw new Error('no folder');
			await world.provider.delete(folder);

			expect((await engineOver.pull()).status).toBe('ok');

			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'mkdir', path: 'Work' },
				{ op: 'mkdir', path: 'Work/Sub' },
				{ op: 'write', path: 'Work/Sub/a.svg' },
			]);
		});

		it('leaves alone a drawing it moved aside, rather than sending it back up', async () => {
			// The other half of the rescan rule: a scan that may be missing
			// things proves nothing about the file our drawing holds, so a drawing the
			// batch moved out of the way for somebody else's file is not touched
			// \u2014 not deleted, and not queued for an upload that would put a
			// second copy of it on a remote that still has the first.
			const one = await remoteFile('a.svg', svg('one\n'));
			const two = await remoteFile('b.svg', svg('two\n'));
			await world.engine.pull();
			const mine = drawingAt('a.svg')?.id;
			killTheCursor(true);
			await world.provider.delete(one);
			await world.provider.move(two, 'a.svg');

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			const kept = world.store.drawings().find((drawing) => drawing.id === mine);
			expect(kept?.path).toContain('conflict');
			expect(kept?.remoteId).toBe(one.remoteId);
			expect(world.store.ops()).toEqual([]);
		});

		it('still takes the remote\u2019s side for a file the scan did return', async () => {
			// "Upload any local items that the service *didn't* return" — this one
			// it did, with different bytes. The drawing here is clean, so its bytes
			// are what it last synced and the remote's are the newer ones; a
			// dirty drawing takes the conflict rule instead, as it always does.
			const file = await remoteFile('a.svg', svg('one\n'));
			await world.engine.pull();
			killTheCursor(true);
			await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: file.version });

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
			expect(drawingAt('a.svg')?.dirty).toBeFalsy();
			expect(result.conflicts).toEqual([]);
			expect(world.store.ops()).toEqual([]);
		});

		it('does not ask a second time for a drawing that is already owed a write', async () => {
			// A dirty drawing takes `detach-drawing`, which forgets the remote and
			// leaves the write it already has to re-create the file. Naming it
			// for reupload as well would queue a second write of the same bytes
			// to the same path: the first makes the file, the second is a blind
			// write over a file the store has no version for.
			await world.engine.pull();
			killTheCursor(true);
			world.store.put({
				id: 'n2',
				path: 'mine.svg',
				content: svg('unsent\n'),
				remoteId: 'no-such-id',
				remoteVersion: 'v1',
				dirty: true,
			});
			// As the real store has it: a dirty drawing is dirty because an edit
			// queued the write.
			world.store.queue({ op: 'write', drawingId: 'n2', path: 'mine.svg' });

			await world.engine.pull();

			expect(drawingAt('mine.svg')?.content).toBe(svg('unsent\n'));
			expect(drawingAt('mine.svg')?.remoteId).toBeUndefined();
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'mine.svg' },
			]);
		});

		it('remembers what the reset asked for across the pages of the rescan', async () => {
			// Only the last page reconciles, and the flag is read there. Carried
			// no further than the first page, every page after it scans as an
			// ordinary reset and the drawings the remote lost are deleted — the
			// whole point of the flag, undone by paging alone.
			world.provider = createFakeProvider({ pageSize: 1 });
			await world.provider.ensureRoot();
			world.store = createMemoryStore();
			world.engine = engineWith();
			await world.provider.write('a.svg', svg('one\n'), {});
			await world.provider.write('b.svg', svg('two\n'), {});
			await world.provider.write('c.svg', svg('three\n'), {});
			await world.engine.pull();
			killTheCursor(true);
			const file = remoteAt(world.provider, 'a.svg');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			const result = await world.engine.pull();

			expect(result.status).toBe('ok');
			expect(drawingAt('a.svg')?.content).toBe(svg('one\n'));
			expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
				{ op: 'write', path: 'a.svg' },
			]);
		});

		it('deletes as usual when the reset does not ask for it', async () => {
			// The other half of the rule, and the one an unrecognized reset code
			// falls back to: without the flag a scan is still the truth.
			await remoteFile('a.svg', svg('one\n'));
			await world.engine.pull();
			killTheCursor();
			const file = remoteAt(world.provider, 'a.svg');
			if (file === undefined) throw new Error('no file');
			await world.provider.delete(file);

			await world.engine.pull();

			expect(drawingAt('a.svg')).toBeUndefined();
			expect(world.store.ops()).toEqual([]);
		});
	});

	it('keeps a dirty drawing the re-scan did not mention', async () => {
		await world.engine.pull();
		killTheCursor();
		world.store.put({
			id: 'n2',
			path: 'mine.svg',
			content: svg('unsent\n'),
			remoteId: 'no-such-id',
			remoteVersion: 'v1',
			dirty: true,
		});

		await world.engine.pull();

		expect(drawingAt('mine.svg')?.content).toBe(svg('unsent\n'));
		expect(drawingAt('mine.svg')?.remoteId).toBeUndefined();
	});

	it('leaves a drawing that was never pushed alone', async () => {
		// It was never in the scan because it has never existed remotely — and
		// it is clean, so nothing but the `remoteId` check stands between it and
		// being deleted as missing. A dirty drawing would survive either way.
		await world.engine.pull();
		killTheCursor();
		world.store.put({ id: 'n3', path: 'new.svg', content: svg('brand new\n') });

		await world.engine.pull();

		expect(drawingAt('new.svg')?.content).toBe(svg('brand new\n'));
	});

	it('reconciles only once the whole scan is in', async () => {
		// A scan is one logical batch spread over pages, and no page but the
		// last one has seen everything. Reconciling against a page would treat
		// every drawing the *other* pages hold as missing and delete nearly the
		// whole store — and, because the scan then finishes normally, report
		// `ok` and store the cursor over it.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.write('b.svg', svg('2\n'), {});
		await world.provider.write('c.svg', svg('3\n'), {});
		world.store = createMemoryStore();
		world.engine = engineWith({
			// One id per drawing. A constant here would have all three land on one
			// row, and the test would fail for a reason of its own making.
			newId: copyId,
		});

		await world.engine.pull();
		const before = world.store.drawings().map((drawing) => drawing.id);
		killTheCursor();
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual([
			'a.svg',
			'b.svg',
			'c.svg',
		]);
		// The same drawings, not three replacements. Reconciling a page against a
		// scan that has only reached that page deletes everything the other
		// pages hold; the later pages put a drawing back at each path, so the only
		// thing left saying it happened is that they are no longer the same
		// drawings — new ids, and everything the app hung off the old ones gone.
		expect(world.store.drawings().map((drawing) => drawing.id)).toEqual(before);
	});

	it('does not reconcile away a root folder row it somehow holds', async () => {
		// Belt and braces for the rule above: `decideFolder` never makes such a
		// row, but an older build or a hand-written store might hold one, and
		// every path is within the root — so reconciling it away after a cursor
		// reset is every drawing on the device, in one batch, reported as `ok`.
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		world.store.putFolder({ path: '', remoteId: 'root-id' });
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')).toBeDefined();
	});

	it('keeps a folder the scan only mentioned by way of a drawing inside it', async () => {
		// A provider that lists files and not folders — the scan never names the
		// folder, so reconciling deletes it, and the delete cascades over the
		// drawing the same batch has just brought in. The exemption for that drawing
		// is undone from the other direction.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.svg', svg('one\n'));
		world.store.putFolder({ path: 'Work', remoteId: 'f-from-an-older-sync' });
		world.store.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('old\n'),
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
		});

		await pullNow([entry]);

		expect(drawingAt('Work/a.svg')?.content).toBe(svg('one\n'));
		expect(world.store.folders().map((each) => each.path)).toContain('Work');
	});

	it('leaves a folder that was never pushed alone', async () => {
		await world.engine.pull();
		killTheCursor();
		world.store.putFolder({ path: 'Fresh' });

		await world.engine.pull();

		expect(world.store.folders().map((folder) => folder.path)).toContain('Fresh');
	});
});

describe('a rescan of a remote that changed while the cursor was dead', () => {
	it('does not delete the drawing it has just imported', async () => {
		// The file was replaced at the same path, so the row still carries the
		// old `remoteId` — which the scan never mentions, because the old file
		// no longer exists. Reconciling against the store as it was deletes the
		// drawing the same batch just brought in, reports `ok`, and stores the
		// cursor, so it never comes back.
		const first = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		killTheCursor();
		await world.provider.delete(first);
		await remoteFile('a.svg', svg('two\n'));

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
		expect(world.store.drawings()).toHaveLength(1);
	});

	it('does not delete a folder that was recreated under the same name', async () => {
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		killTheCursor();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('again\n'));

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
		expect(drawingAt('Work/a.svg')?.content).toBe(svg('again\n'));
	});

	it('still deletes what the rescan really did not find', async () => {
		// The guard above must not turn reconciling off.
		await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		killTheCursor();
		world.store.put({
			id: 'ghost',
			path: 'ghost.svg',
			content: svg('x\n'),
			remoteId: 'no-such-id',
		});
		world.store.putFolder({ path: 'Ghost', remoteId: 'no-such-folder' });

		await world.engine.pull();

		expect(drawingAt('ghost.svg')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
		expect(drawingAt('a.svg')).toBeDefined();
	});
});

describe('sync', () => {
	it('pulls before it pushes', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });

		const result = await world.engine.sync();

		// Pulling first turns a failed round trip into a decision made locally:
		// the conflict is found and resolved before anything is sent.
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).svg']);
		expect(world.provider.contentAt('a (conflict 2026-09-15T14-32).svg')).toBe(
			svg('mine\n', 'copy-1')
		);
	});

	it('does not push when the pull could not finish', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) =>
			call.op === 'changes' ? new AuthError('expired') : undefined
		);

		const result = await world.engine.sync();

		expect(result.status).toBe('paused');
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
	});

	it('gets a new drawing to the remote and back into the store', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });

		await world.engine.sync();

		expect(world.provider.contentAt('a.svg')).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(false);
		expect(drawingAt('a.svg')?.remoteId).toBeDefined();
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a round of changes spread over several pages', () => {
	it('moves a subfolder out before the deletion of its folder takes it', async () => {
		// Graph asks for a whole round to be applied before its state is read
		// as consistent, and a page can end anywhere. Applied a page at a time,
		// `C` goes with everything under it, and the page that says `C/A` went
		// to `B` first finds nothing to move: the folder comes back empty and
		// its clean drawings are gone from this device while the remote has them.
		const doomed = await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.svg', svg('kept\n'));
		await world.engine.pull();
		const before = drawingAt('C/A/n.svg');

		const moved = await world.provider.move(entryAt(world.provider, 'C/A'), 'B');
		await world.provider.delete(doomed);

		const result = await pullPages([
			[{ path: 'C', deleted: true, remoteId: doomed.remoteId }],
			[moved],
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('B/n.svg')?.id).toBe(before?.id);
		expect(folderPaths()).toEqual(['B']);
		expect(world.store.storedCursor()).toBe('page-1');
	});

	it('keeps a clean drawing moved out of a deleted folder as the same drawing', async () => {
		// A provider that lists every descendant reports the drawing's move as
		// its own entry. The cascade would take the drawing first, and the entry
		// would bring the file back as a new drawing under a new id.
		const doomed = await world.provider.createFolder('C');
		await remoteFile('C/n.svg', svg('n\n'));
		await world.engine.pull();
		const before = drawingAt('C/n.svg');

		const moved = await world.provider.move(entryAt(world.provider, 'C/n.svg'), 'n.svg');
		await world.provider.delete(doomed);

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('n.svg')?.id).toBe(before?.id);
		expect(folderPaths()).toEqual([]);
	});

	it('makes one conflict copy of an edited drawing it moves out of a deleted folder', async () => {
		// The move is decided ahead of the deletion, and then again in its own
		// turn. Asked twice against the store as the batch began, an edited
		// drawing would be copied twice to the same name.
		const doomed = await world.provider.createFolder('C');
		await world.engine.pull();
		const first = await remoteFile('C/n.svg', svg('original\n'));
		world.store.put({
			id: 'n1',
			path: 'C/n.svg',
			content: svg('mine\n'),
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write('C/n.svg', svg('theirs\n'), { expectedVersion: first.version });
		const moved = await world.provider.move(entryAt(world.provider, 'C/n.svg'), 'n.svg');
		await world.provider.delete(doomed);

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toHaveLength(1);
		expect(drawingAt('n.svg')?.content).toBe(svg('theirs\n'));
		expect(
			world.store
				.drawings()
				.filter((drawing) => drawing.content === svg('mine\n', drawing.id))
		).toHaveLength(1);
		expect(folderPaths()).toEqual([]);
	});

	it('keeps nothing of a round that fails partway, and its cursor', async () => {
		// The cost of reading the round whole: a failure on any page redoes it
		// from the stored cursor, as a failure before the first page always did.
		const file = await remoteFile('a.svg', svg('a\n'));
		await world.engine.pull();
		const cursor = world.store.storedCursor();
		await world.provider.delete(file);

		const result = await pullPages([
			[{ path: 'a.svg', deleted: true, remoteId: file.remoteId }],
			new Error('offline'),
		]);

		expect(result.status).toBe('retry');
		expect(drawingAt('a.svg')).toBeDefined();
		expect(world.store.storedCursor()).toBe(cursor);
	});

	it('decides a round of two thousand new drawings without reading the store for each again', async () => {
		// Read whole, a round is as big as whatever another device did: an
		// import of thousands of drawings is one round. Each decision asks about
		// the drawings the ones before it made, and asking the store afresh every
		// time is a million IndexedDB reads; replaying every decision for every
		// drawing was half a minute here before anything was stored.
		const paged = createFakeProvider({
			startAt: new Date('2026-01-01T00:00:00Z'),
			pageSize: 100,
		});
		await paged.ensureRoot();
		const counted = { reads: 0 };
		const counting: SyncStore = {
			...world.store,
			drawingById: (id) => {
				counted.reads += 1;
				return world.store.drawingById(id);
			},
			drawingsUnder: (path) => {
				counted.reads += 1;
				return world.store.drawingsUnder(path);
			},
		};
		const big = engineWith({ provider: paged, store: counting });
		await big.pull();
		const drawings = 2000;
		for (let folder = 0; folder < 20; folder += 1) {
			await paged.createFolder(`F${String(folder)}`);
		}
		for (let drawing = 0; drawing < drawings; drawing += 1) {
			await paged.write(
				`F${String(drawing % 20)}/n${String(drawing)}.svg`,
				svg(`${String(drawing)}\n`),
				{}
			);
		}
		counted.reads = 0;

		const started = Date.now();
		const result = await big.pull();

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(drawings);
		expect(counted.reads).toBeLessThan(drawings * 4);
		// The reads above are the guard; this one only catches every decision
		// replayed for every drawing again, which took a minute here. Seconds now,
		// so generous for a slow runner.
		expect(Date.now() - started).toBeLessThan(30_000);
	}, 60_000);
});

/**
 * A pull that fails part-way: a phone's screen goes off and takes the network
 * with it. A batch commits whole or not at all — a round always, and a scan a
 * page at a time, which on Google Drive is a thousand drawings — so what was read
 * before the failure is not in the store. The engine keeps it (`held`), and
 * the next pull on the same engine reads each drawing once, not the whole batch
 * again.
 */
describe('a pull that fails part-way', () => {
	const readsOf = (on: FakeProvider): string[] =>
		on
			.callLog()
			.filter((call) => call.op === 'read')
			.map((call) => call.path ?? '');

	/** How many times each path was read since `from` reads had been made. */
	const readCounts = (on: FakeProvider, from: number): Record<string, number> =>
		readsOf(on)
			.slice(from)
			.reduce<Record<string, number>>(
				(counts, path) => ({ ...counts, [path]: (counts[path] ?? 0) + 1 }),
				{}
			);

	/** The first read of `path`, once, fails with `error`. */
	const failFirstReadOf = (
		on: FakeProvider,
		path: string,
		error: Error = new Error('network suspended')
	) => {
		let failed = false;
		on.setFault((call) => {
			if (call.op !== 'read' || call.path !== path || failed) return undefined;
			failed = true;
			return error;
		});
	};

	const PATHS = ['a.svg', 'b.svg', 'c.svg', 'd.svg', 'e.svg', 'f.svg'];

	/** Six drawings sent from another device since this one's cursor: one round. */
	const sixInARound = async (): Promise<void> => {
		await world.engine.pull();
		expect(world.store.storedCursor()).toBeDefined();
		for (const path of PATHS) await remoteFile(path, svg(`${path}\n`));
	};

	const paths = () =>
		world.store
			.drawings()
			.map((drawing) => drawing.path)
			.sort();

	it('reads each drawing of a round once, however many tries it takes', async () => {
		await sixInARound();
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'd.svg');

		const failed = await world.engine.pull();

		expect(failed.status).toBe('retry');
		expect(world.store.drawings()).toEqual([]);

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(world.store.drawings().find((drawing) => drawing.path === 'c.svg')?.content).toBe(
			svg('c.svg\n')
		);
		// The three read before the failure are not read again. The one that
		// failed is, and those after it once each.
		expect(readCounts(world.provider, before)).toEqual({
			'a.svg': 1,
			'b.svg': 1,
			'c.svg': 1,
			'd.svg': 2,
			'e.svg': 1,
			'f.svg': 1,
		});
	});

	it('reads nothing again when it was the commit that failed', async () => {
		await sixInARound();
		world.store.breakNextApply();

		expect((await world.engine.pull()).status).toBe('retry');
		const before = readsOf(world.provider).length;
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(readsOf(world.provider)).toHaveLength(before);
	});

	it('reads again a drawing written over since it was read', async () => {
		await sixInARound();
		failFirstReadOf(world.provider, 'd.svg');
		expect((await world.engine.pull()).status).toBe('retry');
		world.provider.setFault(undefined);
		const held = remoteAt(world.provider, 'a.svg');
		await world.provider.write('a.svg', svg('written since\n'), {
			expectedVersion: held?.version,
		});
		const before = readsOf(world.provider).length;

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.drawings().find((drawing) => drawing.path === 'a.svg')?.content).toBe(
			svg('written since\n')
		);
		expect(readCounts(world.provider, before)).toEqual({
			'a.svg': 1,
			'd.svg': 1,
			'e.svg': 1,
			'f.svg': 1,
		});
	});

	it('does not hold a file it could not read as text', async () => {
		await world.engine.pull();
		await remoteFile('a.svg', svg('a\n'));
		world.provider.plantBytes('b.svg', new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]));
		await remoteFile('c.svg', svg('c\n'));
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'c.svg');

		expect((await world.engine.pull()).status).toBe('retry');
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(['a.svg', 'c.svg']);
		expect((await world.store.unreadable()).map((file) => file.path)).toEqual(['b.svg']);
		expect(readCounts(world.provider, before)).toEqual({ 'a.svg': 1, 'b.svg': 2, 'c.svg': 2 });
	});

	it('reads a round once more, not twice, when a token expires part-way', async () => {
		await sixInARound();
		let refreshed = 0;
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});
		const before = readsOf(world.provider).length;
		failFirstReadOf(world.provider, 'd.svg', new AuthError('expired'));

		const result = await withAuth.pull();

		expect(result.status).toBe('ok');
		expect(refreshed).toBe(1);
		expect(paths()).toEqual(PATHS);
		expect(Object.values(readCounts(world.provider, before)).reduce((a, b) => a + b, 0)).toBe(
			7
		);
	});

	it('keeps what a scan read on a page that did not commit', async () => {
		const paged = createFakeProvider({ pageSize: 2 });
		await paged.ensureRoot();
		for (const path of PATHS) await paged.write(path, svg(`${path}\n`), {});
		const scanning = engineWith({ provider: paged });
		const before = readsOf(paged).length;
		failFirstReadOf(paged, 'e.svg');

		expect((await scanning.pull()).status).toBe('retry');
		// Pages of two, in path order, the root folder first: [/, a] [b, c]
		// [d, e] [f]. Two committed; the third had read d.svg when e.svg failed.
		expect(paths()).toEqual(['a.svg', 'b.svg', 'c.svg']);
		expect(world.store.storedCursor()).toBeUndefined();

		const result = await scanning.pull();

		expect(result.status).toBe('ok');
		expect(paths()).toEqual(PATHS);
		expect(world.store.storedCursor()).toBeDefined();
		// a.svg to c.svg are in the store at their versions, and d.svg is held.
		// Only the drawing that failed is read twice.
		expect(readCounts(paged, before)).toEqual({
			'a.svg': 1,
			'b.svg': 1,
			'c.svg': 1,
			'd.svg': 1,
			'e.svg': 2,
			'f.svg': 1,
		});
	});
});
