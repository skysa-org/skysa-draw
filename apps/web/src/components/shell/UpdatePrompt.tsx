import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { t } from '../../i18n/t.js';
import { settleEditors } from '../../store/heldEdits.js';
import { letLeave } from '../../store/leaving.js';

/** How long Reload may go unanswered before the prompt says what else to do. */
const SLOW_MS = 10_000;

const reloadPage = () => {
	window.location.reload();
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
 * the database does (`settleEditors`). Meanwhile it says it is updating, and
 * never that it is slow: the take-over has come, and only the drawing is left
 * to write. The reload follows however that went, a settle that rejects
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
			setUpdating('settling');
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
