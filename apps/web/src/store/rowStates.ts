import type { DrawingRecord } from './db.js';

/**
 * What state a row is in, asked by name rather than by its flag (skysa-notes #452). A drawing
 * deleted on this device stays as a row until the delete is sent: a tombstone,
 * which nothing but the sync and an undo should treat as a drawing.
 */

/** A drawing that is there to be shown and edited. `undefined`, which is no drawing, is not. */
export const isLive = (drawing: Pick<DrawingRecord, 'deletedLocally'> | undefined): boolean =>
	drawing?.deletedLocally === 0;

/** A drawing deleted on this device, kept until the delete is sent. `undefined` is not one. */
export const isTombstone = (drawing: Pick<DrawingRecord, 'deletedLocally'> | undefined): boolean =>
	drawing?.deletedLocally === 1;

/**
 * A row as the editor is handed it (`useDrawing`): `missing` where there is
 * none, or it is a tombstone, waiting only for its delete to be sent.
 */
export const foundOf = (row: DrawingRecord | undefined): DrawingRecord | 'missing' =>
	row !== undefined && isLive(row) ? row : 'missing';

/**
 * A source that syncs: not one detached, which is kept only for what it never
 * sent (`SyncStateRecord.detached`).
 */
export const isLiveSource = (source: Readonly<{ detached?: unknown }>): boolean =>
	source.detached === undefined;
