import { SVG_NAMESPACE } from '@skysa/draw-core';
import { cell } from '@skysa/storage';

import { replaceRasterImage } from '../../document/commands.js';
import { canvasBoxOf } from '../../document/crop.js';
import type { Command, EditorDocument } from '../../document/model.js';
import { encodeInWorker } from '../../pictures/index.js';
import type { ToolContext } from '../types.js';
import { type Box, invert, multiply, transformBox, translate } from '../vector/geometry.js';
import {
	affineOf,
	type Area,
	areaMask,
	clipToArea,
	isPlain,
	keepCovered,
	releaseCanvas,
} from './area.js';
import {
	boundsAt,
	heldTo,
	holdsBox,
	inkExtent,
	intersect,
	joinBoxes,
	keepsGrid,
	mostPixels,
	outside,
	padded,
	sameBox,
	shiftBox,
	wholePixels,
} from './grow.js';
import { type Bounds, pixelGrid, placePicture } from './pixels.js';
import { toLocal } from './space.js';

/**
 * The pixel surface of one raster layer while it is edited (docs/ARCHITECTURE.md
 * §3, "Layers"; §7, "The editor"). The layer's `<image>` is decoded onto a
 * canvas the size of the layer's pixel grid once; a stroke is painted on a
 * second canvas, as large or larger, and composited onto the first when it
 * ends, and the first is then encoded as PNG and written into the `<image>`
 * by a command. The encoding is asynchronous on purpose: the stroke stays on
 * screen until the new `href` lands, and a save waits for it through
 * `EditorDocument.pending`.
 *
 * The pixels grow to hold what is written past them, as a layer in
 * Photoshop has no edge of its own (`grow.ts`): a stroke, a shape, a fill or
 * a move that lands outside the grid grows it, in whole pixels at the same
 * pixels per unit, and the `<image>`'s `x`, `y`, `width` and `height` with
 * it, in the same command as the pixels, so nothing already there moves and
 * an undo gives back the file's bytes. Painting grows them only on the
 * drawing's canvas, as Photoshop paints only there; a move keeps its pixels
 * wherever they go. What is written past the grid is read back before the
 * file is: the grid grows only as far as some pixel there was left with any
 * alpha, so a stroke that lands nothing past it does not grow it, and it
 * never shrinks. A tool that holds pixel places
 * across a write holds them in the grid the surface was made with, its
 * frame, which a grid grown left or up starts before (`origin`).
 *
 * One surface per layer per document, cached, and rebuilt when the `href` or
 * the geometry under it is no longer the one it was built from or last
 * wrote: an undo or a redo put other pixels in the file, and the file is the
 * only source of truth.
 */

/** The layer's picture would not decode, so painting on it would replace it with nothing. */
export class UnreadablePictureError extends Error {
	override readonly name = 'UnreadablePictureError';
}

export type CompositeMode = 'source-over' | 'destination-out';

/**
 * What a write's painter is told besides the context: which of the canvas's
 * pixels a write may land on, and whether that is every one of them.
 */
export type Room = Readonly<{ holds: (x: number, y: number) => boolean; everywhere: boolean }>;

/**
 * What a painter did: nothing, which writes nothing; something; or something
 * inside this box of the canvas's pixels as they were when it ran, which is
 * all that is read back to know how far it reached.
 */
type Painted = boolean | Box;

/** A painter of the layer's pixels, given the context of them and where a write may land. */
export type Painter = (ctx: CanvasRenderingContext2D, room: Room) => Painted;

/**
 * Where a write may land past the layer's pixels, so the grid is grown to
 * hold it before the painter runs: a box of the canvas's pixels as they are
 * then, which may be outside them; and whether it may land off the drawing's
 * canvas too, as a move's pixels may. The grid grows only as far as the
 * painter then leaves any alpha.
 */
export type Grow = Readonly<{ reach: () => Box | undefined; offCanvas?: boolean }>;

export interface RasterSurface {
	readonly layerId: string;
	/**
	 * The `<image>`'s geometry the pixels cover now, in the layer's user units:
	 * the canvas's for a layer without one yet, and larger once they grew.
	 */
	readonly bounds: Bounds;
	/** Pixels per user unit. */
	readonly ppu: number;
	/** The layer's pixels; another canvas each time they grow, so read it when it is wanted. */
	readonly canvas: HTMLCanvasElement;
	/**
	 * The stroke under way, composited onto `canvas` by `commit`: as large as
	 * it, or larger where a stroke went past it (`extendStroke`).
	 */
	readonly stroke: HTMLCanvasElement;
	/** The existing picture decoded onto `canvas`; at once for a layer without one. Never rejects. */
	readonly ready: Promise<void>;
	/** Whether `ready` has settled, for a tool that reads the pixels as it goes. */
	readonly decoded: () => boolean;
	/** Whether the pixels are decoded and may be read: the picture neither failed nor is still decoding. */
	readonly readable: () => boolean;
	/**
	 * How many writes have been asked of this surface (`commit`, `paint`,
	 * `derive`, `rewrite`), counted as they are asked, before any is decoded or
	 * encoded: a tool that remembers what it wrote knows by this whether
	 * another has written since.
	 */
	readonly writes: () => number;
	/** The `href` the pixels came from, to tell when the file moved under the surface. */
	readonly source: () => string | undefined;
	/** The `<image>`'s geometry as the file has it, as far as the surface knows: made from or last written. */
	readonly sourceBounds: () => Bounds;
	/**
	 * Where the first pixel of the grid the surface was made with is on
	 * `canvas` now: `[0, 0]` until the pixels grow left or up. A pixel of the
	 * canvas less this is a pixel of that frame, which no write moves.
	 */
	readonly origin: () => readonly [number, number];
	/** The root's user units to `canvas`'s pixels, through the layer's own transform. Not rounded. */
	readonly toPixel: (x: number, y: number) => readonly [number, number];
	/** The root's user units to `stroke`'s pixels. */
	readonly toStroke: (x: number, y: number) => readonly [number, number];
	/**
	 * The box of `canvas`'s pixels a write reaching `reach`, in them too, may
	 * grow the layer's pixels to: them, and as much of `reach` as is on the
	 * drawing's canvas, or all of it `offCanvas`, held to as many pixels as a
	 * layer may have (`mostPixels`).
	 */
	readonly room: (reach: Box, offCanvas?: boolean) => Box;
	/** The box of `canvas`'s pixels painting may grow the layer's to: them and the drawing's canvas (`room`). */
	readonly paintRoom: () => Box;
	/**
	 * The stroke canvas made to reach `box`, in the root's user units, as far
	 * as painting may grow the layer's pixels (`paintRoom`), what is on it
	 * kept: for a stroke that paints past them, before it does.
	 */
	readonly extendStroke: (box: Box) => void;
	/**
	 * The layer's pixels made to reach `box`, in the root's user units, as far
	 * as painting may grow them, transparent there: for a tool that paints on
	 * them as it goes, the smudge, before it does. What is not written there
	 * by the next write is given back then.
	 */
	readonly extend: (box: Box) => void;
	/**
	 * The stroke composited onto the pixels in `mode` at `opacity`, once, so
	 * overlapping stamps do not darken, and only as far as `area` covers each
	 * pixel where one is selected: through a clip for a plain area, through
	 * the area's mask for an inverted or a feathered one (`areaMask`); then
	 * encoded and written, after every write this surface began before it.
	 * `written`, in the root's user units, is where the stroke painted, for
	 * how far it may grow the pixels; with none, anywhere on `stroke`. One
	 * that lands on neither the pixels nor the canvas, or an eraser's off the
	 * pixels, writes nothing. Resolves after the command executed; rejects
	 * with `UnreadablePictureError` for a picture that would not decode or
	 * cannot be read, and nothing is written then.
	 */
	readonly commit: (
		label: string,
		mode: CompositeMode,
		opacity: number,
		area?: Area,
		written?: Box
	) => Promise<void>;
	/**
	 * A change made straight to the layer's pixels once they are decoded, for
	 * a fill: `painter` says whether it changed any, and only then are they
	 * encoded and written, so a picture placed from a file keeps its bytes
	 * until a pixel of it changes. With `grow`, the pixels are grown first to
	 * hold what it may write past them. Rejects as `commit` does.
	 */
	readonly paint: (label: string, painter: Painter, grow?: Grow) => Promise<void>;
	/**
	 * A change to the layer's pixels made from something other than what they
	 * are, for a move from pixels a tool remembers: as `paint`, and, as
	 * `derive`, written only where the file's picture is still the one these
	 * pixels came from when the encoding lands; it rejects otherwise, since an
	 * undo meanwhile put other pixels in the file. Resolves on whether it was
	 * written, which it is not where `painter` changed nothing or the layer went.
	 */
	readonly rewrite: (label: string, painter: Painter, grow?: Grow) => Promise<boolean>;
	/**
	 * A picture made from the layer's pixels once they are decoded, written by
	 * one command with them: `painter` may change the pixels, as for `paint`,
	 * and gives back the picture, a canvas of the same size; whether it changed
	 * the layer's own pixels, which are then encoded too; and the command to
	 * make of the picture's `href`, the layer's new one, and the geometry both
	 * cover, which this surface executes in its turn, after every write it
	 * began before. Or nothing, and nothing is written. Resolves on whether
	 * the command executed, which it does not into a layer that went
	 * meanwhile; rejects as `commit` does, and where the file's picture moved
	 * under the surface while it encoded (an undo), since the pixels it holds
	 * are then not the file's.
	 */
	readonly derive: (
		painter: (ctx: CanvasRenderingContext2D) =>
			| Readonly<{
					picture: HTMLCanvasElement;
					changed: boolean;
					command: (picture: string, own: string | undefined, bounds: Bounds) => Command;
			  }>
			| undefined
	) => Promise<boolean>;
	/** Forget the surface: the next tool to ask gets one built from the file again. */
	readonly discard: () => void;
}

const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/**
 * The one `<image>` a raster layer holds, where it holds one yet: SVG's own,
 * the one `replaceRasterImage` writes, and not an element of that name in
 * another namespace.
 */
export const imageOf = (layer: Element): Element | undefined =>
	Array.from(layer.children).find(
		(child) => child.namespaceURI === SVG_NAMESPACE && child.localName === 'image'
	);

/** `href`, or the `xlink:href` an older file writes. */
export const hrefOf = (image: Element | undefined): string | undefined =>
	image?.getAttribute('href') ?? image?.getAttributeNS(XLINK_NAMESPACE, 'href') ?? undefined;

/** A length in user units, with or without `px`; 0 for anything else. */
const numberAt = (element: Element, name: string): number => {
	const value = Number((element.getAttribute(name) ?? '').trim().replace(/px$/, ''));
	return Number.isFinite(value) ? value : 0;
};

/** The image's geometry, where it has a size; a placed image without one is given the canvas's. */
const boundsOf = (image: Element): Bounds | undefined => {
	const width = numberAt(image, 'width');
	const height = numberAt(image, 'height');
	if (width <= 0 || height <= 0) return undefined;
	return { x: numberAt(image, 'x'), y: numberAt(image, 'y'), width, height };
};

/** What an empty raster layer covers: the drawing's canvas, from the `viewBox`'s origin. */
const canvasBounds = (editor: EditorDocument): Bounds => {
	const [minX = 0, minY = 0] = (editor.root.getAttribute('viewBox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	return {
		x: Number.isFinite(minX) ? minX : 0,
		y: Number.isFinite(minY) ? minY : 0,
		width: editor.size.width,
		height: editor.size.height,
	};
};

/** What a layer's pixels cover: its `<image>`'s geometry, or the canvas for a layer without one yet. */
export const boundsFor = (editor: EditorDocument, image: Element | undefined): Bounds =>
	(image === undefined ? undefined : boundsOf(image)) ?? canvasBounds(editor);

const sameBounds = (a: Bounds, b: Bounds): boolean =>
	a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

const blankCanvas = (width: number, height: number): HTMLCanvasElement => {
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	return canvas;
};

/** Every pixel transparent again. */
export const clearCanvas = (canvas: HTMLCanvasElement): void => {
	canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
};

/** The canvas's pixels on a new one covering `next`, where it covers `was`, both in one frame. */
const relaid = (
	canvas: HTMLCanvasElement,
	was: Box,
	next: Box,
	keep: boolean
): HTMLCanvasElement => {
	const made = blankCanvas(next.width, next.height);
	if (keep) made.getContext('2d')?.drawImage(canvas, was.x - next.x, was.y - next.y);
	releaseCanvas(canvas);
	return made;
};

/**
 * The picture decoded, ready to draw where the browser shows it, by the
 * `<image>`'s `preserveAspectRatio`. `src` is set as an attribute, and the
 * element never enters the page: it is decoded, drawn and dropped. A picture
 * the browser cannot decode rejects.
 */
export const decodePicture = async (href: string): Promise<HTMLImageElement> => {
	const img = document.createElement('img');
	img.setAttribute('src', href);
	await img.decode();
	return img;
};

/** The canvas as a PNG blob; `null` where the browser has no `toBlob`, or it gave nothing. */
const blobOf = (canvas: HTMLCanvasElement): Promise<Blob | null> =>
	new Promise((resolve) => {
		try {
			canvas.toBlob(resolve, 'image/png');
		} catch {
			resolve(null);
		}
	});

const dataUrlOf = (blob: Blob): Promise<string> =>
	new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.addEventListener(
			'load',
			() => {
				if (typeof reader.result === 'string') resolve(reader.result);
				else reject(new Error('the encoded picture could not be read back'));
			},
			{ once: true }
		);
		reader.addEventListener(
			'error',
			() => reject(new Error('the encoded picture could not be read back')),
			{ once: true }
		);
		reader.readAsDataURL(blob);
	});

/**
 * The canvas as a `data:` URL of a PNG on this thread: through `toBlob` and a
 * `FileReader`, which do not hold the main thread for the encoding, and
 * through `toDataURL`, which does, where `toBlob` is not there or gave nothing.
 */
const encodeHere = async (canvas: HTMLCanvasElement): Promise<string> => {
	const blob = await blobOf(canvas);
	return blob === null ? canvas.toDataURL('image/png') : dataUrlOf(blob);
};

/**
 * The canvas as a `data:` URL of a PNG, of its pixels as they are when this
 * is called: in the pictures worker (`../../pictures/`), from a snapshot
 * taken now and transferred to it, which leaves the page's thread neither
 * the read back nor the reading of the PNG as a `data:` URL; and here
 * (`encodeHere`) where there is no worker, or from the snapshot where the
 * worker failed. Either way the PNG decodes to the same bytes, a pixel that
 * is partly transparent among them.
 */
const encodePng = (canvas: HTMLCanvasElement): Promise<string> =>
	encodeInWorker(canvas, encodeHere) ?? encodeHere(canvas);

const surfaces = new WeakMap<EditorDocument, Map<string, RasterSurface>>();

const cacheFor = (editor: EditorDocument): Map<string, RasterSurface> => {
	const found = surfaces.get(editor);
	if (found !== undefined) return found;
	const made = new Map<string, RasterSurface>();
	surfaces.set(editor, made);
	return made;
};

/** Below this a matrix's turn is none: the layer is upright, its pixels' rows the canvas's. */
const UPRIGHT = 1e-9;

const insideBox = (box: Box, x: number, y: number): boolean =>
	x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height;

const createSurface = (
	editor: EditorDocument,
	layerId: string,
	layer: SVGGraphicsElement
): RasterSurface => {
	const image = imageOf(layer);
	const href = hrefOf(image);
	const first = boundsFor(editor, image);
	const grid = pixelGrid(first);
	const limit = mostPixels(first, grid);
	const whole: Box = { x: 0, y: 0, width: grid.width, height: grid.height };
	// In the frame: the grid as it was made, from its first pixel. `extent` is
	// what `canvas` covers, `kept` what of it is the layer's own, which is all
	// of it but while a tool paints on the pixels past it (`extend`).
	const extent = cell<Box>(whole);
	const kept = cell<Box>(whole);
	const strokeExtent = cell<Box>(whole);
	const canvas = cell(blankCanvas(grid.width, grid.height));
	const stroke = cell(blankCanvas(grid.width, grid.height));
	// What past `kept` a write may have left alpha on since the last was read back.
	const dirty = cell<Box | undefined>(undefined);
	// Without a 2D context (jsdom, or a browser with canvas turned off) the
	// surface is inert: strokes paint nothing and commit nothing.
	const inert = canvas.current.getContext('2d') === null;
	const source = cell(href);
	const sourceBounds = cell<Bounds>(first);
	const failure = cell<UnreadablePictureError | undefined>(undefined);
	// The last write begun, so the next lands after it: two encodings under
	// way at once may finish in either order, and the later stroke's pixels
	// hold the earlier's, so the later must be the one the file keeps.
	const queue = cell<Promise<void>>(Promise.resolve());
	const asked = cell(0);
	const settled = cell(href === undefined || inert);

	const ctxOf = (): CanvasRenderingContext2D | null => canvas.current.getContext('2d');

	const origin = (): readonly [number, number] => [0 - extent.current.x, 0 - extent.current.y];

	/** The root's user units to the frame's pixels. */
	const toFrame = (x: number, y: number): readonly [number, number] => {
		const live = editor.layer(layerId) ?? layer;
		const [lx, ly] = toLocal(live, editor.root, x, y);
		return [(lx - first.x) * grid.ppu, (ly - first.y) * grid.ppu];
	};

	const toPixel = (x: number, y: number): readonly [number, number] => {
		const [fx, fy] = toFrame(x, y);
		return [fx - extent.current.x, fy - extent.current.y];
	};

	const toStroke = (x: number, y: number): readonly [number, number] => {
		const [fx, fy] = toFrame(x, y);
		return [fx - strokeExtent.current.x, fy - strokeExtent.current.y];
	};

	const drawingCanvas = (): Box => canvasBoxOf(editor.root, editor.size);

	/** The drawing's canvas in the frame, in the whole pixels it touches. */
	const canvasFrame = (): Box => wholePixels(transformBox(affineOf(toFrame), drawingCanvas()));

	const toCanvas = (box: Box): Box => shiftBox(box, -extent.current.x, -extent.current.y);

	const toFrameBox = (box: Box): Box => shiftBox(box, extent.current.x, extent.current.y);

	/** In the frame: what a write reaching `reach` may grow the pixels to. */
	const roomIn = (reach: Box, offCanvas: boolean): Box => {
		const on = offCanvas ? reach : intersect(reach, canvasFrame());
		return on === undefined ? extent.current : heldTo(extent.current, on, limit);
	};

	const relayStroke = (next: Box, keep: boolean): void => {
		stroke.current = relaid(stroke.current, strokeExtent.current, next, keep);
		strokeExtent.current = next;
	};

	/** The stroke canvas as large as the pixels again, once what was on it is composited. */
	const resetStroke = (): void => {
		if (!sameBox(strokeExtent.current, extent.current)) relayStroke(extent.current, false);
	};

	/** The pixels on a canvas covering `next`, in the frame; the stroke's grown to cover it too. */
	const relayout = (next: Box): void => {
		canvas.current = relaid(canvas.current, extent.current, next, true);
		extent.current = next;
		if (!holdsBox(strokeExtent.current, next)) {
			relayStroke(joinBoxes(strokeExtent.current, next), true);
		}
	};

	/** The pixels grown to hold `reach`, in the frame, as far as `roomIn` allows and the grid reads back. */
	const growTo = (reach: Box, offCanvas: boolean): void => {
		const next = roomIn(reach, offCanvas);
		if (sameBox(next, extent.current) || !keepsGrid(first, grid, next)) return;
		relayout(next);
	};

	const markDirty = (box: Box): void => {
		dirty.current = dirty.current === undefined ? box : joinBoxes(dirty.current, box);
	};

	/**
	 * Pixels past the layer's own that are off the drawing's canvas taken
	 * away, as painting lands only on the canvas: a mask of the layer's own
	 * and the canvas, the canvas's edge to the whole pixel it touches, so a
	 * pixel the edge crosses keeps all it was given.
	 */
	const keepToCanvas = (target: HTMLCanvasElement): void => {
		const matrix = multiply(translate(-extent.current.x, -extent.current.y), affineOf(toFrame));
		const upright = Math.abs(matrix[1]) < UPRIGHT && Math.abs(matrix[2]) < UPRIGHT;
		const on = toCanvas(canvasFrame());
		const own = toCanvas(kept.current);
		const all = { x: 0, y: 0, width: target.width, height: target.height };
		if (upright && outside(all, own).every((band) => holdsBox(on, band))) return;
		const mask = blankCanvas(target.width, target.height);
		const ctx = mask.getContext('2d');
		if (ctx === null) return;
		ctx.fillStyle = '#000000';
		ctx.fillRect(own.x, own.y, own.width, own.height);
		if (upright) {
			ctx.fillRect(on.x, on.y, on.width, on.height);
		} else {
			const [a, b, c, d, e, f] = matrix;
			const box = drawingCanvas();
			// A pixel's width more on every side, so a pixel the edge crosses is whole.
			const pad = 1 / Math.max(Math.hypot(a, b), Math.hypot(c, d), 1e-9);
			ctx.setTransform(a, b, c, d, e, f);
			ctx.fillRect(box.x - pad, box.y - pad, box.width + 2 * pad, box.height + 2 * pad);
		}
		keepCovered(target, mask);
		releaseCanvas(mask);
	};

	/**
	 * What was written past the layer's own pixels read back: kept to the
	 * drawing's canvas unless it may be off it, and the pixels then held to
	 * their own and as far as any alpha was left past them, so a write that
	 * left none there grows nothing.
	 */
	const settle = (offCanvas: boolean): void => {
		const region =
			dirty.current === undefined ? undefined : intersect(dirty.current, extent.current);
		dirty.current = undefined;
		const ctx = ctxOf();
		if (sameBox(extent.current, kept.current) || ctx === null) return;
		if (!offCanvas) keepToCanvas(canvas.current);
		const ink = (region === undefined ? [] : outside(region, kept.current)).flatMap((band) => {
			const at = toCanvas(band);
			const found = inkExtent(ctx.getImageData(at.x, at.y, at.width, at.height).data, band);
			return found === undefined ? [] : [found];
		});
		const next = ink.reduce(joinBoxes, kept.current);
		kept.current = next;
		if (!sameBox(next, extent.current)) relayout(next);
	};

	/** Where a painter may write: the layer's own pixels, and the drawing's canvas unless it may be off it too. */
	const roomFor = (offCanvas: boolean): Room => {
		if (offCanvas || sameBox(kept.current, extent.current)) {
			return { holds: () => true, everywhere: true };
		}
		const own = toCanvas(kept.current);
		const matrix = multiply(translate(-extent.current.x, -extent.current.y), affineOf(toFrame));
		if (Math.abs(matrix[1]) < UPRIGHT && Math.abs(matrix[2]) < UPRIGHT) {
			const on = toCanvas(canvasFrame());
			return {
				holds: (x, y) => insideBox(own, x, y) || insideBox(on, x, y),
				everywhere: false,
			};
		}
		const [a, b, c, d, e, f] = invert(matrix);
		const box = drawingCanvas();
		const pad = Math.max(Math.hypot(a, b), Math.hypot(c, d));
		const near = {
			x: box.x - pad,
			y: box.y - pad,
			width: box.width + 2 * pad,
			height: box.height + 2 * pad,
		};
		return {
			holds: (x, y) => {
				if (insideBox(own, x, y)) return true;
				const [cx, cy] = [x + 0.5, y + 0.5];
				return insideBox(near, a * cx + c * cy + e, b * cx + d * cy + f);
			},
			everywhere: false,
		};
	};

	const ready =
		href === undefined || inert
			? Promise.resolve()
			: decodePicture(href)
					.then((img) => {
						const ctx = ctxOf();
						if (ctx === null) return;
						const natural = { width: img.naturalWidth, height: img.naturalHeight };
						const preserve = image?.getAttribute('preserveAspectRatio') ?? null;
						const at = placePicture(preserve, grid, natural);
						const [ox, oy] = origin();
						ctx.drawImage(img, ox + at.x, oy + at.y, at.width, at.height);
						// A picture from another origin draws but leaves the canvas
						// unreadable: better said before a stroke than after it.
						ctx.getImageData(0, 0, 1, 1);
					})
					.catch(() => {
						failure.current = new UnreadablePictureError(
							`the picture on ${layerId} could not be read`
						);
					})
					.then(() => {
						settled.current = true;
					});

	/**
	 * Encodings landed in turn: `land` is given their `href`s once every write
	 * this surface began before has landed, and what it gives back is the
	 * turn's. Each encoding starts when it is asked for, so what is written is
	 * what the canvas held then, whatever a later stroke does to it meanwhile.
	 */
	const inTurn = <T>(
		encodings: readonly Promise<string>[],
		land: (hrefs: readonly string[]) => T
	): Promise<T> => {
		const turn = queue.current.then(() => Promise.all(encodings)).then(land);
		queue.current = turn.then(
			() => undefined,
			() => undefined
		);
		return turn;
	};

	/** Whether the file's picture is still the one the pixels came from, or last went to. */
	const unmoved = (live: Element): boolean => hrefOf(imageOf(live)) === source.current;

	const boundsNow = (): Bounds => boundsAt(first, grid, extent.current);

	/**
	 * The pixels as they are now, encoded, and written in turn with the
	 * geometry they cover now; with `strict`, only where the file's picture did
	 * not move under them meanwhile. Whether they were written.
	 */
	const write = (label: string, strict = false): Promise<boolean> => {
		const bounds = boundsNow();
		return inTurn([encodePng(canvas.current)], ([encodedHref]) => {
			const live = editor.layer(layerId);
			// The layer went while its pixels were encoded: nothing to write into.
			if (encodedHref === undefined || live === undefined) return false;
			if (strict && !unmoved(live)) {
				throw new Error(`the picture on ${layerId} changed while it was encoded`);
			}
			// Before the command runs: a tool asking for the surface while it
			// runs must find the href it is about to see, not rebuild from the old one.
			source.current = encodedHref;
			sourceBounds.current = bounds;
			editor.execute(replaceRasterImage(layerId, label, { href: encodedHref, ...bounds }));
			return true;
		});
	};

	/**
	 * What the stroke composites onto kept to the area: a clip for a plain
	 * area, the stroke itself masked by the area's coverage for any other.
	 * Where the browser has no `Path2D`, neither, and the stroke is not kept.
	 */
	const keepToArea = (target: CanvasRenderingContext2D, area: Area): void => {
		if (isPlain(area)) {
			clipToArea(target, area, toPixel);
			return;
		}
		const mask = areaMask({ canvas: stroke.current, toPixel: toStroke }, area);
		if (mask === undefined) return;
		keepCovered(stroke.current, mask);
		releaseCanvas(mask);
	};

	/**
	 * Where on the stroke canvas, in the frame, a stroke painted that may land:
	 * on the pixels, and for paint on the canvas too; none where it lands
	 * nowhere. A pixel more each way than `written`, for a stamp's soft edge.
	 */
	const landing = (mode: CompositeMode, written: Box | undefined): Box | undefined => {
		const box = intersect(
			written === undefined
				? strokeExtent.current
				: padded(wholePixels(transformBox(affineOf(toFrame), written)), 1),
			strokeExtent.current
		);
		if (box === undefined) return undefined;
		const onPixels = intersect(box, extent.current);
		if (mode === 'destination-out') return onPixels;
		return onPixels === undefined && intersect(box, canvasFrame()) === undefined
			? undefined
			: box;
	};

	const commit = async (
		label: string,
		mode: CompositeMode,
		opacity: number,
		area?: Area,
		written?: Box
	): Promise<void> => {
		asked.current += 1;
		await ready;
		const lands = landing(mode, written);
		if (failure.current !== undefined || inert || lands === undefined) {
			clearCanvas(stroke.current);
			resetStroke();
			if (failure.current !== undefined) throw failure.current;
			return;
		}
		if (mode === 'source-over') {
			growTo(lands, false);
			markDirty(lands);
		}
		const ctx = ctxOf();
		if (ctx === null) return;
		ctx.save();
		if (area !== undefined) keepToArea(ctx, area);
		ctx.globalAlpha = opacity;
		ctx.globalCompositeOperation = mode;
		ctx.drawImage(
			stroke.current,
			strokeExtent.current.x - extent.current.x,
			strokeExtent.current.y - extent.current.y
		);
		ctx.restore();
		clearCanvas(stroke.current);
		settle(false);
		resetStroke();
		await write(label);
	};

	/**
	 * A painter run on the pixels, grown first where it may write past them,
	 * and what it wrote past them read back; whether it changed any.
	 */
	const run = (painter: Painter, grow: Grow | undefined): boolean => {
		const offCanvas = grow?.offCanvas === true;
		const reach = grow?.reach();
		if (reach !== undefined) growTo(toFrameBox(reach), offCanvas);
		const ctx = ctxOf();
		if (ctx === null) return false;
		const painted = painter(ctx, roomFor(offCanvas));
		if (painted !== false) markDirty(painted === true ? extent.current : toFrameBox(painted));
		settle(offCanvas);
		return painted !== false;
	};

	const paint: RasterSurface['paint'] = async (label, painter, grow) => {
		asked.current += 1;
		await ready;
		if (failure.current !== undefined) throw failure.current;
		if (inert || !run(painter, grow)) return;
		await write(label);
	};

	const rewrite: RasterSurface['rewrite'] = async (label, painter, grow) => {
		asked.current += 1;
		await ready;
		if (failure.current !== undefined) throw failure.current;
		if (inert || !run(painter, grow)) return false;
		return write(label, true);
	};

	const derive: RasterSurface['derive'] = async (painter) => {
		asked.current += 1;
		await ready;
		if (failure.current !== undefined) throw failure.current;
		const ctx = ctxOf();
		if (inert || ctx === null) return false;
		const made = painter(ctx);
		if (made === undefined) return false;
		const bounds = boundsNow();
		const own = made.changed ? [encodePng(canvas.current)] : [];
		return inTurn([encodePng(made.picture), ...own], ([picture, ownHref]) => {
			const live = editor.layer(layerId);
			if (picture === undefined || live === undefined) return false;
			if (!unmoved(live)) {
				throw new Error(`the picture on ${layerId} changed while it was encoded`);
			}
			if (ownHref !== undefined) {
				source.current = ownHref;
				sourceBounds.current = bounds;
			}
			editor.execute(made.command(picture, ownHref, bounds));
			return true;
		});
	};

	const extendStroke = (box: Box): void => {
		if (inert) return;
		const reach = intersect(wholePixels(transformBox(affineOf(toFrame), box)), canvasFrame());
		if (reach === undefined || holdsBox(strokeExtent.current, reach)) return;
		const room = heldTo(extent.current, canvasFrame(), limit, reach);
		relayStroke(joinBoxes(strokeExtent.current, room), true);
	};

	const extend = (box: Box): void => {
		if (inert || !settled.current) return;
		const reach = intersect(wholePixels(transformBox(affineOf(toFrame), box)), canvasFrame());
		if (reach === undefined || holdsBox(extent.current, reach)) return;
		const room = heldTo(extent.current, canvasFrame(), limit, reach);
		if (!keepsGrid(first, grid, room)) return;
		relayout(room);
		markDirty(room);
	};

	const surface: RasterSurface = {
		layerId,
		get bounds() {
			return boundsNow();
		},
		ppu: grid.ppu,
		get canvas() {
			return canvas.current;
		},
		get stroke() {
			return stroke.current;
		},
		ready,
		decoded: () => settled.current,
		readable: () => settled.current && failure.current === undefined && !inert,
		writes: () => asked.current,
		source: () => source.current,
		sourceBounds: () => sourceBounds.current,
		origin,
		toPixel,
		toStroke,
		room: (reach, offCanvas = false) => toCanvas(roomIn(toFrameBox(reach), offCanvas)),
		paintRoom: () => toCanvas(roomIn(canvasFrame(), false)),
		extendStroke,
		extend,
		commit,
		paint,
		rewrite,
		derive,
		discard: () => {
			const byLayer = surfaces.get(editor);
			if (byLayer?.get(layerId) === surface) byLayer.delete(layerId);
		},
	};
	return surface;
};

/**
 * The surface made for a layer already, while the file's `href` and geometry
 * are still the ones it was built from or last wrote; none otherwise, and
 * none is made: for a reader of any layer's pixels that has no business
 * decoding a picture onto a canvas of its own (`probe.ts`).
 */
export const cachedSurface = (
	editor: EditorDocument,
	layerId: string
): RasterSurface | undefined => {
	const element = editor.layer(layerId);
	const cached = surfaces.get(editor)?.get(layerId);
	if (element === undefined || cached === undefined) return undefined;
	const image = imageOf(element);
	return cached.source() === hrefOf(image) &&
		sameBounds(cached.sourceBounds(), boundsFor(editor, image))
		? cached
		: undefined;
};

/**
 * The surface of the active layer, where it is a raster layer: the cached one
 * while the file's `href` and geometry are still the ones it was built from
 * or last wrote, and a new one built from the file where either moved under
 * it (an undo, a redo, a crop of an empty layer's canvas).
 */
export const surfaceFor = (context: ToolContext): RasterSurface | undefined => {
	const { layer } = context;
	if (layer?.kind !== 'raster') return undefined;
	const element = context.document.layer(layer.id);
	if (element === undefined) return undefined;
	const cached = cachedSurface(context.document, layer.id);
	if (cached !== undefined) return cached;
	surfaces.get(context.document)?.get(layer.id)?.discard();
	const made = createSurface(context.document, layer.id, element);
	cacheFor(context.document).set(layer.id, made);
	return made;
};
