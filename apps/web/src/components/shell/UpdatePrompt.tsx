import { useEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { t } from '../../i18n/t.js';
import { settleEditors } from '../../store/heldEdits.js';
import { letLeave } from '../../store/leaving.js';
import { HAS_POPOVER } from '../ui/MenuList.js';
import { keepFocus, useBlockedPage } from './blockPage.js';

/** How long Reload may go unanswered before the prompt says what else to do. */
const SLOW_MS = 10_000;

const reloadPage = () => {
	window.location.reload();
};

/**
 * How long the status a settling window says it is updating in is there
 * before its words come into it, so that a screen reader has it to hear them.
 */
const SAID_AFTER_MS = 100;

/**
 * A window settling as a new build takes over, blocked as a window out of
 * date is (`blockPage.ts`), since a stroke drawn after its last save would go
 * with the reload: under a clear cover, the drawing seen through it, with the
 * bar along its foot saying it is updating, as the bar does where it was not
 * put aside. The page behind is inert, the bar's own status with it, so the
 * cover has a status of its own, there before its words, as `Applying`'s is.
 */
const Settling = () => {
	const cover = useRef<HTMLDivElement>(null);
	const [said, setSaid] = useState(false);
	useBlockedPage(cover);
	useEffect(() => {
		const timer = setTimeout(() => {
			setSaid(true);
		}, SAID_AFTER_MS);
		return () => {
			clearTimeout(timer);
		};
	}, []);
	return createPortal(
		<div
			ref={cover}
			className="update-cover"
			popover={HAS_POPOVER ? 'manual' : undefined}
			onPointerDown={keepFocus}
		>
			<div className="update-prompt" aria-hidden="true">
				<span>{t('shell.update.updating')}</span>
			</div>
			<p role="status" className="visually-hidden">
				{said ? t('shell.update.updating') : ''}
			</p>
		</div>,
		document.body
	);
};

/**
 * `registerType: 'prompt'` means a new build never swaps itself in underneath a
 * half-drawn stroke. The user decides when to reload.
 *
 * `beforeUpdate` is where the sync layer pauses its requests so the new
 * worker can take over at once (`makeWay`, the kit's client's, given by
 * `main.tsx` through `AppFoot`). It says it is updating meanwhile, and
 * if the page has still not reloaded after `SLOW_MS`, what else will do it.
 *
 * Once the new worker has taken over, every window that offered it reloads,
 * not only the one whose Reload was pressed (`onNeedReload`, at
 * vite-plugin-pwa's `controlling`). Each has its open drawing write what it
 * holds first, strokes still waiting on the autosave's pause among them,
 * which the reload would otherwise take with it, as a newer build closing
 * the database does (`settleEditors`). Meanwhile it takes no strokes, and
 * says it is updating, though its bar was put aside, and never that it is
 * slow: the take-over has come, and only the drawing is left to write
 * (`Settling`). The reload follows however that went, a settle that rejects
 * among it, and without the leave prompt that edits not yet in the store hold
 * (`store/leaving.ts`): the page is the new worker's now, which does not serve
 * the old build.
 */
export const UpdatePrompt = ({
	beforeUpdate = () => Promise.resolve(),
	slowAfter = SLOW_MS,
	reload = reloadPage,
}: {
	beforeUpdate?: () => Promise<void>;
	slowAfter?: number;
	/** The browser's reload, but in a test; read once, as the registration's options are. */
	reload?: () => void;
}) => {
	const [updating, setUpdating] = useState<'no' | 'asked' | 'slow' | 'settling'>('no');
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
		// Read once, as the worker is registered.
	} = useRegisterSW({
		onNeedReload: () => {
			// Blocked before the settle starts, which takes what the editor holds
			// as it starts: a stroke drawn after that would go with the reload.
			flushSync(() => {
				setUpdating('settling');
			});
			const leave = () => {
				letLeave();
				reload();
			};
			void settleEditors().then(leave, leave);
		},
	});

	useEffect(() => {
		if (updating !== 'asked') return undefined;
		const timer = setTimeout(() => {
			setUpdating('slow');
		}, slowAfter);
		return () => {
			clearTimeout(timer);
		};
	}, [updating, slowAfter]);

	if (updating === 'settling') return <Settling />;

	if (!needRefresh) return null;

	if (updating !== 'no') {
		return (
			<div className="update-prompt" role="status">
				<span>
					{updating === 'slow' ? t('shell.update.slow') : t('shell.update.updating')}
				</span>
			</div>
		);
	}

	return (
		<div className="update-prompt" role="status">
			<span>{t('shell.update.available')}</span>
			<button
				type="button"
				onClick={() => {
					setUpdating('asked');
					void beforeUpdate().then(() => updateServiceWorker(true));
				}}
			>
				{t('common.reload')}
			</button>
			<button type="button" className="ghost" onClick={() => setNeedRefresh(false)}>
				{t('common.later')}
			</button>
		</div>
	);
};
