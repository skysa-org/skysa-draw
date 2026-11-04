import type { Box } from './geometry.js';

/**
 * How big an element is, in its own user units and before its own `transform`,
 * which is what `getBBox()` answers in a browser. The tools take a measurer
 * rather than calling `getBBox()` themselves because jsdom has none: the tests
 * inject `attributeBox`, and the editor uses `measureOf`, which asks the
 * browser and falls back to the attributes for an element that is not
 * rendered yet, where Firefox throws rather than answers.
 */
export type Measure = (element: Element) => Box;

const EMPTY: Box = { x: 0, y: 0, width: 0, height: 0 };

const num = (element: Element, name: string): number => {
	const value = Number.parseFloat(element.getAttribute(name) ?? '');
	return Number.isFinite(value) ? value : 0;
};

/** The box of a list of coordinates, read in pairs: a polygon's `points`, or the numbers of a `d`. */
const boxOfCoordinates = (text: string): Box => {
	const numbers = (text.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi) ?? []).map(Number);
	const xs = numbers.filter((_, i) => i % 2 === 0);
	const ys = numbers.filter((_, i) => i % 2 === 1);
	if (xs.length === 0 || ys.length === 0) return EMPTY;
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

/**
 * The box an element's attributes describe, for the shapes whose attributes
 * say it outright. A path or a polyline is boxed by every coordinate in it,
 * which holds a curve's control points too and so may be a little generous,
 * and reads a relative command as if it were absolute: a fallback for a path
 * the browser cannot measure, not a measurement.
 */
export const attributeBox: Measure = (element) => {
	const name = element.localName;
	if (name === 'rect' || name === 'image') {
		return {
			x: num(element, 'x'),
			y: num(element, 'y'),
			width: num(element, 'width'),
			height: num(element, 'height'),
		};
	}
	if (name === 'ellipse' || name === 'circle') {
		const rx = name === 'circle' ? num(element, 'r') : num(element, 'rx');
		const ry = name === 'circle' ? num(element, 'r') : num(element, 'ry');
		return {
			x: num(element, 'cx') - rx,
			y: num(element, 'cy') - ry,
			width: 2 * rx,
			height: 2 * ry,
		};
	}
	if (name === 'line') {
		const x1 = num(element, 'x1');
		const y1 = num(element, 'y1');
		const x2 = num(element, 'x2');
		const y2 = num(element, 'y2');
		return {
			x: Math.min(x1, x2),
			y: Math.min(y1, y2),
			width: Math.abs(x2 - x1),
			height: Math.abs(y2 - y1),
		};
	}
	if (name === 'path') return boxOfCoordinates(element.getAttribute('d') ?? '');
	if (name === 'polygon' || name === 'polyline') {
		return boxOfCoordinates(element.getAttribute('points') ?? '');
	}
	if (name === 'text') return { x: num(element, 'x'), y: num(element, 'y'), width: 0, height: 0 };
	return EMPTY;
};

const hasBBox = (element: Element): element is SVGGraphicsElement =>
	'getBBox' in element && typeof element.getBBox === 'function';

/** The browser's measurement where it gives one, the attributes' where it does not. */
export const measureOf: Measure = (element) => {
	if (!hasBBox(element)) return attributeBox(element);
	try {
		const { x, y, width, height } = element.getBBox();
		return { x, y, width, height };
	} catch {
		return attributeBox(element);
	}
};
