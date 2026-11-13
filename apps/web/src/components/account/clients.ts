import type { ApiClient, SyncScheduler } from '@skysa/client';

/**
 * The parts of the API client and the scheduler the account panel uses. The
 * clipboard and the key file notes' scheduler also lends its panel are notes'
 * own, and are not asked for here.
 */

export type Client = Pick<ApiClient, 'config' | 'withCredential' | 'startConnect'>;

export type Sync = Pick<
	SyncScheduler,
	'status' | 'subscribe' | 'syncNow' | 'resync' | 'halt' | 'pause'
>;
