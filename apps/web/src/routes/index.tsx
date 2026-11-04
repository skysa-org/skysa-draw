import { normalizePath, ROOT } from '@skysa/draw-core';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';

import { DrawingView } from '../components/drawing/DrawingView.js';
import { DrawingList } from '../components/list/DrawingList.js';
import { ErrorScreen } from '../components/shell/ErrorScreen.js';
import { Sidebar } from '../components/sidebar/Sidebar.js';

/**
 * The one screen: folders, the drawings in the open folder, and the open
 * drawing. What is open is in the query, so a link opens it and the service
 * worker answers it with the shell (`pwa.ts`): `/?f=Work&d=<id>`.
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

	return (
		<main className="home">
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
			<DrawingView
				id={d}
				onDeleted={() => {
					void navigate({ search: ({ d: _gone, ...rest }) => rest });
				}}
			/>
		</main>
	);
};

export const Route = createFileRoute('/')({
	component: Home,
	validateSearch: searchSchema,
	errorComponent: ErrorScreen,
});
