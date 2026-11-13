/**
 * This app's scheduler under test: its database bound to a source, and its
 * scheduler made as the app makes it, with the files beside drawings
 * attached. The rest of a scheduler under test is the kit's
 * (`@skysa/client/testing`).
 */
import { cleanups, schedulerDefaults } from '@skysa/client/testing';
import { DRAW_FORMAT, syncsHidden } from '@skysa/draw-core';

import { bindConnection } from '../../src/store/connection.js';
import type { DrawDatabase } from '../../src/store/db.js';
import {
	createDrawingsSync,
	type DrawingsSync,
	type DrawingsSyncOptions,
} from '../../src/sync/drawingsSync.js';
import { SYNC_LOCK } from '../../src/sync/lock.js';
import { holdCredential } from './connection.js';
import { watchedDatabase } from './db.js';

export const ACCOUNT = { connectionId: 'c1', provider: 'dropbox', accountId: 'acct' } as const;

export const bound = async (connectionId = 'c1') => {
	const db = watchedDatabase();
	await bindConnection(db, { ...ACCOUNT, connectionId });
	await holdCredential(db, connectionId);
	return db;
};

type Defaults = ReturnType<typeof schedulerDefaults>;

export interface Harness extends Omit<Defaults, 'options'> {
	db: DrawDatabase;
	scheduler: DrawingsSync;
}

export const started = (
	db: DrawDatabase,
	overrides: Partial<DrawingsSyncOptions> = {}
): Harness => {
	const { env, server, remote, options } = schedulerDefaults();
	// As the app makes it (`sync/runtime.ts`): with the files beside drawings
	// attached.
	const scheduler = createDrawingsSync({
		lockName: SYNC_LOCK,
		document: DRAW_FORMAT,
		syncsHidden,
		db,
		...options,
		...overrides,
	});
	cleanups.unshift(() => {
		scheduler.stop();
	});
	scheduler.start();
	return { db, scheduler, env, server, remote };
};
