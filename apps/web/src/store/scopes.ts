import type { Table } from 'dexie';

import type { DrawDatabase } from './db.js';

/**
 * The tables a transaction opens, for the transactions that open many (skysa-notes #452).
 * A writer that asks for a table its caller's transaction did not open fails
 * there with a `SubTransactionError`, so the ones that nest share a list
 * rather than each spelling theirs. A wider scope than the work needs holds
 * more of the database from other tabs and other work for longer, so a
 * transaction with less to do still names its own.
 */

/**
 * Typed as plain tables: a transaction asks no more of them, and an inferred
 * list would make every record type in it part of this module's exports.
 */
type Tables = Table[];

/**
 * Every writer in `store/drawings.ts` and `store/folders.ts` opens this,
 * whether or not it touches every table in it: one caller wraps several
 * writers in a transaction of its own, and the sync store's batch writes
 * under the same list. The files are in it because a folder's delete takes
 * the files in it.
 */
export const writerTables = (db: DrawDatabase): Tables => [
	db.drawings,
	db.folders,
	db.opQueue,
	db.syncState,
	db.prefs,
	db.files,
	db.fileBytes,
];

/**
 * Everything a source has on this device: what it is moved, detached or let go
 * with. The credential too, so that a source let go loses its rows and the
 * key to its account together.
 */
export const sourceTables = (db: DrawDatabase): Tables => [...writerTables(db), db.credentials];
