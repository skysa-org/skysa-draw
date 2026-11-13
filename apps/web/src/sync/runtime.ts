import {
	api,
	createProviderFactory,
	createRelayFactory,
	type SchedulerStatus,
	type SyncScheduler,
} from '@skysa/client';
import { DRAW_FOLDER, DRAW_FORMAT, syncsHidden } from '@skysa/draw-core';
import { useSyncExternalStore } from 'react';

import { t } from '../i18n/t.js';
import { db } from '../store/db.js';
import { createDrawingsSync, type DrawingsSync } from './drawingsSync.js';
import { SYNC_LOCK } from './lock.js';
import { needsReconnect } from './status.js';

/**
 * The app's one sync scheduler, over the app's one database, with what the app
 * syncs beside the drawings attached to it (`sync/drawingsSync.ts`). Started by
 * `main.tsx` before the first render, not by a component, so a remount — or
 * React running an effect twice in development — never stops and starts it.
 */

/** Written into the marker file on first connect. */
const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0-dev';

export const syncScheduler: DrawingsSync = createDrawingsSync({
	db,
	client: api,
	createProvider: createProviderFactory({
		folder: DRAW_FOLDER,
		document: DRAW_FORMAT,
		appVersion: APP_VERSION,
		timedOut: () => t('shell.sync.timedOut'),
	}),
	lockName: SYNC_LOCK,
	document: DRAW_FORMAT,
	syncsHidden,
	// Asks `/config` first, so an instance without a relay is never asked for
	// a ticket (`createRelayFactory`, the kit's).
	relay: createRelayFactory({ credentials: db, client: api }),
});

/** What the scheduler says now, re-rendering whenever that changes. */
export const useSyncStatus = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): SchedulerStatus => useSyncExternalStore(scheduler.subscribe, scheduler.status);

/** Whether the showing source needs connecting again, re-rendering as that changes. */
export const useNeedsReconnect = (
	scheduler: Pick<SyncScheduler, 'status' | 'subscribe'> = syncScheduler
): boolean => useSyncExternalStore(scheduler.subscribe, () => needsReconnect(scheduler.status()));
