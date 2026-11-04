import { describe, expect, it } from 'vitest';

import { createFakeProvider } from '../../../src/providers/fake.js';
import type { StorageProvider } from '../../../src/providers/types.js';
import type { SyncProgress } from '../../../src/sync/engine.js';
import { svg } from '../kit/drawings.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

const { world, engineWith, remoteFile } = syncWorld();

/**
 * What a long run says of itself (`onProgress`). The import dialog draws from
 * it, so what matters is that the counts only climb, that a drawing already held
 * is not counted as fetched, and that a short round says nothing at all.
 */
describe('progress', () => {
	const watching = (base: StorageProvider) => {
		const said: SyncProgress[] = [];
		const counted = engineWith({
			provider: base,
			onProgress: (progress) => said.push(progress),
		});
		return { said, counted };
	};

	it('lists every page before it reads, then counts up to what it found', async () => {
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.write('b.svg', svg('2\n'), {});
		await world.provider.createFolder('Work');
		await world.provider.write('drawings.txt', svg('not a drawing\n'), {});
		const reads: string[] = [];
		const { said, counted } = watching({
			...world.provider,
			read: (entry) => {
				reads.push(entry.path);
				return world.provider.read(entry);
			},
		});

		await counted.pull();

		const scans = said.filter((p) => p.stage === 'scanning');
		const listing = scans.filter((p) => p.listing);
		// Before the first page, none found; while listing, a count so far,
		// and nothing read yet.
		expect(said[0]).toEqual({ stage: 'scanning', found: 0, done: 0, listing: true });
		expect(listing.length).toBeGreaterThan(1);
		expect(listing.every((p) => p.done === 0 && p.path === undefined)).toBe(true);
		// Then the whole of it, and a count up to it, naming each file read.
		const reading = scans.filter((p) => !p.listing);
		expect(reading.every((p) => p.found === 2)).toBe(true);
		expect(reading[0]).toEqual({ stage: 'scanning', found: 2, done: 0, listing: false });
		expect(reading.flatMap((p) => (p.path === undefined ? [] : [p.path])).sort()).toEqual([
			'a.svg',
			'b.svg',
		]);
		expect(reading.at(-1)).toEqual({ stage: 'scanning', found: 2, done: 2, listing: false });
		scans.slice(1).forEach((p, at) => {
			expect(p.done).toBeGreaterThanOrEqual(scans[at]?.done ?? 0);
		});
		expect(reads.sort()).toEqual(['a.svg', 'b.svg']);
	});

	it('counts each drawing once across pages, the one being read and the ones applied', async () => {
		// One drawing a page, so a page's reads are let go of as it is applied:
		// counted again, the third page would say three done with two.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.write('b.svg', svg('2\n'), {});
		await world.provider.write('c.svg', svg('3\n'), {});
		const { said, counted } = watching(world.provider);

		await counted.pull();

		const listing = (found: number) => ({ stage: 'scanning', found, done: 0, listing: true });
		const reading = (done: number, path?: string) => ({
			stage: 'scanning',
			found: 3,
			done,
			listing: false,
			...(path === undefined ? {} : { path }),
		});
		// The marker's page names no drawing; each page after is read, then applied.
		expect(said).toEqual([
			listing(0),
			listing(0),
			listing(1),
			listing(2),
			listing(3),
			reading(0),
			reading(0),
			reading(1, 'a.svg'),
			reading(1),
			reading(2, 'b.svg'),
			reading(2),
			reading(3, 'c.svg'),
			reading(3),
		]);
	});

	it('counts a drawing it already holds as done without reading it', async () => {
		const held = await remoteFile('a.svg', svg('1\n'));
		await remoteFile('b.svg', svg('2\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('1\n'),
			...boundTo(held),
			dirty: false,
		});
		const { said, counted } = watching(world.provider);

		await counted.pull();

		const named = said.flatMap((p) => (p.path === undefined ? [] : [p.path]));
		expect(named).toEqual(['b.svg']);
		expect(said.at(-1)).toEqual({ stage: 'scanning', found: 2, done: 2, listing: false });
	});

	it('counts a round from a stored cursor drawing by drawing, having read its pages first', async () => {
		await remoteFile('a.svg', svg('1\n'));
		await world.engine.pull();
		await remoteFile('b.svg', svg('2\n'));
		await remoteFile('c.svg', svg('3\n'));
		await world.provider.createFolder('Work');
		const { said, counted } = watching(world.provider);

		await counted.pull();

		// The folder is not a drawing, so the count is of the two drawings alone.
		expect(said).toEqual([
			{ stage: 'receiving', done: 0, total: 0, listing: true },
			{ stage: 'receiving', done: 0, total: 2, listing: true },
			{ stage: 'receiving', done: 0, total: 2, listing: false },
			{ stage: 'receiving', done: 1, total: 2, listing: false, path: 'b.svg' },
			{ stage: 'receiving', done: 2, total: 2, listing: false, path: 'c.svg' },
		]);
	});

	it('says it is reading a round’s pages before the first, and how many drawings they name as each is read', async () => {
		// Reported on a phone: another device's folders moved was minutes of
		// plain "Syncing…" while the round's pages were read, before the first
		// drawing was counted.
		world.provider = createFakeProvider({ pageSize: 1 });
		await world.provider.ensureRoot();
		const { said, counted } = watching(world.provider);
		await counted.pull();
		await world.provider.write('a.svg', svg('1\n'), {});
		await world.provider.createFolder('Work');
		await world.provider.write('b.svg', svg('2\n'), {});
		said.length = 0;

		await counted.pull();

		// A page that names no drawing — the folder's — says nothing new.
		expect(said.slice(0, 4)).toEqual([
			{ stage: 'receiving', done: 0, total: 0, listing: true },
			{ stage: 'receiving', done: 0, total: 1, listing: true },
			{ stage: 'receiving', done: 0, total: 2, listing: true },
			{ stage: 'receiving', done: 0, total: 2, listing: false },
		]);
		expect(said.slice(4).every((p) => p.stage === 'receiving' && !p.listing)).toBe(true);
	});

	it('counts a drawing a round names that it already holds, without reading it', async () => {
		await world.engine.pull();
		// This device's own push, which the next round reports back.
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('one\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.engine.push();
		const reads: string[] = [];
		const { said, counted } = watching({
			...world.provider,
			read: (entry) => {
				reads.push(entry.path);
				return world.provider.read(entry);
			},
		});

		await counted.pull();

		expect(reads).toEqual([]);
		expect(said.at(-1)).toEqual({
			stage: 'receiving',
			done: 1,
			total: 1,
			listing: false,
			path: 'a.svg',
		});
	});

	it('says only that it is reading the pages of a round that names no drawing, and then that it is not', async () => {
		await remoteFile('a.svg', svg('1\n'));
		await world.engine.pull();
		await world.provider.createFolder('Work');
		const { said, counted } = watching(world.provider);

		await counted.pull();

		expect(said).toEqual([
			{ stage: 'receiving', done: 0, total: 0, listing: true },
			{ stage: 'receiving', done: 0, total: 0, listing: false },
		]);
	});

	it('counts a push against its queue', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('one\n'), dirty: true });
		world.store.put({ id: 'n2', path: 'b.svg', content: svg('two\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.store.queue({ op: 'write', drawingId: 'n2', path: 'b.svg' });
		const { said, counted } = watching(world.provider);

		await counted.push();

		expect(said).toEqual([
			{ stage: 'uploading', done: 0, total: 2, path: 'a.svg' },
			{ stage: 'uploading', done: 1, total: 2, path: 'b.svg' },
			{ stage: 'uploading', done: 2, total: 2 },
		]);
	});

	it('counts drawings written together as they land together', async () => {
		const four = createFakeProvider({
			startAt: new Date('2026-01-01T00:00:00Z'),
			writesAtOnce: 4,
		});
		await four.ensureRoot();
		world.store.put({ id: 'n1', path: 'Work/a.svg', content: svg('one\n'), dirty: true });
		world.store.put({ id: 'n2', path: 'Work/b.svg', content: svg('two\n'), dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });
		world.store.queue({ op: 'write', drawingId: 'n2', path: 'Work/b.svg' });
		const { said, counted } = watching(four);

		await counted.push();

		// The folder alone, then its two drawings at once (`together`), so the
		// count goes up by two.
		expect(said).toEqual([
			{ stage: 'uploading', done: 0, total: 3, path: 'Work' },
			{ stage: 'uploading', done: 1, total: 3, path: 'Work/a.svg' },
			{ stage: 'uploading', done: 3, total: 3 },
		]);
	});

	it('says nothing for a push with nothing to send', async () => {
		const { said, counted } = watching(world.provider);
		await counted.push();
		expect(said).toEqual([]);
	});
});
