/**
 * The layer vocabulary (docs/decisions/0003-layers.md; docs/ARCHITECTURE.md §3,
 * "Layers"): what the app writes on a layer in its own namespace, the kinds a
 * layer can be, the blend modes it can have, and the limits of a raster. Here
 * rather than in the editor so the editor, the store and the tests name them
 * from one place, and so `emptyDrawing` can write the first layer.
 *
 * A layer is a direct child of the root that draws. What SVG can say about
 * one — hidden, opacity, blend mode, mask, clip, filter, transform — is said
 * SVG's way and has no name here; only what SVG cannot say is the app's.
 */

/** A layer is vector, raster, or a group of layers. */
export const LAYER_KINDS = ['vector', 'raster', 'group'] as const;

export type LayerKind = (typeof LAYER_KINDS)[number];

/** Local names of the app's attributes on a layer, in `DRAWING_NAMESPACE`. */
export const LAYER_ATTRIBUTES = {
	/** `vector`, `raster` or `group`; inferred where absent. */
	kind: 'kind',
	/** The name the user typed; an unnamed layer goes by its number. */
	name: 'name',
	/** `"true"` on a layer the tools may not change. */
	locked: 'locked',
} as const;

/**
 * `mix-blend-mode`'s values, which are the sixteen every editor offers, in
 * the order Photoshop and Procreate list them.
 * https://developer.mozilla.org/en-US/docs/Web/CSS/mix-blend-mode
 */
export const BLEND_MODES = [
	'normal',
	'darken',
	'multiply',
	'color-burn',
	'lighten',
	'screen',
	'color-dodge',
	'overlay',
	'soft-light',
	'hard-light',
	'difference',
	'exclusion',
	'hue',
	'saturation',
	'color',
	'luminosity',
] as const;

export type BlendMode = (typeof BLEND_MODES)[number];

export const isBlendMode = (value: string): value is BlendMode =>
	(BLEND_MODES as readonly string[]).includes(value);

/**
 * A raster layer's longer side in pixels, at most: one pixel per user unit
 * until here, fewer past it, so a large canvas is not a bitmap no phone holds.
 */
export const RASTER_MAX_SIDE = 4096;

const LAYER_ID = /^layer-([1-9]\d*)$/;

/** The id the app gives the n-th layer it makes: `layer-1`. */
export const layerId = (n: number): string => {
	if (!Number.isInteger(n) || n < 1)
		throw new RangeError(`a layer's number counts from 1, not ${n}`);
	return `layer-${n}`;
};

/** The number in an id this app gave, or `undefined` for any other id. */
export const layerNumber = (id: string): number | undefined => {
	const match = LAYER_ID.exec(id);
	return match?.[1] === undefined ? undefined : Number(match[1]);
};

/**
 * The SVG elements that draw, and so make a layer when they sit at the root.
 * `<defs>`, `<title>`, `<desc>`, `<metadata>`, `<style>` and the elements that
 * only define things are not among them.
 * https://svgwg.org/svg2-draft/struct.html#TermGraphicsElement
 */
export const GRAPHICS_ELEMENTS = [
	'g',
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
	'image',
	'use',
	'svg',
	'switch',
] as const;

export const isGraphicsElement = (localName: string): boolean =>
	(GRAPHICS_ELEMENTS as readonly string[]).includes(localName);
