import { colorDistance, parseColor, type Rgba } from '../raster/pixels.js';
import { onRelease } from '../raster/wand.js';
import type { ToolBehavior } from '../types.js';
import { apply } from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace } from './guard.js';
import { elementsOf, paintedColor, topmostAt } from './hit.js';
import type { Measure } from './measure.js';
import { showSelection } from './region.js';

/**
 * The magic wand on a vector layer (docs/decisions/0004-the-interface.md:
 * "Select elements of a color"), as Illustrator's with its default, the
 * fill: a click on an element selects every element of the active layer
 * painted within `tolerance` of it, by the raster wand's distance
 * (`colorDistance`), in paint order. Shift adds them to what is selected;
 * a click on nothing deselects, and with Shift keeps what there is. The
 * area is dropped, as the marquee drops it on a vector layer, and the
 * selection is shown as the marquee shows it, outlined until the select
 * tool takes it up.
 *
 * What an element is painted with is its fill where that is a color, and
 * its stroke where the fill is not one (none, a gradient, a pattern) but the
 * stroke is, so a click on a line drawn with the pencil, which has no fill,
 * selects the lines of its color. A filled element matches only filled
 * ones, and a stroked one only stroked ones, so a click on a red line does
 * not take every shape filled red. A `<line>` has no inside and is matched
 * by its stroke; an `<image>` is painted with neither, and matches nothing,
 * so a click on one selects it alone. A color is read as the eyedropper reads
 * it (`paintedColor`, inherited where the element does not set it), and
 * understood where `parseColor` understands it, `#rgb` and `rgb()`; a named
 * color is not one, as it is not anywhere the tools read colors.
 *
 * `contiguous` does not apply here, and Illustrator's wand has nothing like
 * it: elements do not touch as pixels do. Selecting changes nothing, but it
 * is the way to moving and deleting, so a locked or a hidden layer says so,
 * as the select tool and the marquee do.
 */

/** How an element is painted, for the wand: by which of its paints, and in what color. */
type Paint = Readonly<{ by: 'fill' | 'stroke'; color: Rgba }>;

/** What SVG paints with where nothing says: a black fill, and no stroke. */
const DEFAULTS = { fill: '#000000', stroke: 'none' } as const;

const colorOf = (element: Element, property: 'fill' | 'stroke', root: Element): Rgba | undefined =>
	parseColor(paintedColor(element, property, root, DEFAULTS[property]));

/** What the element is painted with; none for one painted with no color. */
const paintOf = (element: Element, root: Element): Paint | undefined => {
	if (element.localName === 'image') return undefined;
	const fill = element.localName === 'line' ? undefined : colorOf(element, 'fill', root);
	if (fill !== undefined) return { by: 'fill', color: fill };
	const stroke = colorOf(element, 'stroke', root);
	return stroke === undefined ? undefined : { by: 'stroke', color: stroke };
};

/** Whether two paints are the same kind, and their colors within `tolerance`. */
const matches = (a: Paint | undefined, b: Paint, tolerance: number): boolean =>
	a !== undefined && a.by === b.by && colorDistance(a.color, b.color) <= tolerance;

export const createWand = (measure: Measure): ToolBehavior =>
	onRelease((context, sample) => {
		if (guardLayer(context) === undefined) return;
		const layer = activeLayerElement(context);
		if (layer === undefined) return;
		context.region.set(undefined);
		const elements = elementsOf(layer);
		const point = apply(layerSpace(layer).into, { x: sample.x, y: sample.y });
		const hit = topmostAt(elements, point, measure);
		const { root } = context.document;
		const paint = hit === undefined ? undefined : paintOf(hit, root);
		const tolerance = Math.max(0, context.options.tolerance);
		const found = new Set(
			paint === undefined
				? [hit].filter((element) => element !== undefined)
				: elements.filter((element) => matches(paintOf(element, root), paint, tolerance))
		);
		const kept = new Set(sample.shiftKey ? context.selection.elements : []);
		// In paint order, and only the layer's own: a selection left from
		// another layer is not this one's to keep.
		const next = elements.filter((element) => kept.has(element) || found.has(element));
		context.selection.set(next);
		showSelection(context, next, false);
	});
