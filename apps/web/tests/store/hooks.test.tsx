import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bindConnection, showConnection } from '../../src/store/connection.js';
import { db, LOCAL_CONNECTION_ID } from '../../src/store/db.js';
import { createDrawing, deleteDrawing } from '../../src/store/drawings.js';
import { createFolder } from '../../src/store/folders.js';
import { useDrawing, useDrawings, useFolders } from '../../src/store/hooks.js';

/**
 * The store as the screens read it, over the app's own database. Ported from
 * skysa-notes' `tests/hooks.test.tsx` for the three hooks the app has; the
 * rest of that file is about the sidebar, the scratchpad and search, which
 * this app does not have.
 */

/** What `useDrawing` answered, by id where it is a row. */
const answered = (found: ReturnType<typeof useDrawing>) =>
	typeof found === 'string' ? found : found.id;

describe('useDrawing', () => {
	it('reads the open drawing', async () => {
		const drawing = await createDrawing(db, { title: 'Open' });
		const { result } = renderHook(() => answered(useDrawing(drawing.id)));

		expect(result.current).toBe('loading');
		await waitFor(() => {
			expect(result.current).toBe(drawing.id);
		});
	});

	/**
	 * `db.drawings.get` returns a tombstone like any other row. The list has
	 * already dropped it, so returning it here left the drawing fully editable
	 * after the rest of the app moved on — and anything drawn went into a row
	 * that is purged once the delete is pushed.
	 */
	it('lets go of a drawing once it is tombstoned', async () => {
		const drawing = await createDrawing(db, { title: 'Open' });
		const { result } = renderHook(() => answered(useDrawing(drawing.id)));
		await waitFor(() => {
			expect(result.current).toBe(drawing.id);
		});

		await deleteDrawing(db, drawing.id);

		await waitFor(() => {
			expect(result.current).toBe('missing');
		});
	});

	it('finds the drawing in the source showing, and not one of the same id in another', async () => {
		const here = await createDrawing(db, { title: 'Here' });
		await bindConnection(db, { connectionId: 'c1', provider: 'dropbox' });
		await db.drawings.put({ ...here, connectionId: 'c1', title: 'There' });
		await showConnection(db, LOCAL_CONNECTION_ID);
		const { result } = renderHook(() => useDrawing(here.id));
		await waitFor(() => {
			expect(result.current).toMatchObject({ connectionId: LOCAL_CONNECTION_ID });
		});

		await showConnection(db, 'c1');

		await waitFor(() => {
			expect(result.current).toMatchObject({ connectionId: 'c1', title: 'There' });
		});
	});
});

describe('useDrawings and useFolders', () => {
	it('list the live drawings of one folder, last changed first, and every folder', async () => {
		await createFolder(db, 'Work');
		const first = await createDrawing(db, { title: 'First', folderPath: 'Work', now: () => 1 });
		const second = await createDrawing(db, {
			title: 'Second',
			folderPath: 'Work',
			now: () => 2,
		});
		const gone = await createDrawing(db, { title: 'Gone', folderPath: 'Work', now: () => 3 });
		await createDrawing(db, { title: 'Loose' });
		await deleteDrawing(db, gone.id);

		const { result } = renderHook(() => ({
			listed: useDrawings('Work')?.map((drawing) => drawing.id),
			folders: useFolders()?.map((folder) => folder.path),
		}));

		await waitFor(() => {
			expect(result.current).toEqual({ listed: [second.id, first.id], folders: ['Work'] });
		});
	});
});
