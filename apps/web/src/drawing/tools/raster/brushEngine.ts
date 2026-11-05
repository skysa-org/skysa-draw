import type { ScreenCanvas, ToolContext } from '../types.js';
import { type Box, lengthScale, type Mat, transformBox } from '../vector/geometry.js';
import { affineOf, type Area, clipToArea, clipToInverse, takeOutline } from './area.js';
import { parseColor, type Point, stampsAlong, stampSpacing } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * How a raster brush makes its mark (docs/ARCHITECTURE.md §7, "The editor"):
 * a stroke is a row of stamps, each a disk with an edge as soft as the
 * hardness says, spaced a fraction of the radius apart along the pointer's
 * path. Every stamp goes to two places at once: the layer's stroke canvas in
 * pixels, which is what will be written, and the screen canvas over the
 * viewport in device pixels, which is what the user sees until the encoding
 * lands. A stroke that paints past the layer's pixels has its stroke canvas
 * made larger first, as far as the drawing's canvas
 * (`RasterSurface.extendStroke`), so what the screen shows past them lands
 * too, and grows them; an eraser's does not, since there is nothing past them
 * to take away. Both are drawn from one disk in the drawing's user units, through
 * the map from those units to the canvas's pixels, as the Remove tool's
 * footprint is (`removeFootprint.ts`): so the brush is its size in the
 * drawing's units on any layer, the size its outline shows
 * (`tools/common/brushOutline.ts`), and a layer scaled, turned or skewed by
 * its `transform` gets the ellipse the disk makes on its pixels, the same on
 * the screen while the stroke lasts as in the file once it lands. Where an
 * area is selected the screen shows the stamps kept to it,
 * as the commit will keep the stroke (`RasterSurface.commit`): clipped to the
 * outline for a plain area; for an inverted one, clipped to the canvas and
 * the outline's inside taken out of each stamp's square after it, which is
 * exact too. A feather is not previewed: the screen's edge is hard, on the
 * outline itself, where the committed stroke is at half its strength, fading
 * in over the feather inside and out over it outside once the stroke lands.
 */

/** A brush as a stroke holds it: the radius in user units, and the rest as the options say. */
export interface Brush {
	readonly radius: number;
	/** 0 soft to 1 hard. */
	readonly hardness: number;
	/** A CSS color. */
	readonly color: string;
	/** What the live mirror draws in: the color itself, or a neutral for an eraser. */
	readonly mirror: string;
}

/** Below this, in a canvas's own pixels, a stamp would vanish between them; a hairline is still a line. */
const MIN_RADIUS = 0.5;

/**
 * How many of a surface's pixels one of the drawing's user units is across,
 * through the layer's `transform`, as one factor (`lengthScale`).
 */
export const pixelsPerUnit = (surface: Pick<RasterSurface, 'toPixel'>): number =>
	lengthScale(affineOf(surface.toPixel));

/** The same color with no alpha, for the outer stop of a soft edge. */
const transparentOf = (color: string): string => {
	const rgba = parseColor(color);
	return rgba === undefined ? 'rgba(0, 0, 0, 0)' : `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, 0)`;
};

/** A flat disk at hardness 1; otherwise solid to `hardness` of the radius and fading to the edge. */
const fillFor = (
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	hardness: number,
	color: string
): string | CanvasGradient => {
	if (hardness >= 1) return color;
	const gradient = ctx.createRadialGradient(x, y, 0, x, y, radius);
	gradient.addColorStop(0, color);
	gradient.addColorStop(Math.max(0, hardness), color);
	gradient.addColorStop(1, transparentOf(color));
	return gradient;
};

/** A radius in user units, never under half of one of the pixels `matrix` takes them to. */
const shownRadius = (matrix: Mat, radius: number): number => {
	const scale = lengthScale(matrix);
	return scale > 0 ? Math.max(MIN_RADIUS / scale, radius) : radius;
};

/**
 * One stamp of the brush: a disk of `radius` about `at`, in user units, drawn
 * on `ctx` through `matrix`, which takes user units to its pixels, so a soft
 * edge's gradient goes through it too. The transform is the identity after.
 */
const stamp = (
	ctx: CanvasRenderingContext2D,
	matrix: Mat,
	at: Point,
	radius: number,
	hardness: number,
	color: string
): void => {
	const r = shownRadius(matrix, radius);
	const [a, b, c, d, e, f] = matrix;
	ctx.globalAlpha = 1;
	ctx.setTransform(a, b, c, d, e, f);
	ctx.fillStyle = fillFor(ctx, at.x, at.y, r, hardness, color);
	ctx.beginPath();
	ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
	ctx.fill();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
};

/** Where a stroke's stamps go, and the map to the screen from the drawing's user units. */
export interface StrokeTargets {
	readonly surface: RasterSurface;
	readonly screen: ScreenCanvas;
	/** User units to the screen canvas's pixels, through the view. */
	readonly toScreen: Mat;
	/** The area the stroke paints inside, as it was when the stroke began; none for anywhere. */
	readonly area: Area | undefined;
	/** Whether what the stroke paints may land past the layer's pixels and grow them: not an eraser's. */
	readonly grows: boolean;
}

export const targetsOf = (
	context: ToolContext,
	surface: RasterSurface,
	area: Area | undefined,
	grows: boolean
): StrokeTargets => ({
	surface,
	screen: context.screen,
	toScreen: affineOf(context.screen.toScreen),
	area,
	grows,
});

/** The box around disks of `radius` about each point, in user units. */
const disksBox = (points: readonly Point[], radius: number): Box => {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs) - radius;
	const y = Math.min(...ys) - radius;
	return {
		x,
		y,
		width: Math.max(...xs) + radius - x,
		height: Math.max(...ys) + radius - y,
	};
};

/**
 * The map from user units to the stroke canvas's pixels for stamps of
 * `radius` about `points`, the canvas made to reach them first where the
 * stroke may grow the layer's pixels.
 */
const strokeMatrix = (
	targets: StrokeTargets,
	points: readonly Point[],
	radius: number,
	before: Mat = affineOf(targets.surface.toStroke)
): Mat => {
	const { surface } = targets;
	if (!targets.grows || points.length === 0) return before;
	const canvas = surface.stroke;
	surface.extendStroke(disksBox(points, shownRadius(before, radius)));
	return surface.stroke === canvas ? before : affineOf(surface.toStroke);
};

/** One stamp at a point in user units, on the stroke canvas through `toPixels` and on the screen. */
const stampOn = (
	targets: StrokeTargets,
	toPixels: Mat,
	x: number,
	y: number,
	brush: Brush
): void => {
	const { surface, screen, toScreen, area } = targets;
	const at = { x, y };
	const pixelCtx = surface.stroke.getContext('2d');
	if (pixelCtx !== null) stamp(pixelCtx, toPixels, at, brush.radius, brush.hardness, brush.color);
	const screenCtx = screen.canvas.getContext('2d');
	if (screenCtx === null) return;
	const inverse = area?.inverted === true && area.shape !== undefined;
	screenCtx.save();
	if (area !== undefined && !area.inverted) clipToArea(screenCtx, area, screen.toScreen);
	if (inverse) {
		// A pixel more than the disk on every side, for its anti-aliased edge.
		const r = shownRadius(toScreen, brush.radius);
		const disk = transformBox(toScreen, { x: x - r, y: y - r, width: 2 * r, height: 2 * r });
		const near = {
			x: disk.x - 1,
			y: disk.y - 1,
			width: disk.width + 2,
			height: disk.height + 2,
		};
		clipToInverse(screenCtx, area, screen.toScreen, near);
	}
	stamp(screenCtx, toScreen, at, brush.radius, brush.hardness, brush.mirror);
	if (inverse) takeOutline(screenCtx, area, screen.toScreen);
	screenCtx.restore();
};

/**
 * One stamp at a point in user units, on the stroke canvas and on the screen.
 * Alpha 1 on both: the stroke's opacity is applied once when it is committed,
 * so stamps that overlap do not darken, and the screen canvas carries the
 * same opacity as a style while the stroke is live.
 */
export const paintStamp = (targets: StrokeTargets, x: number, y: number, brush: Brush): void => {
	stampOn(targets, strokeMatrix(targets, [{ x, y }], brush.radius), x, y, brush);
};

/**
 * The stamps from the last sample to this one, spaced by the brush's radius
 * in the layer's pixels; `carry` is what `stampsAlong` carries between
 * segments, so the spacing stays even across every sample.
 */
export const paintSegment = (
	targets: StrokeTargets,
	from: Point,
	to: Point,
	brush: Brush,
	carry: number
): number => {
	const before = affineOf(targets.surface.toStroke);
	const unit = lengthScale(before);
	const spacing = unit > 0 ? stampSpacing(brush.radius * unit) / unit : 0;
	const along = stampsAlong(from, to, spacing, carry);
	const toPixels = strokeMatrix(targets, along.stamps, brush.radius, before);
	along.stamps.forEach((point) => stampOn(targets, toPixels, point.x, point.y, brush));
	return along.carry;
};
