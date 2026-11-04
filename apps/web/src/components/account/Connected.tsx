import { useLiveQuery } from 'dexie-react-hooks';
import { useCallback, useRef, useState } from 'react';

import type { Grant, InstanceConfig } from '../../api/client.js';
import { answer, type Asked } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import { connectedSources } from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import type { SyncStateRecord } from '../../store/db.js';
import { holdsAnything, type Library } from '../../store/exportDrawings.js';
import type { Unsynced } from '../../store/unsynced.js';
import {
	type AccountState,
	type LetGoInput,
	PROVIDER_LABELS,
	type UnsentAnswer,
} from '../../sync/account.js';
import { useSyncStatus } from '../../sync/runtime.js';
import type { SchedulerStatus } from '../../sync/scheduler.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import type { Client, Sync } from './clients.js';
import { Devices, stillSignedIn, useGrants } from './Devices.js';
import { DisconnectDialog } from './DisconnectDialog.js';
import { DownloadAll, type Downloading, downloadItem, useDownloadAll } from './DownloadAll.js';
import { otherLiveSources } from './MoveUnsent.js';
import { ActionsMenu } from './PanelMenus.js';
import { Question, QuestionActions } from './Question.js';
import { StatusLine, SyncBar, SyncDetails } from './StatusLine.js';
import { lineStatus, syncCount } from './statusWords.js';
import {
	offersDisconnect,
	offersDownload,
	offersRescan,
	stoppedBy,
	storageItems,
	worthPushing,
} from './storageItems.js';
import { LeftAtProvider, UnseenDialog, unseenItem } from './SyncNotices.js';
import { importingHere, isSyncable, SyncState } from './SyncState.js';
import { useAsked } from './useAsked.js';
import { type Disconnecting, prepare } from './useDisconnects.js';

/**
 * What the account is called: as the server has just said it, or else as it
 * last did — the panel has to be able to name the account offline too.
 */
const accountName = (state: AccountState | undefined, bound: SyncStateRecord): string | null => {
	const said =
		state?.kind === 'connected' && state.connection.id === bound.connectionId
			? state.connection.displayName
			: null;
	return said ?? bound.displayName ?? null;
};

/** The provider, as the user knows it, or plain "storage" where the source no longer says. */
const providerLabel = (bound: SyncStateRecord): string =>
	bound.provider === undefined ? t('connection.someStorage') : PROVIDER_LABELS[bound.provider];

interface ConnectedProps {
	readonly client: Client;
	readonly sync: Sync;
	readonly bound: SyncStateRecord;
	readonly config: Asked<InstanceConfig>;
	readonly account: Asked<AccountState>;
	/** Every disconnect that has been asked for, by source: see `useDisconnects`. */
	readonly disconnects: Readonly<Record<string, Disconnecting>>;
	readonly onDisconnect: (
		connectionId: string,
		answer: Omit<LetGoInput, 'connectionId'>
	) => Promise<void>;
	/** Hand the drawings that were never sent to the user as a file. */
	readonly download: (listed: Unsynced) => Promise<void>;
	/** Hand the whole source to the user as a file. */
	readonly downloadAll: (library: Library) => void;
	readonly returnTo: string;
	readonly navigate?: (url: string) => void;
	readonly slot?: AccountSlot;
}

/**
 * Where a connected source's panel ends: the status line (`StatusLine`), with
 * how syncing is going and the count of the other devices, and the source's
 * `⋯` at the end of its row above. The menu also opens what the provider
 * keeps from the app, said over the library, the line having no room for it.
 */
const ConnectedFoot = ({
	slot,
	bound,
	status,
	label,
	displayName,
	client,
	grants,
	onGrantsChanged,
	downloadable,
	holds,
	downloading,
	onPause,
	...actions
}: Readonly<
	Omit<Parameters<typeof storageItems>[0], 'about' | 'phase' | 'download'> & {
		slot: AccountSlot | undefined;
		/** Pause syncing, from its details (`SyncDetails`). */
		onPause: () => void;
		/**
		 * Whether the source can be downloaded now: not while a first import is
		 * filling it, nor while the disconnect question is open.
		 */
		downloadable: boolean;
		holds: boolean | undefined;
		downloading: Downloading;
		status: SchedulerStatus;
		label: string;
		displayName: string | null;
		client: Client;
		grants: Asked<Grant[]>;
		onGrantsChanged: () => void;
	}
>) => {
	const [about, setAbout] = useState(false);
	const [details, setDetails] = useState(false);
	// Not while a first import holds the source: what it says is all there is
	// to say. Nor while nothing syncs it, when the line has nothing to open.
	const tappable = !importingHere(bound) && status.phase !== 'local';
	const items = storageItems({
		...actions,
		bound,
		phase: status.phase,
		download: downloadItem(offersDownload(downloadable, holds), downloading),
		about: unseenItem(bound.provider, label, () => {
			setAbout(true);
		}),
	});
	const said = lineStatus(status, label, isSyncable(bound));
	const count = syncCount(status.progress, label);
	// Who the account is, which the line has no room for, and the whole of
	// what it says about syncing, where that is more than its few words. Each
	// a sentence of its own, on a line of its own.
	const title = [
		displayName === null
			? t('account.title.syncing', { provider: label })
			: t('account.title.syncingAs', { provider: label, account: displayName }),
		said.title,
	]
		.filter((line) => line !== null)
		.join('\n');
	return (
		<>
			{about && (
				<UnseenDialog
					provider={bound.provider}
					onClose={() => {
						setAbout(false);
					}}
				/>
			)}
			{details && (
				<SyncDetails
					status={status}
					label={label}
					displayName={displayName}
					syncable={isSyncable(bound)}
					onPause={onPause}
					onResume={actions.syncNow}
					onClose={() => {
						setDetails(false);
					}}
				/>
			)}
			<StatusLine
				text={said.text}
				title={title}
				{...(tappable
					? {
							onDetails: () => {
								setDetails(true);
							},
						}
					: {})}
			>
				<Devices
					client={client}
					connectionId={bound.connectionId}
					grants={grants}
					onChanged={onGrantsChanged}
				/>
			</StatusLine>
			{count !== undefined && <SyncBar count={count} />}
			<ActionsMenu slot={slot} name={displayName ?? label} items={items} />
		</>
	);
};

/**
 * Where the disconnect has got to. Closed; sending what is left, which can take
 * as long as a provider takes; or asking, holding the list the question is
 * about and the record of it the answer will be held to.
 *
 * `onServer` rides along from the item that started it: the same question is
 * asked for a plain Disconnect and for "stop syncing on this device", and the
 * only difference is whether the server is told.
 */
type Step =
	| Readonly<{ kind: 'closed' }>
	| Readonly<{ kind: 'pushing'; onServer: boolean }>
	| Readonly<{ kind: 'asking'; onServer: boolean } & Awaited<ReturnType<typeof prepare>>>;

export const Connected = ({
	client,
	sync,
	bound,
	config,
	account,
	disconnects,
	onDisconnect,
	download,
	downloadAll,
	returnTo,
	navigate,
	slot,
}: ConnectedProps) => {
	const database = useDb();
	const [step, setStep] = useState<Step>({ kind: 'closed' });
	const [rescanning, setRescanning] = useState(false);
	const [trouble, setTrouble] = useState<string | null>(null);
	const status = useSyncStatus(sync);
	// Only ever this source's. Named once per render, so the choice below is
	// about the source the user was looking at when they made it.
	const connectionId = bound.connectionId;
	const holds = useLiveQuery(
		() => holdsAnything(database, connectionId),
		[database, connectionId]
	);
	const downloading = useDownloadAll(connectionId, downloadAll);
	// The other live sources, which what this one never sent could go to.
	const sources = useLiveQuery(() => connectedSources(database), [database]);
	const targets = otherLiveSources(sources, connectionId);
	// Here rather than in the list, because the question counts them too.
	const devices = useGrants(client, connectionId);
	const disconnecting = disconnects[connectionId];
	const busy = disconnecting?.busy === true;
	const problem = disconnecting?.problem ?? null;
	const stranded = disconnecting?.stranded === true;
	// Which question the answer coming back belongs to (`ask`).
	const asking = useRef(0);
	const open = step.kind !== 'closed';
	// The question gives the focus back as it closes, to the `⋯` it was asked
	// from (`Question`), rather than letting it fall to the page.
	const cancel = useCallback(() => {
		// A question nobody is waiting for the answer to: whatever the last push
		// is doing, it can go on doing.
		asking.current += 1;
		setStep({ kind: 'closed' });
	}, []);

	const label = providerLabel(bound);
	const displayName = accountName(answer(account), bound);

	const pushable = worthPushing(status);

	/**
	 * Ask the question. Only the newest one's answer is taken up: a user who
	 * cancels while the last push is out, and chooses Disconnect again, must not
	 * have the first list arrive on top of the second.
	 */
	const ask = (onServer: boolean) => {
		asking.current += 1;
		const mine = asking.current;
		setTrouble(null);
		setStep({ kind: 'pushing', onServer });
		// Again, for the question's sake: whether this is the last device decides
		// what it says, and a device may have joined since the panel opened.
		if (onServer) devices.ask();
		void prepare(database, connectionId, pushable ? () => sync.syncNow() : undefined)
			.then((ready) => {
				if (asking.current !== mine) return;
				setStep({ kind: 'asking', onServer, ...ready });
			})
			.catch(() => {
				if (asking.current !== mine) return;
				setStep({ kind: 'closed' });
				setTrouble(t('account.disconnect.unreadable'));
			});
	};

	const answered = (choice: UnsentAnswer) => {
		if (step.kind !== 'asking') return;
		const { seen, onServer } = step;
		// Closing the question is this instance's to do, and nothing if it has
		// gone; what came of the disconnect is the panel's, and is kept.
		void onDisconnect(connectionId, { unsent: choice, seen, onServer }).finally(() => {
			cancel();
		});
	};

	const downloadable = bound.importing === undefined && !open;
	// Not while the server is still being asked on open: its answer could bind
	// the device again right after. Nor while a disconnect of this source is
	// still out, which may have been started before the user looked at another
	// source and back.
	const disconnectBlocked = account.kind === 'asking' || busy;
	// Asked from this source's row before it was showing: done as its own
	// item here would do it, once it can be, and dropped where it would not
	// be offered.
	useAsked(slot, connectionId, (action) => {
		switch (action) {
			case 'download':
				return { offer: offersDownload(downloadable, holds), act: downloading.start };
			case 'rescan':
				return {
					offer: offersRescan(bound, status.phase),
					act: () => {
						setRescanning(true);
					},
				};
			case 'disconnect':
				return {
					offer: offersDisconnect(open, disconnectBlocked),
					act: () => {
						ask(true);
					},
				};
		}
	});

	return (
		<section className="account" aria-label={t('account.region')}>
			<SyncState
				client={client}
				sync={sync}
				bound={bound}
				label={label}
				reconnectable={answer(config)?.authMode === 'storage-first'}
				config={config}
				returnTo={returnTo}
				{...(navigate === undefined ? {} : { navigate })}
				rescanning={rescanning}
				onRescanning={setRescanning}
			/>
			{/*
			 * Not while an import is filling the source, when the archive would be
			 * whatever part of it had arrived; nor while the disconnect question
			 * is open, which offers its own download of what was never sent.
			 */}
			{downloadable && <DownloadAll holds={holds} downloading={downloading} />}
			{(problem ?? trouble) !== null && (
				<p className="muted" role="alert">
					{problem ?? trouble}
				</p>
			)}
			{step.kind === 'pushing' && (
				<Question
					key="pushing"
					className="account-confirm"
					label={t('account.disconnect.sending')}
					onClose={cancel}
				>
					<p className="muted">{t('account.disconnect.sendingNow')}</p>
					<QuestionActions />
				</Question>
			)}
			{step.kind === 'asking' && (
				<DisconnectDialog
					label={label}
					displayName={displayName}
					listed={step.listed}
					targets={targets}
					failing={step.failing}
					busy={busy}
					others={stillSignedIn(devices.grants)}
					onServer={step.onServer}
					leftAtProvider={<LeftAtProvider provider={bound.provider} />}
					stopped={stoppedBy(status, step.listed)}
					download={download}
					onAnswer={answered}
					onCancel={cancel}
				/>
			)}
			<ConnectedFoot
				slot={slot}
				bound={bound}
				status={status}
				label={label}
				displayName={displayName}
				rescanning={rescanning}
				onRescan={() => {
					setRescanning(true);
				}}
				downloadable={downloadable}
				holds={holds}
				downloading={downloading}
				stranded={stranded}
				open={open}
				disconnectBlocked={disconnectBlocked}
				syncNow={() => {
					void sync.syncNow();
				}}
				onPause={() => {
					sync.pause();
				}}
				ask={ask}
				client={client}
				grants={devices.grants}
				onGrantsChanged={devices.ask}
			/>
		</section>
	);
};
