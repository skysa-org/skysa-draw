import { t } from '../../i18n/t.js';
import type { SyncStateRecord } from '../../store/db.js';
import type { Unsynced } from '../../store/unsynced.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import type { MenuItem } from '../ui/Menu.js';
import { importingHere, isSyncable } from './SyncState.js';

/**
 * Whether one last push before the question is worth waiting for. Not where the
 * scheduler is not syncing this source anyway, not where it has already stopped
 * on something it will stop on again, and not where there is no network: each
 * of those is a delay in front of the same question.
 */
export const worthPushing = (status: SchedulerStatus): boolean =>
	navigator.onLine &&
	status.phase !== 'local' &&
	status.phase !== 'attention' &&
	status.phase !== 'offline';

/**
 * Why the last push could not clear what is here, where the user would do
 * better to cancel and come back to it. Not a reason to refuse the disconnect:
 * they may have no intention of ever reaching this account again.
 */
export const stoppedBy = (
	status: SchedulerStatus,
	listed: Unsynced
): 'offline' | 'blocked' | null => {
	if (status.phase === 'offline' || !navigator.onLine) return 'offline';
	return listed.blocked ? 'blocked' : null;
};

/**
 * Whether a source's panel offers a thing now: yes, no, or not known yet —
 * what it waits on (the scheduler past `local`, `holdsAnything` read, a
 * disconnect no longer out) has not arrived. The showing source's `⋯` offers
 * what is `yes`, and an ask from another source's `⋯` (`useAsked`) is done on
 * `yes`, dropped on `no` and kept on `not yet`, so the two cannot come to
 * differ. Being disabled (a sync going, a download running) is the menu's alone.
 */
export type Offer = 'yes' | 'no' | 'not yet';

/** Download all its drawings: where there is anything, and it can be downloaded now. */
export const offersDownload = (downloadable: boolean, holds: boolean | undefined): Offer => {
	if (!downloadable) return 'no';
	if (holds === undefined) return 'not yet';
	return holds ? 'yes' : 'no';
};

/** Read everything again: where it syncs, once the scheduler is syncing it. */
export const offersRescan = (bound: SyncStateRecord, phase: SchedulerStatus['phase']): Offer => {
	if (!isSyncable(bound) || importingHere(bound)) return 'no';
	return phase === 'local' ? 'not yet' : 'yes';
};

/** Disconnect it: not while the question is open, and not yet while one is out. */
export const offersDisconnect = (open: boolean, blocked: boolean): Offer => {
	if (open) return 'no';
	return blocked ? 'not yet' : 'yes';
};

/**
 * Whether the scheduler syncs the source now: not before it has begun, nor
 * while a first import holds it. What a sync is needed for waits on it.
 */
const syncsHere = (bound: SyncStateRecord, phase: SchedulerStatus['phase']): boolean =>
	!importingHere(bound) && phase !== 'local';

/**
 * What can be done to a connected source, beyond what its status offers: the
 * items of the `⋯` at the end of its row, disabled where they cannot be done
 * now. Neither way to let the source go while the disconnect question is open,
 * which is the way on from there.
 */
export const storageItems = ({
	bound,
	phase,
	rescanning,
	onRescan,
	download,
	about,
	stranded,
	open,
	disconnectBlocked,
	syncNow,
	ask,
}: Readonly<{
	bound: SyncStateRecord;
	phase: SchedulerStatus['phase'];
	rescanning: boolean;
	onRescan: () => void;
	download: readonly MenuItem[];
	/** What the provider keeps from the app (`unseenItem`). */
	about: readonly MenuItem[];
	stranded: boolean;
	/** Whether the disconnect question is open. */
	open: boolean;
	disconnectBlocked: boolean;
	syncNow: () => void;
	ask: (onServer: boolean) => void;
}>): MenuItem[] => {
	const syncing = phase === 'syncing';
	return [
		...(syncsHere(bound, phase)
			? [
					{
						id: 'sync',
						label: t('account.menu.syncNow'),
						onSelect: syncNow,
						disabled: syncing,
					},
				]
			: []),
		...(offersRescan(bound, phase) === 'yes' && !rescanning
			? [
					{
						id: 'rescan',
						label: t('account.menu.rescan'),
						onSelect: onRescan,
						disabled: syncing,
					},
				]
			: []),
		...download,
		...about,
		...(stranded && !open
			? [
					{
						id: 'stop-here',
						label: t('account.menu.stopHere'),
						// The same question again, and nothing asked of the server:
						// it has already refused, and nothing on it is touched.
						onSelect: () => {
							ask(false);
						},
					},
				]
			: []),
		...(offersDisconnect(open, disconnectBlocked) === 'no'
			? []
			: [
					{
						id: 'disconnect',
						label: t('account.menu.disconnect'),
						onSelect: () => {
							ask(true);
						},
						danger: true,
						disabled: disconnectBlocked,
					},
				]),
	];
};
