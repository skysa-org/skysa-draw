import { beforeEach, describe, expect, it } from 'vitest';

import { contentHash } from '../../../src/hash.js';
import { conflictPath } from '../../../src/names/conflicts.js';
import { basename, isHidden } from '../../../src/paths.js';
import { createFakeProvider } from '../../../src/providers/fake.js';
import {
	AuthError,
	ConflictError,
	NotFoundError,
	RateLimitError,
	type StorageProvider,
} from '../../../src/providers/types.js';
import { svg } from '../kit/drawings.js';
import { AT, reporting } from '../kit/engine.js';
import { remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * Sending the queue: writes, moves and deletes, and what a push does when one
 * is interrupted, withdrawn, or finds its file or folder not where it was;
 * then our own changes coming back to us in the next pull (`push/drain`,
 * `push/drawings`, and the folders and conflict names a write needs:
 * `push/folders`, `push/conflicts`).
 */
const { world, engineWith, pullNow, remoteFile, drawingAt } = syncWorld();

describe('push', () => {
	it('creates a drawing that has never been pushed', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('a.svg')).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('sends the version it expects, so a racing write is caught', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('two\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });

		await world.engine.push();
		expect(world.provider.contentAt('a.svg')).toBe(svg('two\n'));
	});

	it('leaves a drawing dirty when the user typed again mid-flight', async () => {
		// The bytes that landed are not the bytes on the device. Calling the drawing
		// clean here is exactly how a save disappears.
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('first\n'), dirty: true });
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		const original = world.store.completeOp;
		const engineWithEdit = engineWith({
			store: {
				...world.store,
				completeOp: async (seq, outcome) => {
					world.store.put({
						id: 'n1',
						path: 'a.svg',
						content: svg('first and more\n'),
						dirty: true,
					});
					await original(seq, outcome);
				},
			},
		});

		await engineWithEdit.push();

		expect(op.seq).toBe(1);
		expect(drawingAt('a.svg')?.dirty).toBe(true);
		expect(drawingAt('a.svg')?.content).toBe(svg('first and more\n'));
	});

	it('re-creates a drawing whose remote copy was deleted', async () => {
		// §7's rule for a remote delete of a dirty drawing, arriving the other way round: the
		// push finds nothing there. The retry is a create, not an overwrite.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.delete(entry);

		await world.engine.push();

		expect(world.provider.contentAt('a.svg')).toBe(svg('mine\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(false);
	});

	it('writes the local edit aside when the push loses a race', async () => {
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

		const result = await world.engine.push();

		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
		expect(drawingAt('a.svg')?.content).toBe(svg('theirs\n'));
		expect(result.conflicts).toEqual(['a (conflict 2026-09-15T14-32).svg']);
		const copy = drawingAt('a (conflict 2026-09-15T14-32).svg');
		expect(copy?.content).toBe(svg('mine\n', copy?.id));
	});

	it('does not replay the op that conflicted', async () => {
		// Its content is safe in the copy; sending it again would overwrite the
		// remote with the very bytes the user has just been given a copy of.
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

		await world.engine.push();

		expect(world.store.ops().map((op) => op.path)).toEqual([
			'a (conflict 2026-09-15T14-32).svg',
		]);
	});

	it('makes the folder before the drawing that goes in it', async () => {
		world.store.put({ id: 'n1', path: 'Work/a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.svg')).toBe(svg('mine\n'));
	});

	it('moves a drawing that already exists remotely', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		await world.engine.push();

		expect(world.provider.contentAt('b.svg')).toBe(svg('one\n'));
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
	});

	it('holds the version a move hands back only over bytes it has seen under it', async () => {
		// The fake gives a moved file a new version, as OneDrive does. It
		// is the version of whatever the move found, which nobody here has read.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('one\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		await world.engine.push();

		// Read, found to be the bytes last synced, and held under the version
		// they were read under.
		const read = await world.provider.read({ remoteId: entry.remoteId, path: 'b.svg' });
		expect(drawingAt('b.svg')?.remoteVersion).toBe(read.version);
		expect(read.version).not.toBe(entry.version);
	});

	it('goes on holding the version it had when the moved file is not the one it synced', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('one\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });

		await world.engine.push();

		// Moved all the same: the rename is the user's, and takes no bytes.
		expect(world.provider.contentAt('b.svg')).toBe(svg('theirs\n'));
		expect(drawingAt('b.svg')?.remoteVersion).toBe(entry.version);
		// So the pull does not take the file for one it has already seen.
		await world.engine.pull();
		expect(drawingAt('b.svg')?.content).toBe(svg('theirs\n'));
	});

	it('does the same when the moved file cannot be read, rather than failing a rename that landed', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('one\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(drawingAt('b.svg')?.remoteVersion).toBe(entry.version);
	});

	it('deletes remotely and then drops the tombstone', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });

		await world.engine.push();

		expect(world.provider.contentAt('a.svg')).toBeUndefined();
		expect(world.store.drawings()).toEqual([]);
	});

	it('treats a delete of something already gone as done', async () => {
		// The fake's `delete` is idempotent by contract, so deleting the file
		// first proves nothing — the call would succeed either way. A provider
		// that reports the missing file instead is the case that matters, and
		// it is the one Dropbox produces (`path_lookup/not_found`).
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('one\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });

		const strict = engineWith({
			provider: {
				...world.provider,
				delete: () => Promise.reject(new NotFoundError('a.svg')),
			},
		});
		const result = await strict.push();

		expect(result.status).toBe('ok');
		expect(world.store.drawings()).toEqual([]);
	});

	it('stops at the op that failed rather than stepping over it', async () => {
		// The queue is ordered because later ops depend on earlier ones. Pushing
		// past a failure would write a drawing into a folder that was never made.
		world.store.put({ id: 'n1', path: 'Work/a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/a.svg' });
		world.provider.setFault((call) =>
			call.op === 'createFolder' ? new Error('offline') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(2);
		expect(world.provider.contentAt('Work/a.svg')).toBeUndefined();
	});

	describe('writing drawings at once', () => {
		/**
		 * The provider, with each write and folder it is asked for logged as it
		 * starts and as it ends, a moment apart, so writes sent together are
		 * seen to overlap and ones sent in turn are seen not to.
		 */
		const logged = (base: StorageProvider) => {
			const events: string[] = [];
			const around =
				<A extends unknown[], R>(name: string, call: (...args: A) => Promise<R>) =>
				async (...args: A): Promise<R> => {
					events.push(`+${name}`);
					await new Promise((resolve) => setTimeout(resolve, 1));
					return call(...args).finally(() => {
						events.push(`-${name}`);
					});
				};
			return {
				events,
				provider: {
					...base,
					write: around('write', base.write),
					createFolder: around('mkdir', base.createFolder),
				},
			};
		};

		/** The most calls the log ever had out at once. */
		const most = (events: readonly string[]): number =>
			events.reduce(
				({ out, top }, event) => {
					const next = out + (event.startsWith('+') ? 1 : -1);
					return { out: next, top: Math.max(top, next) };
				},
				{ out: 0, top: 0 }
			).top;

		const queueDrawings = (paths: readonly string[]) => {
			paths.forEach((path, at) => {
				world.store.put({
					id: `n${String(at)}`,
					path,
					content: svg(`${path}\n`),
					dirty: true,
				});
				world.store.queue({ op: 'write', drawingId: `n${String(at)}`, path });
			});
		};

		const pushing = (base: StorageProvider) => engineWith({ provider: base }).push();

		/** A provider that takes four at once, as Google Drive does. */
		beforeEach(async () => {
			world.provider = createFakeProvider({
				startAt: new Date('2026-01-01T00:00:00Z'),
				writesAtOnce: 4,
			});
			await world.provider.ensureRoot();
			world.engine = engineWith();
		});

		it('writes one at a time to a provider that does not say it takes more', async () => {
			// Dropbox locks its namespace for each write, and writes that meet
			// there are refused as a rate limit.
			const one = createFakeProvider({ startAt: new Date('2026-01-01T00:00:00Z') });
			await one.ensureRoot();
			queueDrawings(['a.svg', 'b.svg', 'c.svg']);
			const { events, provider: counted } = logged(one);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(most(events)).toBe(1);
		});

		it('makes a missing folder once for the drawings sent together', async () => {
			// Each finds it missing — deleted on another device while they had
			// edits — and on Drive, each making it made one apiece.
			queueDrawings(['Work/a.svg', 'Work/b.svg', 'Work/c.svg', 'Work/d.svg']);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.filter((event) => event === '+mkdir')).toHaveLength(1);
			expect(world.provider.contentAt('Work/d.svg')).toBe(svg('Work/d.svg\n'));
		});

		it('sends a drawing with a rename queued alone, so a name another gives up is free', async () => {
			// b→c, then a→b, both edited first. Sent together, the write of the
			// drawing going to b.svg found the other still there and was set beside
			// it as a conflict, and the user's rename was lost.
			const first = await remoteFile('a.svg', svg('a\n'));
			const second = await remoteFile('b.svg', svg('b\n'));
			world.store.put({
				id: 'n1',
				path: 'b.svg',
				content: svg('a, edited\n'),
				dirty: true,
				...boundTo(first),
				syncedHash: await contentHash(svg('a\n')),
			});
			world.store.put({
				id: 'n2',
				path: 'c.svg',
				content: svg('b, edited\n'),
				dirty: true,
				...boundTo(second),
				syncedHash: await contentHash(svg('b\n')),
			});
			world.store.queue({ op: 'write', drawingId: 'n2', path: 'b.svg' });
			world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
			world.store.queue({ op: 'move', drawingId: 'n2', path: 'b.svg', targetPath: 'c.svg' });
			world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toEqual([]);
			expect(world.provider.contentAt('b.svg')).toBe(svg('a, edited\n'));
			expect(world.provider.contentAt('c.svg')).toBe(svg('b, edited\n'));
			expect(world.store.drawings().find((drawing) => drawing.id === 'n1')?.path).toBe(
				'b.svg'
			);
		});

		it('writes up to four drawings at once, and every one of them', async () => {
			// One at a time, a thousand drawings on Google Drive took most of half
			// an hour, each waiting on the one before though none depends on
			// another.
			const paths = ['a.svg', 'b.svg', 'c.svg', 'd.svg', 'e.svg', 'f.svg'];
			queueDrawings(paths);
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(result.pushed).toBe(6);
			expect(most(events)).toBe(4);
			expect(world.store.ops()).toEqual([]);
			paths.forEach((path) => {
				expect(world.provider.contentAt(path)).toBe(svg(`${path}\n`));
			});
		});

		it('makes a folder alone, before the drawings behind it', async () => {
			// What a later op can depend on goes in its turn, by itself: a drawing
			// sent beside its folder's `mkdir` could reach the remote first.
			world.store.put({ id: 'n1', path: 'a.svg', content: svg('a\n'), dirty: true });
			world.store.put({ id: 'n2', path: 'Work/b.svg', content: svg('b\n'), dirty: true });
			world.store.put({ id: 'n3', path: 'Work/c.svg', content: svg('c\n'), dirty: true });
			world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
			world.store.queue({ op: 'mkdir', path: 'Work' });
			world.store.queue({ op: 'write', drawingId: 'n2', path: 'Work/b.svg' });
			world.store.queue({ op: 'write', drawingId: 'n3', path: 'Work/c.svg' });
			const { events, provider: counted } = logged(world.provider);

			const result = await pushing(counted);

			expect(result.status).toBe('ok');
			expect(events.slice(0, 4)).toEqual(['+write', '-write', '+mkdir', '-mkdir']);
			expect(most(events.slice(4))).toBe(2);
			expect(world.provider.contentAt('Work/c.svg')).toBe(svg('c\n'));
		});

		it('stops where a write failed, and keeps what landed beside it', async () => {
			queueDrawings(['a.svg', 'b.svg', 'c.svg', 'd.svg', 'e.svg']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'b.svg' ? new Error('offline') : undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			// The three sent with it are done. The one behind them was never
			// sent: the drain stopped at the failure, as it would have alone.
			expect(world.store.ops().map((op) => op.path)).toEqual(['b.svg', 'e.svg']);
			expect(world.store.ops()[0]?.attempts).toBe(1);
			expect(world.provider.contentAt('d.svg')).toBe(svg('d.svg\n'));
			expect(world.provider.contentAt('e.svg')).toBeUndefined();
		});

		it('waits out a rate limit one of them met, without counting it', async () => {
			queueDrawings(['a.svg', 'b.svg', 'c.svg', 'd.svg', 'e.svg']);
			world.provider.setFault((call) =>
				call.op === 'write' && call.path === 'c.svg'
					? new RateLimitError('slow down', 4000)
					: undefined
			);

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(world.store.ops().map((op) => op.path)).toEqual(['c.svg', 'e.svg']);
			expect(world.store.ops()[0]?.attempts).toBe(0);
		});

		it('waits out a rate limit met beside a conflict, rather than sending through it', async () => {
			// The conflict, handled first, let the drain go on, and the write
			// the provider had just told to wait went again at once.
			const entry = await remoteFile('a.svg', svg('one\n'));
			world.store.put({
				id: 'n0',
				path: 'a.svg',
				content: svg('mine\n'),
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n1', path: 'b.svg', content: svg('b\n'), dirty: true });
			world.store.queue({ op: 'write', drawingId: 'n0', path: 'a.svg' });
			world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
			await world.provider.write('a.svg', svg('theirs\n'), {
				expectedVersion: entry.version,
			});
			const sent: string[] = [];
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.push(call.path);
				return call.path === 'b.svg' ? new RateLimitError('slow down', 4000) : undefined;
			});

			const result = await world.engine.push();

			expect(result.status).toBe('retry');
			expect(result.retryAfterMs).toBe(4000);
			expect(sent.filter((path) => path === 'b.svg')).toHaveLength(1);
			// Neither counted: the conflict is met again, and settled, next time.
			expect(world.store.ops().map((op) => [op.path, op.attempts])).toEqual([
				['a.svg', 0],
				['b.svg', 0],
			]);
		});

		it('refreshes once for writes sent together that met an expired token, and sends only those again', async () => {
			queueDrawings(['a.svg', 'b.svg', 'c.svg', 'd.svg']);
			const sent = new Map<string, number>();
			let refreshed = 0;
			world.provider.setFault((call) => {
				if (call.op !== 'write' || call.path === undefined) return undefined;
				sent.set(call.path, (sent.get(call.path) ?? 0) + 1);
				return refreshed === 0 && (call.path === 'b.svg' || call.path === 'c.svg')
					? new AuthError('expired')
					: undefined;
			});
			const withAuth = engineWith({
				reauthorize: () => {
					refreshed += 1;
					return Promise.resolve();
				},
			});

			const result = await withAuth.push();

			expect(result.status).toBe('ok');
			expect(refreshed).toBe(1);
			expect(Object.fromEntries(sent)).toEqual({
				'a.svg': 1,
				'b.svg': 2,
				'c.svg': 2,
				'd.svg': 1,
			});
		});

		it('resolves a conflict one of them met, and goes on', async () => {
			const entry = await remoteFile('b.svg', svg('one\n'));
			world.store.put({ id: 'n0', path: 'a.svg', content: svg('a\n'), dirty: true });
			world.store.put({
				id: 'n1',
				path: 'b.svg',
				content: svg('mine\n'),
				dirty: true,
				...boundTo(entry),
			});
			world.store.put({ id: 'n2', path: 'c.svg', content: svg('c\n'), dirty: true });
			world.store.put({ id: 'n3', path: 'd.svg', content: svg('d\n'), dirty: true });
			world.store.put({ id: 'n4', path: 'e.svg', content: svg('e\n'), dirty: true });
			['a.svg', 'b.svg', 'c.svg', 'd.svg', 'e.svg'].forEach((path, at) => {
				world.store.queue({ op: 'write', drawingId: `n${String(at)}`, path });
			});
			await world.provider.write('b.svg', svg('theirs\n'), {
				expectedVersion: entry.version,
			});

			const result = await world.engine.push();

			expect(result.status).toBe('ok');
			expect(result.conflicts).toHaveLength(1);
			expect(world.provider.contentAt('b.svg')).toBe(svg('theirs\n'));
			expect(world.provider.contentAt('e.svg')).toBe(svg('e\n'));
		});
	});

	/**
	 * Two places ask the provider "is it still there?" by reading it and taking
	 * any rejection for a no. That is only true of a not-found. Everything else
	 * — a rate limit, an outage, a response the adapter could not make sense of
	 * — is the provider failing to answer, and a failure to answer read as "gone"
	 * does the one thing the question was asked to avoid.
	 */
	it('does not re-create a drawing because the provider would not say', async () => {
		// The file is at `moved.svg` — renamed on another device — so `a.svg` is
		// genuinely free and an `add` there would succeed. That is what makes the
		// probe load-bearing: the write finds nothing at the path, and the only
		// thing standing between the user and a second copy of their drawing is the
		// answer to "is it still there under the id we hold?".
		//
		// Only `read` faults, and not with a not-found: the provider is failing to
		// answer rather than answering. Taken for a no, the re-create runs and
		// succeeds, and the user has two drawings where they had one.
		const seeded = await world.provider.write('moved.svg', svg('mine\n'), {});
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			dirty: true,
			...boundTo(seeded),
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('service unavailable') : undefined
		);

		const result = await world.engine.push();

		// (`isHidden` drops the marker file, which `ensureRoot` writes and which
		// is a file like any other.)
		const drawings = world.provider.snapshot().filter((entry) => !isHidden(entry.path));
		expect(drawings.map((entry) => entry.path)).toEqual(['moved.svg']);
		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	it('does not discard a rename because the provider would not say', async () => {
		// Worse than the last one: `runMove` completes the op as done when it
		// decides the source is gone, so the user's rename goes with nothing
		// reported and nothing left to retry.
		const seeded = await world.provider.write('a.svg', svg('mine\n'), {});
		world.store.put({
			id: 'n1',
			path: 'Work/a.svg',
			content: svg('mine\n'),
			...boundTo(seeded),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'Work/a.svg' });
		world.provider.setFault((call) => {
			if (call.op === 'move') return new NotFoundError('Work/a.svg');
			return call.op === 'read' ? new Error('service unavailable') : undefined;
		});

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()).toHaveLength(1);
	});

	/**
	 * A rate limit is the one failure that says nothing about the op: the
	 * provider did not look at it. Counted like any other, five throttles in a
	 * row would block a write the remote never saw, and the user would be told
	 * their drawing cannot be sent.
	 */
	it('does not count a rate limit against the op', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down', 4000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		// And the wait the provider asked for reaches the caller, which is the
		// only thing that knows when to come back.
		expect(result.retryAfterMs).toBe(4000);
		expect(result.error).toContain('slow down');
	});

	it('says nothing about a wait when the provider named none', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new RateLimitError('slow down') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		// Absent, not zero: the caller's own backoff is what applies.
		expect(result.retryAfterMs).toBeUndefined();
	});

	it('does not count a rate limit met while resolving a push conflict', async () => {
		// The conflict rule reads the remote entry before it can decide
		// anything, and that read is a request like any other. Counted under the
		// conflict's name, a provider throttling every read would spend the
		// write's attempts on a file it never looked at — and the wait it asked
		// for would be thrown away with it.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new RateLimitError('slow down', 6000) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(0);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		expect(result.retryAfterMs).toBe(6000);
		expect(result.error).toContain('slow down');
		// And nothing was decided: no conflict copy over a read that never came.
		expect(result.conflicts).toEqual([]);
		expect(world.store.drawings().map((drawing) => drawing.path)).toEqual(['a.svg']);
	});

	it('counts an ordinary failure met while resolving a push conflict', async () => {
		// The other half of the same rule: a resolution that fails for a reason
		// that is not a rate limit must still move the op's attempts, or it can
		// never reach `blocked` however long it goes on failing.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			dirty: true,
			...boundTo(entry),
		});
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });
		world.provider.setFault((call) =>
			call.op === 'read' ? new Error('read failed') : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toContain('read failed');
	});

	it('still blocks an op that has already failed too often, rate limit or not', async () => {
		// The attempts rule is about what has happened, not about today's
		// failure: an op at the limit is surfaced before the provider is asked.
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg', attempts: 5 });
		world.provider.setFault(() => new RateLimitError('slow down', 1000));

		expect((await world.engine.push()).status).toBe('blocked');
	});

	it('carries the wait out of a pull that was rate limited', async () => {
		world.provider.setFault((call) =>
			call.op === 'changes' ? new RateLimitError('slow down', 9000) : undefined
		);

		const result = await world.engine.pull();

		expect(result.status).toBe('retry');
		expect(result.retryAfterMs).toBe(9000);
	});

	it('records the failure against the op it belongs to', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) => (call.op === 'write' ? new Error('offline') : undefined));

		await world.engine.push();

		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBe('offline');
	});

	it('gives up on an op that has failed too many times', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg', attempts: 5 });

		const result = await world.engine.push();

		expect(result.status).toBe('blocked');
		expect(result.error).toContain('a.svg');
	});

	it('skips an op whose drawing has been purged', async () => {
		world.store.queue({ op: 'write', drawingId: 'gone', path: 'a.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a move whose file is no longer there', () => {
	it('finishes rather than blocking the queue for ever', async () => {
		// The other device deleted the file between the rename and the push.
		// Nothing will ever make this move succeed, and the queue is ordered, so
		// failing it strands every op behind it — over a rename, which is the
		// least of what the user has waiting. The drawing keeps its contents; the
		// pull that reports the deletion cuts it loose or takes it away.
		const entry = await remoteFile('a.svg', svg('body\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('body\n'),
			...boundTo(entry),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		world.store.put({ id: 'n2', path: 'c.svg', content: svg('behind it\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n2', path: 'c.svg' });
		await world.provider.delete(entry);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		// And the op behind it got its turn.
		expect(world.provider.contentAt('c.svg')).toBe(svg('behind it\n'));
	});
});

describe('a drawing the user is still typing into', () => {
	it('stays dirty when it changed while the push was in flight', async () => {
		// The store clears `dirty` only if the drawing still holds the bytes that
		// were sent, and the push is the only thing that knows which those were.
		// Reporting what the drawing holds *now* calls an edit that never left the
		// device saved, and the next remote change overwrites it.
		world.store.put({ id: 'mine', path: 'a.svg', content: svg('first\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'mine', path: 'a.svg' });
		const whileTyping: StorageProvider = {
			...world.provider,
			write: async (path, content, opts) => {
				const entry = await world.provider.write(path, content, opts);
				world.store.put({
					id: 'mine',
					path: 'a.svg',
					content: svg('and then more\n'),
					dirty: true,
				});
				return entry;
			},
		};

		const result = await engineWith({ provider: whileTyping }).push();

		expect(result.status).toBe('ok');
		expect(drawingAt('a.svg')?.content).toBe(svg('and then more\n'));
		expect(drawingAt('a.svg')?.dirty).toBe(true);
	});
});

describe('a push interrupted after the write landed', () => {
	it('adopts the version instead of conflicting a drawing with itself', async () => {
		// The write reached the remote and the store could not be told before
		// the tab closed, so the op is still queued carrying a version the
		// remote has moved past. The retry conflicts — over bytes identical to
		// the ones it just sent. Pull has this rule; push needs it too.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });

		// The interruption: the write lands, the store never hears about it.
		const landed = await world.provider.write('a.svg', svg('edited\n'), {
			expectedVersion: entry.version,
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(result.conflicts).toEqual([]);
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('a.svg')?.remoteVersion).toBe(landed.version);
		expect(drawingAt('a.svg')?.dirty).toBe(false);
		expect(world.store.ops()).toEqual([]);
	});

	it('records the failure when the resolution itself cannot finish', async () => {
		// Reading the remote to resolve a conflict can fail in its own right.
		// Left uncounted, the op's `attempts` never moves and it can never reach
		// `blocked` however long it has been failing.
		const entry = await remoteFile('a.svg', svg('theirs\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('mine\n'),
			remoteId: entry.remoteId,
			remoteVersion: 'stale',
			dirty: true,
		});
		const op = world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) => (call.op === 'read' ? new Error('offline') : undefined));

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.store.ops()[0]?.attempts).toBe(1);
		expect(world.store.lastError(op.seq)).toBeDefined();
	});
});

describe('a write whose file is not where it was', () => {
	it('waits for the rename rather than creating a second copy', async () => {
		// `write` is addressed by path, so a file renamed remotely is missing
		// from its old one and reports exactly what a deleted file reports. §7's
		// answer to a deleted file is to re-create it — which here would leave
		// the user with two drawings where they had one, and the next pull would
		// import the stray as a third.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.move(entry, 'renamed.svg');

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
		expect(
			world.provider.snapshot().filter((node) => node.kind === 'file' && !isHidden(node.path))
		).toHaveLength(1);
		expect(world.store.ops()).toHaveLength(1);

		// And the next sync finds out where it went. The fake changes a file's
		// version on a move, as OneDrive's eTag does and Dropbox's rev does not,
		// but the file still holds the bytes this drawing last synced — so it was
		// renamed, not edited, and the drawing follows it with its edit, which then
		// goes out to the new name. No copy (docs/ARCHITECTURE.md §7).
		const synced = await world.engine.sync();

		expect(synced.status).toBe('ok');
		expect(synced.conflicts).toEqual([]);
		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('renamed.svg')).toMatchObject({
			id: 'n1',
			content: svg('edited\n'),
			dirty: false,
		});
		expect(world.provider.contentAt('renamed.svg')).toBe(svg('edited\n'));
	});

	it('does the rename itself when the move is queued behind it', async () => {
		// The user edited a drawing and then renamed it, so the queue is a write
		// and then a move and the drawing's path is already the new one — which the
		// remote has never heard of. The write 404s, the file is still there
		// under the id we hold, and "wait for the next pull to rebase it" is an
		// answer to the wrong question: no pull will rebase a rename the remote
		// knows nothing about, and the ordered queue never reaches the move that
		// would fix it. The user's edit would sit here for ever, with every op
		// behind it.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('b.svg')).toBe(svg('edited\n'));
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
		expect(drawingAt('b.svg')?.dirty).toBe(false);
	});

	it('waits out a rate limit met while reading the file it has just moved, and says so', async () => {
		// Not "has changed on the remote": nobody changed it, and an op failed
		// under that name spends an attempt on a throttle.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		// The first read finds the file by its id; the second is the one after
		// the move.
		world.provider.setFault((call) =>
			call.op === 'read' && call.attempt === 2
				? new RateLimitError('slow down', 3000)
				: undefined
		);

		const limited = await world.engine.push();

		expect(limited.retryAfterMs).toBe(3000);
		expect(world.store.ops()[0]?.attempts ?? 0).toBe(0);

		// And then the edit goes up over the file it was always for, as itself.
		world.provider.setFault(undefined);
		expect((await world.engine.push()).conflicts).toEqual([]);
		expect(world.provider.contentAt('b.svg')).toBe(svg('edited\n'));
		expect(world.store.ops()).toEqual([]);
	});

	it('keeps both where there is no record of what the drawing synced, rather than guess', async () => {
		// A dirty row from before the hash was kept. The moved file cannot be
		// told from one another device edited, so the write is not sent over it:
		// the remote keeps the path and the edit goes beside it. A copy nobody
		// needed, where the other guess is an edit nobody can get back.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		await world.engine.push();
		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.provider.contentAt('b.svg')).toBe(svg('one\n'));
		// The copy carries a `draw:id` of its own, and the words.
		expect(
			world.store
				.drawings()
				.some((drawing) => drawing.content === svg('edited\n', drawing.id))
		).toBe(true);
		expect(world.store.ops().filter((op) => op.op === 'move')).toEqual([]);
	});

	it('makes the folder the drawing was moved into, when the remote has not got it yet', async () => {
		// Edited, then dragged into a folder made on this device. The `mkdir`
		// for it is queued, but behind the write, which gets there first — and a
		// provider answers the move into a folder that is not there with the
		// same not-found as a file that is not there. `runMove` asks which; this
		// has to as well, or the write fails the same way every time.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'Work/Inner/a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'Work/Inner/a.svg' });
		world.store.queue({ op: 'mkdir', path: 'Work' });
		world.store.queue({ op: 'mkdir', path: 'Work/Inner' });
		world.store.queue({
			op: 'move',
			drawingId: 'n1',
			path: 'a.svg',
			targetPath: 'Work/Inner/a.svg',
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.contentAt('Work/Inner/a.svg')).toBe(svg('edited\n'));
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
	});

	it('does not move a file changed on the remote since the pull, to write over it', async () => {
		// Moved first, the write would be checked against the version the move
		// hands back rather than the one the drawing was in step with, and the
		// other device's edit would be gone with no conflict anywhere.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		await world.provider.write('a.svg', svg('theirs\n'), { expectedVersion: entry.version });

		expect((await world.engine.push()).status).toBe('retry');
		expect(world.provider.contentAt('a.svg')).toBe(svg('theirs\n'));
		expect(world.provider.contentAt('b.svg')).toBeUndefined();

		// And the next pull answers it as the conflict it is: both kept.
		await world.engine.sync();
		const texts = [
			...world.store.drawings().map((drawing) => drawing.content),
			...world.provider.snapshot().map((node) => world.provider.contentAt(node.path)),
		];
		expect(texts).toContain(svg('theirs\n'));
		expect(texts.some((text) => text?.includes('edited'))).toBe(true);
	});

	it('moves a drawing aside from a name taken while its rename was being followed', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		const other = await remoteFile('other.svg', svg('other\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		world.provider.setFault((call) =>
			call.op === 'move' ? new ConflictError({ ...other, path: 'b.svg' }) : undefined
		);

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(result.conflicts).toEqual([]);
		const mine = world.store.drawings().find((drawing) => drawing.id === 'n1');
		expect(mine).toMatchObject({ content: svg('edited\n'), remoteId: entry.remoteId });
		expect(mine?.path).toContain('conflict');
		expect(world.store.ops().find((op) => op.op === 'move')?.targetPath).toBe(mine?.path);
		expect(world.store.drawings()).toHaveLength(1);
	});

	it('moves a drawing aside from a file it does not hold, at the name it was renamed to', async () => {
		// Another device wrote `b.svg` after our pull. The write finds a file
		// there, and it is not this drawing's: its id says so. A conflict would give
		// this drawing that file's contents and id, and orphan its own file.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			syncedHash: await contentHash(svg('one\n')),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });
		const theirs = await remoteFile('b.svg', svg('other\n'));

		await world.engine.push();
		await world.engine.sync();

		const mine = world.store.drawings().find((drawing) => drawing.id === 'n1');
		expect(mine).toMatchObject({
			content: svg('edited\n'),
			remoteId: entry.remoteId,
			dirty: false,
		});
		expect(mine?.path).toContain('conflict');
		expect(world.provider.contentAt(mine?.path ?? '')).toBe(svg('edited\n'));
		expect(world.provider.contentAt('b.svg')).toBe(svg('other\n'));
		expect(world.provider.contentAt('a.svg')).toBeUndefined();
		expect(
			world.store.drawings().find((drawing) => drawing.remoteId === theirs.remoteId)?.content
		).toBe(svg('other\n'));
	});

	it('steps aside to one conflict name, not two, when the first is taken on the remote', async () => {
		// A drawing that keeps a file of its own cannot take the name by writing
		// there, the way a drawing with none does \u2014 the path belongs to somebody
		// else's file and its own may be perfectly good. Chosen from the store
		// alone, the name another device took for its own copy in the same
		// minute is chosen anyway: the retry meets that file, steps the drawing
		// aside again from a name that already carries a suffix, and spends a
		// second of five attempts on it with the queue stopped behind.
		const mine = await remoteFile('a.svg', svg('one\n'));
		await remoteFile('b.svg', svg('theirs\n'));
		const theirCopy = conflictPath('b.svg', AT);
		await remoteFile(theirCopy, svg('somebody else\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		await world.engine.push();
		await world.engine.push();

		// One suffix, with the counter `conflictName` adds for a name taken in
		// the same minute \u2014 not `(conflict \u2026) (conflict \u2026)`.
		const drawing = world.store.drawings().find((each) => each.id === 'n1');
		expect(drawing?.path).toBe(conflictPath('b.svg', AT, [basename(theirCopy)]));
		// Still bound to its own file, and nothing of ours written or moved
		// onto either of theirs.
		expect(drawing?.remoteId).toBe(mine.remoteId);
		expect(world.provider.contentAt(theirCopy)).toBe(svg('somebody else\n'));
		expect(world.provider.contentAt('b.svg')).toBe(svg('theirs\n'));
		// And the op was not stepped aside a second time: it is still aimed at
		// the one name the drawing was given.
		expect(world.store.ops().map((op) => op.path)).not.toContain(
			conflictPath(conflictPath('b.svg', AT), AT)
		);
	});

	it('fails the op rather than step aside to a name it has not looked at', async () => {
		// A hundred names beside `b.svg` taken in one minute is not a state a
		// user produces, but running out of tries must not answer it with the
		// next name unasked: that one is taken too, and the drawing displaced onto
		// it would stand on another drawing's path. It gives up instead, as
		// `freeFolderPath` does, and the op is left to be retried.
		const mine = await remoteFile('a.svg', svg('one\n'));
		await remoteFile('b.svg', svg('theirs\n'));
		const taken = Array.from({ length: 101 }).reduce<string[]>(
			(names) => [...names, basename(conflictPath('b.svg', AT, names))],
			[]
		);
		taken.forEach((name, i) =>
			world.store.put({ id: `copy${i}`, path: name, content: svg('copy\n') })
		);
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'b.svg' });

		const result = await world.engine.push();

		// One attempt spent, on the op that met the name, and nothing moved.
		expect(result.status).toBe('retry');
		expect(world.store.ops().map((op) => op.attempts)).toEqual([1, 0]);
		expect(world.store.drawings().find((each) => each.id === 'n1')?.path).toBe('b.svg');
		expect(world.store.drawings().filter((each) => each.path === taken.at(-1))).toHaveLength(1);
	});

	it('does the same with no rename queued to carry the file after it', async () => {
		// The same choice of name, reached without the queued `move` that lets
		// `followTheRename` move the file. What becomes of the op afterward is
		// its own question \u2014 there is nothing here to move the file and the
		// write finds nothing at the new path \u2014 but the drawing is moved aside
		// once, to a name that is free on the remote, rather than twice.
		const mine = await remoteFile('a.svg', svg('one\n'));
		await remoteFile('b.svg', svg('theirs\n'));
		const theirCopy = conflictPath('b.svg', AT);
		await remoteFile(theirCopy, svg('somebody else\n'));
		world.store.put({
			id: 'n1',
			path: 'b.svg',
			content: svg('edited\n'),
			...boundTo(mine),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'b.svg' });

		await world.engine.push();
		await world.engine.push();

		const drawing = world.store.drawings().find((each) => each.id === 'n1');
		expect(drawing?.path).toBe(conflictPath('b.svg', AT, [basename(theirCopy)]));
		expect(drawing?.remoteId).toBe(mine.remoteId);
		expect(drawing?.content).toBe(svg('edited\n'));
		expect(world.provider.contentAt(theirCopy)).toBe(svg('somebody else\n'));
	});

	it('answers a file replaced at the drawing\u2019s own path with the conflict rule, not by moving aside', async () => {
		// Deleted and written again — a new id at the same path — after our pull.
		// Moved aside, this drawing would keep its `draw:id` beside a file that
		// claims the same one. The conflict copy takes a fresh id instead.
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		await world.provider.delete(entry);
		await remoteFile('a.svg', svg('theirs\n'));

		const result = await world.engine.push();

		expect(result.conflicts).toHaveLength(1);
		expect(world.store.drawings().find((drawing) => drawing.id === 'n1')?.content).toBe(
			svg('theirs\n')
		);
		expect(world.store.drawings().find((drawing) => drawing.id !== 'n1')?.content).toContain(
			'edited'
		);
	});

	it('is one drawing when the version survives the move, as Dropbox rev does', async () => {
		const entry = await remoteFile('a.svg', svg('one\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('edited\n'),
			...boundTo(entry),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		const moved = await world.provider.move(entry, 'renamed.svg');

		// The one thing the fake models differently, fed in as Dropbox sends it.
		const stable = engineWith({
			provider: reporting(world.provider, [{ ...moved, version: entry.version }]),
		});
		await stable.pull();

		expect(world.store.drawings()).toHaveLength(1);
		expect(drawingAt('renamed.svg')?.content).toBe(svg('edited\n'));
		expect(drawingAt('renamed.svg')?.dirty).toBe(true);
	});
});

describe('a queued move whose destination folder is not on the remote yet', () => {
	it('makes the folder rather than dropping the rename', async () => {
		// The user made a folder here and dragged a drawing into it. Nothing
		// queues a `mkdir` for a folder that has only ever been moved into, so
		// the `move` is the first thing to name it — and the provider answers
		// not found for a missing destination exactly as it does for a missing
		// source. Reading that as "the file is gone" completes the op and the
		// user's drag is lost with nothing said anywhere.
		const file = await remoteFile('x.svg', svg('x\n'));
		world.store.put({
			id: 'n1',
			path: 'Work/Deep/x.svg',
			content: svg('x\n'),
			...boundTo(file),
		});
		world.store.queue({
			op: 'move',
			drawingId: 'n1',
			path: 'x.svg',
			targetPath: 'Work/Deep/x.svg',
		});

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/Deep/x.svg')).toBe(svg('x\n'));
		expect(world.store.ops()).toEqual([]);
	});

	it('still drops a move whose file is genuinely gone', async () => {
		const file = await remoteFile('x.svg', svg('x\n'));
		world.store.put({
			id: 'n1',
			path: 'x.svg',
			content: svg('x\n'),
			...boundTo(file),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'x.svg', targetPath: 'y.svg' });
		await world.provider.delete(file);

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.ops()).toEqual([]);
		expect(world.provider.snapshot().some((entry) => entry.path === 'y.svg')).toBe(false);
	});
});

describe('a write whose remote folder is gone', () => {
	it('makes the folder rather than blocking the queue for ever', async () => {
		// The ordinary case of a folder deleted on another device while a drawing
		// inside it had unsaved work. The pull keeps that drawing and cuts it loose
		// — an unsaved edit outranks a remote deletion — which leaves nothing on
		// the remote above it. Every write then fails the same way, and the
		// ordered queue strands every op behind it for every drawing.
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('x\n'));
		await world.engine.pull();
		const mine = drawingAt('Work/a.svg');
		if (mine === undefined) throw new Error('nothing at Work/a.svg');
		world.store.put({ ...mine, content: svg('my edit\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: mine.id, path: 'Work/a.svg' });
		await world.provider.delete(folder);

		const result = await world.engine.sync();

		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('Work/a.svg')).toBe(svg('my edit\n'));
		expect(world.store.ops()).toEqual([]);
	});

	it('leaves a kept drawing a folder to be in', async () => {
		// The cascade takes the folder rows on the way down. A drawing left at a
		// path with no folder behind it is invisible in the sidebar while
		// still holding its name.
		const folder = await world.provider.createFolder('Work');
		await remoteFile('Work/a.svg', svg('x\n'));
		await world.engine.pull();
		const mine = drawingAt('Work/a.svg');
		if (mine === undefined) throw new Error('nothing at Work/a.svg');
		world.store.put({ ...mine, content: svg('my edit\n'), dirty: true });
		await world.provider.delete(folder);

		await pullNow([{ path: 'Work', deleted: true, remoteId: folder.remoteId }]);

		expect(drawingAt('Work/a.svg')?.content).toBe(svg('my edit\n'));
		expect(world.store.folders().map((each) => each.path)).toEqual(['Work']);
	});

	it('does not leave a folder behind for a drawing that moved out of it', async () => {
		// The other half: the row is only wanted where a drawing actually ends up.
		const folder = await world.provider.createFolder('Work');
		const file = await remoteFile('Work/a.svg', svg('one\n'));
		await world.engine.pull();
		const mine = drawingAt('Work/a.svg');
		if (mine === undefined) throw new Error('nothing at Work/a.svg');
		world.store.put({ ...mine, content: svg('mine\n'), dirty: true });
		await world.provider.move(file, 'a.svg');
		await world.provider.delete(folder);
		const out = remoteAt(world.provider, 'a.svg');
		if (out === undefined) throw new Error('no file at a.svg');

		await pullNow([
			{ path: 'Work', deleted: true, remoteId: folder.remoteId },
			{ path: 'Work/a.svg', deleted: true, remoteId: file.remoteId },
			out,
		]);

		expect(world.store.folders()).toEqual([]);
	});
});

describe('a pull carrying our own echo of a rename we have not pushed', () => {
	it('leaves the drawing where the user put it', async () => {
		// The feed cannot say whose rename it is; the queue can. Moving the row
		// back undoes what the user just did in front of them, and frees the
		// path they renamed *to* — so a file arriving there in the same batch is
		// imported rather than displaced, and the queued move then conflicts on
		// that path for ever with the whole queue behind it.
		const file = await remoteFile('a.svg', svg('x\n'));
		world.store.put({
			id: 'n1',
			path: 'c.svg',
			content: svg('x\n'),
			...boundTo(file),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'c.svg' });
		const theirs = await remoteFile('c.svg', svg('theirs\n'));

		await pullNow([file, theirs]);
		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		// Ours was displaced by theirs rather than moved back to `a.svg`, and its
		// queued rename went with it.
		expect(drawingAt('c.svg')?.content).toBe(svg('theirs\n'));
		expect(world.store.drawings().find((each) => each.id === 'n1')?.path).toContain('conflict');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('a queued rename onto a path the remote will not give up', () => {
	it('lands beside it instead of stranding the queue', async () => {
		const one = await remoteFile('x.svg', svg('one\n'));
		const two = await remoteFile('y.svg', svg('two\n'));
		world.store.put({
			id: 'n1',
			path: 'y.svg',
			content: svg('two\n'),
			...boundTo(two),
		});
		world.store.put({
			id: 'n2',
			path: 'z.svg',
			content: svg('one\n'),
			...boundTo(one),
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'y.svg', targetPath: 'z.svg' });
		await world.provider.move(one, 'z.svg');

		const result = await world.engine.push();

		expect(result.status).toBe('ok');
		expect(world.store.drawings().find((each) => each.id === 'n1')?.path).toBe(
			conflictPath('z.svg', AT)
		);
		expect(drawingAt('z.svg')?.id).toBe('n2');
		expect(world.store.ops()).toEqual([]);
	});
});

describe('our own echo arriving with a new version', () => {
	it('still leaves a queued rename where the user put it', async () => {
		// The other half of the same rule. Here the version has moved on — our
		// own write coming back — so the bytes are read and found to match, and
		// the path still differs because the rename has not been pushed.
		const file = await remoteFile('a.svg', svg('x\n'));
		world.store.put({
			id: 'n1',
			path: 'c.svg',
			content: svg('x\n'),
			remoteId: file.remoteId,
			remoteVersion: 'stale',
		});
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'a.svg', targetPath: 'c.svg' });

		await pullNow([file]);

		expect(world.store.drawings().map((each) => each.path)).toEqual(['c.svg']);
		expect(world.store.drawings()[0]?.remoteVersion).toBe(file.version);
	});
});

describe('an op withdrawn after the queue was read', () => {
	it('is passed over, not sent', async () => {
		// The engine reads the queue once. A restore that withdraws a delete
		// while an earlier op is out would otherwise still delete the file.
		const kept = await remoteFile('a.svg', svg('keep\n'));
		world.store.put({
			id: 'n1',
			path: 'a.svg',
			content: svg('keep\n'),
			...boundTo(kept),
		});
		const remove = world.store.queue({ op: 'delete', drawingId: 'n1', path: 'a.svg' });
		const stale = await world.store.pendingOps();
		await world.store.completeOp(remove.seq, { kind: 'done' });

		const result = await engineWith({
			store: { ...world.store, pendingOps: () => Promise.resolve(stale) },
		}).push();

		expect(result).toMatchObject({ status: 'ok', pushed: 0 });
		expect(world.provider.callLog().filter((call) => call.op === 'delete')).toEqual([]);
		expect(world.provider.contentAt('a.svg')).toBe(svg('keep\n'));
	});
});

describe('a write that finds nothing, with an unrelated rename queued', () => {
	it('does not rename the remote file to somewhere the user did not ask for', async () => {
		// `followTheRename` exists for the rename that *explains* the missing
		// path — one whose target is where the drawing now is. Any other queued
		// move says nothing about it, and acting on it moves the user's file
		// somewhere they never named.
		const file = await remoteFile('a.svg', svg('x\n'));
		world.store.put({
			id: 'n1',
			path: 'c.svg',
			content: svg('mine\n'),
			...boundTo(file),
			dirty: true,
		});
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'c.svg' });
		world.store.queue({ op: 'move', drawingId: 'n1', path: 'c.svg', targetPath: 'd.svg' });

		const result = await world.engine.push();

		expect(result.status).toBe('retry');
		expect(world.provider.snapshot().map((each) => each.path)).toContain('a.svg');
		expect(world.provider.snapshot().map((each) => each.path)).not.toContain('c.svg');
	});
});
