import { useState } from 'react';

import { t } from '../../i18n/t.js';
import { useDb } from '../../store/database.js';
import {
	downloadNotice,
	downloadProblem,
	downloadSource,
	type Library,
} from '../../store/exportDrawings.js';
import type { MenuItem } from '../ui/Menu.js';
import type { Offer } from './storageItems.js';

/**
 * The whole of one source, as one archive of SVG files: the tree a push would
 * make in its folder. Offered once there is something to put in it, and not
 * before, when all it could make is an empty archive.
 *
 * What went wrong is said here, where it was asked for: a download that fails
 * without a word is one the user goes on waiting for. So is an archive handed
 * over without the changes the editor could not save (`downloadSource`).
 */
export const useDownloadAll = (connectionId: string, downloadAll: (library: Library) => void) => {
	const database = useDb();
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const start = () => {
		setBusy(true);
		setProblem(null);
		void downloadSource(database, connectionId, downloadAll)
			.then((answer) => {
				setProblem(downloadNotice(answer));
			})
			.catch((error: unknown) => {
				setProblem(downloadProblem(error));
			})
			.finally(() => {
				setBusy(false);
			});
	};
	return { busy, problem, start };
};

export type Downloading = ReturnType<typeof useDownloadAll>;

/** What went wrong with the download, said where it was asked for. */
export const DownloadAll = ({
	holds,
	downloading,
}: Readonly<{
	/** `holdsAnything`, as the panel has read it: undefined until it has. */
	holds: boolean | undefined;
	downloading: Downloading;
}>) =>
	holds === true && downloading.problem !== null ? (
		<p className="muted" role="alert">
			{downloading.problem}
		</p>
	) : null;

/** The way to start it, as an item of the source's `⋯`. */
export const downloadItem = (offer: Offer, downloading: Downloading): MenuItem[] =>
	offer === 'yes'
		? [
				{
					id: 'download',
					label: t('account.menu.downloadAll'),
					onSelect: downloading.start,
					disabled: downloading.busy,
				},
			]
		: [];
