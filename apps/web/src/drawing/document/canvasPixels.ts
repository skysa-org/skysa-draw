import { canvasToPng, renderSvg } from '../export/render.js';
import { releaseCanvas } from '../tools/raster/area.js';
import { decodePicture, UnreadablePictureError } from '../tools/raster/surface.js';
import type { Box } from '../tools/vector/geometry.js';
import type { EditorDocument } from './model.js';

/**
 * What the Image operations ask of the browser (`canvasOps.ts`): a raster
 * picture made again at another size, for Image Size with resampling, and
 * the drawing rendered to pixels, for Trim by a corner's color. jsdom has
 * neither, so each is a seam the operations take, and the tests answer in
 * the browser's place.
 */

type PixelSize = Readonly<{ width: number; height: number }>;

/**
 * A picture decoded: its size in pixels, and itself drawn at another size
 * and encoded as a PNG `data:` URL, which rejects where the browser cannot.
 */
type Picture = PixelSize & Readonly<{ drawn: (size: PixelSize) => Promise<string> }>;

/** The picture at `href`, decoded; rejects where it will not decode. */
export type Resampler = (href: string) => Promise<Picture>;

/**
 * The drawing as it is, rendered over `box`, in its user units, onto
 * `width` × `height` pixels: their RGBA, rows `width` wide, as
 * `getImageData` gives them; none where the browser cannot render or read
 * them back.
 */
export type Composite = (
	document: EditorDocument,
	box: Box,
	width: number,
	height: number
) => Promise<Uint8ClampedArray | undefined>;

/** A canvas of `size`, and what `draw` makes of it, the canvas let go of after. */
const onCanvas = async <T>(
	size: PixelSize,
	draw: (canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => Promise<T>
): Promise<T> => {
	const canvas = window.document.createElement('canvas');
	canvas.width = size.width;
	canvas.height = size.height;
	try {
		const ctx = canvas.getContext('2d');
		if (ctx === null) throw new UnreadablePictureError('no 2D canvas to draw the picture on');
		return await draw(canvas, ctx);
	} finally {
		releaseCanvas(canvas);
	}
};

/**
 * The browser's: the picture decoded as a surface decodes it
 * (`decodePicture`), drawn at the new size with the canvas's smoothing at
 * its best, and encoded as a stroke's pixels are, as PNG.
 */
export const browserResampler: Resampler = async (href) => {
	const img = await decodePicture(href);
	return {
		width: img.naturalWidth,
		height: img.naturalHeight,
		drawn: (size) =>
			onCanvas(size, (canvas, ctx) => {
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = 'high';
				ctx.drawImage(img, 0, 0, size.width, size.height);
				return canvasToPng(canvas);
			}),
	};
};

/** The browser's: the drawing's text rendered as an export renders it, and read back. */
export const browserComposite: Composite = async (document, box, width, height) => {
	const canvas = await renderSvg(document.text(), box, width, height);
	if (canvas === undefined) return undefined;
	try {
		return canvas.getContext('2d')?.getImageData(0, 0, width, height).data;
	} catch {
		// A canvas something from another origin was drawn on cannot be read.
		return undefined;
	} finally {
		releaseCanvas(canvas);
	}
};

/**
 * The box, in pixels, around every pixel of `data` that is not exactly the
 * color, alpha included, of the one at `corner`; none where every one is.
 * Read as `inkExtent` reads ink (`tools/raster/grow.ts`): rows from either
 * end, then the columns of the rows between.
 */
export const unlikeCorner = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	corner: 'topLeft' | 'bottomRight'
): Box | undefined => {
	const pixels = new Uint32Array(data.buffer, data.byteOffset, width * height);
	const color = corner === 'topLeft' ? pixels[0] : pixels[width * height - 1];
	const unlike = (pixel: number): boolean => pixel !== color;
	const first = pixels.findIndex(unlike);
	if (first < 0) return undefined;
	const last = pixels.findLastIndex(unlike);
	const top = Math.floor(first / width);
	const bottom = Math.floor(last / width);
	const rows = Array.from({ length: bottom - top + 1 }, (_, index) =>
		pixels.subarray((top + index) * width, (top + index + 1) * width)
	);
	const left = rows.reduce((least, row) => {
		const at = row.findIndex(unlike);
		return at < 0 ? least : Math.min(least, at);
	}, width);
	const right = rows.reduce((most, row) => Math.max(most, row.findLastIndex(unlike)), -1);
	return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
};
