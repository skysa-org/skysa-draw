import { areaPolygons, areaTouchesBox } from '../raster/area.js';
import { areaDrag } from '../raster/region.js';
import type { ToolBehaviour, ToolContext } from '../types.js';
import { type Box, transformBox, unionBox } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace } from './guard.js';
import { elementsOf, placedBox } from './hit.js';
import { measureOf } from './measure.js';
import { clearSelectionBox, drawSelectionBox } from './selection.js';
import { createSvg } from './svg.js';

/**
 * The marquee and the lasso on a vector layer
 * (docs/decisions/0004-the-interface.md: "Select elements in a region"): the
 * same drag as on a raster layer (`raster/region.ts`), and at its end every
 * element of the active layer whose box the area touches is selected, in
 * place of what was, or as well with Shift held as the drag began. The area
 * itself is then dropped: on a vector layer it was the way to the selection,
 * and nothing paints inside it. A click selects nothing.
 *
 * The selection is the viewport's, as the select tool's is, and stays when
 * the select tool is picked next, which shows its box and handles; until
 * then each element selected is outlined here, so the user sees what Delete
 * would take. A locked or a hidden layer says so, as the select tool does.
 */

/** The attribute that marks the outlines, so they can be found and replaced. */
const OUTLINE = 'data-draw-region-outline';

/** The overlay's chrome, in the app's accent (`CHROME_STYLE`), with nothing filled. */
const OUTLINE_STYLE = 'stroke: var(--accent, #2563eb); fill: none';

/** Where an element sits in the drawing's user units: its box, out of the layer's space. */
const boxIn = (layer: Element, element: Element): Box =>
	transformBox(layerSpace(layer).outOf, placedBox(measureOf, element));

const clearOutlines = (overlay: SVGSVGElement): void => {
	overlay.querySelectorAll(`[${OUTLINE}]`).forEach((element) => element.remove());
};

/**
 * The selection shown on the overlay: a dashed outline round each element,
 * or, with `handles`, the select tool's own box and handles, which that tool
 * then works from, so the two never disagree. Nothing for nothing selected.
 */
const showSelection = (
	context: ToolContext,
	elements: readonly Element[],
	handles: boolean
): void => {
	const { overlay } = context;
	clearOutlines(overlay);
	const layer = activeLayerElement(context);
	if (layer === undefined) return;
	const boxes = elements.map((element) => boxIn(layer, element));
	if (handles) {
		drawSelectionBox(overlay, unionBox(boxes), context.viewport.scale);
		return;
	}
	if (boxes.length === 0) return;
	const owner = overlay.ownerDocument;
	const group = createSvg(owner, 'g', {
		[OUTLINE]: '',
		style: OUTLINE_STYLE,
		'pointer-events': 'none',
	});
	boxes.forEach((box) =>
		group.appendChild(
			createSvg(owner, 'rect', {
				...box,
				'stroke-dasharray': '4 4',
				'vector-effect': 'non-scaling-stroke',
			})
		)
	);
	overlay.appendChild(group);
};

/**
 * What shows the selection gone from the overlay, the outlines and the select
 * tool's box alike, once what they showed is deleted or let go; whatever else
 * a tool keeps there stays.
 */
export const hideSelection = (overlay: SVGSVGElement): void => {
	clearOutlines(overlay);
	clearSelectionBox(overlay);
};

/**
 * Select-all on a vector layer (Ctrl or ⌘ A): every element of the active
 * layer, shown as `showSelection` shows it. Whether there was a layer to
 * select in.
 */
export const selectEveryElement = (context: ToolContext, handles: boolean): boolean => {
	const layer = activeLayerElement(context);
	if (layer === undefined) return false;
	const every = elementsOf(layer);
	context.selection.set(every);
	showSelection(context, every, handles);
	return true;
};

/** Every element of the layer whose box the area touches, bottom to top. */
const touchedBy = (layer: Element, path: string): readonly Element[] => {
	const polygons = areaPolygons(path);
	return elementsOf(layer).filter((element) => areaTouchesBox(polygons, boxIn(layer, element)));
};

export const createRegionSelect = (kind: 'marquee' | 'lasso'): ToolBehaviour =>
	areaDrag(
		kind,
		(context, path, adding) => {
			context.region.set(undefined);
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const kept = adding ? context.selection.elements : [];
			const found = path === undefined ? [] : touchedBy(layer, path);
			// In paint order, and only the layer's own: a selection left from
			// another layer is not this one's to keep.
			const next = elementsOf(layer).filter(
				(element) => kept.includes(element) || found.includes(element)
			);
			context.selection.set(next);
			showSelection(context, next, false);
		},
		(context) => guardLayer(context) !== undefined
	);
