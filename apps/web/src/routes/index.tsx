import { normalizePath, ROOT } from '@skysa/draw-core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

import { DrawingList } from '../components/list/DrawingList.js';
import { ErrorScreen } from '../components/shell/ErrorScreen.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';
import { Editor } from '../drawing/Editor.js';
import { t } from '../i18n/t.js';

/**
 * The one route: the library — folders and the drawings in the open folder —
 * and, when a drawing is open, the editor filling the window with the library
 * in a drawer (docs/ARCHITECTURE.md §7, "The interface"). What is open is in
 * the query, so a link opens it and the service worker answers it with the
 * shell (`pwa.ts`): `/?f=Work&d=<id>`.
 */
const searchSchema = z.object({
	/** The open folder's path; the root when absent. */
	f: z.string().optional().catch(undefined),
	/** The open drawing's id. */
	d: z.string().optional().catch(undefined),
});

const Home = () => {
	const { f, d } = Route.useSearch();
	const navigate = useNavigate({ from: Route.fullPath });
	const folderPath = f === undefined ? ROOT : normalizePath(f);

	const library = (
		<>
			<Sidebar
				folderPath={folderPath}
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

	if (d !== undefined) {
		return (
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
	}

	return (
		<main className="home">
			{library}
			<section className="drawing-view" aria-label={t('shell.panes.drawing')}>
				<p className="pane-empty">{t('drawings.nothingOpen')}</p>
			</section>
		</main>
	);
};

export const Route = createFileRoute('/')({
	component: Home,
	validateSearch: searchSchema,
	errorComponent: ErrorScreen,
});
