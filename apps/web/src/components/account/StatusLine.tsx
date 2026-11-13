import { runBar, type SchedulerStatus } from '@skysa/client';
import type { ReactNode } from 'react';

import { t } from '../../i18n/t.js';
import { InfoSheet } from './Question.js';
import { lineStatus, statusMessage, type SyncCount } from './statusWords.js';

/**
 * How full a run is (`runBar`), or, where it cannot say of how many, the
 * browser's own drawing of not knowing.
 */
const RunBar = ({
	bar,
	label,
	className,
}: Readonly<{
	bar: Readonly<{ value: number; max: number }> | null;
	label: string;
	className: string;
}>) =>
	bar === null ? (
		<progress className={className} aria-label={label} />
	) : (
		<progress className={className} aria-label={label} value={bar.value} max={bar.max} />
	);

/** How much of a path's end is kept whole when it is cut. */
const KEPT_END = 24;

/**
 * A path too long for its line, cut in the middle: its start says where the
 * file is and its end which file it is, and the end is the half that matters.
 * CSS cuts only the end of a line, so the text is two spans and only the first
 * gives way (`.run-file-start`); a path that fits shows whole. Split by code
 * point, so a character outside the BMP is never cut in half.
 */
const MiddleCut = ({ text }: Readonly<{ text: string }>) => {
	const points = [...text];
	const at = Math.max(0, points.length - KEPT_END);
	return (
		<>
			<span className="run-file-start">{points.slice(0, at).join('')}</span>
			<span className="run-file-end">{points.slice(at).join('')}</span>
		</>
	);
};

/** The bar, and the file the run is on. `label` names the bar. */
const RunProgress = ({ status, label }: Readonly<{ status: SchedulerStatus; label: string }>) => {
	const progress = status.phase === 'syncing' ? status.progress : undefined;
	const path = progress?.path;
	return (
		<>
			<RunBar bar={runBar(progress)} label={label} className="run-bar" />
			{/* Not live: it changes with every file, faster than anyone could
			    listen, and the count above already says how far it has got. A
			    space holds its line, so the buttons do not jump as it comes and
			    goes. */}
			<p className="run-file" title={path}>
				{path === undefined ? ' ' : <MiddleCut text={path} />}
			</p>
		</>
	);
};

/**
 * How full a long run is, under what says how far it has got: a fraction, or,
 * while a scan or a round is still listing, a bar that does not pretend to know.
 */
export const SyncBar = ({ count }: Readonly<{ count: SyncCount }>) => (
	<RunBar bar={count.bar} label={t('account.progress')} className="account-bar" />
);

/**
 * Where the panel ends, once there is nothing to ask the user: how the source
 * is going, in one line, with a connected source's count of its other devices
 * at the line's end. Everything that can be done to the source is its `⋯`, at
 * the end of its row above. What needs the user — a reconnect, a problem, a
 * question being asked — is drawn above the line while it lasts, so the line
 * is where the panel ends whatever is going on.
 */
export const StatusLine = ({
	text,
	title,
	onDetails,
	children,
}: Readonly<{
	text: string;
	title: string | null;
	/**
	 * Given while the source syncs, but during a first import: the words are a
	 * button that opens how syncing is going, and with which account
	 * (`SyncDetails`). Inside the line rather than in its place, so the line is
	 * the same element whatever it says.
	 */
	onDetails?: () => void;
	children?: ReactNode;
}>) => (
	<div className="account-line">
		<p className="account-status muted" {...(title === null ? {} : { title })}>
			{onDetails === undefined ? (
				text
			) : (
				<button
					type="button"
					className="account-status-button"
					aria-haspopup="dialog"
					onClick={onDetails}
				>
					{text}
				</button>
			)}
		</p>
		{children}
	</div>
);

/**
 * What a sync is doing, at more length than the line has room for, and the
 * way to pause it — or, paused, to resume it. Opened from the status line, and
 * live while open: once the run it was opened on has ended, it says how
 * syncing stands. Opened from it whatever it says, since the line does not
 * name the source and this does, with its account, on a phone that has no
 * tooltip to show. Paused, nothing syncs on this device until Sync now, a
 * re-scan, the source shown again after another, or a reload (`pause`, the
 * kit's scheduler's).
 */
export const SyncDetails = ({
	status,
	label,
	displayName,
	syncable,
	onPause,
	onResume,
	onClose,
}: Readonly<{
	status: SchedulerStatus;
	label: string;
	displayName: string | null;
	syncable: boolean;
	onPause: () => void;
	onResume: () => void;
	onClose: () => void;
}>) => {
	const syncing = status.phase === 'syncing';
	const paused = status.phase === 'paused';
	const title = () => {
		if (paused) return t('account.details.pausedTitle');
		return displayName === null
			? t('account.details.title', { provider: label })
			: t('account.details.titleAs', { provider: label, account: displayName });
	};
	const action = () => {
		if (syncing) {
			return (
				<button type="button" onClick={onPause}>
					{t('account.details.pause')}
				</button>
			);
		}
		if (paused) {
			return (
				<button type="button" className="primary" onClick={onResume}>
					{t('account.details.resume')}
				</button>
			);
		}
		return undefined;
	};
	return (
		<InfoSheet title={title()} onClose={onClose} actions={action()}>
			<div className="run-body">
				{/* Polite: it changes every few files. */}
				<p role="status" aria-live="polite">
					{statusMessage(status, label, syncable) ??
						lineStatus(status, label, syncable).text}
				</p>
				{syncing && <RunProgress status={status} label={t('account.progress')} />}
				{syncing && <p className="muted">{t('account.details.pauseHint')}</p>}
			</div>
		</InfoSheet>
	);
};
