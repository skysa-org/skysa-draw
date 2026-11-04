import { DRAWING_NAMESPACE, LAYER_ATTRIBUTES } from '@skysa/draw-core';

import { elementsAtPositions, elementsOf } from '../tools/vector/hit.js';
import {
	attributeCommand,
	compound,
	copyOf,
	editLayer,
	placeCopy,
	withLayerId,
} from './commands.js';
import { spaceBefore } from './dom.js';
import { freeLayerId, writeLayerKind } from './layers.js';
import type { Command } from './model.js';
import { INKSCAPE_NAMESPACE } from './namespaces.js';

/**
 * Layer via copy and layer via cut on a vector layer
 * (docs/decisions/0004-the-interface.md, "The context menu"): the selected
 * elements, in a new vector layer directly above theirs, where they were. The
 * new layer is the old one's copy with only those elements left in it, so it
 * keeps the old one's transform, opacity, blend mode, style and definitions,
 * and the elements draw just where they did; it goes by its number, as
 * Photoshop names a layer via copy, rather than by a name two layers would
 * then share. A cut takes the elements out of the old layer too, and they
 * keep their ids, having moved rather than been copied, so what refers to
 * them still finds them. One step of the history either way.
 *
 * The elements are named by their places among the layer's own (`positionsIn`
 * in `tools/vector/hit.ts`), which the command finds again on every apply.
 */

export type LayerVia = 'copy' | 'cut';

const LABELS: Readonly<Record<LayerVia, string>> = {
	copy: 'selection.history.layerViaCopy',
	cut: 'selection.history.layerViaCut',
};

/** An element taken out with the indentation before it, so the markup left reads as it did. */
const removeWithSpace = (element: Element): void => {
	spaceBefore(element)?.remove();
	element.remove();
};

/** Whether `element` is one of `moved`, or inside one. */
const within = (moved: readonly Element[], element: Element): boolean =>
	moved.some((each) => each.contains(element));

/**
 * The new layer: the old one copied under `id`, the elements not at
 * `positions` taken out of the copy, and its name with them. For a cut, what
 * is moved keeps its ids.
 */
const extracted = (
	root: SVGSVGElement,
	original: Element,
	id: string,
	positions: readonly number[],
	how: LayerVia
): Element => {
	const copy = copyOf(
		root,
		original,
		id,
		how === 'cut'
			? (element, made) => within(elementsAtPositions(made, positions), element)
			: undefined
	);
	const moved = elementsAtPositions(copy, positions);
	elementsOf(copy)
		.filter((element) => !moved.includes(element))
		.forEach(removeWithSpace);
	copy.removeAttributeNS(DRAWING_NAMESPACE, LAYER_ATTRIBUTES.name);
	copy.removeAttributeNS(INKSCAPE_NAMESPACE, 'label');
	return copy;
};

/**
 * The elements at `positions` among the vector layer `layerId`'s own, copied
 * or cut into a new vector layer directly above it. The new layer says it is
 * vector, so a copy left holding one `<image>` is not then read as raster.
 * Nothing for no positions: the caller has a selection to give.
 */
export const layerViaElements = (
	root: SVGSVGElement,
	layerId: string,
	positions: readonly number[],
	how: LayerVia
): Command & Readonly<{ id: string }> => {
	const id = freeLayerId(root);
	const label = LABELS[how];
	const parts: readonly Command[] = [
		placeCopy(layerId, label, (live, original) =>
			extracted(live, original, id, positions, how)
		),
		attributeCommand(id, label, (live, layer) => writeLayerKind(live, layer, 'vector')),
		...(how === 'cut'
			? [
					editLayer(layerId, label, (layer) => {
						elementsAtPositions(layer, positions).forEach(removeWithSpace);
					}),
				]
			: []),
	];
	return withLayerId(id, compound(label, parts));
};
