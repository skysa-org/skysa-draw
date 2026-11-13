import {
	browserEnvironment,
	createSyncScheduler,
	type SyncScheduler,
	type SyncSchedulerOptions,
} from '@skysa/client';

import type { DrawDatabase } from '../store/db.js';
import { clientStoreOf } from './dexiePorts.js';
import { createFileReader, type FileReader } from './fileReads.js';

/**
 * This app's sync: the scheduler, which is the kit's and knows nothing of
 * drawings (skysa-notes' record 0018), over this app's database, and
 * the files beside drawings read through the session it runs, as they are
 * opened.
 */

export interface DrawingsSyncOptions extends Omit<SyncSchedulerOptions, 'store'> {
	/** The app's database, which the scheduler reaches through `clientStoreOf`. */
	db: DrawDatabase;
}

export interface DrawingsSync extends SyncScheduler {
	/**
	 * A file beside a drawing, for showing it: from this device if it holds the
	 * bytes, and otherwise downloaded through the session running for
	 * `connectionId`, if one is, and kept (`sync/fileReads.ts`). Never rejects.
	 */
	readonly readFile: FileReader['read'];
}

export const createDrawingsSync = (options: DrawingsSyncOptions): DrawingsSync => {
	const { db, ...schedulerOptions } = options;
	const environment = options.environment ?? browserEnvironment();
	const scheduler = createSyncScheduler({
		...schedulerOptions,
		store: clientStoreOf(db),
		environment,
	});
	const { isOnline, now } = environment;
	const reader = createFileReader({ db, isOnline, now, sessionFor: scheduler.sessionFor });
	return { ...scheduler, readFile: reader.read };
};
