import { transformElements } from '../../document/elements.js';
import type { ToolContext } from '../types.js';
import { formatTransform, parseTransform, translate } from './geometry.js';
import { activeLayerElement, layerSpace, targetLayer } from './guard.js';
import { elementsAtPositions, positionsIn } from './hit.js';
import { showSelection } from './region.js';
import { movedBy } from './select.js';

/**
 * The arrows' nudge of what is selected on a vector layer, with the move tool
 * (docs/ARCHITECTURE.md §7, "The editor"), as Illustrator's arrows nudge the
 * objects selected: each element moved by its own `transform`, composed as a
 * drag of them composes it (`movedBy`, `select.ts`), so they go `dx` and `dy`
 * in the drawing's user units, the same distance on the screen and along its
 * axes whatever the layer's own placement, turned, flipped or scaled. One
 * command per key, the drag's own (`transformElements`) under its label, so
 * one undo puts them back, and a key held down costs the history the
 * attributes it changed, not copies of the layer; what was selected stays
 * selected, through the nudge and its undo, and its box is drawn again
 * around where it went. The nudge does not snap, as Photoshop's does not.
 *
 * Whether the elements were the arrows' to move: some are selected on the
 * active vector layer; otherwise the key is the caller's to pass on
 * (`viewport/chosenLayers.ts`). A layer locked or hidden, itself or by a
 * group around it, takes the key and moves nothing, and the guard says why
 * (`targetLayer`).
 */
export const nudgeElements = (context: ToolContext, dx: number, dy: number): boolean => {
	const before = context.layer?.kind === 'vector' ? activeLayerElement(context) : undefined;
	const positions = before === undefined ? [] : positionsIn(before, context.selection.elements);
	if (positions.length === 0) return false;
	// Found again, and their space read again, after the wrapping of a loose
	// layer, which may have moved them and their `transform`.
	const layer = targetLayer(context);
	if (layer === undefined) return true;
	const space = layerSpace(layer);
	const delta = translate(dx, dy);
	const finals = positions.flatMap((position) =>
		elementsAtPositions(layer, [position]).flatMap((element) => {
			const matrix = parseTransform(element.getAttribute('transform'));
			const value = movedBy(delta, space, matrix);
			return value === formatTransform(matrix) ? [] : [{ position, value }];
		})
	);
	if (finals.length === 0) return true;
	context.document.execute(transformElements(layer.id, 'tools.select', finals));
	const now = elementsAtPositions(context.document.layer(layer.id), positions);
	context.selection.set(now);
	showSelection(context, now, true);
	return true;
};
