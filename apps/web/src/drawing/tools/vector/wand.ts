import { areaModeOf } from '../../keys.js';
import { colorDistance, parseColor, type Rgba } from '../raster/pixels.js';
import { onRelease } from '../raster/wand.js';
import type { ToolBehavior } from '../types.js';
import { activeLayerElement, guardLayer, layerSpace } from './guard.js';
import { elementsOf, paintedColor, topmostAt } from './hit.js';
import type { Measure } from './measure.js';
import { combineElements, showSelection } from './region.js';

/**
 * The magic wand on a vector layer (docs/decisions/0004-the-interface.md:
 * "Select elements of a color"), as Illustrator's with its default, the
 * fill: a click on an element selects every element of the active layer
 * painted within `tolerance` of it, by the raster wand's distance
 * (`colorDistance`), in paint order. They meet what is selected in the
 * click's mode, as the marquee's do (`combineElements`), by the option or
 * by Shift, Alt or both held as the press began (`areaModeOf`): in place of
 * it, added to it, taken from it, or only those in both. A click on nothing
 * finds nothing, which deselects in a new selection and leaves the
 * selection in the other modes. The area is dropped, as the marquee drops
 * it on a vector layer, and the selection is shown as the marquee shows it,
 * outlined until the select tool takes it up.
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

/**
 * What a click on `hit` finds: every element painted near it, or it alone
 * where it is painted with no color.
 */
const foundFrom = (
	elements: readonly Element[],
	hit: Element,
	root: Element,
	tolerance: number
): readonly Element[] => {
	const paint = paintOf(hit, root);
	return paint === undefined
		? [hit]
		: elements.filter((element) => matches(paintOf(element, root), paint, tolerance));
};

export const createWand = (measure: Measure): ToolBehavior =>
	onRelease((context, sample) => {
		if (guardLayer(context) === undefined) return;
		const layer = activeLayerElement(context);
		if (layer === undefined) return;
		context.region.set(undefined);
		const elements = elementsOf(layer);
		const point = { x: sample.x, y: sample.y };
		const hit = topmostAt(elements, point, measure, 0, layerSpace(layer).outOf);
		const tolerance = Math.max(0, context.options.tolerance);
		const found =
			hit === undefined
				? undefined
				: foundFrom(elements, hit, context.document.root, tolerance);
		const mode = areaModeOf(sample, context.options.areaMode);
		const next = combineElements(elements, context.selection.elements, found, mode);
		context.selection.set(next);
		showSelection(context, next, false);
	});
