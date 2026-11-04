import { describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../../src/providers/fake.js';
import type { SyncDrawing } from '../../../src/sync/store.js';
import { svg } from '../kit/drawings.js';
import { expectSoundStore } from '../kit/invariants.js';
import { entryAt } from '../kit/remote.js';
import { editHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * One path, more than one claim on it: reused, re-created in one window,
 * reported twice, matched to a drawing that has moved, or met by two drawings
 * neither of which ends up there (`pull/occupancy`, `pull/reconcile`,
 * `pull/replay`).
 */
const { world, engineWith, pullNow, remoteFile, drawingAt, folderPaths, drawingPaths } =
	syncWorld();

describe('a file created, deleted and re-created in one window', () => {
	it('leaves one drawing at that path, not one per entry', async () => {
		// Three entries about one path, and each of the last two has to see what
		// the ones before it did — the store cannot say, because none of the
		// batch has been applied. The deletion finds nothing and falls through
		// to the folder branch; the second file finds no occupant and lands on
		// top. Two rows at one path is a drawing the sidebar shows twice, and on a
		// path-based provider they would share a `remoteId` as well.
		await world.engine.pull();
		const first = await remoteFile('a.svg', svg('one\n'));
		await world.provider.delete(first);
		await remoteFile('a.svg', svg('two\n'));

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
	});
});

describe('two entries for one path with nothing said about the first', () => {
	it('moves the stale one aside rather than keeping two rows at the path', async () => {
		// `deduped` keeps entries for different things apart on purpose — a file
		// deleted and another created at one path is two things happening — so
		// one path can be claimed twice in a batch with no deletion between
		// them. The second claim has to see the drawing the first just made, and
		// the store cannot say: none of the batch has been applied.
		await world.engine.pull();
		const first = await remoteFile('a.svg', svg('one\n'));
		// Moved, not deleted: the entry the feed carries for it is stale, and a
		// stale entry still resolves by id. A file that is genuinely gone is the
		// other rule — there is nothing to import and the deletion arrives on
		// its own.
		await world.provider.move(first, 'b.svg');
		const second = await remoteFile('a.svg', svg('two\n'));

		const result = await pullNow([first, second]);

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.remoteId).toBe(second.remoteId);
		expect(world.store.drawings()).toHaveLength(2);
		expect(
			world.store.drawings().find((drawing) => drawing.remoteId === first.remoteId)?.path
		).toContain('conflict');
	});
});

describe('a path that has been reused', () => {
	it('keeps one drawing when a file is deleted and re-created at the same path', async () => {
		// Two rows at one path is a drawing the sidebar shows twice and two queued
		// writes racing for the same file. The drawing we hold has nothing of its
		// own left — its remote copy is gone — so it becomes the new file.
		const first = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		await world.provider.delete(first);
		const second = await remoteFile('a.svg', svg('two\n'));

		await pullNow([{ path: 'a.svg', deleted: true, remoteId: first.remoteId }, second]);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.content).toBe(svg('two\n'));
		expect(drawingAt('a.svg')?.id).toBe(before?.id);
	});

	it('does not hand a moved drawing somebody else\u2019s file', async () => {
		// Ours moved to `b.svg` and an unrelated file took `a.svg`, both in one
		// batch. Matching by path here would point our drawing at their file: our
		// drawing would adopt their contents, and our next push would overwrite
		// them with ours.
		const mine = await remoteFile('a.svg', svg('mine\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		const moved = await world.provider.move(mine, 'b.svg');
		const theirs = await remoteFile('a.svg', svg('theirs\n'));

		await pullNow([theirs, moved]);

		expect(drawingAt('b.svg')?.id).toBe(before?.id);
		expect(drawingAt('b.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(drawingAt('a.svg')?.id).not.toBe(before?.id);
	});

	it('survives a rename reported new-entry-first', async () => {
		// Nothing promises the entry at the new path comes after the deletion of
		// the old one. Taken in this order the drawing is moved and then, by a
		// deletion that names only a path we have just left, deleted.
		const file = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		const moved = await world.provider.move(file, 'b.svg');

		await pullNow([moved, { path: 'a.svg', deleted: true }]);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('b.svg')?.id).toBe(before?.id);
		expect(drawingAt('b.svg')?.content).toBe(svg('one\n'));
	});

	it('survives a root-level rename reported old-first with no ids', async () => {
		// The one ordering the local drawing's own id is the only answer to: the
		// deletion carries nothing, there is no folder above the drawing to ask
		// about, and the entry that would re-establish it has not been reached.
		const file = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		const moved = await world.provider.move(file, 'b.svg');

		const result = await pullNow([{ path: 'a.svg', deleted: true }, moved]);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('b.svg')?.id).toBe(before?.id);
		// One thing happened. Taking the deletion at face value and letting the
		// entry put the drawing back reaches the same place, but by way of cutting
		// the drawing loose from the remote and telling the user twice.
		expect(result.pulled).toBe(1);
	});

	it('reports a rename of something we do not hold as one change, not two', async () => {
		// Nothing local at either path, so the only thing saying this deletion
		// is half a move is the id it carries. Without it the engine decides a
		// folder was deleted as well as a drawing imported, and tells the user two
		// things happened when one did.
		const other = await world.provider.write('untracked.svg', svg('x\n'), {});
		const moved = await world.provider.move(other, 'renamed.svg');

		const result = await pullNow([
			{ path: 'untracked.svg', deleted: true, remoteId: other.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(result.pulled).toBe(1);
		expect(drawingAt('renamed.svg')?.content).toBe(svg('x\n'));
	});
});

describe('an entry matched by path to a drawing that has moved', () => {
	it('does not hand a drawing carried off by a folder rename somebody else’s file', async () => {
		// The rename of `A` takes `A/x.svg` to `Z/x.svg`, and one entry for the
		// folder is the whole report — nothing in the feed says anything about
		// the file. A different file then arrives at `A/x.svg`, and the store
		// still shows our drawing sitting there, so matching by path writes their
		// bytes over our drawing while its own file goes on existing as `Z/x.svg`.
		const folder = await world.provider.createFolder('A');
		await remoteFile('A/x.svg', svg('mine\n'));
		await world.engine.pull();
		const before = drawingAt('A/x.svg');

		const renamed = await world.provider.move(folder, 'Z');
		await world.provider.createFolder('A');
		const theirs = await remoteFile('A/x.svg', svg('theirs\n'));

		await pullNow([renamed, theirs]);

		expect(drawingAt('Z/x.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('Z/x.svg')?.id).toBe(before?.id);
		expect(drawingAt('A/x.svg')?.content).toBe(svg('theirs\n'));
	});
});

describe('a file moved back onto the path a folder rename carried its drawing off', () => {
	// One round on the other device: `A` renamed to `B`, a new `A` made, and
	// `B/x.svg` moved back to `A/x.svg`. The folder's rename carries the drawing to
	// `B/x.svg`, and the file's entry names the very path the store still shows
	// it at — so compared with the row rather than with where the batch has the
	// drawing, the entry reads as "nothing happened". The drawing then sits at
	// `B/x.svg` over a file at `A/x.svg`, and the next edit finds nothing at its
	// path, finds the file by id, finds no rename of its own to follow, and
	// blocks the ordered queue.

	it('follows the file when the version survived the move', async () => {
		// Dropbox's `rev` survives a move, so this is decided without a read.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('A/x.svg');

		const renamed = await world.provider.move(folder, 'B');
		const made = await world.provider.createFolder('A');
		const back = await world.provider.move(
			{ remoteId: file.remoteId, path: 'B/x.svg' },
			'A/x.svg'
		);

		for (const entries of [
			[renamed, made, { ...back, version: file.version }],
			[made, renamed, { ...back, version: file.version }],
		]) {
			world.store.put({ ...(before as SyncDrawing) });
			const result = await pullNow(entries);

			expect(result.status).toBe('ok');
			expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['A/x.svg']);
			expect(drawingAt('A/x.svg')?.id).toBe(before?.id);
		}

		// The version the feed was made to keep is not the fake's own.
		world.store.put({ ...(drawingAt('A/x.svg') as SyncDrawing), remoteVersion: back.version });
		editHere(world.store, drawingAt('A/x.svg') as SyncDrawing, svg('edited\n'));
		expect((await world.engine.push()).status).toBe('ok');
		expect(world.provider.contentAt('A/x.svg')).toBe(svg('edited\n'));
		expect(world.store.ops()).toEqual([]);
	});

	for (const folderChanges of ['folder-only', 'recursive'] as const) {
		it(`follows the file when the move changed its version (${folderChanges})`, async () => {
			// OneDrive's `eTag` does not survive a move, and nor does the fake's
			// version: same bytes, new version, read and found unchanged.
			const remote = createFakeProvider({ folderChanges });
			await remote.ensureRoot();
			const local = createMemoryStore();
			const solo = engineWith({ provider: remote, store: local });
			const folder = await remote.createFolder('A');
			const file = await remote.write('A/x.svg', svg('one\n'), {});
			await solo.pull();
			const before = local.drawings()[0];

			await remote.move(folder, 'B');
			await remote.createFolder('A');
			const back = await remote.move({ remoteId: file.remoteId, path: 'B/x.svg' }, 'A/x.svg');
			expect(back.version).not.toBe(file.version);

			expect((await solo.pull()).status).toBe('ok');
			expect(local.drawings().map((drawing) => drawing.path)).toEqual(['A/x.svg']);
			expect(local.drawings()[0]?.id).toBe(before?.id);

			editHere(local, local.drawings()[0] as SyncDrawing, svg('edited\n'));
			expect((await solo.push()).status).toBe('ok');
			expect(remote.contentAt('A/x.svg')).toBe(svg('edited\n'));
			expect(local.ops()).toEqual([]);
			// A store of its own, which the file-wide `afterEach` is not watching.
			expectSoundStore(local);
		});
	}

	it('follows the file under unpushed edits, which stay dirty', async () => {
		// The `syncedHash` route to the same answer: the remote's bytes are the
		// ones this drawing last synced, so it was moved and not edited.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('A/x.svg') as SyncDrawing;
		editHere(world.store, before, svg('edited\n'));

		await world.provider.move(folder, 'B');
		await world.provider.createFolder('A');
		await world.provider.move({ remoteId: file.remoteId, path: 'B/x.svg' }, 'A/x.svg');

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['A/x.svg']);
		expect(world.provider.contentAt('A/x.svg')).toBe(svg('edited\n'));
	});

	it('lets go of the drawing when that file is gone by the time it is read', async () => {
		// The deletion behind this entry is at `A/x.svg`, and from Dropbox it has
		// no id — so it finds nothing once the drawing has been carried to
		// `B/x.svg`, and the drawing is held there over no file for ever.
		const folder = await world.provider.createFolder('A');
		const file = await remoteFile('A/x.svg', svg('one\n'));
		await world.engine.pull();

		const renamed = await world.provider.move(folder, 'B');
		const made = await world.provider.createFolder('A');
		const back = await world.provider.move(
			{ remoteId: file.remoteId, path: 'B/x.svg' },
			'A/x.svg'
		);
		await world.provider.delete(back);

		const result = await pullNow([renamed, made, back]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toEqual([]);
	});
});

describe('a folder arriving where another is about to leave', () => {
	it('makes room for a new folder at a path the one there moves on from', async () => {
		// Drive reports a page as it stands: a new `B`, and the old `B` inside
		// it as `B/C`. Merged into one row, the move that follows carries the
		// new folder off with the old one's drawings, and `B` is gone from here.
		const old = await world.provider.createFolder('B');
		await remoteFile('B/a.svg', svg('a\n'));
		await world.engine.pull();

		await world.provider.move(old, 'X');
		const made = await world.provider.createFolder('B');
		await world.provider.move(entryAt(world.provider, 'X'), 'B/C');

		const result = await pullNow([made, entryAt(world.provider, 'B/C')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/C']);
		expect(drawingPaths()).toEqual(['B/C/a.svg']);
	});

	it('deletes a folder the round also says is gone before making the new one', async () => {
		// `B` deleted and a new `B` made, reported new first. Merged into the
		// old row, the new folder takes the old one's drawings, and the deletion
		// by the old id finds nothing to take.
		const old = await world.provider.createFolder('B');
		await remoteFile('B/a.svg', svg('a\n'));
		await world.engine.pull();

		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

		const result = await pullNow([made, { path: 'B', deleted: true, remoteId: old.remoteId }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B']);
		expect(drawingPaths()).toEqual([]);
		expect(world.store.folders()[0]?.remoteId).toBe(made.remoteId);
	});

	it('moves out a subfolder whose own move is what deletes its folder', async () => {
		// `D1` and `D2` deleted, `D1/S1` moved to `D2` and `D2/S2` to `D1`.
		// Deciding `S1` clears `D2`, whose rescue decides `S2`, which clears
		// `D1` — with `S1` still in it and its entry already being decided.
		const d1 = await world.provider.createFolder('D1');
		await world.provider.createFolder('D1/S1');
		await remoteFile('D1/S1/n1.svg', svg('n1\n'));
		const d2 = await world.provider.createFolder('D2');
		await world.provider.createFolder('D2/S2');
		await remoteFile('D2/S2/n2.svg', svg('n2\n'));
		await world.engine.pull();
		const one = drawingAt('D1/S1/n1.svg');
		const two = drawingAt('D2/S2/n2.svg');

		await world.provider.move(entryAt(world.provider, 'D1/S1'), 'X1');
		await world.provider.move(entryAt(world.provider, 'D2/S2'), 'X2');
		await world.provider.delete(d1);
		await world.provider.delete(d2);
		const s1 = await world.provider.move(entryAt(world.provider, 'X1'), 'D2');
		const s2 = await world.provider.move(entryAt(world.provider, 'X2'), 'D1');

		const result = await pullNow([
			s1,
			s2,
			{ path: 'D1', deleted: true, remoteId: d1.remoteId },
			{ path: 'D2', deleted: true, remoteId: d2.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['D1', 'D2']);
		expect(drawingAt('D2/n1.svg')?.id).toBe(one?.id);
		expect(drawingAt('D1/n2.svg')?.id).toBe(two?.id);
	});

	it('takes a subfolder whose entry outside the folder was a place it has left', async () => {
		// `C/B` renamed to `C/C`, `C` renamed to `B`, `B` deleted. The entry
		// at `C/C` is outside `B`, but decided already, and the rename after
		// it carried the folder back in: nothing is leaving, and all of it
		// goes.
		await world.provider.createFolder('C');
		await world.provider.createFolder('C/B');
		await remoteFile('C/B/a.svg', svg('a\n'));
		await world.engine.pull();

		const inner = await world.provider.move(entryAt(world.provider, 'C/B'), 'C/C');
		const outer = await world.provider.move(entryAt(world.provider, 'C'), 'B');
		await world.provider.delete(entryAt(world.provider, 'B'));

		const result = await pullNow([inner, outer, { path: 'B', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(drawingPaths()).toEqual([]);
	});

	it('moves a subfolder out of the doomed folder before deleting it', async () => {
		// `B/sub` moved to `Keep`, `B` deleted, a new `B` made — reported new
		// `B` first, as an id-tree page lists folders. Deleted to make room,
		// the old `B` would take `B/sub` and its drawings with it before the
		// entry saying where `sub` went is reached.
		const old = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		await remoteFile('B/sub/n.svg', svg('n\n'));
		await world.engine.pull();
		const before = drawingAt('B/sub/n.svg');

		const moved = await world.provider.move(entryAt(world.provider, 'B/sub'), 'Keep');
		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

		const result = await pullNow([
			made,
			moved,
			{ path: 'B', deleted: true, remoteId: old.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'Keep']);
		expect(drawingAt('Keep/n.svg')?.id).toBe(before?.id);
	});

	it('keeps an edited drawing in a subfolder moved out of the doomed folder bound to its file', async () => {
		// The same, with unpushed edits. Cut loose by the cascade, the drawing
		// stays behind at `B/sub/n.svg` with no file, and its push makes a
		// second copy beside `Keep/n.svg` instead of going to that file.
		const old = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		const file = await remoteFile('B/sub/n.svg', svg('n\n'));
		await world.engine.pull();
		const before = drawingAt('B/sub/n.svg');
		if (before === undefined) throw new Error('no drawing');
		world.store.put({ ...before, content: svg('mine\n'), dirty: true });

		const moved = await world.provider.move(entryAt(world.provider, 'B/sub'), 'Keep');
		await world.provider.delete(old);
		const made = await world.provider.createFolder('B');

		const result = await pullNow([
			made,
			moved,
			{ path: 'B', deleted: true, remoteId: old.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(
			world.store
				.drawings()
				.map((drawing) => [drawing.path, drawing.content, drawing.remoteId, drawing.dirty])
		).toEqual([['Keep/n.svg', svg('mine\n'), file.remoteId, true]]);
	});

	it('moves a folder out of the one it displaced to make room', async () => {
		// `B` renamed to `Z` and `Z/X` moved up to `B`, reported the other way
		// round. `X` is inside the `B` it displaces, so it has to be asked where
		// it is again after the displacement, or it moves from a path it has
		// already left.
		await world.provider.createFolder('B');
		await world.provider.createFolder('B/X');
		await remoteFile('B/X/n.svg', svg('n\n'));
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'B'), 'Z');
		await world.provider.move(entryAt(world.provider, 'Z/X'), 'B');

		const result = await pullNow([entryAt(world.provider, 'B'), entryAt(world.provider, 'Z')]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'Z']);
		expect(drawingPaths()).toEqual(['B/n.svg']);
	});

	it('keeps a subfolder moved up to the name of the folder being deleted', async () => {
		// `C/A` moved up to `C` as `C` is deleted. Clearing the way by deleting
		// `C` would take the arrival with it.
		const doomed = await world.provider.createFolder('C');
		await world.provider.createFolder('C/A');
		await remoteFile('C/A/n.svg', svg('n\n'));
		await world.engine.pull();
		const before = drawingAt('C/A/n.svg');

		await world.provider.move(entryAt(world.provider, 'C/A'), 'X');
		await world.provider.delete(doomed);
		await world.provider.move(entryAt(world.provider, 'X'), 'C');

		const result = await pullNow([
			{ path: 'C', deleted: true, remoteId: doomed.remoteId },
			entryAt(world.provider, 'C'),
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['C']);
		expect(drawingAt('C/n.svg')?.id).toBe(before?.id);
	});
});

describe('two drawings meeting at a path neither ends up at', () => {
	it('moves neither aside', async () => {
		// `b.svg` moved to `A/c.svg` as `C` (holding `c.svg`) is renamed to `A`
		// and its `c.svg` to `a.svg`, reported as they stand. The drawing arriving
		// and the one carried there meet at `A/c.svg` for a moment, and a
		// conflict copy of either is a drawing that never conflicted.
		await world.provider.createFolder('C');
		await remoteFile('C/c.svg', svg('c\n'));
		await remoteFile('b.svg', svg('b\n'));
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'C'), 'A');
		await world.provider.move(entryAt(world.provider, 'A/c.svg'), 'A/a.svg');
		await world.provider.move(entryAt(world.provider, 'b.svg'), 'A/c.svg');

		const result = await pullNow([
			entryAt(world.provider, 'A/c.svg'),
			entryAt(world.provider, 'A'),
			entryAt(world.provider, 'A/a.svg'),
		]);

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(drawingAt('A/a.svg')?.content).toBe(svg('c\n'));
		expect(drawingAt('A/c.svg')?.content).toBe(svg('b\n'));
	});
});
