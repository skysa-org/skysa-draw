import { describe, expect, it } from 'vitest';

import { contentHash } from '../../../src/hash.js';
import { conflictFolderPath, conflictPath } from '../../../src/names/conflicts.js';
import { parentPath } from '../../../src/paths.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import type { StorageProvider } from '../../../src/providers/types.js';
import { svg } from '../kit/drawings.js';
import { AT } from '../kit/engine.js';
import { expectSoundStore } from '../kit/invariants.js';
import { entryAt, remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';
import { createMemoryStore } from '../memoryStore.js';

/**
 * Folders moved and deleted on the remote, alone or with their ancestors in
 * one round, into themselves or twice; folders removed on one side while
 * the other still uses them; and the drawings inside through all of it
 * (`pull/folders`, `push/folders`, `pull/cascade`).
 */
const {
	world,
	engineWith,
	pullNow,
	remoteFile,
	killTheCursor,
	drawingAt,
	folderPaths,
	drawingPaths,
} = syncWorld();

describe('a batch that both deletes a folder and reconciles a scan', () => {
	it('does not name a drawing the folder delete already took', async () => {
		// The scan sweeps up everything it did not mention, and the folder
		// delete in front of it has already cascaded over the drawings inside —
		// which it named none of, so nothing in the batch says they are gone.
		// The store forgives being told twice; that forgiveness is not what
		// should be holding this up.
		// No stored cursor, so this pull is a full scan and reconciles what the
		// scan did not mention against what we hold.
		world.store.putFolder({ path: 'Work', remoteId: 'rf' });
		world.store.put({ id: 'inside', path: 'Work/a.svg', content: svg('x\n'), remoteId: 'ra' });

		await pullNow([{ path: 'Work', deleted: true, remoteId: 'rf' }]);

		expect(world.store.drawings()).toEqual([]);
		expect(world.store.folders()).toEqual([]);
	});
});

describe('a rename the provider does not re-list the children of', () => {
	it('keeps the drawings inside a renamed folder that reports only itself', async () => {
		// Nothing in §7 says a provider re-lists a folder's unchanged children
		// when the folder is renamed — their bytes did not change. So the batch
		// can be the folder at its new path plus the old child path as deleted,
		// with no id on the deletion and nothing at all about the child's new
		// one. Read literally, every drawing in the folder is gone.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('Work/a.svg');
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await world.provider.move(folder, 'Archive');

		const result = await pullNow([moved, { path: 'Work/a.svg', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('Archive/a.svg')?.id).toBe(before?.id);
		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('one\n'));
	});

	it('keeps them when the deletions come first', async () => {
		// The same batch the other way round, where the only thing saying the
		// folder is alive is the store: `Work` still holds the remote id that
		// the entry further down the batch is about.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const before = drawingAt('Work/a.svg');
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		const moved = await world.provider.move(folder, 'Archive');

		const result = await pullNow([{ path: 'Work/a.svg', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('Archive/a.svg')?.id).toBe(before?.id);
	});

	it('acts on a deletion that names the file, even inside a live folder', async () => {
		// The ancestor walk exists for a deletion that carries nothing but a
		// path. One that names the file is evidence in its own right — the
		// provider knew it well enough to identify it — and "some folder above
		// it is also in this batch" is not evidence against it. Dropped here it
		// is dropped for ever: the cursor moves on and nothing mentions it again.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('one\n'));
		await remoteFile('Work/b.svg', svg('two\n'));
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(file);

		await pullNow([folder, { path: 'Work/a.svg', deleted: true, remoteId: file.remoteId }]);

		expect(drawingAt('Work/a.svg')).toBeUndefined();
		expect(drawingAt('Work/b.svg')).toBeDefined();
	});

	it('still deletes a drawing when the folder really did go', async () => {
		// The guard leans on the folder being alive somewhere in the batch. When
		// it is not, the deletion means what it says.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);

		await pullNow([
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(world.store.drawings()).toEqual([]);
	});
});

describe('a provider that reports a folder recursively', () => {
	/**
	 * Dropbox reports a folder deletion as the folder *and* every descendant,
	 * and a rename as a deletion of the old path plus entries at the new one.
	 * The fake reports neither that way, so these feed the shapes in directly:
	 * a fixture built from the same reading of the docs as the code under test
	 * only ever confirms the reading.
	 */
	const setUpWork = async () => {
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const folder = remoteAt(world.provider, 'Work');
		const drawing = drawingAt('Work/a.svg');
		if (folder === undefined || drawing === undefined) throw new Error('not set up');
		return { file, folder, drawingId: drawing.id };
	};

	it('deletes a folder and everything in it without failing the batch', async () => {
		// The batch names the drawing twice: once as itself, and once by way of the
		// folder that cascades to it. The second one is about a row that is no
		// longer there, and a batch that fails here fails for ever — the cursor
		// moves only with the batch, so the next pull gets the same one back.
		const { file, folder } = await setUpWork();
		await world.provider.createFolder('Work/Deep');
		const deep = remoteAt(world.provider, 'Work/Deep');
		if (deep === undefined) throw new Error('no folder');
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/Deep', deleted: true, remoteId: deep.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('Work/a.svg')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
		expect(world.store.storedCursor()).toBe('reported');
		// One decision, not three. The folder takes the rest with it, and
		// repeating them would tell the user three things happened.
		expect(result.pulled).toBe(1);
	});

	it('keeps a drawing that moved out of a folder the same batch deleted', async () => {
		// Both halves are true: the folder really is gone, and the drawing really
		// did survive it. Deciding the drawing against the store as it was — before
		// the folder took it — names a row that will not be there, and the batch
		// that rejects is retried for ever.
		const { file, folder, drawingId } = await setUpWork();
		await world.provider.move(file, 'a.svg');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.svg');
		if (out === undefined) throw new Error('no file');

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('one\n'));
		expect(world.store.folders()).toEqual([]);
		expect(world.store.drawings()).toHaveLength(1);
		// Written back under the id it had, so it is the drawing that moved rather
		// than one that disappeared and another that arrived.
		expect(drawingAt('a.svg')?.id).toBe(drawingId);
	});

	it('deletes them in the other order too', async () => {
		// Nothing promises the descendants come after the folder.
		const { file, folder } = await setUpWork();
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('Work/a.svg')).toBeUndefined();
		expect(world.store.folders()).toEqual([]);
	});

	it('keeps an edited drawing when its folder is deleted remotely', async () => {
		// Never lose user data. The folder is gone and the edit was never
		// anywhere else, so the drawing survives as a local one.
		const { file, folder } = await setUpWork();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, content: svg('mine\n'), dirty: true });
		await world.provider.delete(folder);

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
		]);

		expect(drawingAt('Work/a.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('Work/a.svg')?.remoteId).toBeUndefined();
	});

	it('does not delete a drawing when the folder was only renamed', async () => {
		// The dangerous half. Read literally, the first two entries say the
		// folder and the drawing in it are gone; the last two say where they went.
		const { file, folder, drawingId } = await setUpWork();
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.svg');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			moved,
			movedFile,
		]);

		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('one\n'));
		expect(drawingAt('Work/a.svg')).toBeUndefined();
		// The same folder, moved — not deleted and conjured back into existence
		// by a drawing's parent path, which leaves it with no `remoteId` and so no
		// way to be recognized the next time it moves.
		expect(world.store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
		// The same drawing, not a replacement that happens to hold the same text.
		// Deleting and re-importing it reads the same from here and is not: it
		// drops whatever the drawing was — and a drawing with unpushed edits would be
		// detached by the delete and then duplicated by the import.
		expect(drawingAt('Archive/a.svg')?.id).toBe(drawingId);
		expect(world.store.drawings()).toHaveLength(1);
	});

	it('does not delete a drawing when the rename carries no ids at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the only
		// thing left to match on is what we already hold at that path.
		const { folder, drawingId } = await setUpWork();
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.svg');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.svg', deleted: true },
			moved,
			movedFile,
		]);

		expect(drawingAt('Archive/a.svg')?.id).toBe(drawingId);
		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('one\n'));
		expect(world.store.drawings()).toHaveLength(1);
		// Moved, not deleted and re-made: a folder that arrives as the side
		// effect of a drawing's path has no `remoteId`, and a folder with no
		// `remoteId` cannot be recognized the next time it moves, or reconciled
		// after a cursor reset.
		expect(world.store.folders()).toEqual([{ path: 'Archive', remoteId: folder.remoteId }]);
	});

	it('does not conflict an edited drawing when only the folder was renamed', async () => {
		// The same rename, with an unpushed edit in the folder. Read as a
		// deletion, the drawing is detached and the entry at the new path looks
		// like a remote change to a drawing we have edited — so the user gets a
		// conflict copy, and two drawings, for a rename they did not make.
		const { folder, drawingId } = await setUpWork();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, content: svg('mine\n'), dirty: true });
		const moved = await world.provider.move(folder, 'Archive');
		const movedFile = remoteAt(world.provider, 'Archive/a.svg');
		if (movedFile === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true },
			{ path: 'Work/a.svg', deleted: true },
			moved,
			movedFile,
		]);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('Archive/a.svg')?.id).toBe(drawingId);
		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('Archive/a.svg')?.dirty).toBe(true);
	});

	const moveOutOfDeletedFolder = async (recorded: boolean) => {
		const { file, folder } = await setUpWork();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		const { syncedHash: _hash, ...unrecorded } = drawing;
		world.store.put({
			...(recorded ? drawing : unrecorded),
			content: svg('mine\n'),
			dirty: true,
		});
		await world.provider.move(file, 'a.svg');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.svg');
		if (out === undefined) throw new Error('no file');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			out,
		]);
		return drawing.id;
	};

	it('keeps an edit on a drawing that moved out of a folder that was deleted', async () => {
		// The folder really is gone and the drawing really did survive it, with an
		// edit that was never anywhere else. Treating the drawing as gone with the
		// folder would write the remote's bytes over it. The remote's bytes are
		// the ones the drawing last synced, so the move is only a move: the drawing
		// follows it, still holding the edit, and there is nothing to copy.
		const id = await moveOutOfDeletedFolder(true);

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')).toMatchObject({ id, content: svg('mine\n'), dirty: true });
		expect(world.store.folders()).toEqual([]);
	});

	it('keeps it as a copy when the drawing cannot say what it last synced', async () => {
		// A row from before the hash was recorded. Kept as a copy of its own,
		// beside where the drawing ended up — not in `Work/`, which this batch
		// deleted.
		await moveOutOfDeletedFolder(false);

		const copy = world.store.drawings().find((each) => each.content.includes('mine'));
		expect(copy?.path).toBe(conflictPath('a.svg', AT));
		expect(drawingAt('a.svg')?.content).toBe(svg('one\n'));
		expect(world.store.folders()).toEqual([]);
	});

	it('survives the same deletion being reported twice', async () => {
		// Nothing says a page holds each path once — Dropbox documents that a
		// path may appear more than once in a batch and that the last entry
		// wins. Said twice, the second is about a drawing the first took away.
		const { file, folder } = await setUpWork();
		await world.provider.delete(folder);

		const result = await pullNow([
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toEqual([]);
		expect(world.store.storedCursor()).toBe('reported');
	});

	it.each([['', 'empty'] as const, ['/', 'a bare separator'] as const])(
		'ignores a deletion of the app folder itself, written %s (%s)',
		async (path, _shape) => {
			// Every path is within the root, so one `delete-folder` there is
			// every drawing on the device. The old fixture used `/` alone, which
			// matches no drawing and no folder under any code path — it would have
			// passed with the guard deleted.
			await setUpWork();
			world.store.putFolder({ path: '', remoteId: 'root-id' });

			const result = await pullNow([{ path, deleted: true, remoteId: 'root-id' }]);

			expect(result.status).toBe('ok');
			expect(drawingAt('Work/a.svg')).toBeDefined();
			expect(world.store.folders().map((each) => each.path)).toContain('Work');
		}
	);

	it('never makes a folder row for the app folder', async () => {
		// Graph's `delta` returns the root item. A row for it would be
		// reconciled away after the next cursor reset as a folder the scan did
		// not mention — and that one deletion takes every drawing with it.
		await setUpWork();
		const root = await world.provider.ensureRoot();

		await pullNow([
			{
				remoteId: root.rootId,
				path: '',
				kind: 'folder',
				version: 'v1',
				modifiedAt: '2026-01-01T00:00:00.000Z',
				size: 0,
			},
		]);

		expect(world.store.folders().map((each) => each.path)).not.toContain('');
	});
});

describe('a remote folder move', () => {
	it('carries the drawings inside it, dirty or not', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.move(folder, 'Archive');
		await world.engine.pull();

		// Metadata, so it applies over a dirty drawing: the user's edit is to the
		// contents and the move does not touch them.
		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('edited\n'));
		expect(drawingAt('Archive/a.svg')?.dirty).toBe(true);
	});

	it('rewrites the queued ops that named the old path', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.move(folder, 'Archive');
		await world.engine.pull();
		await world.engine.push();

		// The op would otherwise write to a path that no longer exists, and on a
		// provider that creates missing parents it would resurrect the folder.
		expect(world.provider.contentAt('Archive/a.svg')).toBe(svg('edited\n'));
		expect(world.provider.contentAt('Work/a.svg')).toBeUndefined();
	});
});

describe('a folder whose ancestor moved in the same batch', () => {
	it('follows the folder to where the batch has already put it', async () => {
		// The user renamed `A` and then dragged `A/sub` out to the root, and both
		// land in one window. By the time the second entry is decided the first
		// has already rebased everything under `A`, so the store's answer for
		// where `sub` is — `A/sub` — names a path nothing is at any more. A
		// folder move over a path that does not exist moves nothing and says
		// nothing about it, and the tree disagrees with the remote for as long
		// as the cursor lives.
		const outer = await world.provider.createFolder('A');
		const inner = await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.svg', svg('x\n'));
		await world.engine.pull();
		const before = drawingAt('A/sub/x.svg');

		const renamed = await world.provider.move(outer, 'B');
		const lifted = await world.provider.move(
			{ remoteId: inner.remoteId, path: 'B/sub' },
			'sub'
		);

		await pullNow([renamed, lifted]);

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['sub/x.svg']);
		expect(drawingAt('sub/x.svg')?.id).toBe(before?.id);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B', 'sub']);
	});

	it('makes a folder afresh when the batch already took the one it was', async () => {
		// `Work` is gone and `Work/Sub` turns up at the root as `Archive`. By
		// the time the second entry is decided the cascade has taken `Work/Sub`
		// with its parent, so there is nothing at that path to move — a
		// `move-folder` naming it moves nothing and says nothing about it, and
		// the folder never appears at all.
		const work = await world.provider.createFolder('Work');
		const sub = await world.provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/x.svg', svg('x\n'));
		await world.engine.pull();
		await world.provider.delete(work);

		await pullNow([
			{ path: 'Work', deleted: true },
			{ ...sub, path: 'Archive' },
		]);

		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('deletes the folder being replaced before moving the new one in', async () => {
		// The user deleted `Archive` and renamed `Archive 2024` onto its name,
		// and both halves arrive together. The store keeps one row per path, so
		// the move overwrites `Archive`'s row and strands its drawings under a
		// folder that is now somebody else's — and the deletion, decided
		// afterward against a path that has changed hands, then takes the
		// newcomer's drawings instead. Both folders' drawings gone, `ok` reported,
		// cursor stored, and only a cursor reset would ever bring them back.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		const result = await pullNow([
			renamed,
			{ path: 'Archive', deleted: true, remoteId: doomed.remoteId },
		]);

		expect(result.status).toBe('ok');
		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Archive/new.svg']);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Archive']);
	});

	it('recognizes a deletion that carries no id at all', async () => {
		// Dropbox's `DeletedMetadata` is a path and nothing else, so the folder
		// being replaced can only be matched by where it was.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Archive', deleted: true }]);

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Archive/new.svg']);
	});

	it('recognizes a deletion whose path is not where we think the folder is', async () => {
		// The folder was moved remotely in a window we never saw, so the
		// deletion names a path our row has never held. The id is the only
		// thing tying the two together, and without it the folder is read as
		// merely in the way and moved aside rather than deleted.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, { path: 'Vault', deleted: true, remoteId: doomed.remoteId }]);

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Archive/new.svg']);
	});

	it('gives two folders displaced out of one path different names', async () => {
		// Dropbox documents that a path may appear more than once in a batch,
		// and `deduped` keeps entries for different things apart deliberately.
		// So one path can be claimed twice, and the folder each claim displaces
		// needs a name of its own — landing on the same one puts two folders at
		// one path, which is where a folder's drawings get merged into another's.
		const first = await world.provider.createFolder('A');
		await remoteFile('A/one.svg', svg('one\n'));
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.svg', svg('two\n'));
		const third = await world.provider.createFolder('C');
		await remoteFile('C/three.svg', svg('three\n'));
		await world.engine.pull();

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
		]);

		const paths = world.store.drawings().map((drawing) => drawing.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(world.store.drawings()).toHaveLength(3);
		expect(drawingAt('A/three.svg')?.content).toBe(svg('three\n'));
		// And the two that were pushed out are still two folders, each with
		// its own drawing. Landing on one name merges them, which reads as "both
		// drawings are somewhere called conflict" unless the folders are compared.
		const one =
			world.store.drawings().find((drawing) => drawing.content === svg('one\n'))?.path ?? '';
		const two =
			world.store.drawings().find((drawing) => drawing.content === svg('two\n'))?.path ?? '';
		expect(one).toContain('conflict');
		expect(two).toContain('conflict');
		expect(parentPath(one)).not.toBe(parentPath(two));
		expect(first.remoteId).not.toBe(second.remoteId);
	});

	it('asks which folder is in the way now, not which one used to be', async () => {
		// `A` is deleted and `B` renamed onto its name, and then `C` is renamed
		// onto that. By the second claim the folder standing at `A` is `B` — the
		// one that is *not* deleted — so it has to be moved aside. Reading the
		// occupant off the store instead answers `A`, which the batch says is
		// doomed, and the delete that follows takes `B`'s drawings with it.
		const doomed = await world.provider.createFolder('A');
		await remoteFile('A/one.svg', svg('one\n'));
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.svg', svg('two\n'));
		const third = await world.provider.createFolder('C');
		await remoteFile('C/three.svg', svg('three\n'));
		await world.engine.pull();
		await world.provider.delete(doomed);

		await pullNow([
			{ ...second, path: 'A' },
			{ ...third, path: 'A' },
			{ path: 'A', deleted: true, remoteId: doomed.remoteId },
		]);

		// `B` kept its own folder rather than being merged into `C`'s: both
		// drawings surviving is not the same as both folders surviving, and the
		// merge leaves them side by side under one name.
		const two =
			world.store.drawings().find((drawing) => drawing.content === svg('two\n'))?.path ?? '';
		expect(two).toContain('conflict');
		expect(parentPath(two)).not.toBe('A');
		expect(drawingAt('A/three.svg')?.content).toBe(svg('three\n'));
		expect(world.store.drawings().some((drawing) => drawing.content === svg('one\n'))).toBe(
			false
		);
	});

	it('does not displace a folder onto a name already standing', async () => {
		// A folder displaced in an earlier batch and never claimed is still
		// sitting there under its conflict name. Taking that name again puts
		// two folders at one path and merges their drawings.
		await world.provider.createFolder('A');
		await remoteFile('A/one.svg', svg('one\n'));
		const second = await world.provider.createFolder('B');
		await remoteFile('B/two.svg', svg('two\n'));
		await world.engine.pull();
		world.store.putFolder({ path: conflictFolderPath('A', AT, []) });
		world.store.put({
			id: 'stranded',
			path: `${conflictFolderPath('A', AT, [])}/old.svg`,
			content: svg('from before\n'),
			dirty: true,
		});

		await pullNow([{ ...second, path: 'A' }]);

		const paths = world.store.drawings().map((drawing) => drawing.path);
		expect(paths).toEqual([...new Set(paths)]);
		expect(world.store.drawings().find((drawing) => drawing.id === 'stranded')?.content).toBe(
			svg('from before\n')
		);
		expect(
			world.store.drawings().find((drawing) => drawing.content === svg('one\n'))?.path
		).toContain('-2');
	});

	it('is right when the deletion comes first, too', async () => {
		// The order the engine has always handled. Asserted beside the other so
		// a fix for one that breaks the other cannot pass.
		const doomed = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();

		await world.provider.delete(doomed);
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([{ path: 'Archive', deleted: true, remoteId: doomed.remoteId }, renamed]);

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Archive/new.svg']);
	});

	it('moves a folder merely in the way aside, and brings it home', async () => {
		// Two drags in one window: `Archive` renamed to `Older`, and
		// `Archive 2024` renamed onto the name it left. Nothing says `Archive`
		// is gone, so deleting it would take drawings nobody asked to lose —
		// and leaving it merges both folders into one folder, which is how
		// `Archive/old.svg` ends up inside `Older`. It moves aside, and the
		// entry saying where it really went moves it on from there.
		const other = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();

		const lifted = await world.provider.move(other, 'Older');
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed, lifted]);

		expect(
			world.store
				.drawings()
				.map((drawing) => drawing.path)
				.sort()
		).toEqual(['Archive/new.svg', 'Older/old.svg']);
	});

	it('keeps a displaced folder and its drawings together when nothing claims it', async () => {
		// The batch never says where `Archive` went — the entry is in the next
		// window, or the provider never sends one. It stays where it was put,
		// under a name the user can recognize, with its drawings still inside it.
		// The alternative is the merge: two folders' drawings in one, and a row
		// gone for good.
		const other = await world.provider.createFolder('Archive');
		await remoteFile('Archive/old.svg', svg('old\n'));
		const renaming = await world.provider.createFolder('Archive 2024');
		await remoteFile('Archive 2024/new.svg', svg('new\n'));
		await world.engine.pull();
		await world.provider.move(other, 'Older');
		const renamed = await world.provider.move(renaming, 'Archive');

		await pullNow([renamed]);

		expect(drawingAt('Archive/new.svg')?.content).toBe(svg('new\n'));
		const kept = world.store.drawings().find((drawing) => drawing.content === svg('old\n'));
		expect(kept?.path).toContain('conflict');
		expect(world.store.folders().map((folder) => folder.path)).toContain(
			parentPath(kept?.path ?? '')
		);
	});

	it('forgets a folder created and deleted inside one window', async () => {
		// Both halves arrive in the same batch, and the store — asked as it was
		// before any of it — has never heard of the folder, so the deletion is
		// read as news about something that is not ours. The folder sits in
		// the sidebar with nothing behind it until the next cursor reset.
		const folder = await world.provider.createFolder('Work');
		await world.provider.delete(folder);

		await pullNow([folder, { path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(world.store.folders()).toEqual([]);
	});
});

describe('a remote folder delete', () => {
	it('takes the clean drawings inside it', async () => {
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		await world.engine.pull();

		const folder = remoteAt(world.provider, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await world.provider.delete(folder);
		await world.engine.pull();

		expect(drawingAt('Work/a.svg')).toBeUndefined();
		expect(world.store.folders().map((f) => f.path)).not.toContain('Work');
	});

	it('keeps a dirty drawing inside it', async () => {
		// The folder is the user's remote layout; the drawing is their writing.
		// Losing the second to a change in the first is not a trade worth making.
		const folderOnly = createFakeProvider({ folderChanges: 'folder-only' });
		await folderOnly.ensureRoot();
		const local = createMemoryStore();
		const solo = engineWith({ provider: folderOnly, store: local });

		await folderOnly.createFolder('Work');
		const entry = await folderOnly.write('Work/a.svg', svg('one\n'), {});
		local.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		await solo.pull();

		const folder = remoteAt(folderOnly, 'Work');
		if (folder === undefined) throw new Error('no folder');
		await folderOnly.delete(folder);
		await solo.pull();

		const kept = local.drawings().find((drawing) => drawing.path === 'Work/a.svg');
		expect(kept?.content).toBe(svg('edited\n'));
		expect(kept?.remoteId).toBeUndefined();
		// This one drives a store of its own, so the file-wide `afterEach` is
		// watching the wrong one.
		expectSoundStore(local);
	});
});

/**
 * Round 8 of adversarial review. Every one of these is the same mistake in a
 * different place — a decision reached against the store when the question it
 * was really asking was about the batch in front of it — and what they have in
 * common beyond that is folders. A folder change says one word about a whole
 * subtree, so the gap between what the feed reports and what actually moves is
 * widest here.
 */
describe('a folder move landing on top of what is already there', () => {
	it('moves the drawings in the way aside, not just the folder', async () => {
		// The user deleted `B` and renamed `A` onto its name. `B/x.svg` had an
		// unpushed edit, so the cascade keeps it and merely cuts it loose — and
		// that leaves nothing at `B` for `clearTheWay` to find while there is
		// still something at `B/x.svg`. `A/x.svg` then lands on top of it: two
		// rows at one path, and after the next push both point at one file,
		// each overwriting the other for ever.
		const fa = await world.provider.createFolder('A');
		await remoteFile('A/x.svg', svg('from A\n'));
		const fb = await world.provider.createFolder('B');
		await remoteFile('B/x.svg', svg('from B\n'));
		await world.engine.pull();
		const mine = drawingAt('B/x.svg');
		if (mine === undefined) throw new Error('nothing at B/x.svg');
		world.store.put({ ...mine, content: svg('my edit\n'), dirty: true });

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(drawingAt('B/x.svg')?.content).toBe(svg('from A\n'));
		const kept = world.store.drawings().find((drawing) => drawing.content === svg('my edit\n'));
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B');
	});

	it('leaves a folder moving within itself alone', async () => {
		// Every drawing under `Work` is both a mover and a sitter here. Displacing
		// them against themselves would rename every drawing in the folder to a
		// conflict copy over a change that moved nothing at all.
		await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('a\n'));
		await world.engine.pull();
		const folder = await world.provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		const renamed = await world.provider.move(folder, 'Archive');

		await pullNow([renamed]);

		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['Archive/a.svg']);
	});
});

describe('a folder deletion decided against a path that changed hands', () => {
	it('acts on a deletion inside a folder the batch has just moved in', async () => {
		// Delete `B`, rename `A` onto `B`, delete `B/sub`. The third is about
		// `A/sub`, which is at `B/sub` by the time it is decided — and the store
		// has never held a row at that path. Asking the store alone drops the
		// deletion, and a dropped deletion is dropped for ever: the cursor moves
		// on and nothing says it again.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/inside.svg', svg('inside\n'));
		const fb = await world.provider.createFolder('B');
		await world.engine.pull();

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([
			{ path: 'B', deleted: true, remoteId: fb.remoteId },
			renamed,
			{ path: 'B/sub', deleted: true },
		]);

		expect(world.store.drawings()).toEqual([]);
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B']);
	});

	it('acts on a second deletion of a path re-occupied in the same batch', () =>
		(async () => {
			// Delete `A`, rename `B` onto `A`, delete `A`. The two deletions name
			// one path and mean two different folders. Reading the second as
			// already covered by the first leaves the folder the user deleted
			// in the sidebar until something else happens to it.
			const fa = await world.provider.createFolder('A');
			await remoteFile('A/in A.svg', svg('in A\n'));
			const fb = await world.provider.createFolder('B');
			await remoteFile('B/in B.svg', svg('in B\n'));
			await world.engine.pull();

			await world.provider.delete(fa);
			const renamed = await world.provider.move(fb, 'A');

			await pullNow([
				{ path: 'A', deleted: true, remoteId: fa.remoteId },
				renamed,
				{ path: 'A', deleted: true, remoteId: fb.remoteId },
			]);

			expect(world.store.drawings()).toEqual([]);
			expect(world.store.folders()).toEqual([]);
		})());
});

describe('the deeper reaches of a folder move', () => {
	it('moves a drawing two levels down out of the way', async () => {
		// A folder move says one word about a whole subtree, and the collisions
		// it causes are not all at the top of it. Looking only at the immediate
		// children of the destination leaves the nested ones to land on top of
		// each other.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.svg', svg('from A\n'));
		const fb = await world.provider.createFolder('B');
		await world.provider.createFolder('B/sub');
		await remoteFile('B/sub/x.svg', svg('from B\n'));
		await world.engine.pull();
		const mine = drawingAt('B/sub/x.svg');
		if (mine === undefined) throw new Error('nothing at B/sub/x.svg');
		world.store.put({ ...mine, content: svg('my edit\n'), dirty: true });

		await world.provider.delete(fb);
		const renamed = await world.provider.move(fa, 'B');

		await pullNow([{ path: 'B', deleted: true, remoteId: fb.remoteId }, renamed]);

		expect(drawingAt('B/sub/x.svg')?.content).toBe(svg('from A\n'));
		const kept = world.store.drawings().find((drawing) => drawing.content === svg('my edit\n'));
		expect(kept?.path).toContain('conflict');
		expect(parentPath(kept?.path ?? '')).toBe('B/sub');
	});
});

describe('a rescan that finds a whole folder tree gone', () => {
	it('says so once, not once per folder in it', async () => {
		// `delete-folder` cascades over everything beneath it, so naming the
		// nested one as well is a second delete of a row the first has already
		// taken away. The store forgives that — a rejected batch is retried for
		// ever — but forgiveness is not the same as being right, and a store
		// that does reject would strand this user's sync permanently.
		await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Sub');
		await remoteFile('Work/Sub/a.svg', svg('a\n'));
		await world.engine.pull();
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['Work', 'Work/Sub']);

		const folder = await world.provider
			.list('')
			.then((entries) => entries.find((entry) => entry.path === 'Work'));
		if (folder === undefined) throw new Error('no Work folder');
		await world.provider.delete(folder);
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders()).toEqual([]);
		expect(world.store.drawings()).toEqual([]);
	});
});

/**
 * Round 9 of adversarial review. The family round 8 traced through the folder
 * decisions runs through the drawing queries too — `drawingsTouching` is the root of
 * every batch-aware question about drawings, and it was still asking the store one
 * the batch had already answered — and the push half has it as well, in two
 * places where an op is decided against state something else has invalidated.
 */
describe('a drawing an earlier decision moved into a folder', () => {
	it('is seen by the folder it lands in', async () => {
		// A `move-drawing` brings a single file in from anywhere at all, and its row
		// is still at the old path in the store, so neither `drawingsUnder(folder)`
		// nor `drawingsUnder(a move-folder source)` can see it. Missing it means
		// nothing is displaced when a second file lands on the same name.
		await world.provider.createFolder('X');
		await world.provider.createFolder('Y');
		const mine = await remoteFile('X/a.svg', svg('mine\n'));
		world.store.put({
			id: 'n1',
			path: 'X/a.svg',
			content: svg('mine, edited\n'),
			...boundTo(mine),
			dirty: true,
		});
		// On the remote inside one window: ours moves X → Y (a rename moves no
		// bytes, and Dropbox's `rev` survives one), is deleted, and a different
		// file takes the name. Ours holds an edit, so the deletion cuts it loose
		// rather than taking it, and it is still in the way.
		const moved = await world.provider.move(mine, 'Y/a.svg');
		await world.provider.delete(moved);
		const theirs = await remoteFile('Y/a.svg', svg('theirs\n'));

		await pullNow([{ ...mine, path: 'Y/a.svg' }, { path: 'Y/a.svg', deleted: true }, theirs]);

		expect(drawingAt('Y/a.svg')?.content).toBe(svg('theirs\n'));
		const ours = world.store.drawings().find((drawing) => drawing.id === 'n1');
		expect(ours?.content).toBe(svg('mine, edited\n'));
		expect(ours?.path).toContain('conflict');
		expect(parentPath(ours?.path ?? '')).toBe('Y');
	});

	it('lets go of a clean drawing in its place, which the deletion was about', async () => {
		await world.provider.createFolder('X');
		await world.provider.createFolder('Y');
		const mine = await remoteFile('X/a.svg', svg('mine\n'));
		world.store.put({
			id: 'n1',
			path: 'X/a.svg',
			content: svg('mine\n'),
			...boundTo(mine),
		});
		const moved = await world.provider.move(mine, 'Y/a.svg');
		await world.provider.delete(moved);
		const theirs = await remoteFile('Y/a.svg', svg('theirs\n'));

		await pullNow([{ ...mine, path: 'Y/a.svg' }, { path: 'Y/a.svg', deleted: true }, theirs]);

		expect(world.store.drawings().map((drawing) => [drawing.path, drawing.content])).toEqual([
			['Y/a.svg', svg('theirs\n')],
		]);
	});
});

describe('a rescan naming a folder the same batch has moved', () => {
	it('names where the row ended up', async () => {
		// A scan is one batch like any other. Naming the pre-batch path asks the
		// store to delete a row that is not there, and leaves the folder the
		// remote no longer has sitting in the sidebar under its new name.
		const fa = await world.provider.createFolder('A');
		await world.provider.createFolder('A/sub');
		await remoteFile('A/sub/x.svg', svg('x\n'));
		await world.engine.pull();
		const sub = await world.provider
			.list('A')
			.then((entries) => entries.find((entry) => entry.path === 'A/sub'));
		if (sub === undefined) throw new Error('no A/sub');
		await world.provider.delete(sub);
		await world.provider.move(fa, 'B');
		killTheCursor();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.folders().map((folder) => folder.path)).toEqual(['B']);
		expect(world.store.drawings()).toEqual([]);
	});
});

/**
 * Phase 6: a round of changes read whole, and what a remote changed at random
 * underneath one device found once it was (`randomRemote.test.ts`). Each test
 * here is one of those findings, reduced to the entries that caused it.
 */
describe('a folder removed here, whose directory the remote still has', () => {
	/** The folder paths the remote holds, which is what an `rmdir` is about. */
	const remoteFolders = () =>
		world.provider
			.snapshot()
			.filter((entry) => entry.kind === 'folder')
			.map((entry) => entry.path)
			.sort();

	it('removes the directory a deleted folder left behind', async () => {
		const made = await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('a\n'));
		await world.engine.pull();
		// What the app queues for a folder delete: the drawings' deletes, and
		// the folder behind them.
		world.store.put({ ...drawingAt('Work/a.svg')!, dirty: true });
		world.store.queue({
			op: 'delete',
			drawingId: drawingAt('Work/a.svg')!.id,
			path: 'Work/a.svg',
		});
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		world.store.removeFolder('Work');

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual([]);
		expect(world.provider.contentAt(file.path)).toBeUndefined();
		expect(world.store.ops()).toEqual([]);
	});

	it('removes the directory a renamed folder left behind, after its drawings move', async () => {
		// The rename goes up as the drawing moving and the old directory being
		// removed. Ordered the other way round, the `rmdir` would find the drawing
		// still in there and leave the directory for ever.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('a\n'));
		await world.engine.pull();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, path: 'Plans/a.svg' });
		world.store.removeFolder('Work');
		world.store.putFolder({ path: 'Plans' });
		world.store.queue({ op: 'mkdir', path: 'Plans' });
		world.store.queue({
			op: 'move',
			drawingId: drawing.id,
			path: 'Work/a.svg',
			targetPath: 'Plans/a.svg',
		});
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Plans']);
		expect(world.provider.contentAt('Plans/a.svg')).toBe(svg('a\n'));
		// And the folder here holds the directory the `mkdir` made, so its
		// own `rmdir` could name it later.
		expect(world.store.folders()).toEqual([
			{
				path: 'Plans',
				remoteId: remoteAt(world.provider, 'Plans')?.remoteId,
			},
		]);
	});

	it('leaves a directory holding a file this device never pulled', async () => {
		// The whole difficulty: another device wrote into the folder while
		// this one was deleting it. Removed recursively, that file goes with it.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await remoteFile('Work/theirs.svg', svg('theirs\n'));
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(world.provider.contentAt('Work/theirs.svg')).toBe(svg('theirs\n'));
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves a directory holding a hidden file, or one in a subfolder', async () => {
		const made = await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Deep');
		await world.engine.pull();
		await world.provider.write('Work/Deep/.keep', svg('x\n'), {});
		world.store.removeFolder('Work');
		world.store.removeFolder('Work/Deep');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work', 'Work/Deep']);
	});

	it('removes a directory whose subfolders are empty', async () => {
		const made = await world.provider.createFolder('Work');
		await world.provider.createFolder('Work/Deep');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.removeFolder('Work/Deep');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual([]);
	});

	it('leaves the directory alone once the user has made the folder again', async () => {
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		// Made again here, which the queue's own withdrawal usually catches —
		// this is the backstop for an `rmdir` already at the network.
		world.store.putFolder({ path: 'Work' });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work']);
	});

	it('leaves the directory alone while a drawing of ours is still in it', async () => {
		// A drawing made here and not pushed yet, so the directory is empty on the
		// remote and the walk says nothing: the row is what says the folder
		// is still in use, and its write is queued behind this.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'Work/fresh.svg', content: svg('fresh\n'), dirty: true });
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/fresh.svg' });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Work']);
		expect(world.provider.contentAt('Work/fresh.svg')).toBe(svg('fresh\n'));
		// Never even asked for: removed and made again by the write behind it,
		// the directory would be a new one on the provider, and every other
		// device would see the folder go and come back.
		expect(
			world.provider.callLog().some((call) => call.op === 'delete' && call.path === 'Work')
		).toBe(false);
	});

	it('leaves alone a directory renamed or replaced somewhere else', async () => {
		// The id is what says which folder this op is about. Another device
		// renamed ours away and made its own at the name; removing whatever
		// holds the name would take theirs.
		// And theirs is empty, so nothing but the id stands between this op and
		// a directory that was never ours.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await world.provider.move(made, 'Ours');
		const theirs = await world.provider.createFolder('Work');
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		await world.engine.push();

		expect(remoteFolders()).toEqual(['Ours', 'Work']);
		expect(remoteAt(world.provider, 'Work')?.remoteId).toBe(theirs.remoteId);
		// Ours is the one the op named, and it is still there too: the folder
		// that moved away is not what the path says any more.
		expect(remoteAt(world.provider, 'Ours')?.remoteId).toBe(made.remoteId);
	});

	it('does nothing at all without the id it was queued with', async () => {
		await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work']);
		expect(world.store.ops()).toEqual([]);
	});

	it('finishes when the directory is already gone', async () => {
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		await world.provider.delete(made);
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
	});

	it('does not put the folder back from the mkdir its own push is about to answer', async () => {
		// A sync pulls before it pushes, so a folder deleted between two
		// rounds is reported by the pull as a folder that exists — this
		// device's own `mkdir`, coming back. Made again from that, the
		// folder is in the sidebar again and the `rmdir` behind it refuses
		// to remove a directory the device still holds.
		//
		// The folder is made here, and its `mkdir` pushed after the cursor
		// is stored: that is what puts it in the next round's feed. Created on
		// the remote before the first pull, it would be behind the cursor and
		// the feed would be empty, which is no test of anything.
		world.store.putFolder({ path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		await world.engine.pull();
		await world.engine.push();
		const made = remoteAt(world.provider, 'Work');
		expect(made?.remoteId).toBe(world.store.folders()[0]?.remoteId);
		// The user deletes it again before the next round.
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made?.remoteId });

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(remoteFolders()).toEqual([]);
	});

	it('makes the folder above one whose directory has gone', async () => {
		// The row above is still here — nothing here deleted it — so no `mkdir`
		// was owed for it, and the one for the subfolder finds nothing to make
		// it in. Left to fail it blocks the queue over a folder.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.putFolder({ path: 'Work/Inner' });
		world.store.queue({ op: 'mkdir', path: 'Work/Inner' });
		// Another device removes the directory the folder is in.
		await world.provider.delete(made);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(remoteFolders()).toEqual(['Work', 'Work/Inner']);
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves the directory, rather than deleting it, where the provider cannot see what it would delete', async () => {
		// Drive's scope hides files the user added themselves (§5.1), so a
		// listing that comes back empty proves nothing — and deleting a folder
		// takes what is under it whether the app can see it or not. It is
		// marked as left instead, which touches nothing in it.
		const blind = createFakeProvider({ listsEverything: false });
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		expect(theirs.ops()).toEqual([]);
		expect(blind.callLog().some((call) => call.op === 'delete')).toBe(false);
		expect(
			blind
				.callLog()
				.filter((call) => call.op === 'leaveFolder')
				.map((call) => call.path)
		).toEqual(['Work']);
		expect(
			blind
				.snapshot()
				.filter((entry) => entry.kind === 'folder')
				.map((entry) => entry.path)
		).toEqual(['Work']);
	});

	it('does not leave a directory a file it can see is still in', async () => {
		// Another device's, written after this one last pulled: the same gate
		// that keeps a delete from taking it keeps the directory a folder.
		const blind = createFakeProvider({ listsEverything: false });
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		await blind.write('Work/theirs.svg', svg('theirs\n'), {});
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		expect(theirs.ops()).toEqual([]);
		expect(
			blind.callLog().some((call) => call.op === 'leaveFolder' || call.op === 'delete')
		).toBe(false);
	});

	it('does nothing where the provider can neither delete nor leave a directory', async () => {
		const fake = createFakeProvider({ listsEverything: false });
		const blind: StorageProvider = { ...fake, leaveFolder: undefined };
		const theirs = createMemoryStore();
		const theirEngine = engineWith({ provider: blind, store: theirs });
		const made = await blind.createFolder('Work');
		await theirEngine.pull();
		theirs.removeFolder('Work');
		theirs.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		const asked = fake.callLog().length;

		const result = await theirEngine.push();

		expect(result.status).toBe('ok');
		// Finished rather than retried for ever, with nothing asked of the
		// provider, and the directory stays.
		expect(theirs.ops()).toEqual([]);
		expect(fake.callLog().slice(asked)).toEqual([]);
	});

	it('gives up on a directory it cannot remove rather than holding up the queue', async () => {
		// Housekeeping, and the only op that is not the user's: an empty
		// directory left on the remote costs them nothing, and every drawing they
		// write from here on waiting behind it costs them everything.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({
			op: 'rmdir',
			path: 'Work',
			remoteId: made.remoteId,
			attempts: 5,
		});
		world.store.put({ id: 'n1', path: 'later.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'later.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('later.svg')).toBe(svg('mine\n'));
		expect(world.store.ops()).toEqual([]);
		expect(remoteFolders()).toEqual(['Work']);
	});

	it('does not let a deletion with no id take a folder made again at the name', async () => {
		// Dropbox reports a folder deletion as a path and nothing else, this
		// device's own included. So the round after an `rmdir` lands carries
		// the deletion of a name the user may have made a folder at since —
		// and taken for that row it deletes the folder they just made, with
		// everything they have put in it, while the `mkdir` queued behind it
		// makes the directory again. A row the remote has never heard of
		// cannot be what a deletion is about.
		// The folder alone, with nothing in it yet: a drawing in it would keep
		// the row by itself — a cascade leaves the drawings it keeps a folder to
		// be in — and the empty folder is the case that needs the rule.
		world.store.putFolder({ path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work' });

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Work']);
		// And its `mkdir` is still owed: the directory has to be made again.
		expect(world.store.ops().map((op) => op.op)).toEqual(['mkdir']);
	});

	it('still takes a folder the remote did have at the name', async () => {
		// The other half: a row with an id is a directory the remote knows, and
		// a deletion by path alone is about it.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		expect(folderPaths()).toEqual(['Work']);

		const result = await pullNow([{ path: 'Work', deleted: true }]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual([]);
		expect(made.remoteId).toBeDefined();
	});

	it('keeps a folder another device made at the name it is removing', async () => {
		// A different folder, with an id of its own: the `rmdir` is not about
		// it, and neither is the row.
		const made = await world.provider.createFolder('Work');
		await world.engine.pull();
		world.store.removeFolder('Work');
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await world.provider.move(made, 'Ours');
		const theirs = await world.provider.createFolder('Work');

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Ours', 'Work']);
		expect(world.store.folders().find((folder) => folder.path === 'Work')?.remoteId).toBe(
			theirs.remoteId
		);
	});

	it('does not bring a renamed folder back on the next pull', async () => {
		// What the op is for on this device: the `mkdir` of the new name and the
		// old directory's removal both come back in the next round, and the old
		// folder must not be among them.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('a\n'));
		await world.engine.pull();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, path: 'Plans/a.svg' });
		world.store.removeFolder('Work');
		world.store.putFolder({ path: 'Plans' });
		world.store.queue({ op: 'mkdir', path: 'Plans' });
		world.store.queue({
			op: 'move',
			drawingId: drawing.id,
			path: 'Work/a.svg',
			targetPath: 'Plans/a.svg',
		});
		world.store.queue({ op: 'rmdir', path: 'Work', remoteId: made.remoteId });
		await world.engine.push();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['Plans']);
		expect(drawingPaths()).toEqual(['Plans/a.svg']);
	});
});

describe('a folder the user moved a drawing into, removed by another device', () => {
	/**
	 * Found by the two-device soak: one device removes the directory the other
	 * has just renamed a drawing into, before that rename was pushed. The
	 * deletion is right — the directory is gone — but the drawing's own file is
	 * still where it always was, and the cascade would take the row with the
	 * folder and leave the file behind on the remote with nothing here
	 * naming it. The cursor has moved past that file, so nothing would mention
	 * it again: only a re-scan would find the drawing.
	 */
	const setUp = async () => {
		const made = await world.provider.createFolder('Plans');
		await remoteFile('a.svg', svg('a\n'));
		await world.engine.pull();
		const drawing = drawingAt('a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		// The rename, as the app queues it: the row moves now, the file moves
		// when the op runs.
		world.store.put({ ...drawing, path: 'Plans/a.svg' });
		world.store.queue({
			op: 'move',
			drawingId: drawing.id,
			path: 'a.svg',
			targetPath: 'Plans/a.svg',
		});
		await world.provider.delete({ remoteId: made.remoteId, path: 'Plans' });
		return drawing;
	};

	it('keeps the drawing the rename has not moved yet', async () => {
		const drawing = await setUp();

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingPaths()).toEqual(['Plans/a.svg']);
		const kept = world.store.drawings().find((one) => one.id === drawing.id);
		expect(kept?.remoteId).toBe(drawing.remoteId);
		expect(kept?.dirty).toBe(false);
		// And a folder to be in, from the same `ensure-folder` that roofs
		// over the drawings a cascade keeps.
		expect(folderPaths()).toEqual(['Plans']);
		expect(world.store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('and the rename makes the directory again when it runs', async () => {
		await setUp();
		await world.engine.pull();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Plans/a.svg')).toBe(svg('a\n'));
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
		expect(world.store.ops()).toEqual([]);
	});

	it('keeps it on a scan, where the folder is gone by not being mentioned', async () => {
		// The other way a folder is found to be gone: a scan reports what
		// exists, and `reconcile` turns everything it did not mention into a
		// deletion. The queued rename is the same, and so is the harm.
		const entry = await remoteFile('a.svg', svg('a\n'));
		world.store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		world.store.put({
			id: 'n1',
			path: 'Plans/a.svg',
			content: svg('a\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('a\n')),
			dirty: false,
		});
		world.store.queue({
			op: 'move',
			drawingId: 'n1',
			path: 'a.svg',
			targetPath: 'Plans/a.svg',
		});

		// No cursor, so this is a scan.
		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(drawingPaths()).toEqual(['Plans/a.svg']);
		expect(world.store.drawings()[0]?.remoteId).toBe(entry.remoteId);
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('roofs over the edited drawing a scan’s cascade keeps', async () => {
		// Not the queued-rename case: an unsent edit outranks a remote
		// deletion, so the cascade keeps that drawing too and merely cuts it
		// loose. Before, only the rounds `decideAll` decides made roofs, so a
		// scan left the drawing at a path with no folder — holding its name,
		// invisible in the sidebar.
		world.store.putFolder({ path: 'Plans', remoteId: 'folder-the-remote-lost' });
		world.store.put({
			id: 'n1',
			path: 'Plans/a.svg',
			content: svg('mine\n'),
			remoteId: 'gone',
			dirty: true,
		});

		await world.engine.pull();

		expect(drawingPaths()).toEqual(['Plans/a.svg']);
		expect(world.store.drawings()[0]?.remoteId).toBeUndefined();
		expect(folderPaths()).toEqual(['Plans']);
	});

	it('takes the drawing whose file was inside the directory under its old name', async () => {
		// The round renames the folder and then deletes it: `Work` to
		// `Plans`, and `Plans` gone. A drawing renamed *within* the folder has
		// an origin outside `Plans` — it is `Work/a.svg` — and is inside the
		// directory all the same. Kept, it would be a clean drawing pointing at a
		// file in the bin, under a folder row for a directory the remote
		// does not have.
		const made = await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('a\n'));
		await world.engine.pull();
		const drawing = drawingAt('Work/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, path: 'Work/b.svg' });
		world.store.queue({
			op: 'move',
			drawingId: drawing.id,
			path: 'Work/a.svg',
			targetPath: 'Work/b.svg',
		});
		const moved = await world.provider.move(made, 'Plans');
		await world.provider.delete({ remoteId: moved.remoteId, path: 'Plans' });

		await world.engine.pull();

		expect(drawingPaths()).toEqual([]);
		expect(folderPaths()).toEqual([]);
	});

	it('takes the drawing whose file is inside the directory that has gone', async () => {
		// The other half of the rule: a rename *within* the folder says
		// nothing about a file the deletion really does remove.
		const made = await world.provider.createFolder('Plans');
		await remoteFile('Plans/a.svg', svg('a\n'));
		await world.engine.pull();
		const drawing = drawingAt('Plans/a.svg');
		if (drawing === undefined) throw new Error('no drawing');
		world.store.put({ ...drawing, path: 'Plans/b.svg' });
		world.store.queue({
			op: 'move',
			drawingId: drawing.id,
			path: 'Plans/a.svg',
			targetPath: 'Plans/b.svg',
		});
		await world.provider.delete({ remoteId: made.remoteId, path: 'Plans' });

		await world.engine.pull();

		expect(drawingPaths()).toEqual([]);
		expect(folderPaths()).toEqual([]);
	});
});

describe('a folder moved into what it was', () => {
	it('swaps a folder with its own child without a conflict copy', async () => {
		// `B` moved into `C` and `C` renamed to `B`, reported as `B` at `B/B`
		// and `C` at `B`. The first move leaves `B` empty and `B/B` full; asked
		// backward, a path inside the old one read as still holding the folder
		// that left it, and the arriving `C` was displaced to a conflict name.
		await world.provider.createFolder('B');
		await remoteFile('B/a.svg', svg('a\n'));
		await world.provider.createFolder('C');
		await remoteFile('C/c.svg', svg('c\n'));
		await world.engine.pull();

		await world.provider.move(entryAt(world.provider, 'B'), 'C/B');
		await world.provider.move(entryAt(world.provider, 'C'), 'B');

		const result = await pullNow([
			entryAt(world.provider, 'B/B'),
			entryAt(world.provider, 'B'),
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['B', 'B/B']);
		expect(drawingPaths()).toEqual(['B/B/a.svg', 'B/c.svg']);
	});
});

describe('a folder said to move twice in one round', () => {
	it('takes both moves, and what was put inside it between them', async () => {
		// A feed that tells the story in order — `B` renamed to `A`, a file
		// moved into `A`, `A` renamed to `C` — needs the first rename to have
		// happened for the file to land inside it. Keeping only the last word
		// about the folder put the file in an `A` that never was.
		const folder = await world.provider.createFolder('B');
		const file = await remoteFile('a.svg', svg('a\n'));
		await world.engine.pull();

		const result = await pullNow([
			{ ...folder, path: 'A' },
			{ ...file, path: 'A/c.svg' },
			{ ...folder, path: 'C' },
		]);

		expect(result.status).toBe('ok');
		expect(folderPaths()).toEqual(['C']);
		expect(drawingPaths()).toEqual(['C/c.svg']);
	});

	it('follows a folder it made from where it made it', async () => {
		await world.engine.pull();
		const folder = await world.provider.createFolder('B');

		await pullNow([{ ...folder, path: 'A' }, folder]);

		expect(folderPaths()).toEqual(['B']);
	});
});
