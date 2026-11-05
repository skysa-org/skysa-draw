import { type RefObject, useEffect } from 'react';

import type { DocumentSnapshot, EditorDocument } from '../document/model.js';
import { elementsOf } from '../tools/vector/hit.js';
import { hideSelection } from '../tools/vector/region.js';
import { clearSelectionBox, hiddenAsSeen } from '../tools/vector/selection.js';
import { NO_SELECTION } from './context.js';
import type { Observable } from './observable.js';

type SelectionFollows = Readonly<{
	document: EditorDocument;
	snapshot: DocumentSnapshot;
	layerId: string | undefined;
	selection: Observable<readonly Element[]>;
	overlay: RefObject<SVGSVGElement | null>;
	/** The overlay emptied of the tools' marks, unless a stroke is drawing its preview there. */
	clearOverlay: () => void;
}>;

/** The selection made `kept`, and the box around what was selected taken off the overlay. */
const keepOnly = (
	selection: Observable<readonly Element[]>,
	kept: readonly Element[],
	overlay: SVGSVGElement | null,
	clearOverlay: () => void
): void => {
	selection.set(kept.length === 0 ? NO_SELECTION : kept);
	if (overlay !== null) clearSelectionBox(overlay);
	clearOverlay();
};

/**
 * The selected elements follow the active layer and the drawing
 * (docs/ARCHITECTURE.md §7, "The editor"). What is selected is on the active
 * layer, and a key that deletes it acts on that layer: another layer made
 * active lets go of it, unless it is that layer's own, as it is when
 * Auto-select made the layer active under a press that selected an element
 * of it. An undo puts a layer's markup back, which replaces its elements: one
 * that left the drawing is no longer selected.
 *
 * The box around what is let go of goes with it at once, a press under way
 * or not. Auto-select makes another layer active inside a press, so a press
 * is always under way when its change of layer lets go of the selection, and
 * one that picked a raster layer draws no box over the old one, as the
 * select tool's does over what it pressed on a vector layer; the old box
 * stayed, around an element no longer selected. The rest of the overlay is
 * the tools', emptied only between strokes, so a stroke's preview stays
 * (`clearOverlay`). The area is the canvas's and outlives a change of layer,
 * as in Photoshop: it is not touched here.
 *
 * A layer hidden, or in a group hidden, keeps what is selected on it out of
 * sight: its box and outlines go, and the select tool draws the box again
 * once the layer is shown (`hiddenAsSeen`), as Photoshop's transform
 * controls go with a hidden layer and come back with it.
 */
export const useSelectionFollows = ({
	document,
	snapshot,
	layerId,
	selection,
	overlay,
	clearOverlay,
}: SelectionFollows): void => {
	useEffect(() => {
		const active = layerId === undefined ? undefined : document.layer(layerId);
		const own = active === undefined ? [] : elementsOf(active);
		const selected = selection.get();
		const kept = selected.filter((element) => own.includes(element));
		if (kept.length > 0 && kept.length === selected.length) return;
		keepOnly(selection, kept, overlay.current, clearOverlay);
	}, [document, layerId, selection, overlay, clearOverlay]);

	useEffect(() => {
		const selected = selection.get();
		const kept = selected.filter((element) => document.root.contains(element));
		if (kept.length === selected.length) return;
		keepOnly(selection, kept, overlay.current, clearOverlay);
	}, [document, snapshot, selection, overlay, clearOverlay]);

	useEffect(() => {
		const shown = overlay.current;
		if (shown !== null && hiddenAsSeen(snapshot.layers, layerId)) hideSelection(shown);
	}, [snapshot, layerId, overlay]);
};
