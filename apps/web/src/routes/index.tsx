import { ENTITLEMENT_CODES } from '@skysa/protocol';
import { normalizePath, ROOT } from '@skysa/storage';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

import { AccountProvider } from '../components/account/AccountPanel.js';
import { DrawingList } from '../components/list/DrawingList.js';
import { ConnectNotice } from '../components/shell/ConnectNotice.js';
import { ErrorScreen } from '../components/shell/ErrorScreen.js';
import { PlacementProvider } from '../components/shell/placement.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { useSizeClass } from '../components/ui/sizeClass.js';
import { Editor } from '../drawing/Editor.js';
import { t } from '../i18n/t.js';
import {
	CONNECT_OUTCOMES,
	useCodeAskedAgain,
	useConnectNotice,
	useEnterCode,
} from './-home/connectNotice.js';

/**
 * The one route: the library — the sources, the folders and the drawings in
 * the open folder — and, when a drawing is open, the editor filling the
 * window with the library in a drawer (docs/ARCHITECTURE.md §7, "The
 * interface"). What is open is in the query, so a link opens it and the
 * service worker answers it with the shell (`pwaApp.ts`): `/?f=Work&d=<id>`.
 *
 * And what the way back from connecting storage says (`?connect=ok`, or a
 * reason, with `&code=` for an operator's no), and the operator's page asking
 * for the code field (`?enter=code`). Each is read once and taken out of the
 * query (`-home/connectNotice.ts`).
 */
const searchSchema = z.object({
	/** The open folder's path; the root when absent. */
	f: z.string().optional().catch(undefined),
	/** The open drawing's id. */
	d: z.string().optional().catch(undefined),
	/** How connecting storage went, on the way back from the provider. */
	connect: z.enum(CONNECT_OUTCOMES).optional().catch(undefined),
	/** The kind of no an operator's policy gave a connect. */
	code: z.enum(ENTITLEMENT_CODES).optional().catch(undefined),
	/** The operator's page sending the user back to type a code. */
	enter: z.literal('code').optional().catch(undefined),
});

const Home = () => {
	const { f, d, connect, code, enter } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const folderPath = f === undefined ? ROOT : normalizePath(f);
	// The frame reads the size class, and says where a panel the library
	// opens floats: a sheet from the bottom on a phone, a drawer elsewhere.
	const sizeClass = useSizeClass();
	const { connectNotice, dismissConnect } = useConnectNotice(connect, code);
	useCodeAskedAgain(connect);
	const enterCode = useEnterCode(enter);

	const library = (
		<>
			<Sidebar
				folderPath={folderPath}
				enterCode={enterCode}
				onOpen={(path) => {
					void navigate({ search: path === ROOT ? {} : { f: path } });
				}}
			/>
			<DrawingList
				folderPath={folderPath}
				openId={d}
				onOpen={(id) => {
					void navigate({ search: (previous) => ({ ...previous, d: id }) });
				}}
			/>
		</>
	);

	const screen =
		d === undefined ? (
			<main className="home">
				{library}
				<section className="drawing-view" aria-label={t('shell.panes.drawing')}>
					<p className="pane-empty">{t('drawings.nothingOpen')}</p>
				</section>
			</main>
		) : (
			<Editor
				id={d}
				library={library}
				onBack={() => {
					void navigate({ search: ({ d: _gone, ...rest }) => rest });
				}}
				onReplaced={(id) => {
					// In place of the drawing deleted from under its edits, which
					// a step back would only find not here.
					void navigate({
						search: (previous) => ({ ...previous, d: id }),
						replace: true,
					});
				}}
			/>
		);

	// Around both screens, so what the account has to go on doing — taking up
	// the credential the way back from the provider brought — goes on whether
	// or not the library, and the account panel in it, is on screen.
	return (
		<AccountProvider>
			<PlacementProvider value={sizeClass === 'compact' ? 'sheet' : 'drawer'}>
				{screen}
				<ConnectNotice notice={connectNotice} onDismiss={dismissConnect} />
			</PlacementProvider>
		</AccountProvider>
	);
};

export const Route = createFileRoute('/')({
	component: Home,
	validateSearch: searchSchema,
	errorComponent: ErrorScreen,
});
