import { type LayerVia, layerViaElements } from '../../document/layerVia.js';
import { areaPolygons, areaTouchesBox } from '../raster/area.js';
import { areaDrag } from '../raster/region.js';
import type { ToolBehavior, ToolContext } from '../types.js';
import { type Box, transformBox, unionBox } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { elementsOf, placedBox, positionsIn } from './hit.js';
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
 * The selection shown on the overlay: a dashed outline around each element,
 * or, with `handles`, the select tool's own box and handles, which that tool
 * then works from, so the two never disagree. Nothing for nothing selected.
 */
export const showSelection = (
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

/**
 * Select inverse on a vector layer: the layer's elements that are not
 * selected, in place of those that are, shown as `showSelection` shows them;
 * none where every one was. Whether there was a layer to select in.
 */
export const selectOtherElements = (context: ToolContext, handles: boolean): boolean => {
	const layer = activeLayerElement(context);
	if (layer === undefined) return false;
	const selected = context.selection.elements;
	const others = elementsOf(layer).filter((element) => !selected.includes(element));
	context.selection.set(others);
	showSelection(context, others, handles);
	return true;
};

/** The box around what is selected, in the drawing's user units; none for nothing selected. */
export const selectedBox = (context: ToolContext): Box | undefined => {
	const layer = activeLayerElement(context);
	if (layer === undefined) return undefined;
	const own = elementsOf(layer);
	const boxes = context.selection.elements
		.filter((element) => own.includes(element))
		.map((element) => boxIn(layer, element));
	return unionBox(boxes);
};

/**
 * Layer via copy or cut on a vector layer (`document/layerVia.ts`): the
 * selected elements into a new layer above theirs, by one command, after the
 * guard every vector tool passes (a loose layer wrapped first, as an edit
 * wraps it), and the selection let go, as Photoshop leaves it. The new
 * layer's id, for the caller to make active; none where nothing was made.
 */
export const layerViaSelection = (context: ToolContext, how: LayerVia): string | undefined => {
	if (context.selection.elements.length === 0 || guardLayer(context) === undefined) {
		return undefined;
	}
	const layer = activeLayerElement(context);
	const positions = layer === undefined ? [] : positionsIn(layer, context.selection.elements);
	if (positions.length === 0) return undefined;
	const target = targetLayer(context);
	if (target === undefined) return undefined;
	const made = layerViaElements(context.document.root, target.id, positions, how);
	context.document.execute(made);
	context.selection.clear();
	hideSelection(context.overlay);
	return made.id;
};

/** Every element of the layer whose box the area touches, bottom to top. */
const touchedBy = (layer: Element, path: string): readonly Element[] => {
	const polygons = areaPolygons(path);
	return elementsOf(layer).filter((element) => areaTouchesBox(polygons, boxIn(layer, element)));
};

export const createRegionSelect = (kind: 'marquee' | 'lasso'): ToolBehavior =>
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
