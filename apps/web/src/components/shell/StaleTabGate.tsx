import { cell } from '@skysa/storage';
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

import { t } from '../../i18n/t.js';
import { subscribeTabState, tabState } from '../../store/staleTab.js';
import { HAS_POPOVER, raise } from '../ui/MenuList.js';

/**
 * The two things `store/staleTab.ts` can have to say, over the app. Apart
 * from `UpdatePrompt`, which offers a new build the user may put off: neither
 * of these can be, since in both the store under the app is not there to read
 * or write.
 *
 * Out of date blocks. The database is closed for good, so every save from
 * here on is refused, and a canvas that still took strokes would be taking
 * strokes it cannot keep. The notice covers the window as work under way does
 * (`Applying`), in the top layer where there is one, and everything else in
 * the page is made inert while it shows, the sheets and drawers in their
 * portals with it, and anything put there later: the drawing can still be
 * seen behind the notice, and nothing behind it can be pressed, focused or
 * typed into. The page's own listeners hear no key, paste or drop either,
 * the editor's shortcuts and its picture placing among them; the notice's
 * buttons answer by the browser's own handling of a key, which that leaves
 * alone. Only a listener on the window's capture phase put there before the
 * notice comes still hears a key, as a gesture under way has one until it
 * ends. What the editor held was written before the database closed
 * (`beforeClosing`).
 *
 * It can be put aside, as skysa-notes' can. A save the store refused earlier
 * says nothing yet (docs/ARCHITECTURE.md §10), so the open drawing may hold
 * what the store does not, and export reads the drawing as it is open: put
 * aside, the app comes back, the focus where it was, under a bar that goes on
 * saying it cannot save.
 *
 * Reload is the answer, last in its row, and has the focus.
 */

/** A key, kept from the page's listeners and left to the browser, which presses the notice's buttons. */
const keepKey = (event: Event): void => {
	event.stopImmediatePropagation();
};

/**
 * A paste or a drop, taken from the page altogether: a drop the page did not
 * take, the browser would open in the window, in place of the drawing.
 */
const refuse = (event: Event): void => {
	event.preventDefault();
	event.stopImmediatePropagation();
};

const KEPT = [
	['keydown', keepKey],
	['keyup', keepKey],
	['paste', refuse],
	['dragover', refuse],
	['drop', refuse],
] as const;

const Blocked = ({ reload, putAside }: { reload: () => void; putAside: () => void }) => {
	const cover = useRef<HTMLDivElement>(null);
	const answer = useRef<HTMLButtonElement>(null);
	const said = useId();

	useLayoutEffect(() => {
		if (cover.current !== null) raise(cover.current);
	}, []);

	// The window's capture phase comes before every other listener but those
	// put there earlier. Inert takes the focus away from what had it, which
	// gets it back once the notice is put aside; what the page had made inert
	// itself stays so.
	useEffect(() => {
		const had = document.activeElement;
		const made = cell<readonly Element[]>([]);
		const quieten = (nodes: readonly Node[]) => {
			const fresh = nodes.filter(
				(node): node is Element =>
					node instanceof Element && node !== cover.current && !node.hasAttribute('inert')
			);
			fresh.forEach((element) => element.setAttribute('inert', ''));
			made.current = [...made.current, ...fresh];
		};
		quieten(Array.from(document.body.children));
		const later = new MutationObserver((records) => {
			quieten(records.flatMap((record) => Array.from(record.addedNodes)));
		});
		later.observe(document.body, { childList: true });
		KEPT.forEach(([type, listener]) => window.addEventListener(type, listener, true));
		answer.current?.focus();
		return () => {
			later.disconnect();
			KEPT.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
			made.current.forEach((element) => element.removeAttribute('inert'));
			if (had instanceof HTMLElement && had.isConnected) had.focus();
		};
	}, []);

	return createPortal(
		<div ref={cover} className="tab-gate" popover={HAS_POPOVER ? 'manual' : undefined}>
			<div
				className="tab-gate-card"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={said}
			>
				<p id={said}>{t('shell.staleTab.text')}</p>
				<div className="tab-gate-actions">
					<button type="button" onClick={putAside}>
						{t('shell.staleTab.notYet')}
					</button>
					<button ref={answer} type="button" className="primary" onClick={reload}>
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
			{state === 'waiting' && (
				<div className="update-prompt" role="status">
					<span>{t('shell.staleTab.waiting')}</span>
				</div>
			)}
		</>
	);
};
