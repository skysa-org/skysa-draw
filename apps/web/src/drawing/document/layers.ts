import {
	type BlendMode,
	DRAWING_NAMESPACE,
	isBlendMode,
	isGraphicsElement,
	LAYER_ATTRIBUTES,
	LAYER_KINDS,
	layerId,
	type LayerKind,
	layerNumber,
	SVG_NAMESPACE,
} from '@skysa/draw-core';

import type { LayerInfo } from './model.js';
import { INKSCAPE_NAMESPACE, XMLNS_NAMESPACE } from './namespaces.js';

/**
 * Layers as the DOM holds them (docs/ARCHITECTURE.md §3, "Layers";
 * docs/decisions/0003-layers.md): which elements are layers, what each says
 * about itself, and the writers that change one the way §3 says it is written.
 * What SVG can say is read and written SVG's way, `display`, `opacity` and
 * `mix-blend-mode`, where any other tool reads it; only the name, the lock and
 * the kind are the app's, in its namespace, under whatever prefix the file
 * binds it to. Nothing here records an undo: the commands do that, around
 * these.
 */

const isSvgElement = (node: Node, localName?: string): node is SVGElement =>
	node instanceof Element &&
	node.namespaceURI === SVG_NAMESPACE &&
	(localName === undefined || node.localName === localName);

/** An element that draws, and so is a layer where it sits at the root or in a group. */
export const isLayerElement = (node: Node): node is SVGGraphicsElement =>
	isSvgElement(node) && isGraphicsElement(node.localName);

const childLayers = (parent: Element): readonly SVGGraphicsElement[] =>
	[...parent.children].filter(isLayerElement);

const isLayerKind = (value: string): value is LayerKind =>
	(LAYER_KINDS as readonly string[]).includes(value);

/**
 * What the layer says it is, or what a file from elsewhere is taken to be: a
 * `<g>` whose only child that draws is one `<image>` is raster, and anything
 * else vector. Titles, descriptions, definitions, comments and the text
 * between elements draw nothing, so they do not count. A `<g>` is a group only
 * where it says so (§3).
 */
export const layerKindOf = (element: Element): LayerKind => {
	const written = element.getAttributeNS(DRAWING_NAMESPACE, LAYER_ATTRIBUTES.kind);
	if (written !== null && isLayerKind(written)) return written;
	if (element.localName !== 'g') return 'vector';
	const drawing = childLayers(element);
	return drawing.length === 1 && drawing[0]?.localName === 'image' ? 'raster' : 'vector';
};

const nonEmpty = (value: string | null): string | undefined =>
	value === null || value.trim() === '' ? undefined : value;

/** `draw:name`, else Inkscape's `inkscape:label`, which is read and never written. */
export const layerNameOf = (element: Element): string | undefined =>
	nonEmpty(element.getAttributeNS(DRAWING_NAMESPACE, LAYER_ATTRIBUTES.name)) ??
	nonEmpty(element.getAttributeNS(INKSCAPE_NAMESPACE, 'label'));

type Declaration = Readonly<{ property: string; value: string; raw: string }>;

/**
 * The declarations of a `style` attribute, in order, each with its text as
 * written so a rewrite keeps the ones it is not about as they were. A value's
 * `!important` is dropped: inside a `style` attribute it changes nothing here.
 */
const declarationsOf = (element: Element): readonly Declaration[] =>
	(element.getAttribute('style') ?? '')
		.split(';')
		.filter((raw) => raw.trim() !== '')
		.map((raw) => {
			const colon = raw.indexOf(':');
			return colon === -1
				? { property: '', value: '', raw }
				: {
						property: raw.slice(0, colon).trim().toLowerCase(),
						value: raw
							.slice(colon + 1)
							.replace(/!\s*important\s*$/i, '')
							.trim(),
						raw,
					};
		});

/** A property's value in `style`, the last one where it is given twice, as CSS has it. */
export const styleValue = (element: Element, property: string): string | undefined =>
	declarationsOf(element)
		.filter((declaration) => declaration.property === property)
		.at(-1)?.value;

/**
 * `style` with `property` set to `value`, or taken out for `undefined`; the
 * attribute goes where nothing is left in it, and is not touched at all where
 * there was nothing to take out.
 */
const writeStyle = (element: Element, property: string, value: string | undefined): void => {
	const declarations = declarationsOf(element);
	const others = declarations.filter((declaration) => declaration.property !== property);
	if (value === undefined && others.length === declarations.length) return;
	const written = [
		...others.map((declaration) => declaration.raw.trim()),
		...(value === undefined ? [] : [`${property}:${value}`]),
	];
	if (written.length === 0) {
		element.removeAttribute('style');
		return;
	}
	element.setAttribute('style', written.join(';'));
};

/** `display` in `style` beats the attribute, as CSS beats a presentation attribute. */
export const isLayerHidden = (element: Element): boolean =>
	(styleValue(element, 'display') ?? element.getAttribute('display') ?? '')
		.trim()
		.toLowerCase() === 'none';

const clampOpacity = (value: number): number => Math.min(1, Math.max(0, value));

const opacityFrom = (raw: string | null | undefined): number => {
	const text = (raw ?? '').trim();
	if (text === '') return 1;
	const value = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
	return Number.isFinite(value) ? clampOpacity(value) : 1;
};

/** 0 to 1, from `style` before the attribute; 1 where neither says, or says something else. */
export const layerOpacityOf = (element: Element): number =>
	opacityFrom(styleValue(element, 'opacity') ?? element.getAttribute('opacity'));

/** `mix-blend-mode`, which has no presentation attribute and is only ever in `style`. */
export const layerBlendOf = (element: Element): BlendMode => {
	const value = styleValue(element, 'mix-blend-mode')?.toLowerCase();
	return value !== undefined && isBlendMode(value) ? value : 'normal';
};

export const isLayerLocked = (element: Element): boolean =>
	element.getAttributeNS(DRAWING_NAMESPACE, LAYER_ATTRIBUTES.locked) === 'true';

const idOf = (element: Element): string => element.getAttribute('id') ?? '';

export const layerInfoOf = (
	element: SVGGraphicsElement,
	depth: number,
	parentId: string | undefined
): LayerInfo => ({
	id: idOf(element),
	kind: layerKindOf(element),
	name: layerNameOf(element),
	hidden: isLayerHidden(element),
	locked: isLayerLocked(element),
	opacity: layerOpacityOf(element),
	blend: layerBlendOf(element),
	depth,
	parentId,
	loose: element.localName !== 'g',
});

type Placed = Readonly<{
	element: SVGGraphicsElement;
	depth: number;
	parentId: string | undefined;
}>;

/** The layers in `parent`, bottom to top, each group followed by its own. */
const placedIn = (
	parent: Element,
	depth: number,
	parentId: string | undefined
): readonly Placed[] =>
	childLayers(parent).flatMap((element) => {
		const here: Placed = { element, depth, parentId };
		return element.localName === 'g' && layerKindOf(element) === 'group'
			? [here, ...placedIn(element, depth + 1, idOf(element))]
			: [here];
	});

/**
 * Every layer in document order, which is paint order, bottom to top; a
 * group's layers follow it, one deeper. A layer that is not a `<g>` is loose:
 * a vector layer of one element, wrapped the first time it is edited (§3).
 */
export const layersOf = (root: Element): readonly LayerInfo[] =>
	placedIn(root, 0, undefined).map(({ element, depth, parentId }) =>
		layerInfoOf(element, depth, parentId)
	);

/** The layers' elements, in the order `layersOf` lists them. */
export const layerElementsOf = (root: Element): readonly SVGGraphicsElement[] =>
	placedIn(root, 0, undefined).map(({ element }) => element);

/**
 * The layer with this id, looked for among the layers alone, so a gradient or
 * a path inside a layer that happens to share the id is never taken for it.
 */
export const layerById = (root: Element, id: string): SVGGraphicsElement | undefined =>
	layerElementsOf(root).find((element) => idOf(element) === id);

/** Every layer inside a group, at any depth, in order; none inside anything else. What a duplicate renumbers. */
export const layersWithin = (layer: Element): readonly SVGGraphicsElement[] =>
	layer.localName === 'g' && layerKindOf(layer) === 'group'
		? placedIn(layer, 0, undefined).map(({ element }) => element)
		: [];

/**
 * The root's `<defs>`, where masks, clips and filters go (§3): the first one,
 * or a new one after the drawing's `<title>`, which stays the first child, or
 * first where there is no title. Making one changes the document, so it is
 * called from inside a command.
 */
export const defsOf = (root: SVGSVGElement): SVGDefsElement => {
	const existing = [...root.children].find((child) => isSvgElement(child, 'defs'));
	if (existing !== undefined) return existing as SVGDefsElement;
	const defs = root.ownerDocument.createElementNS(SVG_NAMESPACE, 'defs');
	const title = [...root.children].find((child) => isSvgElement(child, 'title'));
	if (title === undefined) root.prepend(defs);
	else title.after(defs);
	return defs;
};

/** Every id in use under the root, the root's own included. */
export const idsIn = (root: Element): ReadonlySet<string> =>
	new Set([root, ...root.querySelectorAll('[id]')].map(idOf).filter((id) => id !== ''));

/**
 * The smallest `n` from 1 that is not `taken`, where at most `count` are.
 * Among the first `count + 1` numbers one is always free, so the search ends
 * there: a layer's id, and a prefix for the app's namespace.
 */
const firstFreeNumber = (count: number, taken: (n: number) => boolean): number =>
	Array.from({ length: count + 1 }, (_, index) => index + 1).find((n) => !taken(n)) ?? count + 1;

/** `layer-n` for the smallest `n` no id in `taken` has. */
export const freeLayerIdAmong = (taken: ReadonlySet<string>): string => {
	const used = new Set([...taken].map(layerNumber).filter((n): n is number => n !== undefined));
	return layerId(firstFreeNumber(used.size, (n) => used.has(n)));
};

/** `layer-n` for the smallest `n` free in the document (§3). */
export const freeLayerId = (root: Element): string => freeLayerIdAmong(idsIn(root));

/**
 * An id for every layer that has none, or has one an earlier layer has too,
 * in the DOM only: the text stays as it was until the first command (§3, "a
 * layer with no id is given one the first time the file is written"). The
 * commands and the panel find a layer by its id, so each needs its own.
 */
export const giveLayerIds = (root: SVGSVGElement): void => {
	const taken = new Set(idsIn(root));
	const seen = new Set<string>();
	layerElementsOf(root).forEach((layer) => {
		const id = idOf(layer);
		if (id !== '' && !seen.has(id)) {
			seen.add(id);
			return;
		}
		const fresh = freeLayerIdAmong(taken);
		layer.setAttribute('id', fresh);
		taken.add(fresh);
		seen.add(fresh);
	});
};

/** The prefix the root binds to the app's namespace, where it binds one. */
export const boundDrawingPrefix = (root: Element): string | undefined =>
	[...root.attributes].find(
		(attribute) =>
			attribute.namespaceURI === XMLNS_NAMESPACE &&
			attribute.prefix === 'xmlns' &&
			attribute.value === DRAWING_NAMESPACE
	)?.localName;

/**
 * `draw`, or `draw2`, `draw3`, … where the root binds `draw` to something else:
 * a search, not a recursion, as `freePrefix` is in core.
 */
const freeDrawingPrefix = (root: Element): string => {
	const bound = new Set(
		[...root.attributes]
			.filter((attribute) => attribute.namespaceURI === XMLNS_NAMESPACE)
			.map((attribute) => attribute.localName)
	);
	const candidate = (n: number): string => (n === 1 ? 'draw' : `draw${n}`);
	return candidate(firstFreeNumber(bound.size, (n) => bound.has(candidate(n))));
};

/**
 * The prefix the app's attributes are written with: the one the root binds to
 * its namespace, or `draw` declared on the root now where it binds none, as
 * `withDrawingId` declares it in core (§3: "the attribute's prefix is whatever
 * the file binds the namespace to").
 */
export const drawingPrefixOf = (root: Element): string => {
	const bound = boundDrawingPrefix(root);
	if (bound !== undefined) return bound;
	const prefix = freeDrawingPrefix(root);
	root.setAttributeNS(XMLNS_NAMESPACE, `xmlns:${prefix}`, DRAWING_NAMESPACE);
	return prefix;
};

const writeDrawingAttribute = (
	root: Element,
	layer: Element,
	localName: string,
	value: string | undefined
): void => {
	if (value === undefined) {
		layer.removeAttributeNS(DRAWING_NAMESPACE, localName);
		return;
	}
	layer.setAttributeNS(DRAWING_NAMESPACE, `${drawingPrefixOf(root)}:${localName}`, value);
};

/**
 * Hidden is `display="none"` (§3). A `display` in `style` would beat the
 * attribute, and Inkscape writes `display:inline` on every layer, so hiding
 * takes it out of `style` and showing takes out a `none` there too.
 */
export const writeLayerHidden = (layer: Element, hidden: boolean): void => {
	const styled = styleValue(layer, 'display');
	if (hidden) {
		if (styled !== undefined) writeStyle(layer, 'display', undefined);
		layer.setAttribute('display', 'none');
		return;
	}
	if (styled?.toLowerCase() === 'none') writeStyle(layer, 'display', undefined);
	if ((layer.getAttribute('display') ?? '').trim().toLowerCase() === 'none') {
		layer.removeAttribute('display');
	}
};

/** The precision an opacity is written to, which no eye tells from the next. */
const OPACITY_STEPS = 1000;

/** `opacity`, which an opacity in `style` would beat; fully opaque is no attribute. */
export const writeLayerOpacity = (layer: Element, opacity: number): void => {
	const value = Math.round(clampOpacity(opacity) * OPACITY_STEPS) / OPACITY_STEPS;
	if (styleValue(layer, 'opacity') !== undefined) writeStyle(layer, 'opacity', undefined);
	if (value === 1) {
		layer.removeAttribute('opacity');
		return;
	}
	layer.setAttribute('opacity', String(value));
};

/** `mix-blend-mode` in `style`, beside whatever else `style` says; `normal` is none. */
export const writeLayerBlend = (layer: Element, blend: BlendMode): void => {
	writeStyle(layer, 'mix-blend-mode', blend === 'normal' ? undefined : blend);
};

/** `draw:name`; an empty name takes it away, and the layer goes by its number again. */
export const writeLayerName = (root: Element, layer: Element, name: string): void => {
	const trimmed = name.trim();
	writeDrawingAttribute(root, layer, LAYER_ATTRIBUTES.name, trimmed === '' ? undefined : trimmed);
};

/** `draw:locked="true"`, or nothing. */
export const writeLayerLocked = (root: Element, layer: Element, locked: boolean): void => {
	writeDrawingAttribute(root, layer, LAYER_ATTRIBUTES.locked, locked ? 'true' : undefined);
};

export const writeLayerKind = (root: Element, layer: Element, kind: LayerKind): void => {
	writeDrawingAttribute(root, layer, LAYER_ATTRIBUTES.kind, kind);
};
