import type Dexie from 'dexie';

import { createDatabase, db, type DrawDatabase } from '../../src/store/db.js';

/**
 * How a test gets a database, and how it gets rid of it. Both are wired into
 * `tests/setup.ts`, so no test file clears tables or deletes databases itself.
 *
 * A test that can hand a database in asks `freshDatabase` for one of its own,
 * deleted after the test; a component is handed one by drawing it inside a
 * `DatabaseProvider` (`store/database.tsx`). A test of something that reads
 * the app's own database uses that, and it is emptied after every test.
 */

const opened: Dexie[] = [];

/** A database of the test's own, under a name nobody else has. Deleted after the test. */
export const freshDatabase = (): DrawDatabase => {
	const made = createDatabase(`test-${crypto.randomUUID()}`);
	opened.push(made);
	return made;
};

export const deleteFreshDatabases = async (): Promise<void> => {
	await Promise.all(opened.splice(0).map((each) => each.delete()));
};

/** The app's database emptied, every table: what a fresh page load would find. */
export const resetSharedDb = async (): Promise<void> => {
	if (!db.isOpen()) return;
	await Promise.all(db.tables.map((table) => table.clear()));
};
