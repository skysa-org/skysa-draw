import { type Detached, type DrawDatabase, refIn, type SyncStateRecord } from './db.js';
import type { SettledEditors } from './heldEdits.js';
import { isLiveSource } from './rowStates.js';

/**
 * A source the device no longer reaches, kept for what it never sent
 * (`SyncStateRecord.detached`): what such a row carries, and the questions more
 * than one module asks of one. Apart from `store/connection.ts`, which does the
 * detaching, so the modules it imports can ask them too.
 *
 * skysa-notes also makes one here for a save that lands after its source went
 * (`ensureDetached`, called from bringing a gone note back); this app's
 * `saveDrawing` refuses a gone row instead, so that half has not come across.
 */

/**
 * `state`, as a detached source's row.
 *
 * What says whose the drawings are is kept — provider, account, the name the
 * server last gave it, and the install's client id — since that is how the user
 * tells which source is in question and how a reconnect knows the rows are
 * going home. `resumeUnverified` is kept as well: a resumed source nobody had
 * checked yet is still one whose clean rows are a memory and not a fact
 * (`store/unsynced.ts`), and dropping the flag would let a discard count them
 * as safely on the remote.
 *
 * Everything that reaches the remote goes: the cursor, so the first pull after
 * a reconnect is a full scan that brings back what was removed here; the root,
 * which belongs to a folder that may be another one by then; and the access
 * token, which is a live key to the account and has no business outliving the
 * connection. A row already detached keeps the time it first was.
 */
export const detachedFrom = (
	state: SyncStateRecord,
	reason: Detached['reason'],
	at: number
): SyncStateRecord => ({
	connectionId: state.connectionId,
	...(state.provider === undefined ? {} : { provider: state.provider }),
	...(state.accountId === undefined ? {} : { accountId: state.accountId }),
	...(state.displayName === undefined ? {} : { displayName: state.displayName }),
	clientId: state.clientId,
	...(state.resumeUnverified === true ? { resumeUnverified: true } : {}),
	detached: state.detached ?? { at, reason },
});

/**
 * Write onto a source's row only while the device still syncs it.
 *
 * For what a sync run learns on its way — a token, the root, when it last
 * pulled — which can land after the source was let go. A row that has gone
 * must not come back, which `update` alone would see to; a row that is still
 * there *detached* must not be handed a live access token or a root either,
 * and only reading it first can tell.
 */
export const updateLive = (
	db: DrawDatabase,
	connectionId: string,
	change: (state: SyncStateRecord) => SyncStateRecord
): Promise<void> =>
	db.transaction('rw', db.syncState, async () => {
		const state = await db.syncState.get(connectionId);
		if (state === undefined || !isLiveSource(state)) return;
		await db.syncState.put(change(state));
	});

/**
 * Whether the editors hold text for one of this source's drawings that the store
 * would not take — or hold something they could not even say about. The
 * question a discard has to ask: the store is not the whole of what the user
 * wrote in this source, so the list it would show is not the whole of what
 * would go.
 *
 * Here rather than in `heldEdits.ts`, which the database module reaches
 * through `staleTab.ts` and so must import nothing of it back.
 */
export const holdsTextFor = (settled: SettledEditors, connectionId: string): boolean =>
	settled.rejected > 0 || settled.failing.some((ref) => refIn(ref, connectionId));
