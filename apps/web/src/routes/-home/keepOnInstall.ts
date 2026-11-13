import { useEffect } from 'react';

import { useDb } from '../../store/database.js';
import { keeping } from '../../store/keeping.js';

/**
 * Installing the app is one of the things Chromium weighs when it decides
 * whether to keep a site's storage, so the question is put again then,
 * whatever it said before (`store/keeping.ts`). Silent there; the event is
 * Chromium's alone, as skysa-notes' `useKeepOnInstall` says.
 */
export const useKeepOnInstall = () => {
	const db = useDb();
	useEffect(() => {
		const installed = () => {
			void keeping.ask(db, 'installed');
		};
		window.addEventListener('appinstalled', installed);
		return () => {
			window.removeEventListener('appinstalled', installed);
		};
	}, [db]);
};
