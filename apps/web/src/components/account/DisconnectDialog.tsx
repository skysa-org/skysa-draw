import { type ReactNode, useState } from 'react';

import { t } from '../../i18n/t.js';
import type { ConnectedSource } from '../../store/connection.js';
import { type DrawingRecord, drawingRef } from '../../store/db.js';
import { downloadProblem, hasUnsentDownload } from '../../store/exportDrawings.js';
import { titleShown } from '../../store/titles.js';
import { countedFolders, countOf, isEmpty, type Unsynced } from '../../store/unsynced.js';
import type { UnsentAnswer } from '../../sync/account.js';
import { canMove, leftBehind, MoveUnsent } from './MoveUnsent.js';
import { Question, QuestionActions } from './Question.js';

/**
 * What the user is asked before a source is disconnected.
 *
 * The rule it exists for: they are asked **before** anything happens, not told
 * afterwards (docs/ARCHITECTURE.md §10). Nothing is sent to the server until this has
 * an answer, so cancelling has changed nothing anywhere — and the answer is
 * about a list they were actually shown, which is the only thing a discard may
 * reach (`releaseConnection`'s `seen`).
 *
 * With nothing unsent there is nothing to decide and it is the plain confirm it
 * always was. With something unsent the choice is the owner's four: move it to
 * another connected source, download it, discard it by name, or cancel — and on
 * an only source, the last three. Asked as every question is (`Question`):
 * Cancel first and the answer last, and the answer has the focus, in every
 * step — Disconnect, or Discard for good, each drawn as what it is. Where
 * there is more than one thing to do and none of them is the answer, Cancel
 * has it, or the first account to move them to where there is a choice.
 *
 * Moving is not offered at all where it would be a promise this cannot keep —
 * nowhere to move to, nothing of the kind a move takes, or a source whose files
 * have not been checked against its remote yet, where everything it holds is
 * listed (`canMove`). The last of those is also the one case where the headline
 * is about why the list looks the way it does rather than about what is on it.
 */

/** How many drawings are named before the rest go behind a disclosure. */
const NAMED = 5;

interface DisconnectDialogProps {
	/** The provider, as the user knows it. */
	readonly label: string;
	/** The account's name, where the server has said one. */
	readonly displayName: string | null;
	/** What the source holds that its remote has not been sent, as it stood. */
	readonly listed: Unsynced;
	/** The other live sources, which its unsent work could go to instead. */
	readonly targets: readonly ConnectedSource[];
	/**
	 * A save of this source's that the store would not take. Nothing may be
	 * moved or discarded while that is true: the rows are not the whole of what
	 * the user wrote, so the list is not the whole of what would go.
	 */
	readonly failing: boolean;
	/** Why nothing here can be sent right now, where something is in the way. */
	readonly stopped: 'offline' | 'blocked' | null;
	readonly busy: boolean;
	/**
	 * How many other devices are signed in to the account and stay so, or
	 * `undefined` where the server has not said. Disconnecting signs this
	 * device out and no other, and the last one out disconnects the account.
	 * Not asked for at all with `onServer: false`, which tells the server
	 * nothing.
	 */
	readonly others: number | undefined;
	/** Whether the server is asked, rather than this device stopping alone. */
	readonly onServer: boolean;
	/**
	 * Where the provider leaves the app's access behind, where it does. Said
	 * only where the account may be about to go: with other devices still in
	 * it, the app's access is meant to stay.
	 */
	readonly leftAtProvider: ReactNode;
	readonly download: (listed: Unsynced) => Promise<void>;
	readonly onAnswer: (answer: UnsentAnswer) => void;
	readonly onCancel: () => void;
}

/**
 * "3 drawings not yet sent · 1 rename · 2 deletes", in the order they matter. The
 * folders by the same rule the headline counts by (`countedFolders`), so the
 * two cannot disagree — a breakdown adding up to more than the number above it
 * is the user being told they are about to lose something they are not.
 */
const summary = (listed: Unsynced): string =>
	[
		...(listed.drawings.length > 0
			? [t('unsent.counted.drawingsNotSent', { count: listed.drawings.length })]
			: []),
		...(listed.renames.length > 0
			? [t('unsent.counted.renames', { count: listed.renames.length })]
			: []),
		...(listed.deletes.length > 0
			? [t('unsent.counted.deletes', { count: listed.deletes.length })]
			: []),
		...(countedFolders(listed).length > 0
			? [t('unsent.counted.folders', { count: countedFolders(listed).length })]
			: []),
		...(listed.rmdirs.length > 0
			? [t('unsent.counted.folderDeletes', { count: listed.rmdirs.length })]
			: []),
		...(listed.files.length > 0
			? [t('unsent.counted.filesNotYetUploaded', { count: listed.files.length })]
			: []),
	].join(' · ');

/**
 * Why the last push could not clear this, where the user should wait instead:
 * said after the headline.
 */
const why = (stopped: 'offline' | 'blocked'): string =>
	stopped === 'offline' ? t('unsent.disconnect.offline') : t('unsent.disconnect.blocked');

/**
 * The headline, which has to be true of the list underneath it.
 *
 * Normally that list is what this device did and the remote never heard: "n
 * changes … have not reached X". But a source resumed from an earlier bind and
 * not yet checked against its remote counts *everything live in it* as unsent
 * (`Unsynced.unverified`, and `verifyResume` is what settles it), because
 * "clean, with a file id" is a memory until somebody has looked. Then the list
 * is the whole library, "have not reached" is simply false, and the honest
 * thing is to say why it looks like that and that waiting is the answer.
 */
const headline = (listed: Unsynced, label: string): string => {
	if (listed.unverified) return t('unsent.disconnect.unverified', { provider: label });
	return t('unsent.disconnect.headline', { count: countOf(listed), provider: label });
};

/**
 * What becomes of the account, which depends on who else is in it: other
 * devices keep syncing, and the last one out takes the account with it. Said
 * before the user answers, since the two are different things to agree to.
 */
const elsewhere = (others: number | undefined): string => {
	if (others === undefined) return t('unsent.disconnect.others.unknown');
	if (others === 0) return t('unsent.disconnect.others.none');
	// One is "the other device", which is not a count, and so its own message
	// rather than a plural's `one`: in some languages that is 21 as well.
	return others === 1
		? t('unsent.disconnect.others.single')
		: t('unsent.disconnect.others.several', { count: others });
};

/**
 * The second step's question. A single drawing is "this drawing", which is not a
 * count, and so its own message rather than a plural's `one`: in some
 * languages that is 21 as well.
 */
const discardQuestion = (listed: Unsynced, label: string): string => {
	const count = listed.drawings.length;
	if (count === 0) return t('unsent.discard.unsentOnly');
	if (listed.unverified) {
		return count === 1
			? t('unsent.disconnect.discardDrawingUnverified', { provider: label })
			: t('unsent.disconnect.discardDrawingsUnverified', { count, provider: label });
	}
	return count === 1
		? t('unsent.disconnect.discardDrawing')
		: t('unsent.disconnect.discardDrawings', { count });
};

const Titles = ({ drawings }: Readonly<{ drawings: readonly DrawingRecord[] }>) => {
	const named = drawings.slice(0, NAMED);
	const rest = drawings.slice(NAMED);
	if (named.length === 0) return null;
	return (
		<>
			<ul aria-label={t('unsent.disconnect.drawings')}>
				{named.map((drawing) => (
					<li key={drawingRef(drawing)}>{titleShown(drawing.title)}</li>
				))}
			</ul>
			{rest.length > 0 && (
				<details>
					<summary>{t('unsent.disconnect.more', { count: rest.length })}</summary>
					<ul aria-label={t('unsent.disconnect.rest')}>
						{rest.map((drawing) => (
							<li key={drawingRef(drawing)}>{titleShown(drawing.title)}</li>
						))}
					</ul>
				</details>
			)}
		</>
	);
};

export const DisconnectDialog = ({
	label,
	displayName,
	listed,
	targets,
	failing,
	stopped,
	busy,
	others,
	onServer,
	leftAtProvider,
	download,
	onAnswer,
	onCancel,
}: DisconnectDialogProps) => {
	const [discarding, setDiscarding] = useState(false);
	// Why the last download did not happen. Said here, beside the button: one
	// that silently does nothing is a user who goes on to discard, thinking
	// they have a copy.
	const [failed, setFailed] = useState<string | null>(null);
	const save = () => {
		setFailed(null);
		void download(listed).catch((error: unknown) => {
			setFailed(downloadProblem(error));
		});
	};
	const failure = failed !== null && (
		<p className="muted" role="alert">
			{failed}
		</p>
	);
	const named =
		displayName === null
			? label
			: t('connection.sourceName', { provider: label, account: displayName });
	// Nothing about other devices without the server: it is not asked, so the
	// account is wherever it was.
	const after = onServer ? (
		<>
			<p className="muted">{elsewhere(others)}</p>
			{(others === undefined || others === 0) && leftAtProvider}
		</>
	) : null;
	// A question per step, keyed by it: the button pressed goes with its step,
	// and the next step's answer takes the focus as the first one's did.
	const asked = (step: string, question: string, children: ReactNode) => (
		<Question
			key={step}
			className="account-confirm"
			label={question}
			onClose={onCancel}
			busy={busy}
		>
			{children}
		</Question>
	);

	// Nothing here that the remote lacks: there is nothing to decide, and the
	// question is only whether to disconnect.
	if (isEmpty(listed)) {
		return asked(
			'plain',
			t('unsent.disconnect.group'),
			<>
				<p className="muted">
					{t('unsent.disconnect.plain', { name: named, provider: label })}
				</p>
				{after}
				<QuestionActions
					primary={
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() => {
								onAnswer('discard');
							}}
						>
							{t('unsent.disconnect.confirm')}
						</button>
					}
				/>
			</>
		);
	}

	if (discarding) {
		return asked(
			'discard',
			t('unsent.discard.forGood'),
			<>
				<p>{discardQuestion(listed, label)}</p>
				<Titles drawings={listed.drawings} />
				{failure}
				<QuestionActions
					primary={
						<button
							type="button"
							className="danger"
							disabled={busy}
							onClick={() => {
								onAnswer('discard');
							}}
						>
							{t('unsent.discard.forGood')}
						</button>
					}
				>
					<button
						type="button"
						disabled={busy || !hasUnsentDownload(listed)}
						onClick={save}
					>
						{t('unsent.discard.downloadFirst')}
					</button>
				</QuestionActions>
			</>
		);
	}

	const leaves = canMove(listed, targets) ? leftBehind(listed, label) : null;
	return asked(
		'unsent',
		t('unsent.disconnect.group'),
		<>
			<p className="muted">
				{headline(listed, label)}
				{stopped !== null && ` ${why(stopped)}`}
			</p>
			<p className="muted">{summary(listed)}</p>
			<Titles drawings={listed.drawings} />
			{leaves !== null && (
				<p className="muted">
					{t('unsent.disconnect.movingLeaves', { leftBehind: leaves })}
				</p>
			)}
			{/*
			 * The one thing here that is about a drawing's text rather than a row:
			 * an editor is holding something the store would not take, so neither
			 * the list nor a discard is about the whole of what the user wrote.
			 */}
			{failing && (
				<p className="muted" role="alert">
					{t('unsent.cannotList')}
				</p>
			)}
			{after}
			<MoveUnsent
				listed={listed}
				from={label}
				targets={targets}
				busy={busy}
				disabled={failing}
				onMove={(moveTo) => {
					onAnswer({ moveTo });
				}}
			/>
			{failure}
			<QuestionActions>
				<button type="button" disabled={busy || !hasUnsentDownload(listed)} onClick={save}>
					{t('unsent.disconnect.downloadThem')}
				</button>
				<button
					type="button"
					disabled={busy || failing}
					onClick={() => {
						setDiscarding(true);
					}}
				>
					{t('unsent.disconnect.discardThem')}
				</button>
			</QuestionActions>
		</>
	);
};
