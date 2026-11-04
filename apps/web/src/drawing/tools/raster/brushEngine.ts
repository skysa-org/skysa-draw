import type { ScreenCanvas, ToolContext } from '../types.js';
import { type Area, clipToArea, clipToInverse, takeOutline } from './area.js';
import { parseColor, type Point, stampsAlong, stampSpacing } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * How a raster brush makes its mark (docs/ARCHITECTURE.md §7, "The editor"):
 * a stroke is a row of stamps, each a disk with an edge as soft as the
 * hardness says, spaced a fraction of the radius apart along the pointer's
 * path. Every stamp goes to two places at once: the layer's stroke canvas in
 * pixels, which is what will be written, and the screen canvas over the
 * viewport in device pixels, which is what the user sees until the encoding
 * lands. Where an area is selected the screen shows the stamps kept to it,
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

/** Below this a stamp would vanish between pixels; a hairline is still a line. */
const MIN_RADIUS = 0.5;

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

/** One stamp of the brush: a disk of `radius` at `(x, y)`, in the context's own pixels. */
const stamp = (
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	radius: number,
	hardness: number,
	color: string,
	alpha: number
): void => {
	const r = Math.max(MIN_RADIUS, radius);
	ctx.globalAlpha = alpha;
	ctx.fillStyle = fillFor(ctx, x, y, r, hardness, color);
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
	ctx.fill();
};

/** Where a stroke's stamps go. */
export interface StrokeTargets {
	readonly surface: RasterSurface;
	readonly screen: ScreenCanvas;
	/** Screen-canvas pixels per user unit: the viewport's scale times its pixel ratio. */
	readonly screenScale: number;
	/** The area the stroke paints inside, as it was when the stroke began; none for anywhere. */
	readonly area: Area | undefined;
}

export const targetsOf = (
	context: ToolContext,
	surface: RasterSurface,
	area: Area | undefined
): StrokeTargets => ({
	surface,
	screen: context.screen,
	screenScale: context.viewport.scale * context.screen.pixelRatio,
	area,
});

/**
 * One stamp at a point in user units, on the stroke canvas and on the screen.
 * Alpha 1 on both: the stroke's opacity is applied once when it is committed,
 * so stamps that overlap do not darken, and the screen canvas carries the
 * same opacity as a style while the stroke is live.
 */
export const paintStamp = (targets: StrokeTargets, x: number, y: number, brush: Brush): void => {
	const { surface, screen, screenScale, area } = targets;
	const pixelCtx = surface.stroke.getContext('2d');
	if (pixelCtx !== null) {
		const [px, py] = surface.toPixel(x, y);
		stamp(pixelCtx, px, py, brush.radius * surface.ppu, brush.hardness, brush.color, 1);
	}
	const screenCtx = screen.canvas.getContext('2d');
	if (screenCtx === null) return;
	const [sx, sy] = screen.toScreen(x, y);
	const radius = brush.radius * screenScale;
	// A pixel more than the disk on every side, for its anti-aliased edge.
	const reach = Math.max(MIN_RADIUS, radius) + 1;
	const inverse = area?.inverted === true && area.shape !== undefined;
	screenCtx.save();
	if (area !== undefined && !area.inverted) clipToArea(screenCtx, area, screen.toScreen);
	if (inverse) {
		const near = { x: sx - reach, y: sy - reach, width: 2 * reach, height: 2 * reach };
		clipToInverse(screenCtx, area, screen.toScreen, near);
	}
	stamp(screenCtx, sx, sy, radius, brush.hardness, brush.mirror, 1);
	if (inverse) takeOutline(screenCtx, area, screen.toScreen);
	screenCtx.restore();
};

/**
 * The stamps from the last sample to this one, spaced by the brush's radius
 * in pixels; `carry` is what `stampsAlong` carries between segments, so the
 * spacing stays even across every sample.
 */
export const paintSegment = (
	targets: StrokeTargets,
	from: Point,
	to: Point,
	brush: Brush,
	carry: number
): number => {
	const { ppu } = targets.surface;
	const spacing = stampSpacing(brush.radius * ppu) / ppu;
	const along = stampsAlong(from, to, spacing, carry);
	along.stamps.forEach((point) => paintStamp(targets, point.x, point.y, brush));
	return along.carry;
};
