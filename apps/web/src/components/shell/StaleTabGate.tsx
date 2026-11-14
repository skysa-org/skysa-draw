import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { t } from '../../i18n/t.js';
import { subscribeTabState, tabState } from '../../store/staleTab.js';
import { HAS_POPOVER } from '../ui/MenuList.js';
import { keepFocus, useBlockedPage } from './blockPage.js';

/**
 * The two things `store/staleTab.ts` can have to say, over the app. Apart
 * from `UpdatePrompt`, which offers a new build the user may put off: neither
 * of these can be, since in both the store under the app is not there to read
 * or write.
 *
 * Out of date blocks. The database is closed for good, so every save from
 * here on is refused, and a canvas that still took strokes would be taking
 * strokes it cannot keep. The notice covers the window as work under way does
 * (`Applying`), and the page behind it is blocked (`blockPage.ts`): the
 * drawing can still be seen, and nothing in it pressed, focused or typed
 * into, while the notice's buttons answer. What the editor held was written
 * before the database closed (`beforeClosing`).
 *
 * Beside the router, not in its root route (`AppFoot`), so that a screen
 * put in place of the app on an error still has the notice over it.
 *
 * It can be put aside, as skysa-notes' can. A save the store refused earlier
 * says nothing yet (docs/ARCHITECTURE.md §10), so the open drawing may hold
 * what the store does not, and export reads the drawing as it is open: put
 * aside, the app comes back, the focus where it was, under a bar that goes on
 * saying it cannot save.
 *
 * Reload is the answer, last in its row. The notice itself has the focus,
 * not Reload: a key already on its way as it comes — Space held for the hand,
 * an Enter meant for the drawing — presses nothing, and Tab reaches both.
 *
 * Waiting is said in a status that is there, empty, before its words come
 * into it, as `Applying`'s is, so that a screen reader hears them.
 */

const Blocked = ({ reload, putAside }: { reload: () => void; putAside: () => void }) => {
	const cover = useRef<HTMLDivElement>(null);
	const notice = useRef<HTMLDivElement>(null);
	const said = useId();

	useBlockedPage(cover);
	// After the block's, which keeps what had the focus, to give it back once
	// the notice is put aside.
	useEffect(() => {
		notice.current?.focus();
	}, []);

	return createPortal(
		<div
			ref={cover}
			className="tab-gate"
			popover={HAS_POPOVER ? 'manual' : undefined}
			onPointerDown={keepFocus}
		>
			<div
				ref={notice}
				className="tab-gate-card"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={said}
				tabIndex={-1}
			>
				<p id={said}>{t('shell.staleTab.text')}</p>
				<div className="tab-gate-actions">
					<button type="button" onClick={putAside}>
						{t('shell.staleTab.notYet')}
					</button>
					<button type="button" className="primary" onClick={reload}>
						{t('common.reload')}
					</button>
				</div>
			</div>
		</div>,
		document.body
	);
};

export const StaleTabGate = ({
	reload = () => {
		window.location.reload();
	},
}: {
	/** Injected because jsdom has no navigation. */
	reload?: () => void;
}) => {
	const state = useSyncExternalStore(subscribeTabState, tabState);
	const [putAside, setPutAside] = useState(false);

	return (
		<>
			{state === 'stale' && !putAside && (
				<Blocked
					reload={reload}
					putAside={() => {
						setPutAside(true);
					}}
				/>
			)}
			{state === 'stale' && putAside && (
				<div className="update-prompt" role="alert">
					<span>{t('shell.staleTab.cannotSave')}</span>
					<button type="button" onClick={reload}>
						{t('common.reload')}
					</button>
				</div>
			)}
			<p role="status" className="visually-hidden">
				{state === 'waiting' ? t('shell.staleTab.waiting') : ''}
			</p>
			{state === 'waiting' && (
				<div className="update-prompt" aria-hidden="true">
					<span>{t('shell.staleTab.waiting')}</span>
				</div>
			)}
		</>
	);
};
