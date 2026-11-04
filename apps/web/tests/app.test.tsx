import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { DatabaseProvider } from '../src/store/database.js';
import { createDrawing } from '../src/store/drawings.js';
import { freshDatabase } from './support/db.js';

/** The app at `/`, over a database of the test's own. */
const renderApp = async (path = '/') => {
	const db = freshDatabase();
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	render(
		<DatabaseProvider database={db}>
			<RouterProvider router={router} />
		</DatabaseProvider>
	);
	await screen.findByRole('button', { name: 'New drawing' });
	return { db, router };
};

describe('the app', () => {
	it('starts with no drawings, and makes one into the open folder', async () => {
		const user = userEvent.setup();
		const { db, router } = await renderApp();
		expect(await screen.findByText('No drawings here yet.')).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'New drawing' }));

		const row = await screen.findByRole('button', { name: /^Untitled/ });
		expect(row.getAttribute('aria-current')).toBe('true');
		expect(await db.drawings.count()).toBe(1);
		const [made] = await db.drawings.toArray();
		expect(router.state.location.search).toEqual({ d: made?.id });
		expect(await screen.findByRole('img', { name: 'Preview of “Untitled”' })).toBeDefined();
	});

	it('opens a folder, and makes a drawing there', async () => {
		const user = userEvent.setup();
		const { db, router } = await renderApp();

		await user.click(screen.getByRole('button', { name: 'New folder' }));
		await user.type(screen.getByLabelText('Folder name'), 'Work{Enter}');

		await waitFor(() => {
			expect(router.state.location.search).toEqual({ f: 'Work' });
		});
		const work = await screen.findByRole('button', { name: 'Work' });
		expect(work.getAttribute('aria-current')).toBe('page');

		await user.click(screen.getByRole('button', { name: 'New drawing' }));
		await waitFor(async () => {
			expect((await db.drawings.toArray()).map((row) => row.path)).toEqual([
				'Work/untitled.svg',
			]);
		});

		await user.click(screen.getByRole('button', { name: 'New folder' }));
		await user.type(screen.getByLabelText('Folder name'), 'work{Enter}');
		expect(await screen.findByRole('alert')).toHaveProperty(
			'textContent',
			'There is already a folder called “work”.'
		);
	});

	it('renames and deletes the open drawing', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Before' });
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: [`/?d=${made.id}`] }),
		});
		render(
			<DatabaseProvider database={db}>
				<RouterProvider router={router} />
			</DatabaseProvider>
		);
		expect(await screen.findByRole('heading', { name: 'Before' })).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'Rename' }));
		await user.clear(screen.getByLabelText('Title'));
		await user.type(screen.getByLabelText('Title'), 'After{Enter}');
		expect(await screen.findByRole('heading', { name: 'After' })).toBeDefined();
		expect((await db.drawings.get(made.id))?.path).toBe('after.svg');

		await user.click(screen.getByRole('button', { name: 'Delete' }));
		const asked = await screen.findByRole('alertdialog');
		expect(asked.textContent).toContain('Delete “After”?');
		await user.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(await db.drawings.count()).toBe(1);

		await user.click(screen.getByRole('button', { name: 'Delete' }));
		await user.click(
			(await screen.findByRole('alertdialog')).querySelector('button.primary') as HTMLElement
		);
		expect(await screen.findByText('Choose a drawing, or make a new one.')).toBeDefined();
		expect(await db.drawings.count()).toBe(0);
		expect(router.state.location.search).toEqual({});
	});
});
