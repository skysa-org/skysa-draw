import { cell } from '@skysa/draw-core';

import type { PointerSample, ToolBehaviour, ToolContext, ToolOptions } from '../types.js';
import { type Box, unionBox } from '../vector/geometry.js';
import { type Area, areaMask, areaOf, pixelsToScreen, reachesArea } from './area.js';
import { claimScreen, clearScreen, guardedSurface, releaseScreen, reportFailure } from './guard.js';
import { dabStrength, type Point, smudgeDab, stampsAlong, stampSpacing } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * The smudge on a raster layer (docs/decisions/0004-the-interface.md: "Push
 * pixels"): the classic one. Along the stroke, dabs a `size` across are
 * spaced as the brush's stamps are; each picks up the pixels under the dab
 * before it and lays them over the pixels under itself, by `strength` and
 * with an edge as soft as `hardness` says (`smudgeDab`), so colour is dragged
 * the way the pointer goes and thins as it goes. Pressure is not read.
 *
 * It reads the pixels it writes, so it paints on the layer's own pixels and
 * not on the stroke canvas the brush composites from: a dab must find what
 * the dab before it left. The screen shows each dab's pixels as they change,
 * and the stroke is written into the `<image>` as one command when it ends,
 * as a brush stroke is, and a save waits for it; a stroke that changed no
 * pixel writes nothing. A stroke abandoned leaves pixels that are not the
 * file's, so the surface is forgotten and read from the file again. Where an
 * area is selected the dabs change only what is inside it.
 */

interface Stroke {
	readonly surface: RasterSurface;
	/** The area selected when the stroke began; none for anywhere. */
	readonly area: Area | undefined;
	/** The area's coverage of the layer's pixels, once they can be read; none for no area. */
	readonly mask: CanvasRenderingContext2D | undefined;
	/** Where the next dab picks up from, in user units: the last dab, or where the stroke began. */
	readonly from: Point;
	/** Where the pointer last was, and what `stampsAlong` carries from there. */
	readonly last: Point;
	readonly carry: number;
	/** Dabs not painted yet: the layer's picture was still being decoded. */
	readonly queued: readonly Point[];
	/** Whether the picture is decoded, so a dab may read it. */
	readonly ready: boolean;
	/** Whether any dab changed a pixel. */
	readonly changed: boolean;
	/** Which stroke this is on the screen canvas. */
	readonly serial: number;
}

/** Below this, in pixels, a dab would hold nothing. */
const MIN_RADIUS = 0.5;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The dab's radius in the layer's pixels. */
const radiusOf = (surface: RasterSurface, options: ToolOptions): number =>
	Math.max(MIN_RADIUS, (options.size / 2) * surface.ppu);

/** How far apart the dabs are, in user units: the brush's spacing for the same radius. */
const spacingOf = (surface: RasterSurface, options: ToolOptions): number =>
	stampSpacing(radiusOf(surface, options)) / surface.ppu;

/** The mask's context, where an area is selected and the browser can draw it. */
const maskFor = (
	surface: RasterSurface,
	area: Area | undefined
): CanvasRenderingContext2D | undefined =>
	area === undefined ? undefined : (areaMask(surface, area)?.getContext('2d') ?? undefined);

type DabSettings = Readonly<{
	radius: number;
	hardness: number;
	strength: number;
	mask: CanvasRenderingContext2D | undefined;
}>;

/**
 * One dab from `from` to `to`, in user units, on the layer's pixels: the
 * pixels where it lands, and the ones as far behind it as it moved, read
 * over the part of the dab where both are on the canvas; mixed; and written
 * back where any changed. The box it wrote, in pixels, comes back.
 */
const dabAt = (
	ctx: CanvasRenderingContext2D,
	surface: RasterSurface,
	from: Point,
	to: Point,
	settings: DabSettings
): Box | undefined => {
	const [fx, fy] = surface.toPixel(from.x, from.y);
	const [tx, ty] = surface.toPixel(to.x, to.y);
	const ox = Math.round(tx - fx);
	const oy = Math.round(ty - fy);
	// A dab that moved less than a pixel carries nothing anywhere.
	if (ox === 0 && oy === 0) return undefined;
	const { width, height } = surface.canvas;
	const { radius } = settings;
	const left = Math.max(Math.floor(tx - radius), 0, ox);
	const top = Math.max(Math.floor(ty - radius), 0, oy);
	const right = Math.min(Math.ceil(tx + radius), width, width + ox);
	const bottom = Math.min(Math.ceil(ty + radius), height, height + oy);
	if (right <= left || bottom <= top) return undefined;
	const box = { x: left, y: top, width: right - left, height: bottom - top };
	const picked = ctx.getImageData(left - ox, top - oy, box.width, box.height).data;
	const under = ctx.getImageData(left, top, box.width, box.height);
	const coverage = settings.mask?.getImageData(left, top, box.width, box.height).data;
	const dab = {
		width: box.width,
		height: box.height,
		cx: tx - left,
		cy: ty - top,
		radius,
		hardness: settings.hardness,
		strength: settings.strength,
	};
	if (!smudgeDab(picked, under.data, dab, coverage)) return undefined;
	ctx.putImageData(under, left, top);
	return box;
};

type Painted = Readonly<{ from: Point; changed: boolean; box: Box | undefined }>;

/** The queued dabs, in order, each picking up from the one before. */
const paintDabs = (
	ctx: CanvasRenderingContext2D,
	stroke: Stroke,
	options: ToolOptions,
	mask: CanvasRenderingContext2D | undefined
): Painted => {
	const radius = radiusOf(stroke.surface, options);
	const settings: DabSettings = {
		radius,
		hardness: options.hardness,
		strength: dabStrength(options.strength, stampSpacing(radius), radius),
		mask,
	};
	const reach = options.size / 2;
	return stroke.queued.reduce<Painted>(
		(painted, centre) => {
			const near = reachesArea(stroke.area, {
				x: centre.x - reach,
				y: centre.y - reach,
				width: 2 * reach,
				height: 2 * reach,
			});
			const box = near
				? dabAt(ctx, stroke.surface, painted.from, centre, settings)
				: undefined;
			return {
				from: centre,
				changed: painted.changed || box !== undefined,
				box:
					box === undefined
						? painted.box
						: unionBox([...(painted.box ? [painted.box] : []), box]),
			};
		},
		{ from: stroke.from, changed: false, box: undefined }
	);
};

/**
 * The pixels a dab changed, shown on the screen canvas over the viewport:
 * the layer's own, in their place through the view, until the stroke lands.
 */
const mirror = (context: ToolContext, surface: RasterSurface, box: Box): void => {
	const ctx = context.screen.canvas.getContext('2d');
	if (ctx === null) return;
	const [a, b, c, d, e, f] = pixelsToScreen(surface.toPixel, context.screen.toScreen);
	ctx.save();
	ctx.setTransform(a, b, c, d, e, f);
	ctx.clearRect(box.x, box.y, box.width, box.height);
	ctx.drawImage(
		surface.canvas,
		box.x,
		box.y,
		box.width,
		box.height,
		box.x,
		box.y,
		box.width,
		box.height
	);
	ctx.restore();
};

export const smudgeBehaviour = (): ToolBehaviour => {
	const active = cell<Stroke | undefined>(undefined);

	/** The dabs queued so far painted, where the picture can be read, and shown. */
	const flush = (context: ToolContext): void => {
		const stroke = active.current;
		if (stroke === undefined || !stroke.ready || stroke.queued.length === 0) return;
		const ctx = stroke.surface.canvas.getContext('2d');
		if (ctx === null) {
			active.current = { ...stroke, queued: [] };
			return;
		}
		const painted = paintDabs(ctx, stroke, context.options, stroke.mask);
		active.current = {
			...stroke,
			from: painted.from,
			queued: [],
			changed: stroke.changed || painted.changed,
		};
		if (painted.box !== undefined) mirror(context, stroke.surface, painted.box);
	};

	/** The dabs from where the pointer was to `to`, queued, and painted where they can be. */
	const advance = (context: ToolContext, stroke: Stroke, to: Point): Stroke => {
		const along = stampsAlong(
			stroke.last,
			to,
			spacingOf(stroke.surface, context.options),
			stroke.carry
		);
		return {
			...stroke,
			last: to,
			carry: along.carry,
			queued: [...stroke.queued, ...along.stamps],
		};
	};

	return {
		begin: (context, sample) => {
			const surface = guardedSurface(context);
			if (surface === undefined) return;
			const serial = claimScreen();
			const area = areaOf(context);
			const start = pointOf(sample);
			context.screen.canvas.style.removeProperty('opacity');
			const decoded = surface.decoded();
			active.current = {
				surface,
				area,
				mask: decoded ? maskFor(surface, area) : undefined,
				from: start,
				last: start,
				carry: 0,
				queued: [],
				ready: decoded,
				changed: false,
				serial,
			};
			if (decoded) return;
			// Never rejects: a picture that would not decode is said at the end.
			void surface.ready.then(() => {
				const stroke = active.current;
				if (stroke?.serial !== serial) return;
				active.current = { ...stroke, ready: true, mask: maskFor(surface, area) };
				flush(context);
			});
		},
		move: (context, sample) => {
			const stroke = active.current;
			if (stroke === undefined) return;
			active.current = advance(context, stroke, pointOf(sample));
			flush(context);
		},
		end: (context, sample) => {
			const stroke = active.current;
			if (stroke === undefined) return;
			active.current = undefined;
			const last = advance(context, stroke, pointOf(sample));
			const { surface, serial } = last;
			// After the picture is decoded, so every dab queued meanwhile is painted
			// on it; the mask is drawn then if it was not yet.
			const work = surface
				.paint('tools.smudge', (ctx) => {
					const painted = paintDabs(
						ctx,
						last,
						context.options,
						last.mask ?? maskFor(surface, last.area)
					);
					if (painted.box !== undefined) mirror(context, surface, painted.box);
					return last.changed || painted.changed;
				})
				.then(
					() => releaseScreen(context.screen, serial),
					(error: unknown) => {
						releaseScreen(context.screen, serial);
						reportFailure(context, surface, error);
					}
				);
			context.document.pending(work);
		},
		cancel: (context) => {
			const stroke = active.current;
			active.current = undefined;
			if (stroke === undefined) return;
			if (stroke.changed) stroke.surface.discard();
			clearScreen(context.screen);
		},
	};
};
