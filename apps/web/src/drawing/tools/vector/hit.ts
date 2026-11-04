import { isGraphicsElement } from '@skysa/draw-core';

import {
	type Box,
	boxContains,
	boxesIntersect,
	parseTransform,
	type Point,
	transformBox,
} from './geometry.js';
import type { Measure } from './measure.js';

/**
 * Finding what is under the pointer on a vector layer, by boxes: an element's
 * measured box, placed by its own `transform`, in the layer's user units. A
 * box is coarser than the shape itself, which is what a user of a select tool
 * expects of a click near a thin line, and what the eraser and the fill need.
 */

/**
 * The elements a layer holds, in paint order: the graphics children of a
 * `<g>`, and a loose layer, which is one graphics element at the root, itself.
 */
export const elementsOf = (layer: Element): readonly Element[] =>
	layer.localName === 'g'
		? [...layer.children].filter((child) => isGraphicsElement(child.localName))
		: [layer];

/**
 * Where each of `elements` that is the layer's own sits among its elements. A
 * command finds them again by these, in the layer it looks up by id, rather
 * than holding them, which an undo that rebuilt the layer, or the wrapping of a
 * loose one, would leave behind (`Command`, docs/ARCHITECTURE.md §7). An
 * element of another layer has no place here, so no command of this layer's
 * changes it.
 */
export const positionsIn = (layer: Element, elements: readonly Element[]): readonly number[] => {
	const own = elementsOf(layer);
	return elements.map((element) => own.indexOf(element)).filter((position) => position >= 0);
};

/** The layer's elements at `positions`, as the layer is now; none for a position it no longer has. */
export const elementsAtPositions = (
	layer: Element | undefined,
	positions: readonly number[]
): readonly Element[] => {
	const own = layer === undefined ? [] : elementsOf(layer);
	return positions.flatMap((position) => own.slice(position, position + 1));
};

/** Where an element is in the layer: its measured box, after its own `transform`. */
export const placedBox = (measure: Measure, element: Element): Box =>
	transformBox(parseTransform(element.getAttribute('transform')), measure(element));

/** Every element whose box holds `point`, grown by `slop`, bottom to top. */
export const elementsAt = (
	elements: readonly Element[],
	point: Point,
	measure: Measure,
	slop = 0
): readonly Element[] =>
	elements.filter((element) => boxContains(placedBox(measure, element), point, slop));

/** The topmost element under `point`: the last painted, so the one seen. */
export const topmostAt = (
	elements: readonly Element[],
	point: Point,
	measure: Measure,
	slop = 0
): Element | undefined => elementsAt(elements, point, measure, slop).at(-1);

/** Every element whose box touches `box`: what a marquee takes. */
export const elementsIn = (
	elements: readonly Element[],
	box: Box,
	measure: Measure
): readonly Element[] =>
	elements.filter((element) => boxesIntersect(placedBox(measure, element), box));

/**
 * A paint property as the element has it: `style` first, since CSS wins over a
 * presentation attribute, then the attribute, then up the tree as far as
 * `stopAt`, since `fill` and `stroke` inherit; `fallback` where nothing says.
 */
export const paintedColour = (
	element: Element,
	property: 'fill' | 'stroke',
	stopAt: Element,
	fallback: string
): string => {
	const styled = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`).exec(
		element.getAttribute('style') ?? ''
	);
	const own = styled?.[1]?.trim() ?? element.getAttribute(property)?.trim();
	if (own !== undefined && own !== '') return own;
	const parent = element.parentElement;
	if (element === stopAt || parent === null) return fallback;
	return paintedColour(parent, property, stopAt, fallback);
};

/** `style` without one property, so an attribute set beside it is what shows. */
export const withoutStyleProperty = (style: string, property: string): string =>
	style
		.split(';')
		.map((declaration) => declaration.trim())
		.filter(
			(declaration) =>
				declaration !== '' && !new RegExp(`^${property}\\s*:`, 'i').test(declaration)
		)
		.join('; ');
