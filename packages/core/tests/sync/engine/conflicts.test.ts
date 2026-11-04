import { describe, expect, it } from 'vitest';

import { readDrawingId } from '../../../src/drawing/document.js';
import { conflictPath } from '../../../src/names/conflicts.js';
import { basename } from '../../../src/paths.js';
import { svg } from '../kit/drawings.js';
import { AT } from '../kit/engine.js';
import { remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * Both sides changed one drawing, or one path: §7's conflict rule, where the
 * remote keeps the path and ours is written beside it as a conflict copy
 * (`conflicts`, `push/conflicts`).
 */
const { world, engineWith, pullNow, remoteFile, drawingAt } = syncWorld();

describe('a conflict', () => {
	const bothChanged = async () => {
		const first = await remoteFile('a.svg', svg('original\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: first.version });
	};

	it('gives the remote the path and the local edit a copy beside it', async () => {
		await bothChanged();
		const result = await world.engine.pull();

		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).svg']);
	});

	it('keeps every byte the user wrote', async () => {
		await bothChanged();
		await world.engine.pull();

		// All of them but the id, which is the copy's own (below).
		const copy = drawingAt('a (conflict 2026-09-15T14-32).svg');
		expect(copy?.content).toBe(svg('mine\n', copy?.id));
		expect(copy?.dirty).toBe(true);
	});

	it('gives the copy an identity of its own', async () => {
		// Two files claiming one id is the state the whole identity scheme
		// exists to avoid, and the pair would fight over the same drawing forever.
		await bothChanged();
		await world.engine.pull();

		const copy = drawingAt('a (conflict 2026-09-15T14-32).svg');
		expect(copy?.id).toBe('copy-1');
		expect(readDrawingId(copy?.content ?? '')).toBe('copy-1');
	});

	it('queues the copy for push, so it reaches the other devices too', async () => {
		await bothChanged();
		await world.engine.pull();

		expect(world.store.ops().map((op) => op.path)).toEqual([
			'a (conflict 2026-09-15T14-32).svg',
		]);
	});

	it('does not let a second conflict overwrite the first', async () => {
		await bothChanged();
		await world.engine.pull();
		const first = await world.provider.changes();
		const entry = first.entries.find((e) => e.path === 'a.svg');
		if (entry === undefined || entry.deleted === true) throw new Error('missing');

		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine again\n'),
			...boundTo(entry),
			dirty: true,
		});
		await world.provider.write('a.svg', svg('theirs again\n'), {
			expectedVersion: entry.version,
		});
		await world.engine.pull();

		// Same drawing, same minute: the stamp alone is not unique enough.
		expect(world.store.drawings().map((drawing) => drawing.path)).toContain(
			'a (conflict 2026-09-15T14-32)-2.svg'
		);
		const copy = drawingAt('a (conflict 2026-09-15T14-32).svg');
		expect(copy?.content).toBe(svg('mine\n', copy?.id));
	});

	/**
	 * The same two devices, where the other one is a Mac. A folder made through
	 * the Finder carries its accents decomposed, so the copy that device saved a
	 * minute ago arrives under `Cafe\u0301` while ours is under `Caf\u00e9` —
	 * one folder to every provider in §5, two to a byte comparison. Reading the
	 * folder byte-exactly drops that copy from the names this one must not take,
	 * and the name is then free for a copy that is the only place the losing
	 * edit exists.
	 */
	it('does not overwrite a copy another device left under a decomposed folder name', async () => {
		const nfc = 'Caf\u00e9';
		const nfd = 'Cafe\u0301';
		await world.provider.createFolder(nfc);
		await world.provider.createFolder(nfd);
		const first = await remoteFile(`${nfc}/a.svg`, svg('original\n'));
		await remoteFile(`${nfd}/a (conflict 2026-09-15T14-32).svg`, svg('theirs, saved\n'));
		world.store.put({
			id: 'n1',
			path: `${nfc}/a.svg`,
			content: svg('mine\n'),
			...boundTo(first),
			dirty: true,
		});
		await world.provider.write(`${nfc}/a.svg`, svg('theirs\n'), {
			expectedVersion: first.version,
		});

		await world.engine.pull();

		expect(drawingAt(`${nfd}/a (conflict 2026-09-15T14-32).svg`)?.content).toContain(
			svg('theirs, saved\n')
		);
		const copy = drawingAt(`${nfc}/a (conflict 2026-09-15T14-32)-2.svg`);
		expect(copy?.content).toBe(svg('mine\n', copy?.id));
	});
});

describe('a drawing deleted here and changed there', () => {
	it('lets the delete win, having written the row back first', async () => {
		// The row is the tombstone — it is what carries the `remoteId` the
		// queued delete needs — so the pull finds it and treats it as any other
		// drawing. It is written back and then purged by the op behind it. The
		// delete is something the user did; the remote change may well be their
		// own from the other device.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toEqual([]);
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
	});
});

describe('a drawing of ours where a remote one lands', () => {
	it('moves ours aside rather than leaving two at one path', async () => {
		// Two devices both wrote an `Untitled.svg` offline, or a drawing was moved
		// remotely into a folder where we happen to have one of that name. Left
		// where it is, the sidebar shows the same row twice and the queued write
		// for ours eventually lands on the other one's file — after which both
		// rows carry one remote id and overwrite each other for ever.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('b.svg', svg('theirs\n'));
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'Work/b.svg', content: svg('mine\n'), dirty: true });
		await world.provider.move(entry, 'Work/b.svg');

		await world.engine.pull();

		expect(world.store.drawings()).toHaveLength(2);
		expect(drawingAt('Work/b.svg')?.content).toBe(svg('theirs\n'));
		const ours = world.store.drawings().find((drawing) => drawing.id === 'mine');
		expect(ours?.content).toBe(svg('mine\n'));
		expect(ours?.dirty).toBe(true);
		expect(ours?.path).toContain('conflict');
		expect(ours?.path).not.toBe('Work/b.svg');
	});

	it('conflicts rather than displacing when it is the same drawing', async () => {
		// Two devices both wrote an `Untitled.svg` offline. Ours is the drawing at
		// that path *and* the drawing the entry is about, because it has never been
		// pushed and the path is all there is to go on — so this is an ordinary
		// conflict, not something to move out of its own way first.
		world.store.put({ id: 'mine', path: 'Untitled.svg', content: svg('mine\n'), dirty: true });
		await remoteFile('Untitled.svg', svg('theirs\n'));

		const result = await world.engine.pull();

		// One thing happened to this drawing. Moving it out of its own way first
		// and then conflicting it reaches the same place by way of telling the
		// user their drawing moved somewhere it never was.
		expect(result.pulled).toBe(1);

		expect(world.store.drawings()).toHaveLength(2);
		expect(drawingAt('Untitled.svg')?.id).toBe('mine');
		expect(drawingAt('Untitled.svg')?.content).toBe(svg('theirs\n'));
		expect(
			world.store.drawings().find((drawing) => drawing.content.includes('mine'))?.path
		).toContain('conflict');
		// Moving it out of its own way first would leave it sharing a path with
		// the copy made of it a moment later.
		expect(new Set(world.store.drawings().map((drawing) => drawing.path)).size).toBe(2);
	});

	it('moves a synced drawing aside too, and brings it home next time', async () => {
		// Ours has been pushed, but it has no claim to this path either: the
		// remote has something else here, so our drawing's own file is elsewhere by
		// now. Leaving it would be two rows on one path until whenever the entry
		// saying where it went turns up — and `drawingByRemoteId` only ever hands
		// back one of two rows, so the other would be stale for ever.
		const mine = await remoteFile('a.svg', svg('mine\n'));
		const theirs = await remoteFile('b.svg', svg('theirs\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		// On the remote, ours moved out and theirs moved in. Only the second half
		// reaches us in this batch, so we still think ours is at `a.svg`.
		const movedMine = await world.provider.move(mine, 'c.svg');
		const movedTheirs = await world.provider.move(theirs, 'a.svg');

		await pullNow([movedTheirs]);

		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		const ours = world.store.drawings().find((drawing) => drawing.id === before?.id);
		expect(ours?.path).toContain('conflict');
		// It keeps its `remoteId`, so the entry that says where it went — this
		// is the other half, a batch later — puts it back where it belongs.
		await pullNow([movedMine]);

		expect(drawingAt('c.svg')?.id).toBe(before?.id);
		expect(world.store.drawings()).toHaveLength(2);
	});

	it('moves aside a drawing the same batch detached', async () => {
		// The occupant had been pushed when the batch started and is unpushed by
		// the time this change runs: a remote delete of a drawing we had edits for
		// detaches it and leaves it where it is. Asking the store as it was gets
		// the wrong answer, and the two drawings end up on one path — and then, on
		// the next push, one `remoteId` between them.
		await world.provider.createFolder('Work');
		const ours = await remoteFile('Work/b.svg', svg('theirs-old\n'));
		const loose = await remoteFile('loose.svg', svg('theirs\n'));
		await world.engine.pull();
		const mine = drawingAt('Work/b.svg');
		if (mine === undefined) throw new Error('no drawing');
		world.store.put({ ...mine, content: svg('my unpushed edit\n'), dirty: true });

		// On the remote: ours deleted, and `loose.svg` renamed into its place.
		await world.provider.delete(ours);
		const moved = await world.provider.move(loose, 'Work/b.svg');

		await pullNow([{ path: 'Work/b.svg', deleted: true, remoteId: ours.remoteId }, moved]);

		expect(drawingAt('Work/b.svg')?.content).toBe(svg('theirs\n'));
		const kept = world.store.drawings().find((drawing) => drawing.id === mine.id);
		expect(kept?.content).toBe(svg('my unpushed edit\n'));
		expect(kept?.path).toContain('conflict');
		expect(kept?.remoteId).toBeUndefined();
	});

	it('gives a displacement and a conflict copy of one entry different names', async () => {
		// A drawing moved *and* edited remotely, onto a path we have something at.
		// The one entry needs both — and both are named from the same path, so
		// without one seeing the other they get the same name and the store is
		// handed two drawings for one file.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('Work/old.svg', svg('theirs\n'));
		await world.engine.pull();
		const theirs = drawingAt('Work/old.svg');
		if (theirs === undefined) throw new Error('no drawing');
		world.store.put({ ...theirs, content: svg('my edit\n'), dirty: true });
		world.store.put({
			id: 'squatter',
			path: 'Work/a.svg',
			content: svg('squatting\n'),
			dirty: true,
		});

		const moved = await world.provider.move(entry, 'Work/a.svg');
		const edited = await world.provider.write('Work/a.svg', svg('theirs, edited\n'), {
			expectedVersion: moved.version,
		});

		await pullNow([edited]);

		expect(drawingAt('Work/a.svg')?.content).toBe(svg('theirs, edited\n'));
		const aside = world.store.drawings().filter((drawing) => drawing.path.includes('conflict'));
		expect(aside).toHaveLength(2);
		expect(new Set(aside.map((drawing) => drawing.path)).size).toBe(2);
		expect(world.store.drawings().map((drawing) => drawing.content)).toContain(
			svg('squatting\n')
		);
		expect(world.store.drawings().some((drawing) => drawing.content.includes('my edit'))).toBe(
			true
		);
	});

	it('does not move a drawing an earlier folder delete already took', async () => {
		// The clean, never-pushed drawing at `Work/a.svg` goes with the folder, so
		// by the time the entry lands there is nothing to move aside. Asking the
		// store to move it anyway fails the batch — for ever, since the cursor
		// moves only with it.
		await world.provider.createFolder('Work');
		const loose = await remoteFile('loose.svg', svg('theirs\n'));
		await world.engine.pull();
		world.store.put({ id: 'goner', path: 'Work/a.svg', content: svg('never pushed\n') });

		// On the remote, `Work` was deleted and made again, and a file moved in.
		// One batch can carry the deletion of the old one and the file in the new.
		const old = remoteAt(world.provider, 'Work');
		if (old === undefined) throw new Error('no folder');
		await world.provider.delete(old);
		await world.provider.createFolder('Work');
		const moved = await world.provider.move(loose, 'Work/a.svg');

		const result = await pullNow([
			{ path: 'Work', deleted: true, remoteId: old.remoteId },
			moved,
		]);

		expect(result.status).toBe('ok');
		expect(drawingAt('Work/a.svg')?.content).toBe(svg('theirs\n'));
	});

	it('does not move a drawing an earlier entry already moved out', async () => {
		// Two files swapped places remotely. The second entry lands where the
		// first one's drawing used to be, and the store still says our drawing is
		// there — so the occupant check has to know the batch has moved it on,
		// or the drawing is dragged off to a conflict name instead of its new home.
		const mine = await remoteFile('a.svg', svg('mine\n'));
		const theirs = await remoteFile('b.svg', svg('theirs\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		const movedMine = await world.provider.move(mine, 'c.svg');
		const movedTheirs = await world.provider.move(theirs, 'a.svg');

		await pullNow([movedMine, movedTheirs]);

		expect(drawingAt('c.svg')?.id).toBe(before?.id);
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings()).toHaveLength(2);
	});

	it('does not move a drawing an earlier conflict already moved out', async () => {
		// Same again, where what moved our drawing on was a conflict: the drawing
		// takes the remote's path, which is not the one it was at.
		const mine = await remoteFile('a.svg', svg('mine\n'));
		const theirs = await remoteFile('b.svg', svg('theirs\n'));
		await world.engine.pull();
		const before = drawingAt('a.svg');
		if (before === undefined) throw new Error('no drawing');
		world.store.put({ ...before, content: svg('my edit\n'), dirty: true });

		const movedMine = await world.provider.move(mine, 'c.svg');
		const editedMine = await world.provider.write('c.svg', svg('theirs, edited\n'), {
			expectedVersion: movedMine.version,
		});
		const movedTheirs = await world.provider.move(theirs, 'a.svg');

		await pullNow([editedMine, movedTheirs]);

		expect(drawingAt('c.svg')?.id).toBe(before.id);
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings().some((drawing) => drawing.content.includes('my edit'))).toBe(
			true
		);
	});

	it('does not move a drawing a folder move already carried off', async () => {
		// `Work` was renamed and a new `Work` made in its place, with a file
		// moved in. Our drawing went with the rename; the store still has it at the
		// old path, so without following the folder move the occupant check
		// drags it into the new `Work` under a conflict name.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('mine\n'));
		const loose = await remoteFile('loose.svg', svg('theirs\n'));
		await world.engine.pull();
		const before = drawingAt('Work/a.svg');
		const old = remoteAt(world.provider, 'Work');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'Archive');
		const fresh = await world.provider.createFolder('Work');
		const moved = await world.provider.move(loose, 'Work/a.svg');

		await pullNow([renamed, fresh, moved]);

		expect(drawingAt('Archive/a.svg')?.id).toBe(before?.id);
		expect(drawingAt('Archive/a.svg')?.content).toBe(svg('mine\n'));
		expect(drawingAt('Work/a.svg')?.content).toBe(svg('theirs\n'));
		expect(file.remoteId).toBe(drawingAt('Archive/a.svg')?.remoteId);
	});

	it('points a displaced drawing\u2019s queued rename at where it went', async () => {
		// The user renamed `Untitled.svg` to `Groceries.svg` and the move is still
		// queued; the other device moved its own drawing onto that name first.
		// Ours is displaced, but its queued move still aims at `Groceries.svg` —
		// which the remote now owns, so it conflicts on every attempt and can
		// never succeed. The queue is ordered, so everything behind it is
		// stranded with it.
		const ours = await remoteFile('Untitled.svg', svg('mine\n'));
		const theirs = await remoteFile('other.svg', svg('theirs\n'));
		world.store.put({
			id: 'mine',
			path: 'Groceries.svg',
			content: svg('mine\n'),
			...boundTo(ours),
		});
		world.store.put({
			id: 'theirs',
			path: 'other.svg',
			content: svg('theirs\n'),
			...boundTo(theirs),
		});
		world.store.queue({
			op: 'move',
			drawingId: 'mine',
			path: 'Untitled.svg',
			targetPath: 'Groceries.svg',
		});
		const moved = await world.provider.move(theirs, 'Groceries.svg');

		// Our own file among them: this is a scan, and a scan says everything
		// that exists, so a list that leaves `Untitled.svg` out is a list saying
		// it is gone — and the drawing is then displaced *and* let go of, which is
		// right for that list and not what this test is about.
		await pullNow([ours, moved]);
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		// And the rename followed the drawing: the remote file it names is where
		// the drawing now is, rather than still sitting under its first name.
		const displaced = world.store.drawings().find((drawing) => drawing.id === 'mine');
		expect(displaced?.path).toContain('conflict');
		expect(world.provider.snapshot().map((node) => node.path)).toContain(displaced?.path);
	});

	it('displaces a drawing a folder move in the same batch brings down on the path', async () => {
		// `Old` was renamed to `New` and a file put at `New/b.svg`, in one batch.
		// Our `Old/b.svg` is carried into `New` by the rename, so by the time the
		// file lands there is something at that path — and the store, asked
		// before any of it, says the path is free.
		await world.provider.createFolder('Old');
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'Old/b.svg', content: svg('my edit\n'), dirty: true });
		const old = remoteAt(world.provider, 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'New');
		const landing = await remoteFile('New/b.svg', svg('theirs\n'));

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(drawingAt('New/b.svg')?.content).toBe(svg('theirs\n'));
		const ours = world.store.drawings().find((drawing) => drawing.id === 'mine');
		expect(ours?.content).toBe(svg('my edit\n'));
		expect(ours?.path).toContain('conflict');
	});

	it('does not name a copy after a drawing the same batch is moving in', async () => {
		// Same rename, and this time the drawing being carried in is an older
		// conflict copy — which is exactly the name the copy about to be made
		// wants. Nothing else in the batch mentions it: a rename re-lists no
		// children, so the folder entry is the only thing saying where it went.
		await world.provider.createFolder('Old');
		const file = await remoteFile('Old/b.svg', svg('theirs\n'));
		await world.engine.pull();
		const before = drawingAt('Old/b.svg');
		if (before === undefined) throw new Error('no drawing');
		world.store.put({ ...before, content: svg('my edit\n'), dirty: true });
		world.store.put({
			id: 'older',
			path: conflictPath('Old/b.svg', AT, []),
			content: svg('an earlier copy\n'),
			dirty: true,
		});
		const old = remoteAt(world.provider, 'Old');
		if (old === undefined) throw new Error('no folder');

		const renamed = await world.provider.move(old, 'New');
		const edited = await world.provider.write('New/b.svg', svg('theirs, edited\n'), {
			expectedVersion: file.version,
		});

		await pullNow([renamed, edited]);

		expect(drawingAt('New/b.svg')?.content).toBe(svg('theirs, edited\n'));
		expect(world.store.drawings().find((drawing) => drawing.id === 'older')?.content).toBe(
			svg('an earlier copy\n')
		);
		expect(world.store.drawings().some((drawing) => drawing.content.includes('my edit'))).toBe(
			true
		);
	});

	it('gives a displacement a name nothing else is using', async () => {
		// The name a displacement wants is the one a conflict copy would get,
		// and there may already be one of those sitting beside it from an
		// earlier sync. Taking it again is two drawings at one path.
		const entry = await remoteFile('other.svg', svg('theirs\n'));
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'b.svg', content: svg('never pushed\n'), dirty: true });
		world.store.put({
			id: 'older',
			path: conflictPath('b.svg', AT, []),
			content: svg('an earlier copy\n'),
			dirty: true,
		});
		await world.provider.move(entry, 'b.svg');

		await world.engine.pull();

		expect(drawingAt('b.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings().find((drawing) => drawing.id === 'older')?.content).toBe(
			svg('an earlier copy\n')
		);
		expect(world.store.drawings().find((drawing) => drawing.id === 'mine')?.content).toBe(
			svg('never pushed\n')
		);
	});

	it('gives two drawings landing on one path two different names', async () => {
		// A folder move can bring a drawing down on top of one already there, so
		// more than one can be in the way of a single remote file. Named
		// without each other they both take the same conflict name, and the
		// sidebar shows one row twice.
		const folder = await world.provider.createFolder('Old');
		world.store.putFolder({ path: 'Old', remoteId: folder.remoteId });
		const file = await remoteFile('other.svg', svg('theirs\n'));
		world.store.put({
			id: 'theirs',
			path: 'other.svg',
			content: svg('theirs\n'),
			...boundTo(file),
		});
		world.store.put({
			id: 'here',
			path: 'New/b.svg',
			content: svg('already here\n'),
			dirty: true,
		});
		world.store.put({
			id: 'carried',
			path: 'Old/b.svg',
			content: svg('carried in\n'),
			dirty: true,
		});

		const renamed = await world.provider.move(folder, 'New');
		const landing = await world.provider.move(file, 'New/b.svg');

		const result = await pullNow([renamed, landing]);

		expect(result.status).toBe('ok');
		expect(drawingAt('New/b.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings().find((drawing) => drawing.id === 'here')?.content).toBe(
			svg('already here\n')
		);
		expect(world.store.drawings().find((drawing) => drawing.id === 'carried')?.content).toBe(
			svg('carried in\n')
		);
	});

	it('does not move a drawing a conflict and a folder delete already took', async () => {
		// The conflict hands the local edit to a copy, which leaves the drawing
		// clean — and a clean drawing goes with the folder delete that follows
		// rather than surviving it detached. Reading the dirty flag as it was
		// before the batch has the engine move a drawing the store has dropped.
		await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('theirs\n'));
		const other = await remoteFile('Work/z.svg', svg('other\n'));
		await world.engine.pull();
		const before = drawingAt('Work/a.svg');
		if (before === undefined) throw new Error('no drawing');
		world.store.put({ ...before, content: svg('my edit\n'), dirty: true });
		const edited = await world.provider.write('Work/a.svg', svg('theirs, edited\n'), {
			expectedVersion: file.version,
		});

		const result = await pullNow([
			edited,
			{ path: 'Work', deleted: true, remoteId: 'no-such-folder' },
			{ ...other, path: 'Work/a.svg' },
		]);

		expect(result.status).toBe('ok');
	});

	it('does not displace a drawing the same batch has already removed', async () => {
		// The deletion carries no id, so it is matched by path and takes our
		// local-only drawing with it. A later entry landing on that path would then
		// ask the store to move a drawing that is not there — and a batch the store
		// rejects is retried for ever, because the cursor moves only with it.
		const entry = await remoteFile('b.svg', svg('theirs\n'));
		await world.engine.pull();
		world.store.put({ id: 'mine', path: 'a.svg', content: svg('never pushed\n') });
		const moved = await world.provider.move(entry, 'a.svg');

		const result = await pullNow([{ path: 'a.svg', deleted: true }, moved]);

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
	});
});

describe('a push that cannot be resolved by the conflict rule', () => {
	it('puts a rename beside a target the remote will not give up', async () => {
		// The conflict rule is about two versions of one drawing's contents. A move
		// onto an occupied path is not that: resolving it would take the remote
		// entry the error carries — somebody else's file — and point our drawing at
		// it, adopting its id, its version, and on the next pull its contents.
		//
		// Nor can it simply stay queued. Nothing will ever free that name, so
		// the op fails on every attempt and the ordered queue strands every op
		// behind it, for every drawing, over a rename. The remote keeps the path
		// (CLAUDE.md) and the rename lands beside it under a conflict name,
		// where the user can see what happened to it.
		const mine = await remoteFile('a.svg', svg('mine\n'));
		await remoteFile('b.svg', svg('theirs\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			...boundTo(mine),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toHaveLength(1);
		// Its own file still, not the one that was in the way.
		expect(world.store.drawings()[0]?.remoteId).toBe(mine.remoteId);
		expect(world.store.drawings()[0]?.path).toBe(conflictPath('b.svg', AT));
		expect(world.provider.contentAt('b.svg')).toBe(svg('theirs\n'));
		expect(world.store.ops()).toEqual([]);
	});

	it('moves from where the drawing is now, not where the op was queued', async () => {
		// A pull between queueing a move and running it rebases the drawing but
		// leaves the op's own `path` behind. Invisible where `remoteId`
		// identifies the file, and the whole address where it does not — WebDAV,
		// where `remoteId` *is* the path (deferred).
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'moved-by-pull.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		const seen: string[] = [];
		const byPath = engineWith({
			provider: {
				...world.provider,
				move: (ref, target) => {
					seen.push(ref.path);
					return world.provider.move({ remoteId: ref.remoteId, path: ref.path }, target);
				},
			},
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.svg']);
	});

	it('deletes where the drawing is now, not where the op was queued', async () => {
		// Same reasoning as the move above, and the same blindness in the fake:
		// it resolves by `remoteId` first, so only a provider addressed by path
		// can see the difference.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'moved-by-pull.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });

		const seen: string[] = [];
		const byPath = engineWith({
			provider: {
				...world.provider,
				delete: (ref) => {
					seen.push(ref.path);
					return world.provider.delete(ref);
				},
			},
		});
		await byPath.push();

		expect(seen).toEqual(['moved-by-pull.svg']);
	});

	it('stops rather than dropping an op it could not read (#447)', async () => {
		// A row that is none of the kinds — a move that lost its target, a kind
		// a later version queued — is a store that lost a column, not an op with
		// nothing to do. Completing it would discard the user's rename with
		// nothing said anywhere; it fails, and stops the push once it has
		// failed too often, with the row still queued.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({ id: 'n1', path: 'b.svg', content: svg('one\n'), ...boundTo(entry) });
		const op = world.store.queue({ op: 'malformed', path: 'a.svg', problem: 'no targetPath' });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toContain('no targetPath');

		// At the limit, it stops the push, and is still there.
		world.store.ops().forEach((each) => {
			world.store.unqueue(each.seq);
		});
		world.store.queue({
			op: 'malformed',
			path: 'a.svg',
			problem: 'no targetPath',
			attempts: 5,
		});
		expect((await world.engine.push()).status).toBe('blocked');
		expect(world.store.ops().map((each) => each.op)).toEqual(['malformed']);
	});

	it('stops rather than discarding a mkdir that found a file in the way', async () => {
		// The op carries no drawing at all, so there is nothing to make a copy of.
		// Completing it would tell the queue the folder exists, and the write
		// behind it would go to a path that is not there.
		await remoteFile('Work', svg('not a folder\n'));
		world.store.put({ id: 'n1', path: 'Work/a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.provider.contentAt('Work/a.svg')).toBeUndefined();
	});
});

describe('two conflicts in one batch', () => {
	/** A drawing the remote and this device have both changed. */
	const diverge = async (path: string) => {
		const entry = await remoteFile(path, svg('theirs\n'));
		world.store.put({
			id: `n-${path}`,
			path,
			content: svg('mine\n'),
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		return world.provider.write(path, svg('theirs\n'), { expectedVersion: entry.version });
	};

	it('avoids a copy name already in the store', async () => {
		// A conflict copy is named from the drawing it came from, so the collision
		// to worry about is never with another drawing's copy — it is with a name
		// that is already taken. Here the user resolved yesterday's conflict by
		// keeping the copy, and today's lands on the same minute.
		await diverge('a.svg');
		const taken = conflictPath('a.svg', AT);
		world.store.put({ id: 'kept', path: taken, content: svg('yesterday\n'), dirty: true });

		await world.engine.pull();

		expect(drawingAt(taken)?.content).toBe(svg('yesterday\n'));
		const mine = world.store.drawings().find((drawing) => drawing.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(taken);
	});

	it('avoids a name already taken in the folder the drawing moved to', async () => {
		// The copy lands beside the drawing's new home, so the names it has to
		// avoid are that folder's — not the ones back where the drawing came from.
		await world.provider.createFolder('Work');
		const entry = await remoteFile('a.svg', svg('theirs\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		// Someone already holds the name the copy would want in `Work`.
		world.store.put({
			id: 'squatter',
			path: conflictPath('Work/a.svg', AT),
			content: svg('x\n'),
		});
		const moved = await world.provider.move(entry, 'Work/a.svg');

		await pullNow([moved]);

		const mine = world.store.drawings().find((drawing) => drawing.content.includes('mine'));
		expect(mine?.path).toContain('conflict');
		expect(mine?.path).not.toBe(conflictPath('Work/a.svg', AT));
		expect(drawingAt(conflictPath('Work/a.svg', AT))?.id).toBe('squatter');
	});

	it('gives two drawings conflicting at once a copy each', async () => {
		await diverge('a.svg');
		await diverge('b.svg');

		await world.engine.pull();

		const copies = world.store
			.drawings()
			.filter((drawing) => drawing.path.includes('conflict'));
		expect(copies).toHaveLength(2);
		expect(world.store.drawings().map((drawing) => drawing.content)).toContain(svg('theirs\n'));
	});

	it('avoids a name the same batch is bringing in', async () => {
		// The other device conflicted a minute ago and its copy is arriving in
		// the very batch that decides to make ours. The name is free in the
		// store and taken on the remote, and writing to it loses the edit the
		// copy exists to save.
		await diverge('a.svg');
		const taken = conflictPath('a.svg', AT);
		await remoteFile(taken, svg('theirs, conflicted\n'));

		await world.engine.pull();

		expect(drawingAt(taken)?.content).toBe(svg('theirs, conflicted\n'));
		const mine = world.store.drawings().find((drawing) => drawing.content.includes('mine'));
		expect(mine?.path).not.toBe(taken);
		expect(mine?.path).toContain('conflict');
	});
});

describe('a drawing the pull conflicted with a write still queued', () => {
	it('does not send the remote its own bytes back', async () => {
		// The local edit is in the copy now and the drawing holds the remote's
		// content. Replaying the write puts the remote's own bytes back under a
		// new version, which every other device then pulls as a change that
		// changed nothing — and which can lose a race against a real edit made
		// in between.
		const file = await remoteFile('x.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'x.svg',
			content: svg('my edit\n'),
			...boundTo(file),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'x.svg' });
		const theirs = await world.provider.write('x.svg', svg('theirs\n'), {
			expectedVersion: file.version,
		});

		await pullNow([theirs]);
		await world.engine.push();

		expect(world.provider.contentAt('x.svg')).toBe(svg('theirs\n'));
		expect(remoteAt(world.provider, 'x.svg')?.version).toBe(theirs.version);
		expect(world.store.drawings().some((drawing) => drawing.content.includes('my edit'))).toBe(
			true
		);
	});
});

describe('two devices making a conflict copy at once', () => {
	it('does not name ours what theirs already claims', async () => {
		// The other device conflicted first and its copy is arriving in the very
		// batch that makes ours. Both are named from the same path and the same
		// minute, so the obvious name is taken — by a file that is not in the
		// store yet and will not be until this batch commits. Naming ours the
		// same puts two drawings at one path, which the sidebar shows twice and the
		// next push has overwrite each other for ever.
		const file = await remoteFile('a.svg', svg('one\n'));
		await world.engine.pull();
		const mine = drawingAt('a.svg');
		if (mine === undefined) throw new Error('nothing at a.svg');
		world.store.put({ ...mine, content: svg('my edit\n'), dirty: true });

		const theirs = await world.provider.write('a.svg', svg('theirs\n'), {
			expectedVersion: file.version,
		});
		const theirCopy = await remoteFile(
			'a (conflict 2026-09-15T14-32).svg',
			svg('their edit\n')
		);

		await pullNow([theirs, theirCopy]);

		const copies = world.store
			.drawings()
			.filter((drawing) => drawing.path.includes('conflict'))
			.map((drawing) => drawing.path);
		expect(copies).toHaveLength(2);
		expect(copies).toContain('a (conflict 2026-09-15T14-32).svg');
		expect(copies).toContain('a (conflict 2026-09-15T14-32)-2.svg');
	});
});

describe('a push conflict over a file another drawing already holds', () => {
	it('moves aside rather than handing two drawings one remoteId', async () => {
		// The file in the way is one we hold as a different drawing, whose own row
		// is elsewhere because we have not pulled its rename yet. Adopting it
		// would give two rows one `remoteId`, which the port calls unrecoverable
		// — `drawingByRemoteId` hands back one of them and the other is stale for
		// ever.
		const file = await remoteFile('c.svg', svg('theirs\n'));
		world.store.put({
			id: 'theirs',
			path: 'c.svg',
			content: svg('theirs\n'),
			...boundTo(file),
		});
		await world.provider.move(file, 'b.svg');
		world.store.put({ id: 'mine', path: 'b.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'mine', path: 'b.svg' });

		const result = await world.engine.push();

		const mine = world.store.drawings().find((each) => each.id === 'mine');
		expect(mine?.content).toBe(svg('mine\n'));
		expect(mine?.path).toContain('conflict');
		expect(world.store.drawings().find((each) => each.id === 'theirs')?.remoteId).toBe(
			file.remoteId
		);
		// Its own file, not theirs: the whole point of moving aside. And made
		// here rather than next round — the drawing has no file of its own to stay
		// bound to, so the write goes now and the op is done with.
		expect(mine?.remoteId).not.toBe(file.remoteId);
		expect(world.provider.contentAt(mine?.path ?? '')).toBe(svg('mine\n'));
		expect(world.store.ops()).toEqual([]);
		expect(result.conflicts).toEqual([mine?.path]);
	});

	it('takes the next name when the remote already has the one it picked', async () => {
		// The name is chosen from the store, which has never heard of the file
		// another device set its own edit aside to in the same minute. Asked of
		// the remote as the write goes, the next name is taken instead — rather
		// than spending an attempt and handing the drawing two conflict suffixes.
		const file = await remoteFile('c.svg', svg('theirs\n'));
		world.store.put({
			id: 'theirs',
			path: 'c.svg',
			content: svg('theirs\n'),
			...boundTo(file),
		});
		await world.provider.move(file, 'b.svg');
		await remoteFile(conflictPath('b.svg', AT), svg('somebody else\n'));
		world.store.put({ id: 'mine', path: 'b.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'mine', path: 'b.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		const mine = world.store.drawings().find((each) => each.id === 'mine');
		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute — not `(conflict …) (conflict …)`.
		expect(mine?.path).toBe(conflictPath('b.svg', AT, [basename(conflictPath('b.svg', AT))]));
		expect(world.provider.contentAt(mine?.path ?? '')).toBe(svg('mine\n'));
		expect(world.provider.contentAt(conflictPath('b.svg', AT))).toBe(svg('somebody else\n'));
		// One push, and no attempt spent on a name the remote had already given
		// away: the op is gone from the queue.
		expect(world.store.ops()).toEqual([]);
	});
	it('fails the op rather than write to a name it has not looked at', async () => {
		// The same exhaustion as the drawing that steps aside, met by a drawing with
		// no file of its own, which takes its name by writing there: out of
		// tries, it writes nowhere, moves nowhere, and is retried.
		const file = await remoteFile('c.svg', svg('theirs\n'));
		world.store.put({
			id: 'theirs',
			path: 'c.svg',
			content: svg('theirs\n'),
			...boundTo(file),
		});
		await world.provider.move(file, 'b.svg');
		const taken = Array.from({ length: 101 }).reduce<string[]>(
			(names) => [...names, basename(conflictPath('b.svg', AT, names))],
			[]
		);
		taken.forEach((name, i) =>
			world.store.put({ id: `copy${i}`, path: name, content: svg('copy\n') })
		);
		world.store.put({ id: 'mine', path: 'b.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'mine', path: 'b.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops().map((op) => op.attempts)).toEqual([1]);
		expect(world.store.drawings().find((each) => each.id === 'mine')).toMatchObject({
			path: 'b.svg',
			content: svg('mine\n'),
			dirty: true,
		});
		expect(world.provider.contentAt(taken.at(-1) ?? '')).toBeUndefined();
		expect(world.provider.contentAt('b.svg')).toBe(svg('theirs\n'));
	});
	describe('a rename the remote refuses at every name', () => {
		/** `b.svg`, taken on the remote, and this many of its conflict names. */
		const takeBeside = async (count: number): Promise<string[]> => {
			await remoteFile('b.svg', svg('theirs\n'));
			const names = Array.from({ length: count }).reduce<string[]>(
				(taken) => [...taken, basename(conflictPath('b.svg', AT, taken))],
				[]
			);
			await Promise.all(names.map((name) => remoteFile(name, svg('somebody else\n'))));
			return names;
		};

		const renameToB = async () => {
			const entry = await remoteFile('a.svg', svg('one\n'));
			world.store.put({ id: 'n1', path: 'b.svg', content: svg('one\n'), ...boundTo(entry) });
			world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		};

		it('lands at the tenth conflict name', async () => {
			const taken = await takeBeside(9);
			await renameToB();

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			const tenth = conflictPath('b.svg', AT, taken);
			expect(world.provider.contentAt(tenth)).toBe(svg('one\n'));
			expect(world.provider.contentAt('a.svg')).toBeUndefined();
		});

		it("fails the op on the remote's last refusal, past ten", async () => {
			const taken = await takeBeside(10);
			await renameToB();

			const result = await world.engine.push();

			// One attempt spent, and the file where it was: the remote keeps
			// every name it refused, and no eleventh was asked for.
			expect(result.status).toBe('retry');
			expect(world.store.ops().map((op) => op.attempts)).toEqual([1]);
			expect(world.provider.contentAt('a.svg')).toBe(svg('one\n'));
			expect(world.provider.contentAt(conflictPath('b.svg', AT, taken))).toBeUndefined();
		});
	});
});
