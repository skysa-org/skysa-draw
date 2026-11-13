import { reaches, stopSchedulers } from '@skysa/client/testing';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileRead } from '../../src/sync/fileReads.js';
import { bound, started } from '../support/scheduler.js';

afterEach(stopSchedulers);

describe('files beside drawings, read for showing (skysa-notes #187)', () => {
	/** A file on the remote, mirrored as a row by a sync. */
	const mirrored = async () => {
		const db = await bound();
		const h = started(db);
		await reaches(h.scheduler, 'idle');
		h.remote.fake.plantBytes('pic.png', new TextEncoder().encode('pixels'));
		await h.scheduler.syncNow();
		const row = await db.files.where('[connectionId+path]').equals(['c1', 'pic.png']).first();
		if (row === undefined) throw new Error('The sync did not mirror the file');
		return { ...h, row };
	};

	const text = (read: FileRead): string | undefined =>
		read.state === 'ready' ? new TextDecoder().decode(read.bytes) : undefined;

	it('downloads one through the session running for its source, and keeps it', async () => {
		const { db, scheduler, remote, row } = await mirrored();

		expect(text(await scheduler.readFile('c1', row.id))).toBe('pixels');
		expect(remote.tokensUsed.at(-1)).toBe('t1');
		expect(await db.fileBytes.get(['c1', row.id])).toMatchObject({
			version: row.remoteVersion,
			pinned: 0,
		});
	});

	it('refreshes a token the provider refuses, and reads again', async () => {
		const { scheduler, remote, server, row } = await mirrored();
		remote.rejected.add('t1');

		expect(text(await scheduler.readFile('c1', row.id))).toBe('pixels');
		expect(server.token).toHaveBeenCalledTimes(2);
		expect(remote.tokensUsed.at(-1)).toBe('t2');
	});

	it('reads nothing from a source it is not running, nor while offline', async () => {
		const { db, scheduler, env, row } = await mirrored();
		await db.files.put({ ...row, connectionId: 'c2' });

		expect(await scheduler.readFile('c2', row.id)).toEqual({ state: 'unavailable' });
		env.state.online = false;
		expect(await scheduler.readFile('c1', row.id)).toEqual({ state: 'offline' });
	});
});
