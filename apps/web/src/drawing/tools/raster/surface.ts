import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { replaceRasterImage } from '../../document/commands.js';
import type { EditorDocument } from '../../document/model.js';
import type { ToolContext } from '../types.js';
import { type Area, clipToArea } from './area.js';
import { type Bounds, type PixelGrid, pixelGrid, placePicture } from './pixels.js';
import { toLocal } from './space.js';

/**
 * The pixel surface of one raster layer while it is edited (docs/ARCHITECTURE.md
 * §3, "Layers"; §7, "The editor"). The layer's `<image>` is decoded onto a
 * canvas the size of the layer's pixel grid once; a stroke is painted on a
 * second canvas of the same size and composited onto the first when it ends,
 * and the first is then encoded as PNG and written into the `<image>` by a
 * command. The encoding is asynchronous on purpose: the stroke stays on
 * screen until the new `href` lands, and a save waits for it through
 * `EditorDocument.pending`.
 *
 * One surface per layer per document, cached, and rebuilt when the `href` or
 * the geometry under it is no longer the one it was built from: an undo or a
 * redo put other pixels in the file, and the file is the only source of truth.
 */

/** The layer's picture would not decode, so painting on it would replace it with nothing. */
export class UnreadablePictureError extends Error {
	override readonly name = 'UnreadablePictureError';
}

export type CompositeMode = 'source-over' | 'destination-out';

export interface RasterSurface {
	readonly layerId: string;
	/** The `<image>`'s geometry in the layer's user units, or the canvas's for a layer without one yet. */
	readonly bounds: Bounds;
	/** Pixels per user unit. */
	readonly ppu: number;
	/** The layer's pixels. */
	readonly canvas: HTMLCanvasElement;
	/** The stroke under way, the same size, composited onto `canvas` by `commit`. */
	readonly stroke: HTMLCanvasElement;
	/** The existing picture decoded onto `canvas`; at once for a layer without one. Never rejects. */
	readonly ready: Promise<void>;
	/** Whether `ready` has settled, for a tool that reads the pixels as it goes. */
	readonly decoded: () => boolean;
	/** The `href` the pixels came from, to tell when the file moved under the surface. */
	readonly source: () => string | undefined;
	/** The root's user units to `canvas`'s pixels, through the layer's own transform. Not rounded. */
	readonly toPixel: (x: number, y: number) => readonly [number, number];
	/**
	 * The stroke composited onto the pixels in `mode` at `opacity`, once, so
	 * overlapping stamps do not darken, and only inside `area` where one is
	 * selected; then encoded and written, after every write this surface began
	 * before it. Resolves after the command executed; rejects with
	 * `UnreadablePictureError` for a picture that would not decode or cannot be
	 * read, and nothing is written then.
	 */
	readonly commit: (
		label: string,
		mode: CompositeMode,
		opacity: number,
		area?: Area
	) => Promise<void>;
	/**
	 * A change made straight to the layer's pixels once they are decoded, for
	 * a fill: `painter` says whether it changed any, and only then are they
	 * encoded and written, so a picture placed from a file keeps its bytes
	 * until a pixel of it changes. Rejects as `commit` does.
	 */
	readonly paint: (
		label: string,
		painter: (ctx: CanvasRenderingContext2D) => boolean
	) => Promise<void>;
	/** Forget the surface: the next tool to ask gets one built from the file again. */
	readonly discard: () => void;
}

const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

/**
 * The one `<image>` a raster layer holds, where it holds one yet: SVG's own,
 * the one `replaceRasterImage` writes, and not an element of that name in
 * another namespace.
 */
const imageOf = (layer: Element): Element | undefined =>
	Array.from(layer.children).find(
		(child) => child.namespaceURI === SVG_NAMESPACE && child.localName === 'image'
	);

/** `href`, or the `xlink:href` an older file writes. */
const hrefOf = (image: Element | undefined): string | undefined =>
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
const boundsFor = (editor: EditorDocument, image: Element | undefined): Bounds =>
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

/**
 * The existing picture drawn onto the pixel grid where the browser shows it,
 * by the `<image>`'s `preserveAspectRatio`. `src` is set as an attribute, and
 * the element never enters the page: it is decoded, drawn and dropped. A
 * picture the browser cannot decode rejects, and so does one from another
 * origin, which draws but leaves the canvas unreadable: better said before a
 * stroke than after it.
 */
const decodeInto = async (
	ctx: CanvasRenderingContext2D,
	href: string,
	preserveAspectRatio: string | null,
	grid: PixelGrid
): Promise<void> => {
	const img = document.createElement('img');
	img.setAttribute('src', href);
	await img.decode();
	const natural = { width: img.naturalWidth, height: img.naturalHeight };
	const at = placePicture(preserveAspectRatio, grid, natural);
	ctx.drawImage(img, at.x, at.y, at.width, at.height);
	ctx.getImageData(0, 0, 1, 1);
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
 * The canvas as a `data:` URL of a PNG: through `toBlob` and a `FileReader`,
 * which do not hold the main thread for the encoding, and through
 * `toDataURL`, which does, where `toBlob` is not there or gave nothing.
 */
const encodePng = async (canvas: HTMLCanvasElement): Promise<string> => {
	const blob = await blobOf(canvas);
	return blob === null ? canvas.toDataURL('image/png') : dataUrlOf(blob);
};

const surfaces = new WeakMap<EditorDocument, Map<string, RasterSurface>>();

const cacheFor = (editor: EditorDocument): Map<string, RasterSurface> => {
	const found = surfaces.get(editor);
	if (found !== undefined) return found;
	const made = new Map<string, RasterSurface>();
	surfaces.set(editor, made);
	return made;
};

const createSurface = (
	editor: EditorDocument,
	layerId: string,
	layer: SVGGraphicsElement
): RasterSurface => {
	const image = imageOf(layer);
	const href = hrefOf(image);
	const bounds = boundsFor(editor, image);
	const grid = pixelGrid(bounds);
	const canvas = blankCanvas(grid.width, grid.height);
	const stroke = blankCanvas(grid.width, grid.height);
	// Without a 2D context (jsdom, or a browser with canvas turned off) the
	// surface is inert: strokes paint nothing and commit nothing.
	const ctx = canvas.getContext('2d');
	const source = cell(href);
	const failure = cell<UnreadablePictureError | undefined>(undefined);
	// The last write begun, so the next lands after it: two encodings under
	// way at once may finish in either order, and the later stroke's pixels
	// hold the earlier's, so the later must be the one the file keeps.
	const queue = cell<Promise<void>>(Promise.resolve());
	const settled = cell(href === undefined || ctx === null);
	const ready =
		href === undefined || ctx === null
			? Promise.resolve()
			: decodeInto(ctx, href, image?.getAttribute('preserveAspectRatio') ?? null, grid)
					.catch(() => {
						failure.current = new UnreadablePictureError(
							`the picture on ${layerId} could not be read`
						);
					})
					.then(() => {
						settled.current = true;
					});

	/**
	 * The pixels as they are now, encoded, and written in turn. The encoding
	 * starts here, so what is written is what the canvas held when it was asked
	 * for, whatever a later stroke does to it meanwhile.
	 */
	const write = (label: string): Promise<void> => {
		const encoded = encodePng(canvas);
		const turn = queue.current
			.then(() => encoded)
			.then((encodedHref) => {
				// The layer went while its pixels were encoded: nothing to write into.
				if (editor.layer(layerId) === undefined) return;
				// Before the command runs: a tool asking for the surface while it
				// runs must find the href it is about to see, not rebuild from the old one.
				source.current = encodedHref;
				editor.execute(
					replaceRasterImage(layerId, label, { href: encodedHref, ...bounds })
				);
			});
		queue.current = turn.catch(() => undefined);
		return turn;
	};

	const toPixel = (x: number, y: number): readonly [number, number] => {
		const live = editor.layer(layerId) ?? layer;
		const [lx, ly] = toLocal(live, editor.root, x, y);
		return [(lx - bounds.x) * grid.ppu, (ly - bounds.y) * grid.ppu];
	};

	const commit = async (
		label: string,
		mode: CompositeMode,
		opacity: number,
		area?: Area
	): Promise<void> => {
		await ready;
		if (failure.current !== undefined || ctx === null) {
			clearCanvas(stroke);
			if (failure.current !== undefined) throw failure.current;
			return;
		}
		ctx.save();
		if (area !== undefined) clipToArea(ctx, area, toPixel);
		ctx.globalAlpha = opacity;
		ctx.globalCompositeOperation = mode;
		ctx.drawImage(stroke, 0, 0);
		ctx.restore();
		clearCanvas(stroke);
		await write(label);
	};

	const paint = async (
		label: string,
		painter: (ctx: CanvasRenderingContext2D) => boolean
	): Promise<void> => {
		await ready;
		if (failure.current !== undefined) throw failure.current;
		if (ctx === null || !painter(ctx)) return;
		await write(label);
	};

	const surface: RasterSurface = {
		layerId,
		bounds,
		ppu: grid.ppu,
		canvas,
		stroke,
		ready,
		decoded: () => settled.current,
		source: () => source.current,
		toPixel,
		commit,
		paint,
		discard: () => {
			const byLayer = surfaces.get(editor);
			if (byLayer?.get(layerId) === surface) byLayer.delete(layerId);
		},
	};
	return surface;
};

/**
 * The surface of the active layer, where it is a raster layer: the cached one
 * while the file's `href` and geometry are still the ones it was built from,
 * and a new one built from the file where either moved under it (an undo, a
 * redo, a crop of an empty layer's canvas).
 */
export const surfaceFor = (context: ToolContext): RasterSurface | undefined => {
	const { layer } = context;
	if (layer?.kind !== 'raster') return undefined;
	const element = context.document.layer(layer.id);
	if (element === undefined) return undefined;
	const image = imageOf(element);
	const byLayer = cacheFor(context.document);
	const cached = byLayer.get(layer.id);
	if (
		cached !== undefined &&
		cached.source() === hrefOf(image) &&
		sameBounds(cached.bounds, boundsFor(context.document, image))
	) {
		return cached;
	}
	cached?.discard();
	const made = createSurface(context.document, layer.id, element);
	byLayer.set(layer.id, made);
	return made;
};
