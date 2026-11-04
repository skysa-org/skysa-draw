import { SVG_NAMESPACE } from '@skysa/draw-core';

import { canvasToPng, renderSvg } from '../export/render.js';
import { pixelGrid } from '../tools/raster/pixels.js';
import type { CanvasBox } from './crop.js';
import { idsReferencedIn, isSvgElement } from './dom.js';
import { layerById } from './layers.js';

/**
 * Layers drawn as pixels (docs/ARCHITECTURE.md §7, "Layers": merge down
 * "rasterizes where either side is raster, and rasterize … turns a vector
 * layer into a raster one by rendering it"): an SVG of their own, the root's
 * start tag, its `<defs>` and `<style>` and the layers, rendered as an export
 * is (`export/render.ts`) over the canvas, at the density a raster layer's
 * pixels have (`pixelGrid`), and encoded as PNG for an `<image>`.
 */

export type RenderedImage = Readonly<{
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
}>;

/** What the root holds that a layer may need: its definitions and its stylesheets. */
const isShared = (element: Element): boolean =>
	isSvgElement(element, 'defs') || isSvgElement(element, 'style');

/**
 * The layers the drawn ones use and do not draw themselves: the layer below a
 * clipped one, which its mask `<use>`s, and whatever that one uses in turn.
 * Followed through the root's definitions, so a mask that names a layer by
 * `#id` brings that layer along.
 */
const usedLayers = (
	root: Element,
	from: readonly Element[],
	included: ReadonlySet<string>
): readonly Element[] => {
	const step = (
		pending: readonly string[],
		seen: ReadonlySet<string>,
		found: readonly Element[]
	): readonly Element[] => {
		const [id, ...rest] = pending;
		if (id === undefined) return found;
		if (seen.has(id)) return step(rest, seen, found);
		const nextSeen = new Set([...seen, id]);
		const layer = layerById(root, id);
		const definition =
			layer === undefined
				? [...root.querySelectorAll('defs [id]')].find(
						(each) => each.getAttribute('id') === id
					)
				: undefined;
		const source = layer ?? definition;
		if (source === undefined) return step(rest, nextSeen, found);
		const more = [...idsReferencedIn(source)];
		return step([...rest, ...more], nextSeen, layer === undefined ? found : [...found, layer]);
	};
	const start = from.flatMap((element) => [...idsReferencedIn(element)]);
	return step(start, included, []);
};

/**
 * An SVG of the root's start tag, its definitions and stylesheets, and the
 * layers given, which are copies the caller may have changed: what of the
 * drawing a render of those layers alone needs. A layer they use without
 * drawing it goes in a `<defs>` of its own.
 */
const layersSvgText = (root: SVGSVGElement, layers: readonly Element[]): string => {
	const svg = root.cloneNode(false) as Element;
	const shared = [...root.children].filter(isShared).map((element) => element.cloneNode(true));
	const included = new Set(layers.map((layer) => layer.getAttribute('id') ?? ''));
	const used = usedLayers(root, layers, included);
	const extra = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'defs');
	extra.append(...used.map((layer) => layer.cloneNode(true)));
	svg.append(...shared, ...(used.length === 0 ? [] : [extra]), ...layers);
	return new XMLSerializer().serializeToString(svg);
};

/**
 * The layers rendered over the canvas and encoded as a PNG `data:` URL, with
 * the canvas as the picture's place; nothing where the browser cannot render
 * (jsdom) or would not encode.
 */
export const renderLayers = async (
	root: SVGSVGElement,
	layers: readonly Element[],
	box: CanvasBox
): Promise<RenderedImage | undefined> => {
	const grid = pixelGrid(box);
	const canvas = await renderSvg(layersSvgText(root, layers), box, grid.width, grid.height);
	if (canvas === undefined) return undefined;
	const href = await canvasToPng(canvas).then(
		(url) => url,
		() => undefined
	);
	return href === undefined ? undefined : { href, ...box };
};
