import { answer, api, type Asked, useInstanceConfig } from '@skysa/client';
import { useRouterState } from '@tanstack/react-router';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react';

import { useDb } from '../../store/database.js';
import { activeConnectionId, type SyncStateRecord } from '../../store/db.js';
import { downloadLibrary, downloadUnsent, type Library } from '../../store/exportDrawings.js';
import { type Keeping, keeping as browserKeeping } from '../../store/keeping.js';
import { isLiveSource } from '../../store/rowStates.js';
import type { Unsynced } from '../../store/unsynced.js';
import { type AccountState, claimConnection } from '../../sync/account.js';
import { syncScheduler } from '../../sync/runtime.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import type { Client, Sync } from './clients.js';
import { Connected } from './Connected.js';
import { Detached } from './Detached.js';
import { NotConnected } from './NotConnected.js';
import { useDisconnects } from './useDisconnects.js';

/**
 * Where storage is connected, switched between and let go of: the source in
 * front, the devices holding it, and — for a source being let go — what
 * becomes of the work its remote was never sent (docs/ARCHITECTURE.md §6).
 *
 * Two halves. `AccountProvider` is what has to go on whether or not the panel
 * is on screen, and the frame keeps it mounted under everything: the library,
 * and the panel in it, comes and goes — a drawer from the editor's top bar, a
 * screen before the drawing on a phone — and the way back from the provider's
 * consent page is a full navigation that may land on an open drawing, with no
 * library in sight, where the credential it brought back still has to be
 * taken up. `AccountPanel` is the panel itself, which reads it.
 *
 * What the device is bound to is read from the store, so the panel is right
 * offline and the moment a bind lands. What the server says is asked as the
 * app opens — which includes the return from the provider — and again
 * whenever another tab binds the device to a connection this tab has not been
 * told about.
 *
 * How syncing is going comes from the scheduler (the kit's, `@skysa/client`), which
 * runs on its own; the panel only reports it and offers "Sync now".
 */

interface AccountContextValue {
	readonly client: Client;
	/** Wrapped: the store's "no connection" and the live query's "not read yet" are both `undefined`. */
	readonly bound: Readonly<{ state: SyncStateRecord | undefined }> | undefined;
	readonly account: Asked<AccountState>;
	readonly disconnects: ReturnType<typeof useDisconnects>['disconnects'];
	readonly disconnect: ReturnType<typeof useDisconnects>['disconnect'];
}

const AccountContext = createContext<AccountContextValue | undefined>(undefined);

/** Back to exactly here, minus the outcome of any connect before this one. */
export const returnPath = (href: string): string => {
	const url = new URL(href, 'http://app.invalid');
	url.searchParams.delete('connect');
	url.searchParams.delete('code');
	return url.pathname + url.search;
};

export const AccountProvider = ({
	client = api,
	children,
}: Readonly<{ client?: Client; children: ReactNode }>) => {
	const database = useDb();
	// The source the app is showing, not whichever `syncState` row IndexedDB
	// hands back first: a device may hold several connected sources at once
	// (docs/ARCHITECTURE.md §6). The live query reads `prefs` as well as
	// `syncState`, so a switch in another tab re-renders this one.
	const bound = useLiveQuery(
		async () => ({ state: await database.syncState.get(await activeConnectionId(database)) }),
		[database]
	);
	const [account, setAccount] = useState<Asked<AccountState>>({ kind: 'asking' });
	const { disconnects, disconnect } = useDisconnects(client);

	// What the server is asked about: on open, and again whenever the binding
	// has moved to a connection the answer in hand does not name — another tab
	// connecting an account binds this device too. Never because of an answer
	// alone, so a server that cannot be reached is not asked in a loop, and
	// never while a question is out: a change that lands meanwhile is weighed
	// once the answer is in, against the binding the question was about.
	const boundId = bound === undefined ? null : (bound.state?.connectionId ?? '');
	const answered = answer(account);
	const named = answered?.kind === 'connected' ? answered.connection.id : undefined;
	const asking = useRef(false);
	const askedAbout = useRef<string | null>(null);
	useEffect(() => {
		if (boundId === null || asking.current) return;
		const before = askedAbout.current;
		if (before === boundId) return;
		askedAbout.current = boundId;
		// Gone, or bound by the provider's own answer: nothing to ask.
		if (before !== null && (boundId === '' || named === boundId)) return;
		asking.current = true;
		const settle = (next: Asked<AccountState>) => {
			// Before the state changes, so the render it causes can ask again.
			asking.current = false;
			setAccount(next);
		};
		// `claimConnection`, not `reconcileAccount`: this also runs on the
		// return from the consent page, which is a full navigation back into the
		// app, and that is where a pending credential has to be taken up. With no
		// pending credential it reconciles, so there is no URL to read and a
		// reload in the middle of a flow lands in the same place.
		void claimConnection(database, client)
			.then((value) => {
				settle({ kind: 'answered', value });
			})
			.catch(() => {
				settle({ kind: 'unreachable' });
			});
	}, [boundId, named, account, client, database]);

	return (
		<AccountContext.Provider value={{ client, bound, account, disconnects, disconnect }}>
			{children}
		</AccountContext.Provider>
	);
};

const useAccount = (): AccountContextValue => {
	const value = useContext(AccountContext);
	if (value === undefined) throw new Error('An AccountPanel is drawn inside an AccountProvider.');
	return value;
};

interface AccountPanelProps {
	sync?: Sync;
	/**
	 * How to leave for the provider's consent page. Injected like the rest, and
	 * for the same reason: jsdom has no navigation, so a test that could not
	 * supply this could only ever prove the button renders.
	 */
	navigate?: (url: string) => void;
	/**
	 * How what a source never sent is handed to the user as a file, once its
	 * files' bytes are read (`downloadUnsent`). Injected for the same reason:
	 * jsdom cannot make a blob URL, so the real one cannot run in a test.
	 */
	download?: (library: Library) => void;
	/** How a whole source is handed to the user as a file, for the same reason. */
	downloadAll?: (library: Library) => void;
	/**
	 * Whether the browser keeps this device's drawings. Injected for the same
	 * reason again: jsdom has no `navigator.storage`.
	 */
	keeping?: Keeping;
	/**
	 * What the sources above hand the panel: where its actions go as the showing
	 * source's `⋯`, with what another source's `⋯` asked of this one once it is
	 * showing (`SourcePanel`). A connected source's panel is then one line —
	 * how its syncing is going — with only what needs the user said above it,
	 * while it does.
	 */
	slot?: AccountSlot;
}

export const AccountPanel = ({
	sync = syncScheduler,
	navigate,
	download = downloadLibrary,
	downloadAll = downloadLibrary,
	keeping = browserKeeping,
	slot,
}: AccountPanelProps) => {
	const database = useDb();
	const { client, bound, account, disconnects, disconnect } = useAccount();
	const href = useRouterState({ select: (state) => state.location.href });
	// The one request per client the sources above share (`useInstanceConfig`).
	const config = useInstanceConfig(client);
	// What a source never sent, with the files whose bytes are here. A file it
	// leaves out is the remote's, which still has it, so nothing is said of it.
	const downloadListed = (listed: Unsynced): Promise<void> =>
		downloadUnsent(database, listed, download);

	// A discard takes its source, and its panel, with it: the button the user
	// pressed is gone and the focus would fall to the page. It goes to the next
	// panel instead, once that has rendered — to whatever that panel offers
	// first, and failing that to the panel itself, which takes `tabIndex={-1}`
	// so there is somewhere to land that says where the user is. Not the `+`
	// above: the panel does not own it, and a component reaching across the
	// screen for someone else's button is how focus ends up fought over.
	const frame = useRef<HTMLDivElement>(null);
	const landing = useRef(false);
	const showing = bound?.state?.connectionId ?? null;
	useEffect(() => {
		if (!landing.current) return;
		landing.current = false;
		const next = frame.current?.querySelector<HTMLElement>('button') ?? frame.current;
		next?.focus();
	}, [showing]);
	const released = () => {
		landing.current = true;
	};

	if (bound === undefined) return null;
	const returnTo = returnPath(href);
	const leave = navigate === undefined ? {} : { navigate };
	const shown = slot === undefined ? {} : { slot };

	const panel = () => {
		if (bound.state === undefined) {
			return (
				<NotConnected config={config} downloadAll={downloadAll} keep={keeping} {...shown} />
			);
		}

		if (!isLiveSource(bound.state)) {
			return (
				<Detached
					key={bound.state.connectionId}
					client={client}
					config={config}
					bound={bound.state}
					download={downloadListed}
					onReleased={released}
					notice={disconnects[bound.state.connectionId]?.problem ?? null}
					returnTo={returnTo}
					{...leave}
					{...shown}
				/>
			);
		}

		return (
			// Keyed by source. Everything under here holds state about one source — a
			// confirm half way through, a re-scan being asked about, a list of devices
			// — and unkeyed it survives showing another source and is rendered, and
			// acted on, under the other one's name. What has to outlive the switch is
			// handed down instead, by the source it names.
			<Connected
				key={bound.state.connectionId}
				disconnects={disconnects}
				onDisconnect={disconnect}
				download={downloadListed}
				downloadAll={downloadAll}
				client={client}
				sync={sync}
				bound={bound.state}
				account={account}
				config={config}
				returnTo={returnTo}
				{...leave}
				{...shown}
			/>
		);
	};
	// `tabIndex={-1}`: reachable by script, so a discard has somewhere to put
	// the focus, and never in the tab order, where an empty wrapper would be a
	// stop that does nothing.
	return (
		<div ref={frame} className="account-frame" tabIndex={-1}>
			{panel()}
		</div>
	);
};
