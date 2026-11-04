import { useSyncExternalStore } from 'react';

import type { DocumentSnapshot, EditorDocument } from './model.js';

/** For no document: nothing to listen to. One function, so React keeps its subscription. */
const NOTHING_TO_SUBSCRIBE = (): (() => void) => () => undefined;

/**
 * The open document's snapshot, re-read whenever a command, an undo or a redo
 * changes it (docs/ARCHITECTURE.md §7, "Commands and history"); `undefined`
 * while there is no document. The snapshot is the same object until the next
 * change, as `useSyncExternalStore` asks.
 */
export const useDocumentSnapshot = (
	document: EditorDocument | undefined
): DocumentSnapshot | undefined =>
	useSyncExternalStore(document?.subscribe ?? NOTHING_TO_SUBSCRIBE, () => document?.snapshot());
