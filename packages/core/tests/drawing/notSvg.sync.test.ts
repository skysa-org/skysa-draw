import type { SyncNote as SyncDrawing } from '@skysa/sync';
import { syncWorld } from '@skysa/sync/testing';
import { describe, expect, it } from 'vitest';

import { DRAW_FORMAT } from '../../src/drawing/format.js';
import { svg } from '../support/drawings.js';

// The kit's simulation kit has helpers like these of its own, but
// `@skysa/sync/testing` does not export them, and they are a line each.
type World = ReturnType<typeof syncWorld>['world'];
const remoteAt = (provider: World['provider'], path: string) =>
	provider.snapshot().find((entry) => entry.path === path);
const editHere = (store: World['store'], drawing: SyncDrawing, content: string): void => {
	store.put({ ...drawing, content, dirty: true });
	store.queue({ op: 'write', noteId: drawing.id, path: drawing.path });
};

/**
 * A `.svg` that decodes as UTF-8 and is not an SVG document: a file misnamed,
 * or one some tool wrote that is not one. skysa-notes took any text in a `.md`
 * for a note; here the name is not enough, and such a file is answered as one
 * that will not decode is (docs/ARCHITECTURE.md §3): left alone, listed,
 * never rewritten (`DRAW_FORMAT.isDocumentText`). The cases of a file
 * that is not UTF-8 are the kit's (`packages/sync/tests/engine/files.test.ts`); these are the same cases met
 * through the other half of the rule.
 */
const { world, remoteFile, noteAt: drawingAt, pulledNote: pulledDrawing } = syncWorld(DRAW_FORMAT);

const NOT_SVG = new TextEncoder().encode('# a note, misnamed\n');
const COPY = 'a (conflict 2026-09-15T14-32).svg';

const holders = (remoteId: string): SyncDrawing[] =>
	world.store.notes().filter((drawing) => drawing.remoteId === remoteId);

/** What the engine has asked the provider to change. */
const sent = (): string[] =>
	world.provider
		.callLog()
		.filter((call) => call.op === 'write' || call.op === 'move' || call.op === 'delete')
		.map((call) => `${call.op} ${call.path ?? ''}`);

const listed = async (): Promise<string[]> =>
	(await world.store.unreadable()).map((file) => `${file.remoteId} ${file.path}`).sort();

describe('a .svg that is not an SVG document', () => {
	it('imports nothing, lists the file, and the pull goes through', async () => {
		const file = world.provider.plantBytes('a.svg', NOT_SVG);
		await remoteFile('b.svg', svg('readable\n'));

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(world.store.storedCursor()).toBeDefined();
		expect(world.store.notes().map((drawing) => drawing.path)).toEqual(['b.svg']);
		expect(holders(file.remoteId)).toEqual([]);
		expect(await listed()).toEqual([`${file.remoteId} a.svg`]);
		expect(world.provider.bytesAt('a.svg')).toEqual(NOT_SVG);
	});

	it('lets go of a clean drawing whose file was rewritten as one, and sends nothing', async () => {
		const { entry } = await pulledDrawing('a.svg', svg('one\n'));
		const before = sent();
		world.provider.plantBytes('a.svg', NOT_SVG);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.store.notes()).toEqual([]);
		expect(world.store.ops()).toEqual([]);
		expect(sent()).toEqual(before);
		expect(world.provider.bytesAt('a.svg')).toEqual(NOT_SVG);
		expect(remoteAt(world.provider, 'a.svg')?.remoteId).toBe(entry.remoteId);
	});

	it('cuts a dirty drawing loose and moves it aside, and its edit goes up beside the file', async () => {
		const { entry, note: drawing } = await pulledDrawing('a.svg', svg('one\n'));
		editHere(world.store, drawing, svg('my edit\n'));
		world.provider.plantBytes('a.svg', NOT_SVG);

		expect((await world.engine.pull()).status).toBe('ok');
		expect(drawingAt(COPY)).toMatchObject({
			id: drawing.id,
			content: svg('my edit\n'),
			dirty: true,
		});
		expect(drawingAt('a.svg')).toBeUndefined();

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.provider.contentAt(COPY)).toBe(svg('my edit\n'));
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.svg')).toEqual(NOT_SVG);
	});

	it('sets a push’s edit aside in one drain when the drawing’s own file became one', async () => {
		const { entry, note: drawing } = await pulledDrawing('a.svg', svg('one\n'));
		editHere(world.store, drawing, svg('my edit\n'));
		world.provider.plantBytes('a.svg', NOT_SVG);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([COPY]);
		expect(world.store.ops()).toEqual([]);
		expect(drawingAt(COPY)).toMatchObject({
			id: drawing.id,
			content: svg('my edit\n'),
			dirty: false,
		});
		expect(world.provider.contentAt(COPY)).toBe(svg('my edit\n'));
		expect(holders(entry.remoteId)).toEqual([]);
		expect(world.provider.bytesAt('a.svg')).toEqual(NOT_SVG);
		expect(await listed()).toEqual([`${entry.remoteId} a.svg`]);
	});

	it('imports the file once it is one, under the same id', async () => {
		const file = world.provider.plantBytes('a.svg', NOT_SVG);
		await world.engine.pull();
		await world.provider.write('a.svg', svg('fixed\n'), { expectedVersion: file.version });

		const result = await world.engine.pull();

		expect(result.status).toBe('ok');
		expect(await listed()).toEqual([]);
		expect(drawingAt('a.svg')).toMatchObject({
			content: svg('fixed\n'),
			remoteId: file.remoteId,
		});
	});
});
