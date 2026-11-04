import { cell, DRAWING_NAMESPACE, layerNumber, SVG_NAMESPACE } from '@skysa/draw-core';

import { compound, previousLayerSibling, wrapLooseLayer } from './commands.js';
import { canvasBoxOf } from './crop.js';
import { removeUnreferenced } from './definitions.js';
import { declaring, definitionById, markupSize, soleReference, spaceBefore } from './dom.js';
import { type RenderedImage, renderLayers } from './layerPixels.js';
import {
	isLayerHidden,
	isLayerLocked,
	layerBlendOf,
	layerById,
	layerKindOf,
	layerOpacityOf,
	writeLayerBlend,
	writeLayerHidden,
	writeLayerKind,
	writeLayerOpacity,
} from './layers.js';
import type { Command, EditorDocument } from './model.js';
import { XLINK_NAMESPACE, XMLNS_NAMESPACE } from './namespaces.js';

/**
 * Merge down and rasterize (docs/ARCHITECTURE.md §7, "Layers"): two layers
 * made one, and a layer made pixels. Both replace layers whole, so both keep
 * copies of what they replaced and what they made, as a layer edit does
 * (`editLayer`), and find the layers by id on every apply and every revert.
 *
 * Vector onto vector stays vector: the upper layer's content goes into the
 * lower layer, each side in a `<g>` that carries what its layer said of
 * itself (its transform, opacity, blend mode, filter, style), so nothing
 * moves or changes colour, and the merged layer, which keeps the lower one's
 * id, name and lock, is at full opacity and normal blend. Anything with a
 * raster or a group on either side is rendered (`layerPixels.ts`) and becomes
 * one raster layer the same way. A rasterized layer keeps its id, name,
 * opacity, blend mode, hidden and lock, and has its transform, filter, mask
 * and clip drawn into its pixels. A render is asynchronous; what it found to
 * render is what it replaces, so a drawing changed while it ran is left
 * alone and the user is told.
 */

/** What became of a merge or a rasterize, for the panel to tell the user. */
export type LayerJob = 'done' | 'unrenderable' | 'changed' | 'nothing';

/** Why the layer cannot be merged down, or nothing. */
type MergeProblem = 'bottom' | 'hidden' | 'locked';

export const mergeProblem = (root: Element, id: string): MergeProblem | undefined => {
	const upper = layerById(root, id);
	const below = upper === undefined ? undefined : previousLayerSibling(upper);
	if (upper === undefined || below === undefined) return 'bottom';
	if (isLayerHidden(upper) || isLayerHidden(below)) return 'hidden';
	if (isLayerLocked(upper) || isLayerLocked(below)) return 'locked';
	return undefined;
};

type Replaced = Readonly<{ before: Element; after: Element; declared: string | undefined }>;

/** The app's namespace declared on the root again, as the first apply declared it. */
const redeclare = (root: Element, prefix: string | undefined): void => {
	if (prefix !== undefined) {
		root.setAttributeNS(XMLNS_NAMESPACE, `xmlns:${prefix}`, DRAWING_NAMESPACE);
	}
};

const undeclare = (root: Element, prefix: string | undefined): void => {
	if (prefix !== undefined) root.removeAttributeNS(XMLNS_NAMESPACE, prefix);
};

/** The layer replaced by what `build` makes of it, which keeps its id. */
const replaceLayer = (
	id: string,
	label: string,
	build: (root: SVGSVGElement, layer: SVGGraphicsElement) => Element
): Command => {
	const done = cell<Replaced | undefined>(undefined);
	return {
		label,
		apply: (root) => {
			const known = done.current;
			if (known !== undefined) {
				redeclare(root, known.declared);
				layerById(root, id)?.replaceWith(known.after.cloneNode(true));
				return;
			}
			const layer = layerById(root, id);
			if (layer === undefined) return;
			const before = layer.cloneNode(true) as Element;
			const made = cell<Element | undefined>(undefined);
			const declared = declaring(root, () => {
				made.current = build(root, layer);
			});
			const after = made.current;
			if (after === undefined) return;
			layer.replaceWith(after);
			done.current = { before, after: after.cloneNode(true) as Element, declared };
		},
		revert: (root) => {
			const known = done.current;
			if (known === undefined) return;
			layerById(root, id)?.replaceWith(known.before.cloneNode(true));
			undeclare(root, known.declared);
		},
		get bytes() {
			const known = done.current;
			return known === undefined ? 0 : markupSize(known.before) + markupSize(known.after);
		},
	};
};

type Merged = Readonly<{
	below: Element;
	upper: Element;
	/** The indentation before the upper layer, which goes with it. */
	space: Text | undefined;
	/**
	 * What was before the upper layer and its indentation, where that was not
	 * the lower layer: a comment or a `<defs>` between the two, which stays.
	 */
	anchor: Node | undefined;
	after: Element;
	declared: string | undefined;
}>;

/**
 * The lower layer replaced by what `build` makes of the two, and the upper
 * one taken out with its indentation. Undo puts copies of both back, the
 * upper one again right after what was before it.
 */
const mergeInto = (
	belowId: string,
	upperId: string,
	label: string,
	build: (root: SVGSVGElement, below: SVGGraphicsElement, upper: SVGGraphicsElement) => Element
): Command => {
	const done = cell<Merged | undefined>(undefined);
	const takeOutUpper = (root: Element): void => {
		const upper = layerById(root, upperId);
		if (upper === undefined) return;
		spaceBefore(upper)?.remove();
		upper.remove();
	};
	return {
		label,
		apply: (root) => {
			const known = done.current;
			if (known !== undefined) {
				redeclare(root, known.declared);
				takeOutUpper(root);
				layerById(root, belowId)?.replaceWith(known.after.cloneNode(true));
				return;
			}
			const below = layerById(root, belowId);
			const upper = layerById(root, upperId);
			if (below === undefined || upper === undefined) return;
			const space = spaceBefore(upper);
			const before = (space ?? upper).previousSibling;
			const kept = {
				below: below.cloneNode(true) as Element,
				upper: upper.cloneNode(true) as Element,
				space: space?.cloneNode() as Text | undefined,
				anchor: before === below || before === null ? undefined : before,
			};
			takeOutUpper(root);
			const made = cell<Element | undefined>(undefined);
			const declared = declaring(root, () => {
				made.current = build(root, below, upper);
			});
			const after = made.current;
			if (after === undefined) return;
			if (after !== below) below.replaceWith(after);
			done.current = { ...kept, after: after.cloneNode(true) as Element, declared };
		},
		revert: (root) => {
			const known = done.current;
			const merged = layerById(root, belowId);
			if (known === undefined || merged === undefined) return;
			const below = known.below.cloneNode(true) as Element;
			merged.replaceWith(below);
			const upper = known.upper.cloneNode(true) as Element;
			// After what was before it, where that is still beside the lower layer.
			const parent = below.parentNode;
			const anchor =
				known.anchor !== undefined && known.anchor.parentNode === parent
					? known.anchor
					: below;
			const nodes = known.space === undefined ? [upper] : [known.space.cloneNode(), upper];
			const next = anchor.nextSibling;
			nodes.forEach((node) => parent?.insertBefore(node, next));
			undeclare(root, known.declared);
		},
		get bytes() {
			const known = done.current;
			return known === undefined
				? 0
				: markupSize(known.below) + markupSize(known.upper) + markupSize(known.after);
		},
	};
};

/** What a layer says of itself that SVG draws: every attribute in no namespace but its id. */
const ownLook = (element: Element): readonly Attr[] =>
	[...element.attributes].filter(
		(attribute) => attribute.namespaceURI === null && attribute.name !== 'id'
	);

/** A `<g>` carrying `look`, around `nodes`. */
const wrapper = (root: SVGSVGElement, look: readonly Attr[], nodes: readonly Node[]): Element => {
	const group = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
	look.forEach((attribute) => group.setAttribute(attribute.name, attribute.value));
	group.append(...nodes);
	return group;
};

/**
 * Vector onto vector, in the lower layer: its own content in a `<g>` with its
 * look, where it has one, then the upper layer's in a `<g>` with the upper's.
 * A loose element above goes in as it is, without the `layer-n` it was given
 * on open, which no longer names a layer.
 */
const mergeVectors = (
	root: SVGSVGElement,
	below: SVGGraphicsElement,
	upper: SVGGraphicsElement
): Element => {
	const belowLook = ownLook(below);
	if (belowLook.length > 0) {
		const inner = wrapper(root, belowLook, [...below.childNodes]);
		belowLook.forEach((attribute) => below.removeAttribute(attribute.name));
		below.appendChild(inner);
	}
	if (upper.localName !== 'g') {
		if (layerNumber(upper.getAttribute('id') ?? '') !== undefined) upper.removeAttribute('id');
		below.appendChild(upper);
		return below;
	}
	const upperLook = ownLook(upper);
	if (upperLook.length === 0) below.append(...upper.childNodes);
	else below.appendChild(wrapper(root, upperLook, [...upper.childNodes]));
	return below;
};

/**
 * A raster layer of the rendered picture, under `id`: the app's attributes and
 * any other tool's of `from` (its name, its lock, Inkscape's label), and, if
 * `keepLook`, its opacity, blend mode and hidden; the picture over the canvas
 * box it was rendered in, as `replaceRasterImage` writes one.
 */
const rasterLayer = (
	root: SVGSVGElement,
	from: Element,
	id: string,
	image: RenderedImage,
	keepLook: boolean
): Element => {
	const layer = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
	layer.setAttribute('id', id);
	[...from.attributes]
		.filter(
			(attribute) =>
				attribute.namespaceURI !== null &&
				attribute.namespaceURI !== XMLNS_NAMESPACE &&
				attribute.namespaceURI !== XLINK_NAMESPACE &&
				!(attribute.namespaceURI === DRAWING_NAMESPACE && attribute.localName === 'kind')
		)
		.forEach((attribute) =>
			layer.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
		);
	writeLayerKind(root, layer, 'raster');
	if (keepLook) {
		writeLayerOpacity(layer, layerOpacityOf(from));
		writeLayerBlend(layer, layerBlendOf(from));
		writeLayerHidden(layer, isLayerHidden(from));
	}
	const picture = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'image');
	picture.setAttribute('href', image.href);
	picture.setAttribute('x', String(image.x));
	picture.setAttribute('y', String(image.y));
	picture.setAttribute('width', String(image.width));
	picture.setAttribute('height', String(image.height));
	picture.setAttribute('preserveAspectRatio', 'none');
	layer.appendChild(picture);
	return layer;
};

/** The vector merge, as one step: a loose layer below is put in a `<g>` of its own first. */
const vectorMergeDown = (root: SVGSVGElement, upperId: string, below: Element): Command => {
	const belowId = below.getAttribute('id') ?? '';
	const wrap = below.localName === 'g' ? undefined : wrapLooseLayer(root, belowId);
	const target = wrap?.id ?? belowId;
	return compound('layers.mergeDown', [
		...(wrap === undefined ? [] : [wrap]),
		mergeInto(target, upperId, 'layers.mergeDown', mergeVectors),
	]);
};

/** Whether the two stay vector: both vector, and nothing on the upper one that refers below. */
const staysVector = (below: Element, upper: Element): boolean =>
	layerKindOf(below) === 'vector' &&
	layerKindOf(upper) === 'vector' &&
	!upper.hasAttribute('mask');

/**
 * The filters and clips of the app's own that the layers use, which a render
 * draws into the pixels, and which go once nothing else uses them.
 */
const ownDefinitionsOf = (
	root: Element,
	layers: readonly Element[]
): readonly Readonly<{ id: string; localName: string }>[] =>
	layers.flatMap((layer) =>
		[layer, ...layer.querySelectorAll('[filter], [mask]')].flatMap((element) =>
			(['filter', 'mask'] as const).flatMap((localName) => {
				const id = soleReference(element.getAttribute(localName));
				const own = localName === 'filter' ? 'adjust-' : 'clip-';
				return id?.startsWith(own) === true &&
					definitionById(root, id, localName) !== undefined
					? [{ id, localName }]
					: [];
			})
		)
	);

/** Why the layer cannot be rasterized, or nothing. */
export const rasterizeProblem = (root: Element, id: string): 'raster' | 'locked' | undefined => {
	const layer = layerById(root, id);
	if (layer === undefined || layerKindOf(layer) === 'raster') return 'raster';
	return isLayerLocked(layer) ? 'locked' : undefined;
};

/** A copy of the layer as a rasterize renders it: without the look the raster layer keeps. */
const contentOnly = (layer: Element): Element => {
	const copy = layer.cloneNode(true) as Element;
	writeLayerOpacity(copy, 1);
	writeLayerBlend(copy, 'normal');
	writeLayerHidden(copy, false);
	return copy;
};

/**
 * Renders, then executes what `command` makes of the picture, unless the
 * drawing changed meanwhile. The work is the document's to wait for before a
 * save.
 */
const afterRender = (
	document: EditorDocument,
	layers: readonly Element[],
	command: (image: RenderedImage) => Command
): Promise<LayerJob> => {
	const version = document.snapshot().version;
	const box = canvasBoxOf(document.root, document.size);
	const job = renderLayers(document.root, layers, box).then((image): LayerJob => {
		if (image === undefined) return 'unrenderable';
		if (document.snapshot().version !== version) return 'changed';
		document.execute(command(image));
		return 'done';
	});
	document.pending(job);
	return job;
};

/**
 * The layer and the one below it made one, in the lower one's place under its
 * id: at once for two vector layers, after a render otherwise. Nothing for a
 * layer `mergeProblem` names.
 */
export const mergeDown = (document: EditorDocument, upperId: string): Promise<LayerJob> => {
	const root = document.root;
	const upper = layerById(root, upperId);
	const below = upper === undefined ? undefined : previousLayerSibling(upper);
	const belowId = below?.getAttribute('id') ?? '';
	if (upper === undefined || below === undefined || mergeProblem(root, upperId) !== undefined) {
		return Promise.resolve('nothing');
	}
	if (staysVector(below, upper)) {
		document.execute(vectorMergeDown(root, upperId, below));
		return Promise.resolve('done');
	}
	const baked = ownDefinitionsOf(root, [below, upper]);
	return afterRender(
		document,
		[below.cloneNode(true) as Element, upper.cloneNode(true) as Element],
		(image) =>
			compound('layers.mergeDown', [
				mergeInto(belowId, upperId, 'layers.mergeDown', (live, lower) =>
					rasterLayer(live, lower, belowId, image, false)
				),
				removeUnreferenced(baked),
			])
	);
};

/** The layer rendered and put in its place as a raster layer under its id, after the render. */
export const rasterizeLayer = (document: EditorDocument, id: string): Promise<LayerJob> => {
	const root = document.root;
	const layer = layerById(root, id);
	if (layer === undefined || rasterizeProblem(root, id) !== undefined) {
		return Promise.resolve('nothing');
	}
	const baked = ownDefinitionsOf(root, [layer]);
	return afterRender(document, [contentOnly(layer)], (image) =>
		compound('layers.rasterize', [
			replaceLayer(id, 'layers.rasterize', (live, old) =>
				rasterLayer(live, old, id, image, true)
			),
			removeUnreferenced(baked),
		])
	);
};
