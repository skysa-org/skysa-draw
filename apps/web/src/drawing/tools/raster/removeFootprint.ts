import type { ScreenCanvas } from '../types.js';
import { type Box, distance, type Mat, multiply, transformBox } from '../vector/geometry.js';
import {
	affineOf,
	type Area,
	areaMask,
	clipToArea,
	clipToInverse,
	keepCovered,
	releaseCanvas,
	takeOutline,
} from './area.js';
import type { Point } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * What a stroke of the Remove tool covers (docs/decisions/0004-the-interface.md;
 * `remove.ts`): a round, hard brush swept along the pointer's samples. It is
 * drawn twice from the same geometry, into a canvas the size of the layer's
 * pixels, whose alpha is the coverage the engine makes again, and onto the
 * screen canvas, where the user sees it while the stroke lasts. Each sample
 * adds the disk where it is and the band from the sample before, as wide as
 * the disk, so the stroke is the disk dragged along the path, joined however
 * far apart the samples are, with no row of stamps to space. Both are drawn
 * through an affine map from user units, so a layer scaled, turned or skewed
 * by its `transform` gets the ellipse the disk makes on its pixels.
 */

/** What a segment's sweep covers, in user units: the box around its two ends, grown by the radius. */
export const sweepBox = (from: Point, to: Point, radius: number): Box => ({
	x: Math.min(from.x, to.x) - radius,
	y: Math.min(from.y, to.y) - radius,
	width: Math.abs(to.x - from.x) + 2 * radius,
	height: Math.abs(to.y - from.y) + 2 * radius,
});

/**
 * The frame whose x axis runs from `from` toward `to`, a unit of it a user
 * unit, in user units: where the band between them is a rectangle.
 */
const alongSegment = (from: Point, to: Point, length: number): Mat => {
	const cos = (to.x - from.x) / length;
	const sin = (to.y - from.y) / length;
	return [cos, sin, -sin, cos, from.x, from.y];
};

/**
 * The brush swept from `from` to `to`, filled on `ctx` in `color` through
 * `matrix`, which takes user units to the context's pixels: the disk at `to`
 * and the band between the two ends as wide as it, both wound the same way,
 * so under `nonzero` they are one shape. For a dab, `from` is `to`, and it is
 * the disk alone. The path is put in the context's pixels as it is built, so
 * the transform it is filled under is the identity, which it is after.
 */
export const sweep = (
	ctx: CanvasRenderingContext2D,
	matrix: Mat,
	from: Point,
	to: Point,
	radius: number,
	color: string
): void => {
	const [a, b, c, d, e, f] = matrix;
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
	ctx.fillStyle = color;
	ctx.beginPath();
	ctx.setTransform(a, b, c, d, e, f);
	ctx.arc(to.x, to.y, radius, 0, Math.PI * 2);
	const length = distance(from, to);
	if (length > 0) {
		const [ra, rb, rc, rd, re, rf] = multiply(matrix, alongSegment(from, to, length));
		ctx.setTransform(ra, rb, rc, rd, re, rf);
		ctx.rect(0, -radius, length, 2 * radius);
	}
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.fill();
};

/** A box made larger by `by` on every side. */
const grown = (box: Box, by: number): Box => ({
	x: box.x - by,
	y: box.y - by,
	width: box.width + 2 * by,
	height: box.height + 2 * by,
});

/**
 * One segment of the stroke shown on the screen canvas, kept to the area as
 * the coverage will be, as the brush's live stroke is (`brushEngine.ts`):
 * clipped to the outline of an area that is not inverted; for an inverse,
 * clipped to the canvas and to the segment's own box, and the outline's
 * inside taken out after, which is exact. A feather's edge shows hard, on the
 * outline, where the coverage is half.
 */
export const showSweep = (
	screen: ScreenCanvas,
	area: Area | undefined,
	from: Point,
	to: Point,
	radius: number,
	color: string
): void => {
	const ctx = screen.canvas.getContext('2d');
	if (ctx === null) return;
	const matrix = affineOf(screen.toScreen);
	const inverse = area?.inverted === true && area.shape !== undefined;
	ctx.save();
	if (area !== undefined && !area.inverted) clipToArea(ctx, area, screen.toScreen);
	if (inverse) {
		// A pixel more than the sweep on every side, for its anti-aliased edge.
		const near = grown(transformBox(matrix, sweepBox(from, to, radius)), 1);
		clipToInverse(ctx, area, screen.toScreen, near);
	}
	sweep(ctx, matrix, from, to, radius, color);
	if (inverse) takeOutline(ctx, area, screen.toScreen);
	ctx.restore();
};

/** A clear canvas the size of `like`, for a stroke's footprint on a layer's pixels. */
export const footprintCanvas = (like: HTMLCanvasElement): HTMLCanvasElement => {
	const canvas = document.createElement('canvas');
	canvas.width = like.width;
	canvas.height = like.height;
	return canvas;
};

/**
 * A box in user units in a canvas's pixels, through `matrix`: whole pixels,
 * inside the canvas; none where it misses every pixel.
 */
export const pixelBoxOf = (canvas: HTMLCanvasElement, matrix: Mat, box: Box): Box | undefined => {
	const mapped = transformBox(matrix, box);
	const left = Math.max(0, Math.floor(mapped.x));
	const top = Math.max(0, Math.floor(mapped.y));
	const right = Math.min(canvas.width, Math.ceil(mapped.x + mapped.width));
	const bottom = Math.min(canvas.height, Math.ceil(mapped.y + mapped.height));
	if (!(right > left) || !(bottom > top)) return undefined;
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * The footprint kept to the area's coverage, in place, as every raster tool
 * paints inside the area: nothing outside it, less over a feathered edge,
 * and for an inverse only outside the outline (`areaMask`). With no area,
 * or where the browser has no `Path2D`, it is left whole, as a brush stroke
 * is.
 */
export const keepToArea = (
	surface: Pick<RasterSurface, 'canvas' | 'toPixel'>,
	footprint: HTMLCanvasElement,
	area: Area | undefined
): void => {
	const mask = area === undefined ? undefined : areaMask(surface, area);
	if (mask === undefined) return;
	keepCovered(footprint, mask);
	releaseCanvas(mask);
};
