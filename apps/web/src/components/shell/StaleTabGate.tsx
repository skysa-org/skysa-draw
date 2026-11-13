import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

import { t } from '../../i18n/t.js';
import { subscribeTabState, tabState } from '../../store/staleTab.js';

/**
 * The app, and in front of it the two things `store/staleTab.ts` can have to
 * say. Apart from `UpdatePrompt`, which offers a new build the user may put
 * off: neither of these can be, since in both the store under the app is not
 * there to read or write.
 *
 * Out of date blocks. The database is closed for good, so every save from
 * here on is refused, and a canvas that still took strokes would be taking
 * strokes it cannot keep. The app underneath is made inert rather than
 * unmounted, so the drawing can still be seen behind the notice; what the
 * editor held was written before the database closed (`beforeClosing`).
 *
 * It can be put aside, as skysa-notes' can. A save the store refused earlier
 * says nothing yet (docs/ARCHITECTURE.md §10), so the open drawing may hold
 * what the store does not, and export reads the drawing as it is open: put
 * aside, the app comes back under a bar that goes on saying it cannot save.
 *
 * Reload is the answer, last in its row, and has the focus.
 */
export const StaleTabGate = ({
	children,
	reload = () => {
		window.location.reload();
	},
}: {
	children: ReactNode;
	/** Injected because jsdom has no navigation. */
	reload?: () => void;
}) => {
	const state = useSyncExternalStore(subscribeTabState, tabState);
	const [putAside, setPutAside] = useState(false);
	const blocked = state === 'stale' && !putAside;
	const said = useId();
	const answer = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		if (blocked) answer.current?.focus();
	}, [blocked]);

	return (
		<>
			<div className="tab-gate" inert={blocked}>
				{children}
			</div>
			{blocked && (
				<div className="update-prompt" role="alertdialog" aria-labelledby={said}>
					<span id={said}>{t('shell.staleTab.text')}</span>
					<button
						type="button"
						className="ghost"
						onClick={() => {
							setPutAside(true);
						}}
					>
						{t('shell.staleTab.notYet')}
					</button>
					<button ref={answer} type="button" className="primary" onClick={reload}>
						{t('common.reload')}
					</button>
				</div>
			)}
			{state === 'stale' && putAside && (
				<div className="update-prompt" role="alert">
					<span>{t('shell.staleTab.cannotSave')}</span>
					<button type="button" onClick={reload}>
						{t('common.reload')}
					</button>
				</div>
			)}
			{state === 'waiting' && (
				<div className="update-prompt" role="status">
					<span>{t('shell.staleTab.waiting')}</span>
				</div>
			)}
		</>
	);
};
