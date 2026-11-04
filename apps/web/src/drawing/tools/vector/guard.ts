import { t } from '../../../i18n/t.js';
import { wrapLooseLayer } from '../../document/commands.js';
import type { LayerInfo } from '../../document/model.js';
import { layerDisplayName } from '../../layerName.js';
import type { ToolContext } from '../types.js';
import { IDENTITY, invert, type Mat, multiply, parseTransform } from './geometry.js';

/**
 * What every vector tool checks before it touches a layer (docs/ARCHITECTURE.md
 * §7, "The editor"): that there is an active layer, and that it is neither
 * locked nor hidden. The tool says why it did nothing, in the user's words,
 * and the stroke is over before it began.
 */
export const guardLayer = (context: ToolContext): LayerInfo | undefined => {
	const { layer } = context;
	if (layer === undefined) {
		context.notify(t('layers.noneActive'));
		return undefined;
	}
	const index = context.document.snapshot().layers.findIndex((each) => each.id === layer.id);
	const name = layerDisplayName(layer, Math.max(0, index));
	if (layer.locked) {
		context.notify(t('layers.locked', { name }));
		return undefined;
	}
	if (layer.hidden) {
		context.notify(t('layers.hidden', { name }));
		return undefined;
	}
	return layer;
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
