import { createContext, Fragment, type ReactNode, useContext } from 'react';

import { db, type DrawDatabase } from './db.js';

/**
 * Which database the screens read: the app's own, or one a test hands in. The
 * store's functions take a database as their first argument for the same
 * reason, so a test never has to empty the shared one between cases.
 */
const DatabaseContext = createContext<DrawDatabase>(db);

/**
 * What it holds is drawn afresh for another database, by its name (one name,
 * one database): a hook's answers were read from the one before, and none of
 * them is checked against which database it came from.
 */
export const DatabaseProvider = ({
	database,
	children,
}: {
	database: DrawDatabase;
	children: ReactNode;
}) => (
	<DatabaseContext.Provider value={database}>
		<Fragment key={database.name}>{children}</Fragment>
	</DatabaseContext.Provider>
);

/** The database the component is drawn over: the app's, outside a provider. */
export const useDb = (): DrawDatabase => useContext(DatabaseContext);
