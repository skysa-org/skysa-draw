import { t } from '../../../i18n/t.js';
import { wrapLooseLayer } from '../../document/commands.js';
import type { LayerInfo } from '../../document/model.js';
import { heldBy } from '../common/held.js';
import type { ToolContext } from '../types.js';
import {
	formatFineTransform,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
} from './geometry.js';

/**
 * What every vector tool checks before it touches a layer (docs/ARCHITECTURE.md
 * §7, "The editor"): that there is an active layer, and that it is neither
 * locked nor hidden, itself or by a group around it (`heldBy`). The tool says
 * why it did nothing, in the user's words, naming the layer or the group
 * that holds it, and the stroke is over before it began.
 */
export const guardLayer = (context: ToolContext): LayerInfo | undefined => {
	const { layer } = context;
	if (layer === undefined) {
		context.notify(t('layers.noneActive'));
		return undefined;
	}
	const held = heldBy(context.document.snapshot().layers, layer);
	if (held === undefined) return layer;
	context.notify(held);
	return undefined;
};

/**
 * The live element a tool may edit: the active layer, after the guard, wrapped
 * in a `<g>` first where it was a bare element at the root (docs/ARCHITECTURE.md
 * §3, "Layers": a loose element is wrapped the first time it is edited). The
 * wrapping is a command of its own, so it is done only when an edit follows,
 * never for a stroke that is canceled.
 */
export const targetLayer = (context: ToolContext): SVGGraphicsElement | undefined => {
	const layer = guardLayer(context);
	if (layer === undefined) return undefined;
	if (!layer.loose) return context.document.layer(layer.id);
	const wrapped = wrapLooseLayer(context.document.root, layer.id);
	context.document.execute(wrapped);
	return context.document.layer(wrapped.id);
};

/** The active layer's live element without an edit in mind: for hit tests and reading. */
export const activeLayerElement = (context: ToolContext): SVGGraphicsElement | undefined =>
	context.layer === undefined ? undefined : context.document.layer(context.layer.id);

/**
 * The two ways between the drawing's user units, which the pointer and the
 * overlay are in, and a layer's own, which its elements are in: a layer's
 * position is its `transform` (docs/ARCHITECTURE.md §3, "Layers"), after those
 * of the groups it is in, so a point drawn on a moved layer goes `into` the
 * layer's space, and a box of its elements comes `outOf` it to be shown on the
 * overlay.
 */
export type LayerSpace = Readonly<{ into: Mat; outOf: Mat }>;

/** Where an element's children are drawn: its own `transform` after every ancestor's, up to the root. */
const placementOf = (element: Element | null): Mat =>
	element === null || element.localName === 'svg'
		? IDENTITY
		: multiply(
				placementOf(element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

/**
 * A layer's space. A loose layer is the one element it holds (`elementsOf`),
 * placed by its own `transform` as every element is, so its space is that of
 * where it sits, and its `transform` is not counted twice.
 */
export const layerSpace = (layer: Element | undefined): LayerSpace => {
	const outOf =
		layer === undefined
			? IDENTITY
			: placementOf(layer.localName === 'g' ? layer : layer.parentElement);
	return { into: invert(outOf), outOf };
};

/** Below this, a number of a matrix is the identity's: a ninth place, as a layer's `transform` is written. */
const SLACK = 1e-9;

/** Whether a matrix only moves what it places: no turn, flip, scale or skew. */
const onlyMoves = (m: Mat): boolean =>
	Math.abs(m[0] - 1) < SLACK &&
	Math.abs(m[1]) < SLACK &&
	Math.abs(m[2]) < SLACK &&
	Math.abs(m[3] - 1) < SLACK;

/**
 * The units a new element is written in, and its `transform`: `into` takes a
 * point of the drawing, where the pointer and the overlay are, into the
 * element's own numbers.
 */
export type NewElementSpace = Readonly<{ into: Mat; transform: string | undefined }>;

/**
 * Where a tool puts a new element on a layer (docs/ARCHITECTURE.md §7,
 * "Tools"): upright, unmirrored and at the sizes the options say, as it is
 * seen on the canvas, whatever the layer's placement, as Photoshop draws
 * after the canvas is turned or resized. Written in the units of a layer
 * turned, flipped, scaled or skewed, by the Image operations or by Free
 * Transform of it or of a group it is in, a new text would run on its side
 * or mirrored, a rectangle would tilt, and a stroke's width, a corner's
 * radius and a font's size would be scaled with the layer.
 *
 * On a layer that is only moved, the common case, the element's numbers are
 * the layer's, which are the drawing's moved, its sizes are the options' as
 * they are, and it has no `transform`: the file is what it always was.
 *
 * On any other, the element is written in the drawing's own units, the very
 * numbers the overlay previewed, and given the inverse of the layer's
 * placement as its `transform`, which undoes it: the way Inkscape draws into
 * a transformed group. That is one rule for every kind of element and every
 * tool, the same `transform` on everything drawn on that layer, and exact for
 * any placement: on a layer scaled more one way than the other, a circle
 * stays round and a stroke as wide every way, which no factor on a size
 * gives. The other way, the points kept in the layer's units and only the
 * turn and the scale undone about an anchor of each element, needs an anchor
 * for each kind of element, and gives every element a `transform` of its own.
 * The matrix is written to nine places, as the layer's own is
 * (`formatFineTransform`), so a quarter turn or a flip is whole numbers and
 * the two meet.
 */
export const newElementSpace = (layer: Element): NewElementSpace => {
	const { into, outOf } = layerSpace(layer);
	if (onlyMoves(outOf)) return { into, transform: undefined };
	const transform = formatFineTransform(into);
	return { into: IDENTITY, transform: transform === '' ? undefined : transform };
};
