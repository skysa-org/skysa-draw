import type { ReactNode } from 'react';

import { rich } from '../../i18n/rich.js';
import { t } from '../../i18n/t.js';
import { type ConnectedSource, renameSource } from '../../store/connection.js';
import type { DrawDatabase } from '../../store/db.js';
import { isLiveSource } from '../../store/rowStates.js';

/**
 * A name typed into a source's rename field, stored.
 *
 * `was` is the name the source was shown under. The same name given back
 * stores nothing: it may be the derived one ("Dropbox", "Dropbox 2"), and
 * stored it would pin the source to it, no longer following the account.
 * Nothing typed is the source's own name back again (`renameSource` clears
 * it). The row shows the store's name as it lands, by its live query, so
 * there is nothing to hold meanwhile; a store that turns it down leaves the
 * name the source had, which the row goes on showing.
 */
export const storeSourceName = (
	db: DrawDatabase,
	connectionId: string,
	was: string,
	chosen: string | undefined
): void => {
	// Escape, or nothing changed: nothing to store.
	if (chosen === undefined || chosen.trim() === was) return;
	void renameSource(db, connectionId, chosen).catch(() => undefined);
};

/**
 * A source's name as a screen reader is told it: one that syncs nowhere says
 * so, and a live one that needs connecting again says that. Said outright
 * rather than left to be assembled from the spans `ShownSourceName` draws,
 * which the name from contents joins by its own rules. The visible words are
 * in it, so it still satisfies WCAG 2.5.3.
 */
export const sourceLabel = (source: ConnectedSource, name: string, reconnect = false): string => {
	if (!isLiveSource(source)) return t('sources.disconnected.label', { source: name });
	return reconnect ? t('sources.reconnect', { source: name }) : name;
};

/**
 * A source's name on screen, and a disconnected one's with the words that say
 * so — not an icon alone: a source that syncs nowhere is the one thing about
 * the list a user must not have to infer from a colour.
 */
export const ShownSourceName = ({
	source,
	name,
}: Readonly<{
	source: ConnectedSource;
	name: string;
}>): ReactNode =>
	isLiveSource(source)
		? name
		: rich(
				'sources.disconnected.shown',
				{
					name: (words) => words,
					state: (words) => <span className="source-row-detached">{words}</span>,
				},
				{ source: name }
			);
