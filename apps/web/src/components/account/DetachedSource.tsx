import { useLiveQuery } from 'dexie-react-hooks';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

import { t } from '../../i18n/t.js';
import {
	connectedSources,
	type MoveOutcome,
	moveUnsyncedTo,
	releaseConnection,
} from '../../store/connection.js';
import { useDb } from '../../store/database.js';
import { drawingRef, type SyncStateRecord } from '../../store/db.js';
import { holdsTextFor } from '../../store/detached.js';
import { downloadProblem, hasUnsentDownload } from '../../store/exportDrawings.js';
import { settleEditors } from '../../store/heldEdits.js';
import { titleShown } from '../../store/titles.js';
import { countOf, isEmpty, seenIn, type Unsynced, unsyncedIn } from '../../store/unsynced.js';
import { PROVIDER_LABELS, sourceName, UNKNOWN_LABEL } from '../../sync/account.js';
import { MoveUnsent, otherLiveSources } from './MoveUnsent.js';
import { Question, QuestionActions } from './Question.js';

/**
 * A source this device no longer reaches, which is still here because it holds
 * something its remote was never sent (`SyncStateRecord.detached`).
 *
 * The panel is where the user decides what becomes of that, and it offers the
 * four things that can: connect the account again, which sends it; move it into
 * another connected source; download it; or discard it. Nothing here happens on
 * its own, and the move is a separate, explicit act that names the account it
 * is going to, since it is the one thing here that crosses between two people's
 * storage (docs/ARCHITECTURE.md §10).
 *
 * Discarding takes two steps, and the second one names what goes. These drawings
 * are the only copies there are, so "Discard…" is not the button that does it:
 * it shows the titles, says that this cannot be undone, puts the focus on
 * Cancel, and keeps a download within reach. What the user was shown is exactly
 * what is discarded (`releaseConnection`'s `seen`): a drawing another tab wrote
 * meanwhile was not in the list, and stays, and so does text written since into
 * a drawing that was.
 */

interface DetachedSourceProps {
	readonly bound: SyncStateRecord;
	/** Start connecting this source's account again, where the server lets the user. */
	readonly reconnect: ReactNode;
	/** Hand the drawings to the user as a file. Injected: jsdom cannot make a blob URL. */
	readonly download: (listed: Unsynced) => Promise<void>;
	/**
	 * The source has gone, and this panel with it. Called for the focus, which
	 * was on a button that no longer exists: the caller puts it somewhere that
	 * still does.
	 */
	readonly onReleased?: () => void;
	/** Something the caller has to say about how the source came to be here. */
	readonly notice?: string | null;
}

/**
 * What is going besides the drawings listed by title, or nothing to add: "1
 * rename, 2 deletes", each count a whole phrase of the catalog's, listed as
 * the files that could not be read are (`account.paths.separator`).
 */
const alsoGoing = (unsynced: Unsynced): string | null => {
	const parts = [
		...(unsynced.renames.length > 0
			? [t('unsent.counted.renames', { count: unsynced.renames.length })]
			: []),
		...(unsynced.deletes.length > 0
			? [t('unsent.counted.deletes', { count: unsynced.deletes.length })]
			: []),
		...(unsynced.folders.length > 0
			? [t('unsent.counted.folders', { count: unsynced.folders.length })]
			: []),
		...(unsynced.rmdirs.length > 0
			? [t('unsent.counted.folderDeletes', { count: unsynced.rmdirs.length })]
			: []),
		...(unsynced.files.length > 0
			? [t('unsent.counted.filesNotUploaded', { count: unsynced.files.length })]
			: []),
	];
	return parts.length === 0
		? null
		: t('unsent.detached.alsoGoing', { list: parts.join(t('account.paths.separator')) });
};

/**
 * A delete the source still owes is carried out on reconnecting, however long
 * that takes and whatever has been done to the file meanwhile: the delete wins
 * (docs/ARCHITECTURE.md §7). Over weeks rather than seconds that is worth saying
 * plainly, with the way to withdraw it, which is Discard.
 */
const stillOwed = (unsynced: Unsynced, bound: SyncStateRecord): string | null => {
	const count = unsynced.deletes.length;
	if (count === 0) return null;
	return bound.provider === undefined
		? t('unsent.detached.stillOwedUnknown', { count })
		: t('unsent.detached.stillOwed', { count, provider: PROVIDER_LABELS[bound.provider] });
};

/**
 * A save the store would not take, found at the last moment: the drawing and the
 * source around it are kept rather than removed with the rest, so the text has
 * somewhere to land when it can be written.
 */
const heldBack = (): string => t('unsent.detached.heldBack');

/**
 * What is left to say of a move, where what happened was not quite what was
 * asked for. None of them lost anything, so none is said as a failure.
 */
const wentAs = (outcome: MoveOutcome): string | null => {
	switch (outcome) {
		case 'detached':
			return t('unsent.detached.movedAs.kept');
		case 'holding':
			return heldBack();
		case 'reconnected':
			return t('unsent.detached.movedAs.reconnected');
		case 'no-target':
			return t('unsent.detached.movedAs.noTarget');
		case 'unverified':
			return t('unsent.detached.movedAs.unverified');
		case 'nothing-to-move':
			return t('unsent.detached.movedAs.nothing');
		case 'released':
			return null;
	}
};

/**
 * What the second step asks. A source can be left holding nothing — the one
 * unsent drawing deleted since — and then there is nothing to lose and the
 * question is only whether to take it off the list. A single drawing is "this
 * drawing", which is not a count, and so its own message rather than a plural's
 * `one`: in some languages that is 21 as well.
 */
const question = (unsynced: Unsynced): string => {
	if (isEmpty(unsynced)) return t('unsent.detached.remove');
	if (unsynced.drawings.length === 0) return t('unsent.discard.unsentOnly');
	return unsynced.drawings.length === 1
		? t('unsent.detached.discardDrawing')
		: t('unsent.detached.discardDrawings', { count: unsynced.drawings.length });
};

/**
 * The second step of a discard: what goes, by name, and that it goes for good.
 * The list is the one the user was shown, held still while they read it — not
 * the live one, which is what the answer is then held to (`seenIn`).
 */
const DiscardConfirm = ({
	listed,
	busy,
	download,
	onDiscard,
	onCancel,
}: Readonly<{
	listed: Unsynced;
	busy: boolean;
	download: (listed: Unsynced) => void;
	onDiscard: () => void;
	onCancel: () => void;
}>) => (
	<Question
		className="account-confirm"
		label={t('unsent.discard.forGood')}
		onClose={onCancel}
		busy={busy}
	>
		<p className="muted">{question(listed)}</p>
		{listed.drawings.length > 0 && (
			<ul aria-label={t('unsent.detached.toDiscard')}>
				{listed.drawings.map((drawing) => (
					<li key={drawingRef(drawing)}>{titleShown(drawing.title)}</li>
				))}
			</ul>
		)}
		{alsoGoing(listed) !== null && <p className="muted">{alsoGoing(listed)}</p>}
		{!isEmpty(listed) && <p>{t('unsent.detached.nowhereElse')}</p>}
		<QuestionActions
			primary={
				<button type="button" className="danger" disabled={busy} onClick={onDiscard}>
					{isEmpty(listed)
						? t('unsent.detached.removeButton')
						: t('unsent.discard.forGood')}
				</button>
			}
		>
			<button
				type="button"
				disabled={busy || !hasUnsentDownload(listed)}
				onClick={() => {
					download(listed);
				}}
			>
				{t('unsent.discard.downloadFirst')}
			</button>
		</QuestionActions>
	</Question>
);

export const DetachedSource = ({
	bound,
	reconnect,
	download,
	onReleased,
	notice = null,
}: DetachedSourceProps) => {
	const database = useDb();
	const connectionId = bound.connectionId;
	const unsynced = useLiveQuery(
		() => unsyncedIn(database, connectionId),
		[database, connectionId]
	);
	// Where what is here could go instead of waiting for an account that may
	// never come back. Live sources only: a detached one cannot send it either.
	const others = useLiveQuery(() => connectedSources(database), [database]);
	const targets = otherLiveSources(others, connectionId);
	/** The list the user is being asked about, as it stood when they asked. */
	const [listed, setListed] = useState<Unsynced | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);

	// The question takes the focus as every question does (`Question`), as
	// in the disconnect confirm; closed, it goes back to Discard, which is
	// drawn again in its place and so is not the button that opened it.
	const focusBack = useRef(false);
	const openButton = useRef<HTMLButtonElement>(null);
	const panel = useRef<HTMLElement>(null);
	const confirming = listed !== null;
	useEffect(() => {
		// Only focus that is still here to move: a user who went back to a drawing
		// while the editors were being settled keeps typing into the drawing.
		const focused = document.activeElement;
		const here =
			focused === null ||
			focused === document.body ||
			panel.current?.contains(focused) === true;
		if (focusBack.current && here) openButton.current?.focus();
		focusBack.current = false;
	}, [confirming]);

	const name = sourceName(bound) ?? UNKNOWN_LABEL;
	const held = unsynced === undefined ? undefined : countOf(unsynced);

	// A download that fails says so here, in the panel's own alert: one that
	// silently does nothing is a user who goes on to discard, thinking they
	// have a copy.
	const save = (shown: Unsynced) => {
		setProblem(null);
		void download(shown).catch((error: unknown) => {
			setProblem(downloadProblem(error));
		});
	};

	const ask = () => {
		setBusy(true);
		setProblem(null);
		// The editors write first: a sentence still inside the autosave window is
		// in no row, and a list made without it would leave out the very thing
		// the user is about to be told is going for good.
		void settleEditors()
			.then(async (settled) => {
				// This source's drawings only: a save failing in some other source is
				// that source's problem, and no reason to hold this one up.
				if (holdsTextFor(settled, connectionId)) {
					setProblem(t('unsent.cannotList'));
					return;
				}
				setListed(await unsyncedIn(database, connectionId));
			})
			.catch(() => {
				setProblem(t('unsent.detached.notDiscarded'));
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const close = useCallback(() => {
		focusBack.current = true;
		setListed(null);
	}, []);

	/**
	 * Into another account, which is the one thing here that is not about this
	 * source alone. The list is the one the user was just shown, and the editors
	 * write once more first: a sentence typed while they were reading it is in
	 * no row, and a drawing that has changed since is kept rather than carried into
	 * a stranger's storage under a description that no longer fits it.
	 */
	const move = (shown: Unsynced, target: string) => {
		setBusy(true);
		setProblem(null);
		void settleEditors()
			.then(async (settled) => {
				if (holdsTextFor(settled, connectionId)) {
					setProblem(t('unsent.detached.cannotMove'));
					return;
				}
				const outcome = await moveUnsyncedTo(database, {
					connectionId,
					target,
					seen: seenIn(shown),
					holding: new Set(settled.failing),
				});
				if (outcome === 'released') onReleased?.();
				setProblem(wentAs(outcome));
			})
			.catch(() => {
				setProblem(t('unsent.detached.notMoved'));
			})
			.finally(() => {
				setBusy(false);
			});
	};

	const discard = (shown: Unsynced) => {
		setBusy(true);
		setProblem(null);
		// The editors write once more first: a sentence typed into a listed drawing
		// while the list was open is in no row, and would go with the row. In a
		// row, it makes the drawing one the list did not stand for, and it is kept.
		// What they still cannot write is named, and kept for the same reason.
		void settleEditors()
			.then((settled) =>
				releaseConnection(database, {
					connectionId,
					unsynced: 'discard',
					seen: seenIn(shown),
					holding: new Set(settled.failing),
				})
			)
			.then((outcome) => {
				if (outcome === 'detached') setProblem(t('unsent.detached.discardedAs.kept'));
				if (outcome === 'holding') setProblem(heldBack());
				if (outcome === 'reconnected') {
					setProblem(t('unsent.detached.discardedAs.reconnected'));
				}
				if (outcome === 'released') onReleased?.();
			})
			.catch(() => {
				setProblem(t('unsent.detached.notDiscarded'));
			})
			.finally(() => {
				setBusy(false);
				close();
			});
	};

	return (
		<section ref={panel} className="account" aria-label={t('unsent.detached.panel')}>
			<p>{t('unsent.detached.title', { source: name })}</p>
			{held !== undefined && (
				<p className="muted">
					{held === 0
						? t('unsent.detached.nothingWaiting')
						: t('unsent.detached.waiting', { count: held })}{' '}
					{t('unsent.detached.restRemoved')}
				</p>
			)}
			{unsynced !== undefined && stillOwed(unsynced, bound) !== null && (
				<p className="muted">{stillOwed(unsynced, bound)}</p>
			)}
			{bound.provider === undefined && (
				<p className="muted">{t('unsent.detached.unknownAccount')}</p>
			)}
			{(problem ?? notice) !== null && (
				<p className="muted" role="alert">
					{problem ?? notice}
				</p>
			)}
			{reconnect}
			{listed === null && unsynced !== undefined && !isEmpty(unsynced) && (
				<MoveUnsent
					listed={unsynced}
					from={name}
					targets={targets}
					busy={busy}
					disabled={false}
					// The list the second step was about, not whatever the live query
					// has made of it since: what the user was shown is what the move
					// is held to (`seenIn`).
					onMove={(target, shown) => {
						move(shown, target);
					}}
				/>
			)}
			<button
				type="button"
				disabled={unsynced === undefined || !hasUnsentDownload(unsynced)}
				onClick={() => {
					if (unsynced !== undefined) save(unsynced);
				}}
			>
				{t('unsent.detached.download')}
			</button>
			{listed === null ? (
				<button
					ref={openButton}
					type="button"
					className="ghost"
					disabled={busy}
					onClick={ask}
				>
					{t('unsent.detached.discard')}
				</button>
			) : (
				<DiscardConfirm
					listed={listed}
					busy={busy}
					download={save}
					onDiscard={() => {
						discard(listed);
					}}
					onCancel={close}
				/>
			)}
		</section>
	);
};
