import { useSyncExternalStore } from 'react';

import type { DocumentSnapshot } from '../document/model.js';
import type { SelectionFacts } from '../selectionActions.js';
import type { Region } from '../tools/types.js';
import { NO_SELECTION } from './context.js';
import { type Observable, observable } from './observable.js';

/**
 * The two selections (docs/ARCHITECTURE.md §7, "The editor"): the area the
 * marquee and the lasso make, and the elements selected on a vector layer.
 * The frame holds them, so that its selection bar shows what the viewport's
 * context menu shows; the viewport works them, as its tools and keys set
 * them, and one given none keeps its own.
 */
export type ViewportSelection = Readonly<{
	region: Observable<Region | undefined>;
	elements: Observable<readonly Element[]>;
	/**
	 * Whether the area's outline is being transformed (Transform selection),
	 * which the viewport works and the frame's selection bar shows as Apply
	 * and Cancel.
	 */
	transforming: Observable<boolean>;
}>;

export const createViewportSelection = (): ViewportSelection => ({
	region: observable<Region | undefined>(undefined),
	elements: observable(NO_SELECTION),
	transforming: observable(false),
});

/**
 * What the selection's actions are built from (`selectionActions.ts`), as
 * React reads it: anew whenever the selection, the layers or the history
 * change, so the menu and the bar say what can be done now.
 */
export const useSelectionFacts = (
	selection: ViewportSelection,
	snapshot: DocumentSnapshot,
	layerId: string | undefined
): SelectionFacts => {
	const region = useSyncExternalStore(selection.region.subscribe, selection.region.get);
	const elements = useSyncExternalStore(selection.elements.subscribe, selection.elements.get);
	const transforming = useSyncExternalStore(
		selection.transforming.subscribe,
		selection.transforming.get
	);
	return {
		region,
		elements: elements.length,
		layer: snapshot.layers.find((layer) => layer.id === layerId),
		canUndo: snapshot.canUndo,
		canRedo: snapshot.canRedo,
		transforming,
	};
};
