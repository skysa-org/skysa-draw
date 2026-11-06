import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { isLayerElement, layerKindOf } from '../document/layers.js';
import type { EditorDocument } from '../document/model.js';
import type { LayerExtent } from '../tools/common/align.js';
import { affineOf, releaseCanvas } from '../tools/raster/area.js';
import { inkExtent, padded } from '../tools/raster/grow.js';
import { type PixelGrid, pixelGrid, placePicture } from '../tools/raster/pixels.js';
import {
	boundsFor,
	cachedSurface,
	decodePicture,
	hrefOf,
	imageOf,
	UnreadablePictureError,
} from '../tools/raster/surface.js';
import {
	type Box,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
	transformBox,
	unionBox,
} from '../tools/vector/geometry.js';
import { type Measure, measureOf } from '../tools/vector/measure.js';

/**
 * What each layer paints, measured, for the move tool's alignment
 * (`tools/common/align.ts`): the box of it in the root's user units, the
 * drawing's `viewBox` units, so the view's zoom and pan change nothing.
 * Photoshop aligns a layer by its pixels that are not transparent, and this
 * is that, as near as each kind of layer can say it.
 *
 * A vector layer is the box around what its elements draw: each one's box as
 * the browser measures it (`measureOf`), larger by half its stroke where it
 * has one, since a stroke paints half outside the outline, and the box around
 * its four corners where its own `transform` and every one above it put
 * them. What draws nothing is passed over: an element not displayed or not
 * visible, a shape with neither a fill nor a stroke, and everything that only
 * defines things, `<defs>`, a mask, a clip, a pattern, a marker, a symbol,
 * and `<title>`, `<desc>`, `<metadata>` and `<style>`. A marker, a miter's
 * point and a filter's spread past the outline are not counted, and a mask
 * or a clip does not cut the box.
 *
 * A raster layer is the box around its pixels with any alpha (`inkBox`): from
 * its surface where a tool decoded it already (`cachedSurface`), which holds a
 * stroke still being encoded, and otherwise from its picture, decoded and
 * placed as a surface places it; once for the same pixels, which are then
 * only placed again (`measuredInk`). A picture that will not decode, or will
 * not be read back, is taken as its whole box, as Auto-Select takes it
 * (`probe.ts`), so the layer is aligned by where it is rather than not at
 * all. A group is the box around the layers in it that are displayed. A
 * layer that is not displayed, or is in a group that is not, paints nothing.
 *
 * Places are read from the `transform` attributes, as everywhere the app
 * moves a layer (docs/ARCHITECTURE.md §3, "Layers": position is `transform`),
 * and not from the browser's `getScreenCTM()`, whose matrices are single
 * precision: under a zoomed stage, Firefox gave back a `translate(1234.5
 * 567.25)` as 567.24994, which an alignment would write as a move of a layer
 * already in place. What is asked of the browser, the boxes, the computed
 * style and the pixels, is asked through `ExtentReaders`, which the tests
 * answer in its place: jsdom has none of them.
 */

/** How an element paints, by its computed style. */
export type Paint = Readonly<{
	/** Not `display: none`, which takes everything inside the element with it. */
	displayed: boolean;
	/** Not `visibility: hidden` or `collapse`, which an element inside may undo, so it is read where things draw. */
	visible: boolean;
	filled: boolean;
	/** The stroke's width in the element's own user units; 0 where it has none. */
	stroke: number;
}>;

/**
 * The RGBA of a box of pixels, rows `box.width` wide, as `getImageData` gives
 * them; throws where the browser will not let them be read.
 */
export type ReadPixels = (box: Box) => Uint8ClampedArray;

/**
 * A surface's pixels: how many, how to read them, and from them to the
 * root's user units; and what they are the pixels of, the surface and how
 * many writes had been asked of it, which tells pixels measured before from
 * pixels that changed since.
 */
export type Pixels = Readonly<{
	width: number;
	height: number;
	read: ReadPixels;
	toRoot: Mat;
	holder: object;
	writes: number;
}>;

/** What is asked of the browser to measure a layer, which the tests answer in its place. */
export type ExtentReaders = Readonly<{
	/** An element's box in its own user units, before its own `transform`. */
	measure: Measure;
	paint: (element: Element) => Paint;
	/**
	 * The pixels of the surface a tool made for the raster layer `layerId`
	 * already, while it still holds the file's picture; none otherwise.
	 */
	surface: (editor: EditorDocument, layerId: string) => Promise<Pixels | undefined>;
	/**
	 * The picture of `image` decoded, as its layer's pixel grid `grid` holds
	 * it, to be read a box at a time. Rejects where it will not decode.
	 */
	picture: (image: Element, grid: PixelGrid) => Promise<ReadPixels>;
}>;

/** Nine places, past which a sine of a right angle is noise. */
const clean = (value: number): number => Math.round(value * 1e9) / 1e9 || 0;

const cleanBox = (box: Box): Box => ({
	x: clean(box.x),
	y: clean(box.y),
	width: clean(box.width),
	height: clean(box.height),
});

/** How many pixels are read at once, at most: a band of a picture, 1 MB of RGBA. */
const BAND = 1 << 18;

/** The ink of the first of `count` boxes, `boxAt(0)` first, that has any. */
const firstInked = (
	read: ReadPixels,
	count: number,
	boxAt: (index: number) => Box,
	index = 0
): Box | undefined => {
	if (index >= count) return undefined;
	const box = boxAt(index);
	return inkExtent(read(box), box) ?? firstInked(read, count, boxAt, index + 1);
};

/**
 * `[from, to)` cut in bands of `step`, from its start or from its end: how
 * many, and the start and length of each by its place in that order.
 */
const bandsOf = (
	from: number,
	to: number,
	step: number,
	fromEnd: boolean
): Readonly<{ count: number; at: (index: number) => readonly [number, number] }> => ({
	count: Math.ceil((to - from) / step),
	at: (index) => {
		const start = fromEnd ? Math.max(from, to - (index + 1) * step) : from + index * step;
		const end = fromEnd ? to - index * step : Math.min(to, start + step);
		return [start, end - start];
	},
});

/**
 * The box around the pixels with any alpha of a picture `width` × `height`,
 * in its pixels; none where every one is clear. Read through `read` a band of
 * at most `most` pixels at a time: rows from the top down to the first band
 * with any, then from the bottom up to the last, then, between those rows,
 * columns from the left and from the right, so a picture with paint near its
 * edges is read only that far and a clear one once through, and none is ever
 * held whole.
 */
export const inkBox = (
	width: number,
	height: number,
	read: ReadPixels,
	most = BAND
): Box | undefined => {
	if (width < 1 || height < 1) return undefined;
	const rows = Math.max(1, Math.floor(most / width));
	const scanRows = (from: number, fromEnd: boolean): Box | undefined => {
		const bands = bandsOf(from, height, rows, fromEnd);
		return firstInked(read, bands.count, (index) => {
			const [y, length] = bands.at(index);
			return { x: 0, y, width, height: length };
		});
	};
	const top = scanRows(0, false);
	if (top === undefined) return undefined;
	const bottom = scanRows(top.y, true) ?? top;
	const y = top.y;
	const tall = bottom.y + bottom.height - y;
	const columns = Math.max(1, Math.floor(most / tall));
	const scanColumns = (from: number, fromEnd: boolean): Box | undefined => {
		const bands = bandsOf(from, width, columns, fromEnd);
		return firstInked(read, bands.count, (index) => {
			const [x, length] = bands.at(index);
			return { x, y, width: length, height: tall };
		});
	};
	const left = scanColumns(0, false) ?? top;
	const right = scanColumns(left.x, true) ?? left;
	return { x: left.x, y, width: right.x + right.width - left.x, height: tall };
};

/** What computed style says of how an element paints. A width in percent, which the app never writes, is not read. */
const paintOf = (element: Element): Paint => {
	const style = getComputedStyle(element);
	const visibility = style.getPropertyValue('visibility');
	const stroke = style.getPropertyValue('stroke');
	const width = style.getPropertyValue('stroke-width').trim();
	const strokeWidth = width.endsWith('%') ? 0 : Number.parseFloat(width);
	return {
		displayed: style.getPropertyValue('display') !== 'none',
		visible: visibility !== 'hidden' && visibility !== 'collapse',
		filled: style.getPropertyValue('fill') !== 'none',
		stroke: stroke !== 'none' && stroke !== '' && strokeWidth > 0 ? strokeWidth : 0,
	};
};

/**
 * The surface's pixels, once it has decoded them, where it is still the
 * layer's and they can be read: a surface whose picture failed has none.
 */
const surfacePixels = async (
	editor: EditorDocument,
	layerId: string
): Promise<Pixels | undefined> => {
	const surface = cachedSurface(editor, layerId);
	if (surface === undefined) return undefined;
	await surface.ready;
	const ctx = surface.readable() ? surface.canvas.getContext('2d') : null;
	if (ctx === null || cachedSurface(editor, layerId) !== surface) return undefined;
	return {
		width: surface.canvas.width,
		height: surface.canvas.height,
		read: (box) => ctx.getImageData(box.x, box.y, box.width, box.height).data,
		toRoot: invert(affineOf(surface.toPixel)),
		holder: surface,
		writes: surface.writes(),
	};
};

/**
 * The picture decoded as a surface decodes it, placed on the grid by its
 * `preserveAspectRatio`, and each box of it drawn onto a canvas of that box
 * alone and read back, so a band of a large picture costs a band.
 */
const pictureOf = async (image: Element, grid: PixelGrid): Promise<ReadPixels> => {
	const img = await decodePicture(hrefOf(image) ?? '');
	const natural = { width: img.naturalWidth, height: img.naturalHeight };
	const at = placePicture(image.getAttribute('preserveAspectRatio'), grid, natural);
	return (box) => {
		const canvas = document.createElement('canvas');
		canvas.width = box.width;
		canvas.height = box.height;
		try {
			const ctx = canvas.getContext('2d', { willReadFrequently: true });
			if (ctx === null)
				throw new UnreadablePictureError('no 2D canvas to read the picture on');
			ctx.drawImage(img, at.x - box.x, at.y - box.y, at.width, at.height);
			return ctx.getImageData(0, 0, box.width, box.height).data;
		} finally {
			releaseCanvas(canvas);
		}
	};
};

const BROWSER: ExtentReaders = {
	measure: measureOf,
	paint: paintOf,
	surface: surfacePixels,
	picture: pictureOf,
};

/** What groups the elements in a layer, and so is looked into. */
const CONTAINERS: ReadonlySet<string> = new Set(['g', 'a']);

/** What paints by its fill and its stroke. */
const SHAPES: ReadonlySet<string> = new Set([
	'path',
	'rect',
	'circle',
	'ellipse',
	'line',
	'polyline',
	'polygon',
	'text',
]);

/** What paints its box, whatever its own fill and stroke. */
const BOXED: ReadonlySet<string> = new Set(['image', 'use', 'svg', 'switch', 'foreignObject']);

/**
 * Where the user units of `element` are in the root's: the `transform`
 * written on it and on every element above it short of the root.
 */
const placeOf = (root: Element, element: Element | null): Mat =>
	element === null || element === root
		? IDENTITY
		: multiply(
				placeOf(root, element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

/** Where one element that draws paints, in its own user units: none where it paints nothing. */
const ownPaint = (readers: ExtentReaders, element: Element): Box | undefined => {
	const name = element.localName;
	const shape = SHAPES.has(name);
	if (!shape && !BOXED.has(name)) return undefined;
	const paint = readers.paint(element);
	if (!paint.displayed || !paint.visible) return undefined;
	const box = readers.measure(element);
	if (!shape) return box.width > 0 || box.height > 0 ? box : undefined;
	if (paint.stroke > 0) return padded(box, paint.stroke / 2);
	// A fill needs an inside, which a line never has.
	return paint.filled && name !== 'line' && box.width > 0 && box.height > 0 ? box : undefined;
};

/**
 * The boxes, in the root's user units, of what `element` and everything in
 * it paint, where `above` places its parent's user units in the root's.
 */
const paintedBoxes = (readers: ExtentReaders, element: Element, above: Mat): readonly Box[] => {
	if (element.namespaceURI !== SVG_NAMESPACE) return [];
	const place = multiply(above, parseTransform(element.getAttribute('transform')));
	if (CONTAINERS.has(element.localName)) {
		return readers.paint(element).displayed
			? [...element.children].flatMap((child) => paintedBoxes(readers, child, place))
			: [];
	}
	const box = ownPaint(readers, element);
	return box === undefined ? [] : [transformBox(place, box)];
};

/** From a grid's pixels to the units of the box it is stretched to. */
const gridToBox = (grid: PixelGrid, box: Box): Mat => [
	box.width / grid.width,
	0,
	0,
	box.height / grid.height,
	box.x,
	box.y,
];

/**
 * What a picture's pixels were measured from: its `href`, the grid it was
 * drawn on and how it was placed there, and the surface it was read from, by
 * a number, and that surface's writes then; none for the picture itself.
 */
type Source = Readonly<{
	href: string;
	grid: string;
	preserveAspectRatio: string | null;
	holder: number | undefined;
	writes: number | undefined;
}>;

/** The ink of a picture, in the pixels it was read from, and what it was read from. */
type Measured = Readonly<{ source: Source; ink: Box | undefined }>;

/**
 * Each picture's ink as last measured, by its `<image>`, so the move tool,
 * which measures every layer as a drag begins, decodes and reads a picture
 * once and not on every drag. Kept in the picture's own pixels, so a layer
 * moved or turned since is only placed again; measured again once its
 * `href` changed, or its grid, or, read from a surface, the surface did or
 * was asked to write, since it composites a stroke before the `href` it is
 * encoded as lands.
 */
const measuredInk = new WeakMap<Element, Measured>();

/**
 * A number for each surface, to tell one from another in `measuredInk`
 * without holding the surface, whose canvases would outlive it there.
 */
const holders = new WeakMap<object, number>();
const holdersSeen = cell(0);

const holderNumber = (holder: object): number => {
	const known = holders.get(holder);
	if (known !== undefined) return known;
	holdersSeen.current += 1;
	holders.set(holder, holdersSeen.current);
	return holdersSeen.current;
};

const sameSource = (one: Source, other: Source): boolean =>
	one.href === other.href &&
	one.grid === other.grid &&
	one.preserveAspectRatio === other.preserveAspectRatio &&
	one.holder === other.holder &&
	one.writes === other.writes;

/**
 * The ink of a picture in the pixels it is read from, the surface's where
 * there is one, the grid's otherwise; all of them where they cannot be
 * decoded or read, a picture from another origin or a browser with no 2D
 * canvas.
 */
const inkOf = async (
	readers: ExtentReaders,
	image: Element,
	grid: PixelGrid,
	held: Pixels | undefined
): Promise<Box | undefined> => {
	const size = held ?? grid;
	try {
		const read = held?.read ?? (await readers.picture(image, grid));
		return inkBox(size.width, size.height, read);
	} catch {
		return { x: 0, y: 0, width: size.width, height: size.height };
	}
};

/**
 * What a raster layer paints: its pixels with any alpha, from its surface or
 * from its picture, as measured already where they are the same pixels; none
 * for a layer with no picture yet, or one not seen.
 */
const rasterExtent = async (
	editor: EditorDocument,
	readers: ExtentReaders,
	layer: Element
): Promise<Box | undefined> => {
	const image = imageOf(layer);
	const href = image === undefined ? undefined : hrefOf(image);
	if (image === undefined || href === undefined) return undefined;
	const paint = readers.paint(image);
	if (!paint.displayed || !paint.visible) return undefined;
	const bounds = boundsFor(editor, image);
	const grid = pixelGrid(bounds);
	const held = await readers.surface(editor, layer.getAttribute('id') ?? '');
	const source: Source = {
		href,
		grid: `${grid.width}×${grid.height}`,
		preserveAspectRatio: image.getAttribute('preserveAspectRatio'),
		holder: held === undefined ? undefined : holderNumber(held.holder),
		writes: held?.writes,
	};
	const known = measuredInk.get(image);
	const ink =
		known !== undefined && sameSource(known.source, source)
			? known.ink
			: await inkOf(readers, image, grid, held);
	measuredInk.set(image, { source, ink });
	if (ink === undefined) return undefined;
	const toRoot = held?.toRoot ?? multiply(placeOf(editor.root, image), gridToBox(grid, bounds));
	return transformBox(toRoot, ink);
};

/** Whether every group above `element`, short of the root, is displayed. */
const displayedAbove = (readers: ExtentReaders, root: Element, element: Element): boolean => {
	const parent = element.parentElement;
	return (
		parent === null ||
		parent === root ||
		(readers.paint(parent).displayed && displayedAbove(readers, root, parent))
	);
};

/**
 * The extent of each layer of `document` as it is when asked, measured by
 * the browser, or by `given` in its place where it is given.
 */
export const layerExtentIn = (
	document: EditorDocument,
	given: Partial<ExtentReaders> = {}
): LayerExtent => {
	const readers: ExtentReaders = { ...BROWSER, ...given };
	// The raster layer last read, so the next is read after it rather than
	// beside it: a picture of 4096 × 3072 is 48 MB once decoded.
	const last = cell<Promise<unknown>>(Promise.resolve());
	const inTurn = <T>(read: () => Promise<T>): Promise<T> => {
		const next = last.current.then(read);
		last.current = next.catch(() => undefined);
		return next;
	};

	const extentOf = async (layer: Element): Promise<Box | undefined> => {
		if (!readers.paint(layer).displayed) return undefined;
		const kind = layerKindOf(layer);
		if (kind === 'raster') return inTurn(() => rasterExtent(document, readers, layer));
		if (kind === 'vector') {
			return unionBox(
				paintedBoxes(readers, layer, placeOf(document.root, layer.parentElement))
			);
		}
		const inside = await Promise.all([...layer.children].filter(isLayerElement).map(extentOf));
		return unionBox(inside.filter((box) => box !== undefined));
	};

	return async (id) => {
		const layer = document.layer(id);
		if (layer === undefined || !displayedAbove(readers, document.root, layer)) return undefined;
		const box = await extentOf(layer);
		return box === undefined ? undefined : cleanBox(box);
	};
};
