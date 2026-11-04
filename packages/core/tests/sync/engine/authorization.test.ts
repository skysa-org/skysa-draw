import { describe, expect, it } from 'vitest';

import { AuthError, CursorResetError } from '../../../src/providers/types.js';
import type { SyncEngine } from '../../../src/sync/engine.js';
import { svg } from '../kit/drawings.js';
import { remoteAt } from '../kit/remote.js';
import { boundTo } from '../kit/seed.js';
import { syncWorld } from '../kit/world.js';

/**
 * A provider that stops taking the token part-way, and the one
 * refresh-and-retry the engine allows it (`pull/run`).
 */
const { world, engineWith, remoteFile, drawingAt, pulledDrawing } = syncWorld();

describe('authorization', () => {
	it('refreshes the token once and carries on', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		let refreshed = 0;
		world.provider.setFault((call) =>
			call.op === 'write' && refreshed === 0 ? new AuthError('expired') : undefined
		);
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('ok');
		expect(world.provider.contentAt('a.svg')).toBe(svg('mine\n'));
	});

	it('refreshes for a token that expired while resolving a push conflict', async () => {
		// The conflict rule reads the remote before it decides anything, and
		// that read meets an expired token like any other. Under the conflict's
		// name it was neither refreshed nor retried — just counted, so a token
		// going stale at exactly the wrong moment spent one of the write's
		// attempts and left the conflict unresolved.
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
		let refreshed = 0;
		world.provider.setFault((call) =>
			call.op === 'read' && refreshed === 0 ? new AuthError('expired') : undefined
		);
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('ok');
		// The write is done with — what is left queued is the conflict copy's
		// own write, which the resolution made.
		expect(world.store.ops().map((queued) => queued.seq)).not.toContain(op.seq);
		expect(world.store.lastError(op.seq)).toBeUndefined();
		// And the conflict rule got to run after the fresh token: the remote
		// keeps the path and the local copy is beside it.
		expect(result.conflicts).toHaveLength(1);
		expect([...world.store.drawings()].map((drawing) => drawing.path).sort()).toEqual(
			['a.svg', ...result.conflicts].sort()
		);
	});

	it('pauses rather than looping when the refresh does not help', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		let refreshed = 0;
		world.provider.setFault((call) =>
			call.op === 'write' ? new AuthError('expired') : undefined
		);
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.push();

		expect(refreshed).toBe(1);
		expect(result.status).toBe('paused');
		expect(result.error).toBe('authorization required');
	});

	it('pauses immediately when there is no way to refresh', async () => {
		world.store.put({ id: 'n1', path: 'a.svg', content: svg('mine\n'), dirty: true });
		world.store.queue({ op: 'write', drawingId: 'n1', path: 'a.svg' });
		world.provider.setFault((call) =>
			call.op === 'write' ? new AuthError('expired') : undefined
		);

		expect((await world.engine.push()).status).toBe('paused');
	});

	it('pauses a pull after one refresh that does not help, as it does a push', async () => {
		let refreshed = 0;
		world.provider.setFault((call) =>
			call.op === 'changes' ? new AuthError('expired') : undefined
		);
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.pull();

		expect(refreshed).toBe(1);
		expect(result).toEqual(
			expect.objectContaining({ status: 'paused', error: 'authorization required' })
		);
	});

	it('pauses a pull at once when there is no way to refresh', async () => {
		let asked = 0;
		world.provider.setFault((call) => {
			if (call.op !== 'changes') return undefined;
			asked += 1;
			return new AuthError('expired');
		});

		expect(await world.engine.pull()).toEqual(
			expect.objectContaining({ status: 'paused', error: 'authorization required' })
		);
		expect(asked).toBe(1);
	});

	/**
	 * The provider, answering `changes` through `answer` first, and the cursor
	 * each call carried: `undefined` is a scan from the top, the stored one a
	 * round. The fake's own fault hook cannot tell those apart.
	 */
	const answering = (
		answer: (cursor: string | undefined) => Error | undefined
	): { asked: (string | undefined)[]; refreshed: () => number; engine: SyncEngine } => {
		const asked: (string | undefined)[] = [];
		const refreshes: number[] = [];
		const withAuth = engineWith({
			provider: {
				...world.provider,
				changes: (cursor?: string) => {
					asked.push(cursor);
					const refusal = answer(cursor);
					return refusal === undefined
						? world.provider.changes(cursor)
						: Promise.reject(refusal);
				},
			},
			reauthorize: () => {
				refreshes.push(1);
				return Promise.resolve();
			},
		});
		return { asked, refreshed: () => refreshes.length, engine: withAuth };
	};

	it('refreshes for a token that expires in the scan that answers a dead cursor', async () => {
		await pulledDrawing('a.svg', svg('one\n'));
		await remoteFile('b.svg', svg('two\n'));
		const dead = world.store.storedCursor();
		const run = answering((cursor) => {
			if (cursor === dead) return new CursorResetError('reset');
			return cursor === undefined && run.refreshed() === 0
				? new AuthError('expired')
				: undefined;
		});

		const result = await run.engine.pull();

		expect(run.refreshed()).toBe(1);
		expect(result.status).toBe('ok');
		expect(drawingAt('b.svg')?.content).toBe(svg('two\n'));
		// Round, scan, and the scan again: not the refused cursor a second time.
		expect(run.asked).toEqual([dead, undefined, undefined]);
	});

	it('scans when the cursor turns out dead on the retry after a refresh', async () => {
		await pulledDrawing('a.svg', svg('one\n'));
		await remoteFile('b.svg', svg('two\n'));
		const dead = world.store.storedCursor();
		const run = answering((cursor) => {
			if (run.refreshed() === 0) return new AuthError('expired');
			return cursor === dead ? new CursorResetError('reset') : undefined;
		});

		const result = await run.engine.pull();

		expect(run.refreshed()).toBe(1);
		expect(result.status).toBe('ok');
		expect(drawingAt('b.svg')?.content).toBe(svg('two\n'));
		expect(run.asked).toEqual([dead, dead, undefined]);
	});

	it('keeps the upload a dead cursor asked for through the retry after a refresh', async () => {
		await pulledDrawing('a.svg', svg('one\n'));
		const kept = drawingAt('a.svg');
		const file = remoteAt(world.provider, 'a.svg');
		if (file === undefined) throw new Error('no file');
		await world.provider.delete(file);
		const dead = world.store.storedCursor();
		// Refused with the upload once only: a provider asked again may say less.
		const run = answering((cursor) => {
			if (cursor === dead) return new CursorResetError('reset', run.asked.length === 1);
			return cursor === undefined && run.refreshed() === 0
				? new AuthError('expired')
				: undefined;
		});

		expect((await run.engine.pull()).status).toBe('ok');
		expect(run.refreshed()).toBe(1);
		// Sent back up, not let go of.
		expect(drawingAt('a.svg')).toEqual(expect.objectContaining({ id: kept?.id, dirty: true }));
		expect(world.store.ops().map((op) => ({ op: op.op, path: op.path }))).toEqual([
			{ op: 'write', path: 'a.svg' },
		]);
	});

	it('pauses, after one refresh, a dead cursor whose scan keeps meeting an expired token', async () => {
		await pulledDrawing('a.svg', svg('one\n'));
		const dead = world.store.storedCursor();
		const run = answering((cursor) =>
			cursor === dead ? new CursorResetError('reset') : new AuthError('expired')
		);

		const result = await run.engine.pull();

		expect(run.refreshed()).toBe(1);
		expect(result).toEqual(
			expect.objectContaining({ status: 'paused', error: 'authorization required' })
		);
		expect(run.asked).toEqual([dead, undefined, undefined]);
		expect(world.store.storedCursor()).toBe(dead);
	});

	it('pauses a pull from a stored cursor after one refresh, and keeps the cursor', async () => {
		await remoteFile('a.svg', svg('one\n'));
		expect((await world.engine.pull()).status).toBe('ok');
		const cursor = await world.store.cursor();
		expect(cursor).toBeDefined();
		let refreshed = 0;
		world.provider.setFault((call) =>
			call.op === 'changes' ? new AuthError('expired') : undefined
		);
		const withAuth = engineWith({
			reauthorize: () => {
				refreshed += 1;
				return Promise.resolve();
			},
		});

		const result = await withAuth.pull();

		expect(refreshed).toBe(1);
		expect(result).toEqual(
			expect.objectContaining({ status: 'paused', error: 'authorization required' })
		);
		expect(await world.store.cursor()).toBe(cursor);
	});
});
