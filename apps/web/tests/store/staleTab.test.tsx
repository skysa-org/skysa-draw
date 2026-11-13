import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type Dexie from 'dexie';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { StaleTabGate } from '../../src/components/shell/StaleTabGate.js';
import { createDatabase, type DrawDatabase, watchTab } from '../../src/store/db.js';
import { beforeClosing } from '../../src/store/heldEdits.js';
import { CLOSE_GRACE_MS, tabState } from '../../src/store/staleTab.js';
import { deleteAfterTest, watchedDatabase } from '../support/db.js';

/**
 * A newer build opening the database in another window, and the gate that says
 * so. One test file, in one order: out of date is for good, in the module as in
 * the tab, so everything that needs the state before it comes first. Carried
 * over from skysa-notes' `staleTab.test.tsx`, with the waiting notice added.
 */

/** Later than any version this build declares. */
const NEWER = 99;

const thisTab = async (): Promise<DrawDatabase> => {
	const db = watchedDatabase();
	await db.prefs.put({ key: 'before', value: 'kept' });
	return db;
};

/** The same database as a later build declares it: everything there is, and more. */
const newerBuild = (name: string): Dexie => {
	const db = createDatabase(name) as Dexie;
	db.version(NEWER).stores({ somethingNew: 'id' });
	deleteAfterTest(db);
	return db;
};

const gate = (reload = vi.fn()) => {
	render(
		<StaleTabGate reload={reload}>
			<p>the app</p>
		</StaleTabGate>
	);
	return reload;
};

// In the order written, even when the run is shuffled: see above.
describe('a window whose database a newer build has asked for', { shuffle: false }, () => {
	it('says nothing while it is the newest there is', async () => {
		await thisTab();
		gate();

		expect(tabState()).toBe('current');
		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.queryByRole('status')).toBeNull();
		expect(screen.getByText('the app').closest('[inert]')).toBeNull();
	});

	it('says it is waiting while an older window holds its upgrade, and stops once it lets go', async () => {
		const name = `waiting-${crypto.randomUUID()}`;
		// An older window, deaf to the upgrade: it does not close for it.
		const older = createDatabase(name) as Dexie;
		older.on('versionchange', () => false);
		deleteAfterTest(older);
		await older.open();
		// This window is the newer build here.
		const db = newerBuild(name);
		onTestFinished(watchTab(db));
		gate();

		const opening = db.open();
		const notice = await screen.findByRole('status', {}, { timeout: 3000 });
		expect(notice.textContent).toMatch(/Waiting for an older window/);
		expect(tabState()).toBe('waiting');
		// Nothing is blocked: the app is only waiting to read.
		expect(screen.getByText('the app').closest('[inert]')).toBeNull();

		older.close();
		await act(async () => {
			await opening;
		});
		expect(tabState()).toBe('current');
		expect(screen.queryByRole('status')).toBeNull();
	});

	it('is not out of date because the database was deleted', async () => {
		const db = await thisTab();

		await (createDatabase(db.name) as Dexie).delete();

		expect(tabState()).toBe('current');
		// And carries on, in a database that is empty again.
		await db.prefs.put({ key: 'after', value: 'a fresh start' });
		expect(await db.prefs.get('before')).toBeUndefined();
	});

	it('finishes the writes that are under way before it lets go, and only then', async () => {
		const db = await thisTab();
		const held: { release: () => void } = { release: () => undefined };
		const release = beforeClosing(async () => {
			await new Promise<void>((resolve) => {
				held.release = resolve;
			});
			// As an editor's held edit is: a write that had not started yet.
			await db.prefs.put({ key: 'drawn', value: 'just now' });
		});
		const newer = newerBuild(db.name);

		const upgraded = newer.open();
		await vi.waitFor(() => {
			expect(tabState()).toBe('stale');
		});
		// The upgrade is waiting on this window, which has not closed yet.
		expect(db.isOpen()).toBe(true);

		held.release();
		await upgraded;
		release();

		expect(db.isOpen()).toBe(false);
		expect(await newer.table('prefs').get('drawn')).toEqual({
			key: 'drawn',
			value: 'just now',
		});
	});

	it('does not open the database again, whatever is asked of it afterwards', async () => {
		const db = await thisTab();
		const newer = newerBuild(db.name);
		await newer.open();

		await expect(db.prefs.put({ key: 'after', value: 'lost?' })).rejects.toMatchObject({
			name: 'DatabaseClosedError',
		});
		await expect(db.prefs.get('before')).rejects.toMatchObject({ name: 'DatabaseClosedError' });
		expect(db.isOpen()).toBe(false);
		// Not written by old code into a database it has never seen.
		expect(await newer.table('prefs').get('after')).toBeUndefined();
		expect(newer.verno).toBe(NEWER);
	});

	it('does not keep the upgrade waiting for ever on a write that never ends', async () => {
		const db = await thisTab();
		const release = beforeClosing(() => new Promise(() => undefined));
		const newer = newerBuild(db.name);
		const began = Date.now();

		const upgraded = newer.open();
		await vi.waitFor(() => {
			expect(tabState()).toBe('stale');
		});
		expect(db.isOpen()).toBe(true);
		// Real time: fake-indexeddb runs on the same timers a fake clock stops.
		await upgraded;
		release();

		expect(db.isOpen()).toBe(false);
		expect(Date.now() - began).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 50);
	}, 10_000);

	it('is out of date when it opens on a database already upgraded, with no event to say so', async () => {
		// Back from the back-forward cache, or an old build out of a stale cache:
		// nothing was open to hear `versionchange`, and Dexie opens an older
		// declaration against a newer database without complaint.
		const name = `stale-${crypto.randomUUID()}`;
		const newer = newerBuild(name);
		await newer.open();
		newer.close();

		const old = createDatabase(name);
		onTestFinished(watchTab(old));
		deleteAfterTest(old);
		// What an editor holds is not written: the newer schema is already
		// live, and this is old code that would be writing into it.
		const finish = vi.fn(() => old.prefs.put({ key: 'held', value: 'by the editor' }));
		const release = beforeClosing(finish);
		await old.open().catch(() => undefined);

		await vi.waitFor(() => {
			expect(old.isOpen()).toBe(false);
		});
		release();
		expect(finish).not.toHaveBeenCalled();
		expect(tabState()).toBe('stale');
		await expect(old.prefs.put({ key: 'after', value: 'lost?' })).rejects.toMatchObject({
			name: 'DatabaseClosedError',
		});
	});

	it('blocks the app behind a notice that offers the one thing left to do', async () => {
		const user = userEvent.setup();
		// Out of date since the tests above, and for good.
		expect(tabState()).toBe('stale');
		const reload = gate();

		const notice = screen.getByRole('alertdialog', { name: /can no longer save/ });
		expect(notice.textContent).toMatch(/newer version of the app is open in another window/);
		expect(screen.getByText('the app').closest('[inert]')).not.toBeNull();
		const button = screen.getByRole('button', { name: 'Reload' });
		expect(document.activeElement).toBe(button);

		await user.click(button);
		expect(reload).toHaveBeenCalledTimes(1);
	});

	it('can be put aside to export what the drawing holds, and goes on saying it cannot save', async () => {
		// Inert stops everything, export with it. A save the store refused earlier
		// says nothing yet, so the open drawing may hold what the store does not.
		const user = userEvent.setup();
		const reload = gate();

		await user.click(screen.getByRole('button', { name: 'Not yet' }));

		expect(screen.queryByRole('alertdialog')).toBeNull();
		expect(screen.getByText('the app').closest('[inert]')).toBeNull();
		expect(screen.getByRole('alert').textContent).toMatch(/cannot save/);
		await user.click(screen.getByRole('button', { name: 'Reload' }));
		expect(reload).toHaveBeenCalledTimes(1);
	});
});
