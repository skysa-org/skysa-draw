import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { DatabaseProvider, useDb } from '../../src/store/database.js';
import { db } from '../../src/store/db.js';
import { createDrawing } from '../../src/store/drawings.js';
import { useDrawing } from '../../src/store/hooks.js';
import { freshDatabase } from '../support/db.js';

/**
 * The database a component reads (skysa-notes #455): the one the provider above it names,
 * and the app's own where none does.
 */

describe('the database a component is drawn over', () => {
	it('is the app’s own outside a provider', () => {
		const { result } = renderHook(useDb);

		expect(result.current).toBe(db);
	});

	it('is the provider’s, for the store’s hooks as well', async () => {
		const own = freshDatabase();
		const theirs = await createDrawing(own, { title: 'Theirs' });
		const wrapper = ({ children }: { children: ReactNode }) => (
			<DatabaseProvider database={own}>{children}</DatabaseProvider>
		);

		const { result } = renderHook(() => ({ db: useDb(), drawing: useDrawing(theirs.id) }), {
			wrapper,
		});

		expect(result.current.db).toBe(own);
		await waitFor(() => {
			expect(result.current.drawing).toMatchObject({ title: 'Theirs' });
		});
		expect(await db.drawings.count()).toBe(0);
	});

	it('is never read from the one before, where the provider is given another', async () => {
		const first = freshDatabase();
		const second = freshDatabase();
		const drawing = await createDrawing(first, { title: 'First' });
		await createDrawing(second, { title: 'Second', id: drawing.id });
		const current = { db: first };
		const titleOf = (found: ReturnType<typeof useDrawing>) =>
			typeof found === 'string' ? found : found.title;
		const { result, rerender } = renderHook(() => titleOf(useDrawing(drawing.id)), {
			wrapper: ({ children }: { children: ReactNode }) => (
				<DatabaseProvider database={current.db}>{children}</DatabaseProvider>
			),
		});
		await waitFor(() => {
			expect(result.current).toBe('First');
		});

		current.db = second;
		rerender();

		expect(result.current).toBe('loading');
		await waitFor(() => {
			expect(result.current).toBe('Second');
		});
	});
});
