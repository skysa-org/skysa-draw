import { api, type ApiClient, type SyncScheduler } from '@skysa/client';
import { useLiveQuery } from 'dexie-react-hooks';
import {
	type ReactNode,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';

import { t } from '../../i18n/t.js';
import { type ConnectedSource, LABEL_LIMIT, showConnection } from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { holdsAnything } from '../../store/exportDrawings.js';
import { isLiveSource } from '../../store/rowStates.js';
import { CONNECTABLE, tabName } from '../../sync/account.js';
import { useNeedsReconnect } from '../../sync/runtime.js';
import { IconButton } from '../ui/IconButton.js';
import { AddIcon, MoreIcon } from '../ui/icons.js';
import { Menu, type MenuItem } from '../ui/Menu.js';
import { AddSource } from './AddSource.js';
import { ProviderIcon, sourceKind } from './ProviderIcon.js';
import { ShownSourceName, sourceLabel, storeSourceName } from './SourceName.js';
import { useSourceChoices } from './useSourceChoices.js';

/**
 * A choice made from the `⋯` of a source that is not the one showing. The
 * account panel acts only on the source showing — the scheduler syncs only
 * that one, and its questions are asked in its panel — so the choice shows the
 * source first, and its panel carries this out once it is there
 * (`account/useAsked.ts`). Sync now needs no asking: showing a source syncs
 * it.
 */
export interface SourceAsk {
	readonly connectionId: string;
	readonly action: 'rescan' | 'download' | 'disconnect';
}

/** What the source panel hands the account panel under it. */
export interface AccountSlot {
	/** Rename the showing source, where it can be: its row becomes the field. */
	readonly onRename?: () => void;
	/**
	 * Where the showing source's `⋯` goes: the end of its row, as every other
	 * source's is (`ActionsMenu` in `account/PanelMenus.tsx`). Null until the
	 * row is drawn.
	 */
	readonly menuIn: HTMLElement | null;
	/** What the showing source's row calls it, for its `⋯`. */
	readonly name: string;
	readonly asked: SourceAsk | null;
	/** The ask has been carried out, or cannot be. */
	readonly onAsked: () => void;
}

interface SourcePanelProps {
	readonly client?: Pick<ApiClient, 'config' | 'startConnect' | 'checkConnectCode'>;
	/** Whether the showing source needs connecting again, which its mark shows. */
	readonly sync?: Pick<SyncScheduler, 'status' | 'subscribe'>;
	/** Where the provider's callback should send the browser back to. */
	readonly returnTo: string;
	/** Seam for tests: jsdom has no navigation. */
	readonly navigate?: (url: string) => void;
	/** The account panel — what the showing source is syncing with — under the sources. */
	readonly account?: (slot: AccountSlot) => ReactNode;
	/** How many times the app's URL has asked for the code field (`useEnterCode`). */
	readonly enterCode?: number;
}

/**
 * A source's row while it is renamed: the field in its place, with the mark
 * beside it as the row has. Enter or leaving the field keeps what was typed,
 * and Escape the name it had; either way the row comes back.
 */
const RenameField = ({
	name,
	mark,
	onDone,
}: Readonly<{
	name: string;
	mark: ReactNode;
	/** What was typed, or `undefined` where the user went back on it. */
	onDone: (chosen: string | undefined) => void;
}>) => {
	const [typed, setTyped] = useState(name);
	const field = useRef<HTMLInputElement>(null);
	// Once: a second answer, from the blur that follows Enter taking the row
	// away, is not an answer.
	const done = useRef(false);
	const finish = (chosen: string | undefined) => {
		if (done.current) return;
		done.current = true;
		onDone(chosen);
	};
	useEffect(() => {
		field.current?.select();
	}, []);
	const submit = (event: SyntheticEvent) => {
		event.preventDefault();
		finish(typed);
	};
	return (
		<form className="source-row source-rename" onSubmit={submit}>
			{mark}
			<label className="source-rename-label">
				<span className="visually-hidden">{t('sources.name')}</span>
				<input
					ref={field}
					value={typed}
					maxLength={LABEL_LIMIT}
					onChange={(event) => {
						setTyped(event.target.value);
					}}
					onKeyDown={(event) => {
						if (event.key !== 'Escape') return;
						event.preventDefault();
						finish(undefined);
					}}
					onBlur={() => {
						finish(typed);
					}}
				/>
			</label>
		</form>
	);
};

/**
 * The sources, at the top of the library on every size of window: a row for
 * this device's drawings and one for each account connected, with the one
 * showing marked as the folder open is (`aria-current`), and the `+` that
 * connects another (`AddSource`), there even with nothing to offer, disabled,
 * so the header keeps its shape.
 *
 * Each source's row ends in a `⋯` for what can be done to it, as each layer's
 * does in the editor: the showing source's is the account panel's own, drawn
 * into the row (`AccountSlot.menuIn`); another's shows that source and then
 * does what was chosen (`SourceAsk`). A source is renamed from its `⋯`, its
 * row becoming the field: a row is a place to go, and a second press on it is
 * not a way to rename it.
 */
export const SourcePanel = ({
	client = api,
	sync,
	returnTo,
	navigate,
	account,
	enterCode,
}: SourcePanelProps) => {
	const db = useDb();
	const choices = useSourceChoices(client);
	const { ordered } = choices;
	const reconnect = useNeedsReconnect(sync);
	// State rather than a ref: the account panel draws its menu into this, and
	// has to be drawn again once it is there.
	const [actions, setActions] = useState<HTMLSpanElement | null>(null);
	const [asked, setAsked] = useState<SourceAsk | null>(null);
	const onAsked = useCallback(() => {
		setAsked(null);
	}, []);
	const ids = ordered.map((source) => source.connectionId);
	// Which sources hold anything, so another's `⋯` offers a download only
	// where there is something to download, as the showing one's does.
	const holding = useLiveQuery(async () => {
		const holds = await Promise.all(ids.map((id) => holdsAnything(db, id)));
		return new Set(ids.filter((_, index) => holds[index] === true));
	}, [db, ids.join(' ')]);
	const showing = ordered.find((source) => source.active);
	const showingId = showing?.connectionId;
	// An ask still waiting is let go once another source is shown: it was for
	// the one the user went to, not for whenever that one is next shown. Here
	// as the render sees the change, as React has state follow a prop.
	const [shownWas, setShownWas] = useState(showingId);
	if (shownWas !== showingId) {
		setShownWas(showingId);
		if (asked !== null && asked.connectionId !== showingId) setAsked(null);
	}
	/** The source whose name is being typed, if one is. */
	const [renaming, setRenaming] = useState<string | null>(null);
	const list = useRef<HTMLUListElement>(null);
	// The row a rename ends on, once it is drawn again in the field's place:
	// the focus was in the field, which has gone.
	const backTo = useRef<string | null>(null);
	useEffect(() => {
		const id = backTo.current;
		if (renaming !== null || id === null) return;
		backTo.current = null;
		const rows = [...(list.current?.querySelectorAll<HTMLElement>('[data-source]') ?? [])];
		rows.find((each) => each.dataset.source === id)?.focus();
	}, [renaming]);

	const renamed = (connectionId: string, was: string, chosen: string | undefined) => {
		backTo.current = connectionId;
		setRenaming(null);
		storeSourceName(db, connectionId, was, chosen);
	};
	/** Every source but this device's has a name of the user's to give it. */
	const renameItem = (source: ConnectedSource): MenuItem[] =>
		source.connectionId === LOCAL_CONNECTION_ID
			? []
			: [
					{
						id: 'rename',
						label: t('sources.options.rename'),
						onSelect: () => {
							setRenaming(source.connectionId);
						},
					},
				];

	/** Another source's `⋯`: what its panel would offer once it is showing. */
	const itemsFor = (source: ConnectedSource): MenuItem[] => {
		if (!isLiveSource(source)) return renameItem(source);
		const show = (action?: SourceAsk['action']) => () => {
			setAsked(action === undefined ? null : { connectionId: source.connectionId, action });
			void showConnection(db, source.connectionId);
		};
		const download =
			holding?.has(source.connectionId) === true
				? [
						{
							id: 'download',
							label: t('sources.options.download'),
							onSelect: show('download'),
						},
					]
				: [];
		const syncable = source.provider !== undefined && CONNECTABLE.includes(source.provider);
		if (source.connectionId === LOCAL_CONNECTION_ID) return download;
		return [
			...renameItem(source),
			...(syncable
				? [
						{ id: 'sync', label: t('sources.options.sync'), onSelect: show() },
						{
							id: 'rescan',
							label: t('sources.options.rescan'),
							onSelect: show('rescan'),
						},
					]
				: []),
			...download,
			{
				id: 'disconnect',
				label: t('sources.options.disconnect'),
				onSelect: show('disconnect'),
				danger: true,
			},
		];
	};

	const row = (source: ConnectedSource) => {
		const name = tabName(source, ordered);
		const alert = source.active && reconnect;
		const mark = <ProviderIcon kind={sourceKind(source)} alert={alert} />;
		if (renaming === source.connectionId) {
			return (
				<RenameField
					name={name}
					mark={mark}
					onDone={(chosen) => {
						renamed(source.connectionId, name, chosen);
					}}
				/>
			);
		}
		const options = itemsFor(source);
		const menuLabel = t('account.menu.sourceLabel', { name });
		return (
			<>
				<button
					type="button"
					className="source-row"
					data-source={source.connectionId}
					aria-label={sourceLabel(source, name, alert)}
					{...(alert ? { title: sourceLabel(source, name, alert) } : {})}
					{...(source.active ? { 'aria-current': 'true' as const } : {})}
					onClick={() => {
						if (!source.active) void showConnection(db, source.connectionId);
					}}
				>
					{mark}
					<span className="source-row-name">
						<ShownSourceName source={source} name={name} />
					</span>
				</button>
				{source.active ? (
					<span className="source-row-options" ref={setActions} />
				) : (
					<span className="source-row-options">
						{options.length === 0 ? (
							<IconButton
								icon={<MoreIcon />}
								label={menuLabel}
								onClick={() => undefined}
								disabled
							/>
						) : (
							<Menu
								label={menuLabel}
								icon={<MoreIcon />}
								items={options}
								align="end"
							/>
						)}
					</span>
				)}
			</>
		);
	};

	return (
		<section className="source-panel" aria-label={t('sources.title')}>
			<div className="source-panel-header">
				<h2 className="source-panel-title">{t('sources.title')}</h2>
				<AddSource
					choices={choices}
					enterCode={enterCode}
					client={client}
					returnTo={returnTo}
					navigate={navigate}
					button={({ adding, toggle, first, offering, label }) =>
						first ? (
							<button
								type="button"
								className="source-add-first"
								aria-expanded={adding}
								disabled={!offering}
								onClick={toggle}
							>
								<AddIcon />
								<span>{label}</span>
							</button>
						) : (
							<IconButton
								icon={<AddIcon />}
								label={label}
								onClick={toggle}
								expanded={adding}
								disabled={!offering}
							/>
						)
					}
				/>
			</div>
			{ordered.length > 0 && (
				<ul ref={list} className="source-list">
					{ordered.map((source) => (
						<li key={source.connectionId} className="source-item">
							{row(source)}
						</li>
					))}
				</ul>
			)}
			<div className="source-panel-foot">
				{account?.({
					...(showing === undefined || showing.connectionId === LOCAL_CONNECTION_ID
						? {}
						: {
								onRename: () => {
									setRenaming(showing.connectionId);
								},
							}),
					menuIn: actions,
					name: showing === undefined ? '' : tabName(showing, ordered),
					asked,
					onAsked,
				})}
			</div>
		</section>
	);
};
