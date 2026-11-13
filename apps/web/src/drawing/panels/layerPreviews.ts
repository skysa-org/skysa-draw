import { type DrawingSize, SVG_NAMESPACE } from '@skysa/draw-core';
import { cell } from '@skysa/storage';

import { clipStateOf } from '../document/clip.js';
import { type CanvasBox, canvasBoxOf } from '../document/crop.js';
import { idsReferencedIn } from '../document/dom.js';
import {
	isLayerElement,
	layerElementsOf,
	writeLayerBlend,
	writeLayerHidden,
	writeLayerOpacity,
} from '../document/layers.js';
import { XLINK_NAMESPACE } from '../document/namespaces.js';
import { serializeDrawing } from '../document/serialize.js';
import { layerSpace } from '../tools/vector/guard.js';
import { elementsOf, placedBox } from '../tools/vector/hit.js';
import { type Measure, measureOf } from '../tools/vector/measure.js';

/**
 * A layer's picture for the layers panel, Photoshop's layer thumbnail
 * (docs/decisions/0004-the-interface.md, "The layers panel's previews"): a
 * standalone SVG text, built from the live root, which the sanitizer has
 * cleaned, and shown through an `<img>` of a `blob:` URL, never in the page
 * (docs/ARCHITECTURE.md §7, "The editor"; §9). The root is never changed:
 * what is kept is copied into an inert document of its own, which loads and
 * runs nothing, and the copy is changed instead.
 *
 * What the picture shows is the layer as it paints by itself. Its content is
 * kept with what places and shapes it, its `transform`, its `filter` (its
 * adjustments), a `clip-path` or a mask of the file's own; how it is painted
 * onto what is under it is left out, its `opacity`, a `display` that hides
 * it, its `mix-blend-mode` and the app's clip to the layer below
 * (`document/clip.ts`), so a hidden, faint or clipped layer still shows its
 * own pixels. The groups it is in are kept as shells, by the same rule: their
 * `transform` and `filter` stay, their compositing goes, and their other
 * layers go. Every other layer is left out. One item of a vector layer is the
 * layer's shell holding that element alone. A group's own picture, which the
 * panel does not ask for, is its layers together, as the group paints them.
 *
 * Of what is not a layer, every `<style>` is kept, and of the definitions,
 * wherever they are in the file, those the picture refers to, by `url(#…)`
 * or a `#…` link, and those they refer to in turn, copied into one `<defs>`;
 * the rest is left out. A definition the picture does not use cannot change
 * it, so an adjustment changed on one layer gives that layer a new picture
 * and leaves every other one as it was.
 *
 * A picture in the file's own bytes, a raster layer's every pixel, is drawn
 * by its stand-in (`previewPictures.ts`), a few hundred pixels across, so the
 * SVG a preview holds is kilobytes where the layer is megabytes; where the
 * stand-in is not made yet the build says so (`BuiltPreview.wanted`), and the
 * picture shown stays as it was until it is.
 */

/** Which picture: a layer, or one item of a vector layer, by where it is among the layer's elements (`elementsOf`). */
export type PreviewTarget = Readonly<{
	layerId: string;
	position?: number;
}>;

/**
 * The room for the canvas inside the box, in CSS px at a 16 px rem:
 * `--layer-preview-width` by `--layer-preview-height`
 * (`styles/layerPreview.css`), less a pixel each side for the hairline round
 * the canvas.
 */
export const PREVIEW_ROOM = { width: 34, height: 26 } as const;

/** The canvas fitted in the room at its own aspect, in CSS px; never less than a pixel either way. */
export type PreviewFit = Readonly<{ width: number; height: number }>;

export type BuiltPreview = Readonly<{
	/**
	 * The SVG text in the pieces a `Blob` takes: the markup, with every long
	 * attribute value apart, the very string the DOM holds, so a picture is
	 * told from the last one by `===` rather than by a copy of its pixels.
	 */
	parts: readonly string[];
	fit: PreviewFit;
	/** The layers at the root, other than the picture's own, that a definition or a `<style>` in it was copied from. */
	sources: ReadonlySet<string>;
	/** The `href` of every picture in the file's own bytes it draws, by its stand-in or, where that is not made, by itself. */
	pictures: readonly string[];
	/** Those of `pictures` whose stand-in is not made yet: the picture is not to be shown until they are. */
	wanted: readonly string[];
}>;

/** A picture's stand-in, by its `href`: a small one, or the `href` itself; nothing while it is not made (`previewPictures.ts`). */
export type StandIn = (href: string) => string | undefined;

/** What one round of builds reads of the document, read once for all of them. */
export type PreviewContext = Readonly<{
	root: SVGSVGElement;
	canvas: CanvasBox;
	/** What measures an item, to frame its picture: the browser, or a test in its place. */
	measure: Measure;
	layer: (id: string) => SVGGraphicsElement | undefined;
	/** The first element with this id, as a reference resolves. */
	byId: (id: string) => Element | undefined;
	standIn: StandIn;
}>;

const idOf = (element: Element): string => element.getAttribute('id') ?? '';

/** The elements by id, the first one where two share an id. */
const firstById = <T extends Element>(elements: readonly T[]): ReadonlyMap<string, T> =>
	new Map([...elements].reverse().map((element) => [idOf(element), element]));

/** A table made the first time it is read, and not before: a round that builds nothing reads none. */
const once = <T>(make: () => T): (() => T) => {
	const made = cell<Readonly<{ value: T }> | undefined>(undefined);
	return () => {
		const known = made.current ?? { value: make() };
		made.current = known;
		return known.value;
	};
};

/** Every picture drawn by itself, as a test of the rest wants it. */
const asItself: StandIn = (href) => href;

export const previewContext = (
	root: SVGSVGElement,
	opened: DrawingSize,
	measure: Measure = measureOf,
	standIn: StandIn = asItself
): PreviewContext => {
	const layers = once(() => firstById(layerElementsOf(root)));
	const ids = once(() => firstById([...root.querySelectorAll('[id]')]));
	return {
		root,
		canvas: canvasBoxOf(root, opened),
		measure,
		layer: (id) => layers().get(id),
		byId: (id) => ids().get(id),
		standIn,
	};
};

/** The root's child that holds `node`, or is it; the root for the root; nothing for a node out of the tree. */
export const topLevelOf = (root: Node, node: Node): Node | undefined => {
	if (node === root) return root;
	const parent = node.parentNode;
	if (parent === null) return undefined;
	return parent === root ? node : topLevelOf(root, parent);
};

/** Three places are more than a thumbnail shows, and keep float noise out of the text. */
const tidy = (value: number): number => Number(value.toFixed(3));

/** Room round an item, a share of its larger side, and at least a few units for a stroke its box leaves out. */
const ITEM_MARGIN = 0.12;
const ITEM_MARGIN_UNITS = 2;

/** The most an item is enlarged, in CSS px to a unit, so a dot is not blown up to fill the box. */
const ITEM_MOST_ZOOM = 2;

/**
 * What an item's picture frames: the item itself, as Illustrator's layers
 * panel shows each object, since on the whole canvas most items are a dot.
 * Its box as it is seen on the canvas (`placedBox`, its own `transform` and
 * its layer's), with room round it, at the room's aspect, centered on it;
 * the canvas for an item with no box, an empty text or group.
 */
const itemFrame = (
	layer: Element,
	item: Element,
	canvas: CanvasBox,
	measure: Measure
): CanvasBox => {
	const box = placedBox(measure, item, layerSpace(layer).outOf);
	const sides = [box.x, box.y, box.width, box.height];
	if (!sides.every(Number.isFinite) || (box.width <= 0 && box.height <= 0)) return canvas;
	const margin = Math.max(ITEM_MARGIN_UNITS, ITEM_MARGIN * Math.max(box.width, box.height));
	const aspect = PREVIEW_ROOM.width / PREVIEW_ROOM.height;
	const width = Math.max(
		box.width + 2 * margin,
		(box.height + 2 * margin) * aspect,
		PREVIEW_ROOM.width / ITEM_MOST_ZOOM
	);
	const height = width / aspect;
	return {
		x: tidy(box.x + box.width / 2 - width / 2),
		y: tidy(box.y + box.height / 2 - height / 2),
		width: tidy(width),
		height: tidy(height),
	};
};

const fitOf = (canvas: CanvasBox): PreviewFit => {
	const scale = Math.min(PREVIEW_ROOM.width / canvas.width, PREVIEW_ROOM.height / canvas.height);
	return {
		width: Math.max(1, tidy(canvas.width * scale)),
		height: Math.max(1, tidy(canvas.height * scale)),
	};
};

/** The element and the groups it is in, outermost first, from the root's child down. */
const pathTo = (root: Element, element: Element): readonly Element[] => {
	const parent = element.parentElement;
	if (parent === null || parent === root) return [element];
	return [...pathTo(root, parent), element];
};

/** A copy, and the live elements it holds whole, which need no definition copied for them. */
type Placed = Readonly<{ copy: Element; whole: readonly Element[] }>;

const within = (holders: readonly Element[], element: Element): boolean =>
	holders.some((holder) => holder.contains(element));

/** The copy of `live` as it paints by itself: everything it says, but how it is put onto what is under it. */
const alone = (root: Element, live: Element, copy: Element): Element => {
	writeLayerOpacity(copy, 1);
	writeLayerHidden(copy, false);
	writeLayerBlend(copy, 'normal');
	if (clipStateOf(root, live) === 'clipped') copy.removeAttribute('mask');
	return copy;
};

const wholeCopy = (inert: Document, live: Element): Placed => ({
	copy: inert.importNode(live, true),
	whole: [live],
});

/**
 * `live` as a shell: its own attributes, by itself (`alone`), holding a copy
 * of each child `child` gives one for, in order. Text between the children is
 * left out: a `<g>` draws none.
 */
const shellOf = (
	root: Element,
	inert: Document,
	live: Element,
	child: (element: Element) => Placed | undefined
): Placed => {
	const placed = [...live.children].flatMap((element) => child(element) ?? []);
	const copy = alone(root, live, inert.importNode(live, false));
	copy.append(...placed.map((each) => each.copy));
	return { copy, whole: placed.flatMap((each) => each.whole) };
};

/**
 * The layer by itself, whole, or as a shell holding the one item and what
 * draws nothing, its own definitions or a title; a loose layer is its own one
 * item.
 */
const placedLayer = (
	root: Element,
	inert: Document,
	layer: Element,
	item: Element | undefined
): Placed => {
	if (item === undefined || item === layer) {
		const whole = wholeCopy(inert, layer);
		return { ...whole, copy: alone(root, layer, whole.copy) };
	}
	const items = elementsOf(layer);
	return shellOf(root, inert, layer, (child) => {
		if (child === item) return wholeCopy(inert, child);
		return items.includes(child) ? undefined : wholeCopy(inert, child);
	});
};

/** The path down to the layer, each group a shell holding what draws nothing and the next step down. */
const placedPath = (
	root: Element,
	inert: Document,
	path: readonly Element[],
	item: Element | undefined
): Placed | undefined => {
	const [here, ...below] = path;
	if (here === undefined) return undefined;
	const next = below[0];
	if (next === undefined) return placedLayer(root, inert, here, item);
	return shellOf(root, inert, here, (child) => {
		if (child === next) return placedPath(root, inert, below, item);
		return isLayerElement(child) ? undefined : wholeCopy(inert, child);
	});
};

/** `url(#…)` in a style sheet's text, as `dom.ts` reads one in an attribute. */
const STYLE_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

const idsInStyles = (styles: readonly Element[]): readonly string[] =>
	styles.flatMap((style) =>
		[...style.textContent.matchAll(STYLE_REFERENCE)].map((match) => match[2] ?? '')
	);

/**
 * The definitions the picture needs, found by id in the live root, and what
 * they need in turn, until nothing new is named; never one the picture holds
 * already (`skip`), and never one inside another already found.
 */
const definitionsFor = (
	context: PreviewContext,
	wanted: readonly string[],
	skip: (element: Element) => boolean,
	seen: ReadonlySet<string>,
	found: readonly Element[]
): readonly Element[] => {
	const fresh = [...new Set(wanted)].filter((id) => id !== '' && !seen.has(id));
	if (fresh.length === 0) return found;
	const more = fresh
		.map(context.byId)
		.filter(
			(element): element is Element =>
				element !== undefined && !skip(element) && !within(found, element)
		);
	return definitionsFor(
		context,
		more.flatMap((element) => [...idsReferencedIn(element)]),
		skip,
		new Set([...seen, ...fresh]),
		[...found, ...more]
	);
};

/** Of elements that may hold one another, those no other one holds, in the file's order. */
const outermost = (elements: readonly Element[]): readonly Element[] =>
	elements
		.filter((element) =>
			elements.every((other) => other === element || !other.contains(element))
		)
		.sort((one, other) =>
			one.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
		);

/** A value at least this long is a part of its own, a raster layer's picture or a traced path. */
const LONG_VALUE = 1024;

/** What `XMLSerializer` writes otherwise than as it is in an attribute's value. */
const ESCAPED = /[&<>"\t\n\r]/;

/** Marks a long value's place in the markup: a private-use character either side of its number. */
const MARK = '\uE000';
const MARKED = /\uE000(\d+)\uE000/;

type Held = Readonly<{ element: Element; namespace: string | null; name: string; value: string }>;

const heldValues = (svg: Element): readonly Held[] =>
	[svg, ...svg.querySelectorAll('*')].flatMap((element) =>
		[...element.attributes]
			.filter(
				(attribute) =>
					attribute.value.length >= LONG_VALUE && !ESCAPED.test(attribute.value)
			)
			.map((attribute) => ({
				element,
				namespace: attribute.namespaceURI,
				name: attribute.name,
				value: attribute.value,
			}))
	);

/** Whether the pieces are the markup between the marks, and the marks every one of them, in order, and nothing else. */
const marksInOrder = (pieces: readonly string[], count: number): boolean =>
	pieces.length === count * 2 + 1 &&
	pieces.every((piece, index) => index % 2 === 0 || piece === String((index - 1) / 2));

/**
 * The copy serialized (`XMLSerializer`, as the file is) in parts. Each long
 * value is swapped for a mark while the rest is serialized, put back, and
 * given as a part of its own, so the markup around a picture of megabytes is
 * all that is written out; only a value with nothing to escape is, so a part
 * is exactly what the serializer would have written. Where the file holds
 * something that reads as a mark, the copy is serialized whole instead.
 */
const partsOf = (svg: Element): readonly string[] => {
	const held = heldValues(svg);
	if (held.length === 0) return [serializeDrawing(svg, '')];
	held.forEach((each, index) => {
		each.element.setAttributeNS(each.namespace, each.name, `${MARK}${index}${MARK}`);
	});
	const marked = serializeDrawing(svg, '');
	held.forEach((each) => {
		each.element.setAttributeNS(each.namespace, each.name, each.value);
	});
	const pieces = marked.split(MARKED);
	if (!marksInOrder(pieces, held.length)) return [serializeDrawing(svg, '')];
	return pieces.map((piece, index) =>
		index % 2 === 0 ? piece : (held[(index - 1) / 2]?.value ?? '')
	);
};

/** Where an `<image>` names its picture: SVG 2's `href`, or the `xlink:href` an older file writes. */
const PICTURE_ATTRIBUTES = [
	[null, 'href'],
	[XLINK_NAMESPACE, 'href'],
] as const;

type Picture = Readonly<{ image: Element; attribute: Attr }>;

/** A picture in the file's own bytes: a `data:` URL long enough to be a part of its own. */
const isOwnPicture = (href: string): boolean =>
	href.length >= LONG_VALUE && href.startsWith('data:');

/** The pictures in the file's own bytes that `copy`, or what it holds, draws. */
const picturesIn = (copy: Element): readonly Picture[] =>
	[copy, ...copy.getElementsByTagNameNS(SVG_NAMESPACE, 'image')]
		.filter(
			(element) => element.namespaceURI === SVG_NAMESPACE && element.localName === 'image'
		)
		.flatMap((image) =>
			PICTURE_ATTRIBUTES.flatMap(([namespace, name]) => {
				const attribute = image.getAttributeNodeNS(namespace, name);
				return attribute !== null && isOwnPicture(attribute.value)
					? [{ image, attribute }]
					: [];
			})
		);

type StoodIn = Readonly<{ pictures: readonly string[]; wanted: readonly string[] }>;

/**
 * Each picture in the file's own bytes in the copy drawn by its stand-in,
 * where it is made: before anything else reads the copy's attributes, so no
 * pass over them reads a picture's megabytes.
 */
const standInFor = (copy: Element, standIn: StandIn): StoodIn => {
	const found = picturesIn(copy).map(({ image, attribute }) => {
		const href = attribute.value;
		const small = standIn(href);
		if (small !== undefined && small !== href) {
			image.setAttributeNS(attribute.namespaceURI, attribute.name, small);
		}
		return { href, made: small !== undefined };
	});
	return {
		pictures: found.map((each) => each.href),
		wanted: found.filter((each) => !each.made).map((each) => each.href),
	};
};

/** The layers at the root, but `own`, that `copied` came from. */
const sourcesOf = (root: Element, own: Element, copied: readonly Element[]): ReadonlySet<string> =>
	new Set(
		copied
			.map((element) => topLevelOf(root, element))
			.filter(
				(top): top is SVGGraphicsElement =>
					top !== undefined && top !== own && isLayerElement(top)
			)
			.map(idOf)
	);

/**
 * The picture of `target`, as the document is now; nothing for a layer it no
 * longer has, or an item past the layer's last.
 */
export const buildPreview = (
	context: PreviewContext,
	target: PreviewTarget
): BuiltPreview | undefined => {
	const { root, canvas } = context;
	const layer = context.layer(target.layerId);
	if (layer === undefined) return undefined;
	const item = target.position === undefined ? undefined : elementsOf(layer)[target.position];
	if (target.position !== undefined && item === undefined) return undefined;
	const inert = root.ownerDocument.implementation.createDocument(null, null, null);
	const path = pathTo(root, layer);
	const content = placedPath(root, inert, path, item);
	const own = path[0];
	if (content === undefined || own === undefined) return undefined;
	const drawn = standInFor(content.copy, context.standIn);

	const frame = item === undefined ? canvas : itemFrame(layer, item, canvas, context.measure);
	const fit = fitOf(frame);
	// Not to be shown until its stand-ins are made, so nothing is spent writing it out.
	if (drawn.wanted.length > 0) {
		return {
			parts: [],
			fit,
			sources: new Set(),
			pictures: drawn.pictures,
			wanted: drawn.wanted,
		};
	}
	const svg = inert.importNode(root, false);
	svg.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.width} ${frame.height}`);
	svg.setAttribute('width', String(fit.width));
	svg.setAttribute('height', String(fit.height));

	const styles = [...root.getElementsByTagNameNS(SVG_NAMESPACE, 'style')].filter(
		(style) => !within(content.whole, style)
	);
	const named = [
		...idsReferencedIn(svg),
		...idsReferencedIn(content.copy),
		...idsInStyles(styles),
	];
	const skip = (element: Element): boolean =>
		within(content.whole, element) || element.contains(layer);
	const definitions = outermost(definitionsFor(context, named, skip, new Set(), []));
	const defs = inert.createElementNS(SVG_NAMESPACE, 'defs');
	defs.append(...definitions.map((element) => inert.importNode(element, true)));
	const defined = standInFor(defs, context.standIn);

	svg.append(
		...styles.map((style) => inert.importNode(style, true)),
		...(definitions.length === 0 ? [] : [defs]),
		content.copy
	);
	return {
		parts: partsOf(svg),
		fit,
		sources: sourcesOf(root, own, [...styles, ...definitions]),
		pictures: [...drawn.pictures, ...defined.pictures],
		wanted: [...drawn.wanted, ...defined.wanted],
	};
};
