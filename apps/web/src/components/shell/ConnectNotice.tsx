import type { ConnectGate } from '@skysa/draw-core';

import { t } from '../../i18n/t.js';
import { IconButton } from '../ui/IconButton.js';
import { CloseIcon } from '../ui/icons.js';

/** What is said on the way back from connecting storage, and how it is said. */
export interface ConnectNoticeShown {
	readonly message: string;
	/** Connected; nothing connected but nothing broken; or something went wrong. */
	readonly tone: 'success' | 'warning' | 'error';
	/** The operator's link, where a refusal has somewhere to send the user. */
	readonly action?: ConnectGate['action'];
}

/**
 * How connecting storage went, said once on the way back from the provider: a
 * card over the top of whatever the app opened on — the library, or the
 * drawing that was open when the user left — until it is put away. An
 * `alert` where something went wrong, which a screen reader says at once,
 * and a `status` otherwise. Its ✕ is the one control it has besides the
 * operator's link, and is as large as every other (`IconButton`).
 */
export const ConnectNotice = ({
	notice,
	onDismiss,
}: Readonly<{ notice: ConnectNoticeShown | undefined; onDismiss: () => void }>) =>
	notice === undefined ? null : (
		<div
			className={`connect-notice connect-notice-${notice.tone}`}
			role={notice.tone === 'error' ? 'alert' : 'status'}
		>
			<p className="connect-notice-message">{notice.message}</p>
			{notice.action !== undefined && (
				// In this window, as connecting is; `noreferrer`, so the operator's
				// page is not told which drawing was open.
				<a className="connect-notice-action" href={notice.action.url} rel="noreferrer">
					{notice.action.label}
				</a>
			)}
			<IconButton
				icon={<CloseIcon />}
				label={t('connect.outcome.dismiss')}
				onClick={onDismiss}
			/>
		</div>
	);
