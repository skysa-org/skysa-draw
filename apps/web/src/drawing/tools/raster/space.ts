/**
 * Where a raster layer is (docs/ARCHITECTURE.md §7, "The editor": a
 * `transform` on a raster layer is a transform, never a resample): the root's
 * user units, in which the pointer arrives, into a layer's own, and a move in
 * the root's units into the units of the layer's parent. Read through the SVG
 * DOM, which a browser has and jsdom does not; where the DOM cannot say, every
 * space is taken as the root's.
 */

type Point2 = readonly [number, number];

/**
 * An element's own `transform` as one matrix. The list is multiplied, never
 * consolidated, since `consolidate()` rewrites the attribute.
 */
const ownMatrix = (element: SVGGraphicsElement): DOMMatrix | undefined => {
	if (!('transform' in element)) return undefined;
	return Array.from(element.transform.baseVal).reduce(
		(matrix, transform) => matrix.multiply(transform.matrix),
		new DOMMatrix()
	);
};

/** The matrix from an element's user units to the root's, through every group above it. */
const matrixToRoot = (element: SVGGraphicsElement, root: SVGSVGElement): DOMMatrix | undefined => {
	const own = ownMatrix(element);
	const parent = element.parentNode;
	if (own === undefined || parent === root || !(parent instanceof SVGGraphicsElement)) return own;
	const above = matrixToRoot(parent, root);
	return above === undefined ? undefined : above.multiply(own);
};

/** `matrix` undone, applied to a point (`translate` true) or to a vector; `undefined` where it cannot be undone. */
const undone = (
	matrix: DOMMatrix,
	x: number,
	y: number,
	translate: boolean
): Point2 | undefined => {
	const inverse = matrix.inverse();
	const lx = inverse.a * x + inverse.c * y + (translate ? inverse.e : 0);
	const ly = inverse.b * x + inverse.d * y + (translate ? inverse.f : 0);
	return Number.isFinite(lx) && Number.isFinite(ly) ? [lx, ly] : undefined;
};

/**
 * A point in the root's user units in the layer's own, so a stroke lands
 * under the pointer on a layer the select tool moved.
 */
export const toLocal = (
	layer: SVGGraphicsElement,
	root: SVGSVGElement,
	x: number,
	y: number
): Point2 => {
	const matrix = matrixToRoot(layer, root);
	return (matrix === undefined ? undefined : undone(matrix, x, y, true)) ?? [x, y];
};

/**
 * A move in the root's user units in the units of the layer's parent, which
 * is what a `translate` in the layer's own `transform` is written in: the same
 * move for a layer at the root, and a scaled or turned one inside a group
 * that is scaled or turned.
 */
export const moveInParent = (
	layer: SVGGraphicsElement,
	root: SVGSVGElement,
	dx: number,
	dy: number
): Point2 => {
	const parent = layer.parentNode;
	if (parent === root || !(parent instanceof SVGGraphicsElement)) return [dx, dy];
	const matrix = matrixToRoot(parent, root);
	return (matrix === undefined ? undefined : undone(matrix, dx, dy, false)) ?? [dx, dy];
};
