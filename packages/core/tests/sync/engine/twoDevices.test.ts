import { describe, expect, it } from 'vitest';

import type { ChangeEntry } from '../../../src/providers/types.js';
import { svg } from '../kit/drawings.js';
import { renameHere } from '../kit/userActions.js';
import { syncWorld } from '../kit/world.js';

const { world, pullNow, remoteFile, killTheCursor, drawingAt, pulledDrawing } = syncWorld();

/**
 * Found by two devices syncing at random over each provider
 * (`overProviders.test.ts`): each one a drawing one device kept, or a file it took
 * from the other, and so two devices that no longer agree.
 */
describe('two devices at random', () => {
	it('does not let a drawing deleted here before it was pushed take another device’s file', async () => {
		// The store reports it clean, so claiming it writes the other device's
		// bytes into a drawing the user deleted, and its queued delete then
		// removes their drawing from the remote.
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n') });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });
		const theirs = await remoteFile('a.svg', svg('theirs\n'));

		await pullNow([theirs]);
		await world.engine.push();

		expect(
			world.store.drawings().find((drawing) => drawing.id === 'n1')?.remoteId
		).toBeUndefined();
		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
	});

	it('does not let a drawing deleted here and there take the file made at its name', async () => {
		// Written back under the same id, the new file is still a deleted drawing
		// here, and the queued delete takes it from the remote.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		world.store.queue({ op: 'delete', drawingId: drawing.id, path: 'a.svg' });
		await world.provider.delete(entry);
		const theirs = await remoteFile('a.svg', svg('theirs\n'));

		await pullNow([{ path: 'a.svg', deleted: true, remoteId: entry.remoteId }, theirs]);
		await world.engine.push();

		expect(world.store.drawings().map((each) => each.id)).not.toContain(drawing.id);
		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
	});

	it('does not let it take that file in a rescan either, which never says the old one went', async () => {
		// The two-device soak over Drive, seed 36, once a long feed became a
		// scan: the other device deleted this drawing's file and moved one of its
		// own to the name. A scan lists the newcomer and nothing about the old
		// file, so the drawing was still at the path, was claimed as a file
		// replaced while the cursor was dead, and its queued delete took the
		// other device's drawing from the remote.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		world.store.queue({ op: 'delete', drawingId: drawing.id, path: 'a.svg' });
		await world.provider.delete(entry);
		await remoteFile('a.svg', svg('theirs\n'));
		killTheCursor();

		expect((await world.engine.sync()).status).toBe('ok');

		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings().map((each) => each.id)).not.toContain(drawing.id);
	});

	it('does not let a drawing renamed here onto a name take the file made there', async () => {
		// Not even when the batch says what was there before went, which is what
		// lets a drawing whose own file was replaced be claimed. The rename's file
		// is still at the old name, and claimed, the drawing forgets it for ever.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('mine\n'));
		renameHere(world.store, drawing, 'b.svg');
		const theirs = await remoteFile('b.svg', svg('theirs\n'));

		await pullNow([{ path: 'b.svg', deleted: true }, theirs]);

		const mine = world.store.drawings().find((each) => each.id === drawing.id);
		expect(mine?.remoteId).toBe(entry.remoteId);
		expect(mine?.content).toBe(svg('mine\n'));
		expect(drawingAt('b.svg')?.content).toBe(svg('theirs\n'));
	});

	it('does not let a drawing take a file that arrives at its path while its own is unmentioned', async () => {
		const { entry, drawing } = await pulledDrawing('a.svg', svg('mine\n'));
		const theirs = await world.provider.write('b.svg', svg('theirs\n'), {});

		await pullNow([{ ...theirs, path: 'a.svg' }]);

		expect(world.store.drawings().find((each) => each.id === drawing.id)?.remoteId).toBe(
			entry.remoteId
		);
	});

	it('does not let a deletion at a name take the drawing renamed onto it here', async () => {
		// Often this device's own delete of the drawing that had the name, coming
		// back after the user gave the name to another.
		const gone = await pulledDrawing('a.svg', svg('gone\n'));
		const { drawing } = await pulledDrawing('b.svg', svg('kept\n'));
		world.store.queue({ op: 'delete', drawingId: gone.drawing.id, path: 'a.svg' });
		await world.engine.push();
		renameHere(world.store, drawing, 'a.svg');

		await pullNow([{ path: 'a.svg', deleted: true }]);
		await world.engine.push();

		expect(drawingAt('a.svg')?.id).toBe(drawing.id);
		expect(world.provider.contentAt('a.svg')).toBe(svg('kept\n'));
	});

	it('lets a deletion at the old name of a queued rename take that drawing', async () => {
		// Ahead of a drawing the user made at the name the rename freed, which has
		// never had a file for it to be about.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		renameHere(world.store, drawing, 'b.svg');
		world.store.put({ id: 'made', path: 'a.svg', content: svg('new\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'made', path: 'a.svg' });
		await world.provider.delete(entry);

		await pullNow([{ path: 'a.svg', deleted: true }]);

		expect(world.store.drawings().map((each) => [each.id, each.content])).toEqual([
			['made', svg('new\n')],
		]);
	});

	it('does not let a deletion at a rename’s old name take the drawing whose file has moved on', async () => {
		// Another device renamed the file after the rename was queued here, so
		// the queue still names the old path, and something made there later
		// and deleted is not this drawing's file.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		renameHere(world.store, drawing, 'b.svg');
		const moved = await world.provider.move(entry, 'c.svg');
		await pullNow([{ path: 'a.svg', deleted: true }, moved]);
		const later = await remoteFile('a.svg', svg('later\n'));
		await world.provider.delete(later);

		await pullNow([{ path: 'a.svg', deleted: true }]);

		expect(world.store.drawings().find((each) => each.id === drawing.id)?.remoteId).toBe(
			entry.remoteId
		);
		expect(world.store.ops().map((op) => op.op)).toEqual(['move']);
	});

	it('takes a drawing at the path that has a file ahead of the one renamed from it', async () => {
		const { drawing } = await pulledDrawing('a.svg', svg('one\n'));
		renameHere(world.store, drawing, 'b.svg');
		world.store.put({
			id: 'here',
			path: 'a.svg',
			content: svg('here\n'),
			remoteId: 'gone-file',
			remoteVersion: 'v',
		});

		await pullNow([{ path: 'a.svg', deleted: true }]);

		expect(world.store.drawings().map((each) => each.id)).toEqual([drawing.id]);
	});

	it('lets a drawing take the file that replaced its own when the feed reports no deletion', async () => {
		// A provider need not report the deletion of a file replaced at its path.
		// Moved aside instead, the drawing points at a file nothing will mention again.
		const { entry } = await pulledDrawing('a.svg', svg('one\n'));
		await world.provider.delete(entry);
		const theirs = await remoteFile('a.svg', svg('two\n'));

		await pullNow([theirs]);

		expect(world.store.drawings().map((each) => [each.path, each.content])).toEqual([
			['a.svg', svg('two\n')],
		]);
	});

	it.each([
		{
			how: 'by id alone',
			deletion: (id: string): ChangeEntry => ({ deleted: true, remoteId: id }),
		},
		{ how: 'by path', deletion: (): ChangeEntry => ({ path: 'a.svg', deleted: true }) },
	])(
		'lets a drawing take a file at its path when the batch deletes its own $how',
		async ({ deletion }) => {
			// Its file still answers a read here, so only the batch says it went: the
			// drawing, holding an edit, is cut loose and then conflicts with the file
			// that took its place, rather than moving aside.
			const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
			world.store.put({ ...drawing, content: svg('mine\n'), dirty: true });
			const theirs = await world.provider.write('elsewhere.svg', svg('theirs\n'), {});

			await pullNow([deletion(entry.remoteId), { ...theirs, path: 'a.svg' }]);

			expect(drawingAt('a.svg')?.id).toBe(drawing.id);
		}
	);

	it('takes a drawing never pushed when its own first push comes back', async () => {
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('body\n') });
		const file = await remoteFile('a.svg', svg('body\n'));

		await pullNow([file]);

		expect(world.store.drawings().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('takes a drawing never pushed when the file coming back carries its id', async () => {
		await world.engine.pull();
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('body\n') });
		const file = await remoteFile('a.svg', svg('body\n', 'n1'));

		await pullNow([file]);

		expect(world.store.drawings().map((each) => [each.id, each.remoteId])).toEqual([
			['n1', file.remoteId],
		]);
	});

	it('lets go of a drawing whose file moved and went, when the deletion comes in a later batch', async () => {
		// A page boundary between the two, or the file deleted between the feed
		// and the read: nothing at the new path to find the drawing by afterwards.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		await world.provider.delete(entry);

		await pullNow([
			{ path: 'a.svg', deleted: true },
			{ ...entry, path: 'c.svg', version: 'after-the-move' },
		]);
		await pullNow([{ path: 'c.svg', deleted: true }]);

		expect(world.store.drawings().map((each) => each.id)).not.toContain(drawing.id);
	});

	it('leaves a drawing at its own path to the deletion that follows, not to the read', async () => {
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		await world.provider.delete(entry);

		await pullNow([{ ...entry, version: 'edited-elsewhere' }]);

		expect(world.store.drawings().map((each) => each.id)).toEqual([drawing.id]);
	});

	it('asks whether a file is there when a rename queued here adopted it and a deletion follows', async () => {
		// Adopting the version reads nothing, so it says nothing about whether
		// the file outlived the deletion behind it.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		renameHere(world.store, drawing, 'b.svg');
		await world.provider.delete(entry);

		await pullNow([entry, { path: 'a.svg', deleted: true }]);

		expect(world.store.drawings()).toEqual([]);
	});

	it('lets go of a drawing whose file moved and then went', async () => {
		// The deletion is at the new name, where the drawing never got to, and
		// carries no id to find it by.
		const { entry, drawing } = await pulledDrawing('a.svg', svg('one\n'));
		world.store.put({ id: 'made', path: 'c.svg', content: svg('new\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'made', path: 'c.svg' });
		await world.provider.delete(entry);

		await pullNow([
			{ ...entry, path: 'c.svg', version: 'after-the-move' },
			{ path: 'c.svg', deleted: true },
		]);

		expect(world.store.drawings().map((each) => each.id)).not.toContain(drawing.id);
		expect(drawingAt('c.svg')?.content).toBe(svg('new\n'));
	});

	it('does not move a drawing aside onto the old name of a queued rename', async () => {
		// The file is still there until the rename runs, which is queued behind
		// the write that would create the copy: that write conflicts for ever.
		// Here the drawing in the way was made, and its write queued, before the
		// rename.
		const copyName = 'b (conflict 2026-09-15T14-32).svg';
		const { drawing } = await pulledDrawing(copyName, svg('renamed\n'));
		world.store.put({ id: 'made', path: 'b.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'made', path: 'b.svg' });
		renameHere(world.store, drawing, 'r.svg');
		const theirs = await remoteFile('b.svg', svg('theirs\n'));

		await pullNow([theirs]);
		const pushed = await world.engine.push();

		const mine = world.store.drawings().find((each) => each.content.includes('mine'));
		expect(mine?.path).not.toBe(copyName);
		expect(pushed.status).toBe('ok');
		expect(world.provider.contentAt('r.svg')).toBe(svg('renamed\n'));
	});
});
