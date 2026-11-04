import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { DatabaseProvider } from '../src/store/database.js';
import type { DrawDatabase } from '../src/store/db.js';
import { createDrawing } from '../src/store/drawings.js';
import { freshDatabase } from './support/db.js';

/**
 * The app at `/`, over a database of the test's own: the library, and a
 * drawing opened in the editor, with the library in a drawer from its top bar
 * (docs/ARCHITECTURE.md §7, "The interface"). jsdom has no `matchMedia`, so
 * the window is expanded.
 */
const renderApp = (path = '/', db: DrawDatabase = freshDatabase()) => {
	const router = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [path] }),
	});
	render(
		<DatabaseProvider database={db}>
			<RouterProvider router={router} />
		</DatabaseProvider>
	);
	return { db, router };
};

/** The top bar's More menu, open, and the item named. */
const more = async (user: ReturnType<typeof userEvent.setup>, item: string) => {
	await user.click(screen.getByRole('button', { name: 'More' }));
	await user.click(await screen.findByRole('menuitem', { name: item }));
};

describe('the app', () => {
	it('starts with no drawings, and makes one into the open folder, opening it', async () => {
		const user = userEvent.setup();
		const { db, router } = renderApp();
		expect(await screen.findByText('No drawings here yet.')).toBeDefined();

		await user.click(screen.getByRole('button', { name: 'New drawing' }));

		expect(await screen.findByRole('heading', { name: 'Untitled' })).toBeDefined();
		expect(await db.drawings.count()).toBe(1);
		const [made] = await db.drawings.toArray();
		expect(router.state.location.search).toEqual({ d: made?.id });
		expect(screen.getByRole('toolbar', { name: 'Tools' })).toBeDefined();

		// The library is a drawer from the top bar, with the drawing current in it.
		await user.click(screen.getByRole('button', { name: 'Drawings' }));
		const library = await screen.findByRole('dialog', { name: 'Drawings' });
		expect(
			within(library)
				.getByRole('button', { name: /^Untitled/ })
				.getAttribute('aria-current')
		).toBe('true');
	});

	it('opens a folder, refuses a second of the same name, and makes a drawing there', async () => {
		const user = userEvent.setup();
		const { db, router } = renderApp();

		await user.click(await screen.findByRole('button', { name: 'New folder' }));
		await user.type(screen.getByLabelText('Folder name'), 'Work{Enter}');

		await waitFor(() => {
			expect(router.state.location.search).toEqual({ f: 'Work' });
		});
		const work = await screen.findByRole('button', { name: 'Work' });
		expect(work.getAttribute('aria-current')).toBe('page');

		await user.click(screen.getByRole('button', { name: 'New folder' }));
		await user.type(screen.getByLabelText('Folder name'), 'work{Enter}');
		expect(await screen.findByRole('alert')).toHaveProperty(
			'textContent',
			'There is already a folder called “work”.'
		);
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		await user.click(screen.getByRole('button', { name: 'New drawing' }));
		await waitFor(async () => {
			expect((await db.drawings.toArray()).map((row) => row.path)).toEqual([
				'Work/untitled.svg',
			]);
		});
		expect(await screen.findByRole('heading', { name: 'Untitled' })).toBeDefined();
		expect(router.state.location.search).toMatchObject({ f: 'Work' });
	});

	it('renames and deletes the open drawing from the top bar', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Before' });
		const { router } = renderApp(`/?d=${made.id}`, db);
		expect(await screen.findByRole('heading', { name: 'Before' })).toBeDefined();

		await more(user, 'Rename');
		await user.clear(screen.getByLabelText('Title'));
		await user.type(screen.getByLabelText('Title'), 'After{Enter}');
		expect(await screen.findByRole('heading', { name: 'After' })).toBeDefined();
		expect((await db.drawings.get(made.id))?.path).toBe('after.svg');

		await more(user, 'Delete');
		const asked = await screen.findByRole('alertdialog');
		expect(asked.textContent).toContain('Delete “After”?');
		await user.click(within(asked).getByRole('button', { name: 'Cancel' }));
		expect(await db.drawings.count()).toBe(1);

		await more(user, 'Delete');
		await user.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
		);
		expect(await screen.findByText('Choose a drawing, or make a new one.')).toBeDefined();
		expect(await db.drawings.count()).toBe(0);
		expect(router.state.location.search).toEqual({});
	});
});
