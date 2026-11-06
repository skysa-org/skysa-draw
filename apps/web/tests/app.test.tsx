import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { routeTree } from '../src/routeTree.gen';
import { DatabaseProvider } from '../src/store/database.js';
import { type DrawDatabase, drawingKey } from '../src/store/db.js';
import { createDrawing } from '../src/store/drawings.js';
import { isTombstone } from '../src/store/rowStates.js';
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

/** The drawings not deleted: a delete keeps a tombstone until the source hears of it. */
const liveDrawings = async (db: DrawDatabase): Promise<number> =>
	(await db.drawings.toArray()).filter((row) => !isTombstone(row)).length;

/**
 * The drawing called `title`, open, with its tools. While it loads the frame
 * is a still one with a top bar of its own, which gives way to the open
 * frame's, and a menu, a drawer or a field opened on it goes with it: on a
 * slow runner a test that pressed the bar as soon as the title showed pressed
 * the still one.
 */
const opened = async (title: string) => {
	await screen.findByRole('toolbar', { name: 'Tool options' });
	return screen.getByRole('heading', { name: title });
};

/** The top bar's More menu, open, and the item named, once the drawing is open. */
const more = async (user: ReturnType<typeof userEvent.setup>, item: string) => {
	await screen.findByRole('toolbar', { name: 'Tool options' });
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
		// Found, not got: under a loaded run the editor's frame may come a moment after the title.
		expect(await screen.findByRole('toolbar', { name: 'Tools' })).toBeDefined();

		// The library is a drawer from the top bar, with the drawing current in it.
		await user.click(screen.getByRole('button', { name: 'Drawings' }));
		const library = await screen.findByRole('dialog', { name: 'Drawings' });
		expect(
			(await within(library).findByRole('button', { name: /^Untitled/ })).getAttribute(
				'aria-current'
			)
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

	it('has the sources at the top of the library, on the home screen and in the editor’s drawer', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Plan' });
		const { router } = renderApp('/', db);

		const home = await screen.findByRole('region', { name: 'Sources' });
		expect(await within(home).findByRole('button', { name: 'This device' })).toBeDefined();
		await user.click(await screen.findByRole('button', { name: /^Plan/ }));
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ d: made.id });
		});
		expect(await opened('Plan')).toBeDefined();

		await user.click(await screen.findByRole('button', { name: 'Drawings' }));
		const library = await screen.findByRole('dialog', { name: 'Drawings' });
		expect(within(library).getByRole('region', { name: 'Sources' })).toBeDefined();
	});

	it('says how connecting went on the way back from the provider, once, until put away', async () => {
		const user = userEvent.setup();
		const { router } = renderApp('/?f=Work&connect=ok');

		const said = await screen.findByText('Storage connected. Your drawings will sync with it.');
		// Out of the address at once, so a reload does not say it again.
		await waitFor(() => {
			expect(router.state.location.search).toEqual({ f: 'Work' });
		});
		expect(said.closest('[role="status"]')).not.toBeNull();

		await user.click(screen.getByRole('button', { name: 'Dismiss' }));
		expect(
			screen.queryByText('Storage connected. Your drawings will sync with it.')
		).toBeNull();
	});

	it('says why the operator would not take the account, as an alert', async () => {
		renderApp('/?connect=refused&code=lapsed');

		expect((await screen.findByRole('alert')).textContent).toContain(
			"This account's access to sync on this server has lapsed, so storage was not connected."
		);
	});

	it('says nothing for an outcome this build has no words for', async () => {
		const { router } = renderApp('/?connect=signin');

		await screen.findByText('No drawings here yet.');
		expect(screen.queryByRole('alert')).toBeNull();
		expect(router.state.location.search).toEqual({});
	});

	it('renames the open drawing on a double-click of its title, and Escape keeps the old one', async () => {
		const user = userEvent.setup();
		const db = freshDatabase();
		const made = await createDrawing(db, { title: 'Before' });
		renderApp(`/?d=${made.id}`, db);
		const heading = await opened('Before');
		expect(heading.getAttribute('title')).toBe('Double-click to rename');

		await user.dblClick(heading);
		expect(document.activeElement).toBe(screen.getByLabelText('Title'));
		await user.keyboard('{Escape}');
		expect(screen.queryByLabelText('Title')).toBeNull();
		expect(screen.getByRole('heading', { name: 'Before' })).toBeDefined();

		await user.dblClick(screen.getByRole('heading', { name: 'Before' }));
		await user.keyboard('After{Enter}');
		expect(await screen.findByRole('heading', { name: 'After' })).toBeDefined();
		expect((await db.drawings.get(drawingKey(made)))?.title).toBe('After');
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
		expect((await db.drawings.get(drawingKey(made)))?.path).toBe('after.svg');

		await more(user, 'Delete');
		const asked = await screen.findByRole('alertdialog');
		expect(asked.textContent).toContain('Delete “After”?');
		await user.click(within(asked).getByRole('button', { name: 'Cancel' }));
		expect(await liveDrawings(db)).toBe(1);

		await more(user, 'Delete');
		await user.click(
			within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete' })
		);
		expect(await screen.findByText('Choose a drawing, or make a new one.')).toBeDefined();
		// Kept as a tombstone, for the delete to reach the source's storage.
		expect(await liveDrawings(db)).toBe(0);
		expect(router.state.location.search).toEqual({});
	});
});
