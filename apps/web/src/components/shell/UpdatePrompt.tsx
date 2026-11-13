import { useEffect, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { t } from '../../i18n/t.js';
import { settleEditors } from '../../store/heldEdits.js';

/** How long Reload may go unanswered before the prompt says what else to do. */
const SLOW_MS = 10_000;

/**
 * `registerType: 'prompt'` means a new build never swaps itself in underneath a
 * half-drawn stroke. The user decides when to reload.
 *
 * Reload has the open drawing write what it holds first, strokes still
 * waiting on the autosave's pause among them, which the reload would
 * otherwise take with it, as a newer build closing the database does
 * (`settleEditors`). Then `beforeUpdate` is where the sync layer pauses its
 * requests so the new worker can take over at once (`makeWay`, the kit's
 * client's, given by `main.tsx` through `AppFoot`). It says it is updating
 * meanwhile, and if the page has still not reloaded after `SLOW_MS`, what
 * else will do it.
 */
export const UpdatePrompt = ({
	beforeUpdate = () => Promise.resolve(),
	slowAfter = SLOW_MS,
}: {
	beforeUpdate?: () => Promise<void>;
	slowAfter?: number;
}) => {
	const {
		needRefresh: [needRefresh, setNeedRefresh],
		updateServiceWorker,
	} = useRegisterSW();
	const [updating, setUpdating] = useState<'no' | 'asked' | 'slow'>('no');

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
					void settleEditors()
						.then(beforeUpdate)
						.then(() => updateServiceWorker(true));
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
