import { type DrawingSize, RASTER_MAX_SIDE } from '@skysa/draw-core';

import type { LayerExtent } from '../tools/common/align.js';
import { pixelGrid } from '../tools/raster/pixels.js';
import { hrefOf, imageOf } from '../tools/raster/surface.js';
import {
	type Box,
	type Mat,
	multiply,
	rotate,
	translate,
	unionBox,
} from '../tools/vector/geometry.js';
import {
	browserComposite,
	browserResampler,
	type Composite,
	type Resampler,
	unlikeCorner,
} from './canvasPixels.js';
import { movedPlan, placeOf, type Remade, rewriteCommand } from './canvasTransform.js';
import { keepingClips } from './clip.js';
import { compound } from './commands.js';
import { type CanvasBox, canvasBoxOf, cropCanvas } from './crop.js';
import { layerElementsOf, layerKindOf } from './layers.js';
import type { Command, EditorDocument } from './model.js';

/**
 * The drawing's Image operations, as Photoshop's Image menu has them: Image
 * Size, Canvas Size, Image Rotation, Trim and Reveal All. Each is one command,
 * labeled `image.undo.*`, that undo takes back to the very bytes. The canvas
 * is set as the crop sets it (`cropCanvas`): the `viewBox`, and `width` and
 * `height` scaled in their own unit. Every size is in whole user units, which
 * are the drawing's pixels, and every new canvas edge falls on the old
 * canvas's grid of whole units, counted from its corner.
 *
 * Image Rotation turns or flips everything drawn with the canvas, by a matrix
 * in front of each `transform` at the root (`canvasTransform.ts`), so nothing
 * is resampled: a raster layer is turned by its transform, as a move moves
 * it. The canvas keeps its top left corner, in user units, and a quarter turn
 * swaps its width and height; Arbitrary… turns about the canvas's center and
 * grows the canvas to the box around the turned one, rounded up to whole
 * units, the turned canvas in its middle. A quarter turn asked of Arbitrary…
 * is the fixed one, exactly.
 *
 * Canvas Size sets the canvas to the size asked, placed by the anchor:
 * `topLeft` keeps the old top left corner where it was, `bottomRight` the
 * bottom right, and the middle anchors split the difference, the odd unit to
 * the right or the bottom. Nothing drawn moves, and what the canvas gains is
 * transparent, as every drawing's canvas is.
 *
 * Image Size scales everything drawn and the canvas about the canvas's
 * corner, by the new width over the old across and the new height over the
 * old down. Without resampling only the transforms and the canvas change, and
 * a raster layer's pixels are larger or smaller. With it, each raster layer's
 * picture is made again with as many pixels to a user unit as it had (a
 * `Resampler`), no more on its longer side than `RASTER_MAX_SIDE` or than it
 * had, and its box grows by as much in the layer's own units, so a tool that
 * paints it later finds every pixel. A picture that is an SVG, or is placed
 * by a `preserveAspectRatio` other than `none`, which no raster layer the app
 * writes has, is scaled and not made again. The pictures are made first, one
 * at a time, and the command runs once they all are, unless the drawing
 * changed meanwhile ('changed') or one would not decode ('unrenderable').
 *
 * Trim cuts the canvas, on the sides asked, to what is painted on it:
 * by transparency, to the box around every shown layer's paint as the move
 * tool's alignment measures it (`LayerExtent`), so a mask, a clip or a
 * filter's spread is not counted; by a corner's color, to the box around
 * every pixel of the drawing rendered as an export renders it (a
 * `Composite`) that is not exactly that corner's color. Reveal All grows the
 * canvas to hold every shown layer's paint. Both round outward to whole
 * units, and do nothing, 'nothing', where nothing is painted or the canvas
 * would stay as it is.
 *
 * What measures or renders first is work a save waits for, and is dropped,
 * 'changed', where the drawing changed before it was done, a stroke landing
 * from its encoding included, as a merge's render is (`merge.ts`).
 */

/** Where the drawing stays as the canvas grows or shrinks around it: Photoshop's nine anchors. */
export type Anchor =
	| 'topLeft'
	| 'top'
	| 'topRight'
	| 'left'
	| 'center'
	| 'right'
	| 'bottomLeft'
	| 'bottom'
	| 'bottomRight';

/** Image Rotation's fixed turns and flips. */
export type CanvasTurn =
	'rotate180' | 'rotate90cw' | 'rotate90ccw' | 'flipHorizontal' | 'flipVertical';

/** What Trim cuts away: clear pixels, or pixels of the top left's color, or of the bottom right's. */
export type TrimBasis = 'transparent' | 'topLeft' | 'bottomRight';

/** Which sides Trim may cut. */
export type Sides = Readonly<{ top: boolean; bottom: boolean; left: boolean; right: boolean }>;

/** How an operation that measures or renders first came out. */
export type CanvasJob = 'done' | 'nothing' | 'changed' | 'unrenderable';

/** A size in user units, which are the drawing's pixels. */
export type Size = Readonly<{ width: number; height: number }>;

/** Past float noise, two edges are the same, and an edge on a whole unit is on it. */
const SLACK = 1e-6;

/** A size asked for, in whole units and at least one; none for one that is not a size. */
const wholeSize = (value: number): number | undefined =>
	Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : undefined;

const sameBox = (one: CanvasBox, other: CanvasBox): boolean =>
	Math.abs(one.x - other.x) < SLACK &&
	Math.abs(one.y - other.y) < SLACK &&
	Math.abs(one.width - other.width) < SLACK &&
	Math.abs(one.height - other.height) < SLACK;

/** No change, which costs nothing and which the document does not record. */
const unchanged = (label: string): Command => compound(label, []);

/**
 * The canvas set to `to` and everything drawn moved by `matrix`, its
 * pictures remade as `remade` says, as one step, every clip of a layer
 * whose `transform` that changes kept true (`keepingClips`): its `<use>`
 * the inverse of the layer's new `transform`, which a picture remade
 * changes too.
 */
const moveDrawing = (
	label: string,
	from: CanvasBox,
	to: CanvasBox,
	matrix: Mat,
	remade?: ReadonlyMap<Element, Remade>
): Command =>
	compound(label, [
		...(sameBox(from, to) ? [] : [cropCanvas(to, from)]),
		keepingClips(rewriteCommand(label, (live) => movedPlan(live, matrix, remade))),
	]);

/** Each fixed turn as the matrix that carries the canvas onto the turned one, its top left corner where it was. */
const TURNS: Readonly<Record<CanvasTurn, (box: CanvasBox) => Mat>> = {
	rotate180: ({ x, y, width, height }) => [-1, 0, 0, -1, 2 * x + width, 2 * y + height],
	rotate90cw: ({ x, y, height }) => [0, 1, -1, 0, x + y + height, y - x],
	rotate90ccw: ({ x, y, width }) => [0, -1, 1, 0, x - y, x + y + width],
	flipHorizontal: ({ x, width }) => [-1, 0, 0, 1, 2 * x + width, 0],
	flipVertical: ({ y, height }) => [1, 0, 0, -1, 0, 2 * y + height],
};

const isFlip = (turn: CanvasTurn): boolean => turn === 'flipHorizontal' || turn === 'flipVertical';

const isQuarter = (turn: CanvasTurn): boolean => turn === 'rotate90cw' || turn === 'rotate90ccw';

/** The fixed turns and flips: every layer turned or flipped with the canvas. One command. */
export const turnCanvas = (root: SVGSVGElement, opened: DrawingSize, turn: CanvasTurn): Command => {
	const from = canvasBoxOf(root, opened);
	const to = isQuarter(turn) ? { ...from, width: from.height, height: from.width } : from;
	const label = isFlip(turn) ? 'image.undo.flip' : 'image.undo.rotate';
	return moveDrawing(label, from, to, TURNS[turn](from));
};

/** A whole number of quarter turns clockwise, by how many: none, then the three fixed turns. */
const QUARTERS: readonly (CanvasTurn | undefined)[] = [
	undefined,
	'rotate90cw',
	'rotate180',
	'rotate90ccw',
];

/** Arbitrary: by `degrees`, clockwise where positive, the canvas grown to hold the turned one. One command. */
export const rotateCanvas = (
	root: SVGSVGElement,
	opened: DrawingSize,
	degrees: number
): Command => {
	const label = 'image.undo.rotate';
	if (!Number.isFinite(degrees)) return unchanged(label);
	const turn = ((degrees % 360) + 360) % 360;
	const quarters = Math.round(turn / 90);
	if (Math.abs(turn - quarters * 90) < 1e-9) {
		const fixed = QUARTERS[quarters % 4];
		return fixed === undefined ? unchanged(label) : turnCanvas(root, opened, fixed);
	}
	const from = canvasBoxOf(root, opened);
	const radians = (turn * Math.PI) / 180;
	const cos = Math.abs(Math.cos(radians));
	const sin = Math.abs(Math.sin(radians));
	const width = Math.ceil(from.width * cos + from.height * sin - SLACK);
	const height = Math.ceil(from.width * sin + from.height * cos - SLACK);
	const center = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
	const matrix = multiply(
		translate(from.x + width / 2 - center.x, from.y + height / 2 - center.y),
		rotate(turn, center)
	);
	return moveDrawing(label, from, { ...from, width, height }, matrix);
};

/** How far across and down the old canvas the anchor holds still: 0, a half or all of it. */
const ANCHORS: Readonly<Record<Anchor, readonly [number, number]>> = {
	topLeft: [0, 0],
	top: [0.5, 0],
	topRight: [1, 0],
	left: [0, 0.5],
	center: [0.5, 0.5],
	right: [1, 0.5],
	bottomLeft: [0, 1],
	bottom: [0.5, 1],
	bottomRight: [1, 1],
};

/**
 * How far the new canvas's near edge is from the old one's: none, the whole
 * difference, or half of it in whole units, so the odd unit falls to the far
 * side whether the canvas grows or shrinks.
 */
const shift = (at: number, from: number, to: number): number =>
	at === 0.5 ? Math.trunc((from - to) / 2) : at * (from - to);

/** Canvas Size: the canvas set to `size`, placed by `anchor`; nothing drawn moves. One command. */
export const resizeCanvas = (
	root: SVGSVGElement,
	opened: DrawingSize,
	size: Size,
	anchor: Anchor
): Command => {
	const label = 'image.undo.canvasSize';
	const width = wholeSize(size.width);
	const height = wholeSize(size.height);
	if (width === undefined || height === undefined) return unchanged(label);
	const from = canvasBoxOf(root, opened);
	const [across, down] = ANCHORS[anchor];
	const to = {
		x: from.x + shift(across, from.width, width),
		y: from.y + shift(down, from.height, height),
		width,
		height,
	};
	return sameBox(from, to) ? unchanged(label) : compound(label, [cropCanvas(to, from)]);
};

/** A picture to make again: its `<image>`, its `href`, and how much the scale stretches each of its axes. */
type PictureJob = Readonly<{
	image: Element;
	href: string;
	by: Readonly<{ x: number; y: number }>;
}>;

const PLAIN_NUMBER = /^\s*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

/** Whether the attribute is a plain number, or absent where `optional`. */
const isPlain = (image: Element, name: string, optional: boolean): boolean => {
	const value = image.getAttribute(name);
	return value === null ? optional : PLAIN_NUMBER.test(value);
};

/**
 * Whether a raster layer's picture is made again by a scale: one of pixels,
 * not an SVG, stretched to its box as the app writes it, in plain numbers
 * and with no `transform` of its own.
 */
const remakeable = (image: Element, href: string): boolean =>
	!/^data:image\/svg\+xml[;,]/i.test(href) &&
	(image.getAttribute('preserveAspectRatio') ?? '').trim() === 'none' &&
	!image.hasAttribute('transform') &&
	isPlain(image, 'x', true) &&
	isPlain(image, 'y', true) &&
	isPlain(image, 'width', false) &&
	isPlain(image, 'height', false);

/** How much `m` stretches the direction (`vx`, `vy`): its length after over its length before. */
const stretch = (m: Mat, vx: number, vy: number): number =>
	Math.hypot(m[0] * vx + m[2] * vy, m[1] * vx + m[3] * vy) / Math.hypot(vx, vy);

/** The raster pictures `matrix` scales, each with how much along each of its own axes. */
const pictureJobs = (root: SVGSVGElement, matrix: Mat): readonly PictureJob[] =>
	layerElementsOf(root)
		.filter((layer) => layerKindOf(layer) === 'raster')
		.flatMap((layer) => {
			const image = imageOf(layer);
			const href = hrefOf(image);
			if (image === undefined || href === undefined || !remakeable(image, href)) return [];
			const place = placeOf(root, layer);
			const by = {
				x: stretch(matrix, place[0], place[1]),
				y: stretch(matrix, place[2], place[3]),
			};
			const sound = [by.x, by.y].every((value) => Number.isFinite(value) && value > 0);
			return sound ? [{ image, href, by }] : [];
		});

/**
 * The pixels a picture of `natural` size has once stretched `by`, its longer
 * side no more than a raster layer's, or than it had where it had more;
 * none where that is the size it has.
 */
const remadeSize = (natural: Size, by: PictureJob['by']): Size | undefined => {
	if (natural.width < 1 || natural.height < 1) throw new Error('the picture has no pixels');
	const width = natural.width * by.x;
	const height = natural.height * by.y;
	const most = Math.max(RASTER_MAX_SIDE, natural.width, natural.height);
	const fit = Math.min(1, most / Math.max(width, height));
	const size = {
		width: Math.max(1, Math.round(width * fit)),
		height: Math.max(1, Math.round(height * fit)),
	};
	return size.width === natural.width && size.height === natural.height ? undefined : size;
};

type Made = readonly (readonly [Element, Remade])[];

/** Every picture the scale makes again, one after another; none where one would not decode or encode. */
const remadePictures = async (
	root: SVGSVGElement,
	matrix: Mat,
	resampler: Resampler
): Promise<ReadonlyMap<Element, Remade> | undefined> => {
	try {
		const made = await pictureJobs(root, matrix).reduce<Promise<Made>>(async (done, job) => {
			const before = await done;
			const picture = await resampler(job.href);
			const size = remadeSize(picture, job.by);
			if (size === undefined) return before;
			const href = await picture.drawn(size);
			return [...before, [job.image, { href, ...job.by }]];
		}, Promise.resolve([]));
		return new Map(made);
	} catch {
		return undefined;
	}
};

/** Image Size: the canvas and everything drawn scaled to `size`; with `resample`, raster layers' pixels too. */
export const resizeImage = (
	document: EditorDocument,
	size: Size & Readonly<{ resample: boolean }>,
	resampler: Resampler = browserResampler
): Promise<CanvasJob> => {
	const label = 'image.undo.imageSize';
	const width = wholeSize(size.width);
	const height = wholeSize(size.height);
	const from = canvasBoxOf(document.root, document.size);
	if (width === undefined || height === undefined) return Promise.resolve('nothing');
	if (width === from.width && height === from.height) return Promise.resolve('nothing');
	const sx = width / from.width;
	const sy = height / from.height;
	const matrix: Mat = [sx, 0, 0, sy, from.x * (1 - sx), from.y * (1 - sy)];
	const run = (remade?: ReadonlyMap<Element, Remade>): CanvasJob => {
		document.execute(moveDrawing(label, from, { ...from, width, height }, matrix, remade));
		return 'done';
	};
	if (!size.resample) return Promise.resolve(run());
	const version = document.snapshot().version;
	const job = remadePictures(document.root, matrix, resampler).then((remade): CanvasJob => {
		if (remade === undefined) return 'unrenderable';
		if (document.snapshot().version !== version) return 'changed';
		return run(remade);
	});
	document.pending(job);
	return job;
};

/** The box grown outward to whole units of the grid that starts at `origin`, at least one each way. */
const wholeUnits = (box: Box, origin: Readonly<{ x: number; y: number }>): Box => {
	const left = origin.x + Math.floor(box.x - origin.x + SLACK);
	const top = origin.y + Math.floor(box.y - origin.y + SLACK);
	const right = origin.x + Math.ceil(box.x + box.width - origin.x - SLACK);
	const bottom = origin.y + Math.ceil(box.y + box.height - origin.y - SLACK);
	return {
		x: left,
		y: top,
		width: Math.max(1, right - left),
		height: Math.max(1, bottom - top),
	};
};

/** Where two boxes overlap; none where they do not. */
const overlap = (one: Box, other: Box): Box | undefined => {
	const left = Math.max(one.x, other.x);
	const top = Math.max(one.y, other.y);
	const right = Math.min(one.x + one.width, other.x + other.width);
	const bottom = Math.min(one.y + one.height, other.y + other.height);
	return right > left && bottom > top
		? { x: left, y: top, width: right - left, height: bottom - top }
		: undefined;
};

type Measured = Box | undefined | 'unrenderable';

/** The box around what every shown layer at the root paints, groups with what is in them. */
const paintedBox = async (document: EditorDocument, extent: LayerExtent): Promise<Measured> => {
	const ids = document
		.snapshot()
		.layers.filter((layer) => layer.depth === 0 && !layer.hidden)
		.map((layer) => layer.id);
	try {
		const boxes = await Promise.all(ids.map(extent));
		return unionBox(boxes.filter((box) => box !== undefined));
	} catch {
		return 'unrenderable';
	}
};

/** The box around every pixel of the canvas rendered that is not the corner's color, in user units. */
const unlikeBox = async (
	document: EditorDocument,
	from: CanvasBox,
	corner: 'topLeft' | 'bottomRight',
	composite: Composite
): Promise<Measured> => {
	const grid = pixelGrid(from);
	try {
		const data = await composite(document, from, grid.width, grid.height);
		if (data === undefined) return 'unrenderable';
		const box = unlikeCorner(data, grid.width, grid.height, corner);
		if (box === undefined) return undefined;
		const across = from.width / grid.width;
		const down = from.height / grid.height;
		return {
			x: from.x + box.x * across,
			y: from.y + box.y * down,
			width: box.width * across,
			height: box.height * down,
		};
	} catch {
		return 'unrenderable';
	}
};

/**
 * What measures the drawing, then `finish` of what it found and the canvas
 * it found it on, unless the drawing changed meanwhile: work a save waits
 * for.
 */
const afterMeasure = (
	document: EditorDocument,
	measure: (from: CanvasBox) => Promise<Measured>,
	finish: (found: Box | undefined, from: CanvasBox) => CanvasJob
): Promise<CanvasJob> => {
	const version = document.snapshot().version;
	const from = canvasBoxOf(document.root, document.size);
	const job = measure(from).then((found): CanvasJob => {
		if (found === 'unrenderable') return 'unrenderable';
		if (document.snapshot().version !== version) return 'changed';
		return finish(found, from);
	});
	document.pending(job);
	return job;
};

/** The canvas set to `to`, as one command labeled `label`, where that changes it. */
const setCanvas = (
	document: EditorDocument,
	label: string,
	from: CanvasBox,
	to: CanvasBox
): CanvasJob => {
	if (sameBox(from, to)) return 'nothing';
	document.execute(compound(label, [cropCanvas(to, from)]));
	return 'done';
};

/** The canvas's edges, each cut to the trimmed box's where its side is to be cut. */
const trimmedSides = (from: CanvasBox, trim: Box, sides: Sides): CanvasBox => {
	const left = sides.left ? trim.x : from.x;
	const top = sides.top ? trim.y : from.y;
	const right = sides.right ? trim.x + trim.width : from.x + from.width;
	const bottom = sides.bottom ? trim.y + trim.height : from.y + from.height;
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/** Trim: the canvas cut to what is painted, on the sides given. */
export const trimCanvas = (
	document: EditorDocument,
	basis: TrimBasis,
	sides: Sides,
	extent: LayerExtent,
	composite: Composite = browserComposite
): Promise<CanvasJob> => {
	if (!(sides.top || sides.bottom || sides.left || sides.right))
		return Promise.resolve('nothing');
	return afterMeasure(
		document,
		(from) =>
			basis === 'transparent'
				? paintedBox(document, extent)
				: unlikeBox(document, from, basis, composite),
		(found, from) => {
			const trim = found === undefined ? undefined : overlap(wholeUnits(found, from), from);
			if (trim === undefined) return 'nothing';
			return setCanvas(document, 'image.undo.trim', from, trimmedSides(from, trim, sides));
		}
	);
};

/** Reveal All: the canvas grown to hold every layer's paint. */
export const revealAll = (document: EditorDocument, extent: LayerExtent): Promise<CanvasJob> =>
	afterMeasure(
		document,
		() => paintedBox(document, extent),
		(found, from) => {
			const to = found === undefined ? from : unionBox([from, wholeUnits(found, from)]);
			return setCanvas(document, 'image.undo.revealAll', from, to ?? from);
		}
	);
