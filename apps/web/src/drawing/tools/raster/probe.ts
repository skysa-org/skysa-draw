import { SVG_NAMESPACE } from '@skysa/draw-core';

import type { EditorDocument } from '../../document/model.js';
import { type PixelGrid, pixelGrid } from './pixels.js';
import { toLocal } from './space.js';
import { boundsFor, cachedSurface, imageOf, type RasterSurface } from './surface.js';

/**
 * How much of a raster layer's own paint is under a point, for the move
 * tool's Auto-Select (`tools/common/autoSelect.ts`): the alpha of the one
 * pixel of the layer's grid there, the pixel a tool would paint, through the
 * layer's place in the drawing, its `transform` and its groups' included
 * (`RasterSurface.toPixel`).
 *
 * One pixel is read, never the picture. Where the layer has a surface
 * decoded already (`cachedSurface`), from its canvas, which holds a stroke
 * still being encoded. Otherwise from the `<image>` in the page, drawn onto
 * a canvas of one pixel at the offset that puts that pixel there: the
 * browser decodes the picture the first time it is drawn so, and keeps it.
 * Measured in headless Chromium, Firefox and WebKit on an Apple M-series
 * machine, for a 4096 × 3072 PNG of noise (14 MB as a `data:` URL): the first
 * read took 66, 76 and 120 ms, and every read after it 0.01 to 0.05 ms. A
 * surface would have decoded the same picture onto a canvas of the layer's
 * size, 89, 128 and 183 ms and 48 MB, for every layer the walk passed.
 *
 * The picture is read stretched to its box, as the app writes every raster
 * picture (`preserveAspectRatio="none"`) and places every file (fitted to its
 * own shape). A picture still loading has drawn nothing, on screen as here.
 */

/** A raster layer's `<image>`, which a canvas draws: SVG's own, as `imageOf` finds it. */
const isPicture = (element: Element): element is SVGImageElement =>
	element.namespaceURI === SVG_NAMESPACE && element.localName === 'image';

/** Alpha, 0 to 1, from the RGBA of one pixel. */
const alphaOf = (data: Uint8ClampedArray): number => (data[3] ?? 0) / 255;

/** The pixel of a surface's canvas under a point in the root's units: 0 outside it; none where it cannot be read. */
const alphaOnSurface = (surface: RasterSurface, x: number, y: number): number | undefined => {
	const [px, py] = surface.toPixel(x, y).map(Math.floor);
	const { canvas } = surface;
	if (px === undefined || py === undefined) return undefined;
	if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return 0;
	try {
		return alphaOf(
			canvas.getContext('2d')?.getImageData(px, py, 1, 1).data ?? new Uint8ClampedArray()
		);
	} catch {
		return undefined;
	}
};

/**
 * Pixel `px`, `py` of the grid the picture fills, drawn onto a canvas of one
 * pixel; none where the browser has no 2D canvas, will not draw the
 * element, or will not let what it drew be read.
 */
const alphaOfPicture = (
	image: SVGImageElement,
	grid: PixelGrid,
	px: number,
	py: number
): number | undefined => {
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const ctx = canvas.getContext('2d', { willReadFrequently: true });
	if (ctx === null) return undefined;
	try {
		ctx.drawImage(image, -px, -py, grid.width, grid.height);
		return alphaOf(ctx.getImageData(0, 0, 1, 1).data);
	} catch {
		return undefined;
	}
};

/**
 * How opaque the raster layer `layerId` is at `x`, `y` in the root's user
 * units, 0 to 1, by its own pixels, before its opacity: 0 outside its
 * picture, and on a layer with none yet; 1 inside the picture where its
 * pixels cannot be read, so a layer is found by its box rather than not at
 * all.
 */
export const coverageAt = (
	editor: EditorDocument,
	layerId: string,
	x: number,
	y: number
): number => {
	const surface = cachedSurface(editor, layerId);
	if (surface?.readable() === true) return alphaOnSurface(surface, x, y) ?? 1;
	const layer = editor.layer(layerId);
	const image = layer === undefined ? undefined : imageOf(layer);
	if (layer === undefined || image === undefined || !isPicture(image)) return 0;
	const bounds = boundsFor(editor, image);
	const grid = pixelGrid(bounds);
	const [lx, ly] = toLocal(layer, editor.root, x, y);
	const px = Math.floor((lx - bounds.x) * grid.ppu);
	const py = Math.floor((ly - bounds.y) * grid.ppu);
	if (px < 0 || py < 0 || px >= grid.width || py >= grid.height) return 0;
	return alphaOfPicture(image, grid, px, py) ?? 1;
};
