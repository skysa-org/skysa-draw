import { expect } from 'vitest';

import type { MemoryStore } from '../memoryStore.js';

/**
 * What must be true of the store between batches, whatever the provider said,
 * for a test file to assert after every test (`afterEach`) rather than in the
 * handful that happen to think of it.
 *
 * - **No anomalies.** The store forgives a `delete-drawing` for a drawing that is not
 *   there, because a batch that rejects is a batch that is retried for ever.
 *   That forgiveness must never be what is holding a test up.
 * - **One drawing per path, one per remote id.** Two rows at one path is a drawing
 *   the sidebar shows twice and two queued writes racing for one file; two
 *   rows with one `remoteId` is worse — `drawingByRemoteId` only ever hands back
 *   one of them, so the other is stale for ever and every edit to it conflicts.
 * - **The same two for files:** a picture shown twice, or a link the store
 *   cannot keep.
 *
 * Each is a soft assertion, so a store wrong in two ways says both.
 */
export const expectSoundStore = (store: MemoryStore): void => {
	expect.soft(store.anomalies()).toEqual([]);
	const drawings = store.drawings();
	const drawingPaths = drawings.map((drawing) => drawing.path);
	expect.soft(drawingPaths).toEqual([...new Set(drawingPaths)]);
	const drawingRemotes = drawings.flatMap((drawing) =>
		drawing.remoteId === undefined ? [] : [drawing.remoteId]
	);
	expect.soft(drawingRemotes).toEqual([...new Set(drawingRemotes)]);
	const files = store.files();
	const filePaths = files.map((file) => file.path);
	expect.soft(filePaths).toEqual([...new Set(filePaths)]);
	const fileRemotes = files.flatMap((file) =>
		file.remoteId === undefined ? [] : [file.remoteId]
	);
	expect.soft(fileRemotes).toEqual([...new Set(fileRemotes)]);
};
