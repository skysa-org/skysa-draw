import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useSyncExternalStore } from 'react';

import type { InstanceConfig } from '../../api/client.js';
import { answer, type Asked } from '../../api/instanceConfig.js';
import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import { LOCAL_CONNECTION_ID } from '../../store/db.js';
import { holdsAnything, type Library } from '../../store/exportDrawings.js';
import type { Keeping } from '../../store/keeping.js';
import type { AccountSlot } from '../sources/SourcePanel.js';
import { DownloadAll, downloadItem, useDownloadAll } from './DownloadAll.js';
import { ActionsMenu } from './PanelMenus.js';
import { StatusLine } from './StatusLine.js';
import { offersDownload } from './storageItems.js';
import { useAsked } from './useAsked.js';

/**
 * What the browser has said about keeping this device's drawings, asked on
 * sight — `persisted()` never prompts — and followed as it changes, since the
 * request that changes it is made from somewhere else (a drawing being
 * created).
 *
 * Asked again whenever the tab comes back into view: the answer can change
 * where this tab cannot hear it, in another tab's request or in the browser's
 * own site settings.
 */
const useKept = (keep: Keeping) => {
	const kept = useSyncExternalStore(keep.subscribe, keep.state);
	useEffect(() => {
		void keep.check();
		const shown = () => {
			if (document.visibilityState === 'visible') void keep.check();
		};
		document.addEventListener('visibilitychange', shown);
		return () => {
			document.removeEventListener('visibilitychange', shown);
		};
	}, [keep]);
	return kept;
};

/**
 * The panel while nothing is connected: where the drawings are, and what
 * there is to know about keeping them. The way to connect is the `+` above,
 * which has its words while nothing is connected.
 */
export const NotConnected = ({
	config,
	downloadAll,
	keep,
	slot,
}: Readonly<{
	config: Asked<InstanceConfig>;
	downloadAll: (library: Library) => void;
	keep: Keeping;
	slot?: AccountSlot;
}>) => {
	const database = useDb();
	const settings = answer(config);
	const holds = useLiveQuery(() => holdsAnything(database, LOCAL_CONNECTION_ID), [database]);
	const downloading = useDownloadAll(LOCAL_CONNECTION_ID, downloadAll);
	// The device's own drawings offer a download alone.
	useAsked(slot, LOCAL_CONNECTION_ID, (action) => ({
		offer: action === 'download' ? offersDownload(true, holds) : 'no',
		act: downloading.start,
	}));
	const kept = useKept(keep);
	const items = downloadItem(offersDownload(true, holds), downloading);

	return (
		<section className="account" aria-label={t('account.region')}>
			{settings?.authMode === 'account-first' && (
				<p className="muted">{t('account.local.signInMissing')}</p>
			)}
			{config.kind === 'unreachable' && (
				<p className="muted">{t('account.local.unreachable')}</p>
			)}
			{/*
			 * The one place the drawings here are all there is, so the one place
			 * it is said. Not before the browser has answered, and not once it
			 * has said it will keep them. What helps is connecting, which makes a
			 * second copy, and the download, which makes one now.
			 *
			 * Not installing, though the app asks again when it is installed.
			 * It is advice that holds only in Chromium: Firefox on a desktop has
			 * nothing to install, and in Safari a Home Screen app keeps its data
			 * apart from Safari's, so the installed app opens empty and the
			 * drawings stay where they were.
			 */}
			{holds === true && kept === 'not-kept' && (
				<p className="muted">{t('account.local.mayClear')}</p>
			)}
			<DownloadAll holds={holds} downloading={downloading} />
			<StatusLine text={t('account.local.line')} title={null} />
			<ActionsMenu slot={slot} name={t('connection.pile')} items={items} />
		</section>
	);
};
