import { createContext, type ReactNode, useContext } from 'react';

import { db, type DrawDatabase } from './db.js';

/**
 * Which database the screens read: the app's own, or one a test hands in. The
 * store's functions take a database as their first argument for the same
 * reason, so a test never has to empty the shared one between cases.
 */
const DatabaseContext = createContext<DrawDatabase>(db);

export const DatabaseProvider = ({
	database,
	children,
}: {
	database: DrawDatabase;
	children: ReactNode;
}) => <DatabaseContext.Provider value={database}>{children}</DatabaseContext.Provider>;

export const useDb = (): DrawDatabase => useContext(DatabaseContext);
