import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import { withBrushOutline } from '../common/brushOutline.js';
import type { PointerSample, ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import { type Box, type Mat, unionBox } from '../vector/geometry.js';
import { affineOf, type Area, areaOf, reachesArea, releaseCanvas } from './area.js';
import { makeAgainUnder, type MakeAgainWords, makingAgain } from './areaFill.js';
import { claimScreen, clearScreen, guardedSurface, releaseScreen, reportFailure } from './guard.js';
import type { Point } from './pixels.js';
import {
	footprintCanvas,
	keepToArea,
	pixelBoxOf,
	showSweep,
	sweep,
	sweepBox,
} from './removeFootprint.js';
import type { RasterSurface } from './surface.js';

/**
 * The Remove tool on a raster layer (docs/decisions/0004-the-interface.md),
 * Photoshop's: a stroke is painted over what should go, and when it ends the
 * pixels under it are made again from the rest of the layer.
 *
 * The brush is round and hard, `size` across in user units, and follows no
 * pressure. While the stroke lasts its footprint is shown on the screen
 * canvas as a translucent highlight, as Photoshop shows its pink, drawn
 * opaque with the canvas made half transparent so that where the stroke
 * crosses itself it is no darker. The same footprint is drawn on a canvas
 * the size of the layer's pixels, through the layer's pixel map and its
 * `transform` (`removeFootprint.ts`); when the stroke ends that is the
 * coverage the content-aware engine makes again, laid over the layer by the
 * coverage at full opacity in one command (`remove.command`), with Fill…'s
 * Content-Aware's status, Stop, Escape, stale check and pending write
 * (`makeAgainUnder`). The highlight stays until the result has landed or
 * the engine stopped. A click without moving is one dab. Where an area is
 * selected the coverage is kept to it, and the highlight to its outline, as
 * every raster tool paints inside the area; a stroke that reaches none of
 * the layer's pixels inside it does nothing and asks nothing of the engine.
 *
 * Its pointer is the brush's outline, as every tool's with a size is
 * (`tools/common/brushOutline.ts`).
 *
 * A stroke begun while the engine is still making pixels again, for the
 * stroke before or for Fill…, paints nothing and says so (`makingAgain`):
 * it would be painted over pixels about to change, and whichever of the two
 * landed second would find the layer changed under it and be dropped, so
 * one would be lost anyway. Photoshop holds the canvas while its Remove
 * works for the same reason. Escape during a stroke abandons it; during the
 * engine's work it stops the engine.
 */

/** What the engine's work says, in the Remove tool's words. */
const WORDS = {
	working: 'remove.working',
	stop: 'remove.stop',
	stopped: 'remove.stopped',
	changed: 'remove.changed',
	failed: 'remove.failed',
} as const satisfies MakeAgainWords;

/** The highlight's color, drawn opaque; the screen canvas carries `HIGHLIGHT_OPACITY`. */
const HIGHLIGHT = '#ff2d95';

const HIGHLIGHT_OPACITY = 0.5;

/** What the footprint is drawn in on the layer's pixels: only its alpha is read. */
const FOOTPRINT = '#000000';

/** The smallest brush, in user units, for a size that is not one. */
const MIN_SIZE = 1;

interface Stroke {
	readonly surface: RasterSurface;
	/** The area selected when the stroke began; none for anywhere. */
	readonly area: Area | undefined;
	/** The footprint on the layer's pixels: a canvas their size whose alpha is how much of each the stroke covers. */
	readonly footprint: HTMLCanvasElement;
	/** User units to the footprint's pixels, read when the stroke began. */
	readonly toFootprint: Mat;
	/** The brush's radius in user units. */
	readonly radius: number;
	/** Where the pointer last was, in user units. */
	readonly last: Point;
	/** The box around the footprint, in user units. */
	readonly box: Box;
	/** Whether any of the footprint reached the area, so it may cover a pixel to make again. */
	readonly reached: boolean;
	/** Which stroke this is on the screen canvas, so only the latest clears it. */
	readonly serial: number;
}

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The brush's radius in user units: half its size, and never under half a unit. */
const radiusOf = (options: ToolOptions): number =>
	(Number.isFinite(options.size) ? Math.max(MIN_SIZE, options.size) : MIN_SIZE) / 2;

/**
 * The stroke carried on to `to`: the sweep from where it was drawn on the
 * footprint and on the screen, and its box and its reach grown by it.
 */
const extend = (context: ToolContext, stroke: Stroke, to: Point): Stroke => {
	const { area, last, radius } = stroke;
	const ctx = stroke.footprint.getContext('2d');
	if (ctx !== null) sweep(ctx, stroke.toFootprint, last, to, radius, FOOTPRINT);
	showSweep(context.screen, area, last, to, radius, HIGHLIGHT);
	const swept = sweepBox(last, to, radius);
	return {
		...stroke,
		last: to,
		box: unionBox([stroke.box, swept]) ?? swept,
		reached: stroke.reached || reachesArea(area, swept),
	};
};

/**
 * The stroke ended: its footprint, kept to the area, made again by the
 * engine, which the document waits for before a save. The highlight goes
 * once that is written or stopped, unless a later stroke is on the screen
 * canvas. A footprint that reaches none of the layer's pixels inside the
 * area does nothing.
 */
const finish = (context: ToolContext, stroke: Stroke): void => {
	const { area, footprint, serial, surface } = stroke;
	const done = (): void => {
		releaseCanvas(footprint);
		releaseScreen(context.screen, serial);
	};
	const box = stroke.reached ? pixelBoxOf(footprint, stroke.toFootprint, stroke.box) : undefined;
	if (box === undefined) {
		done();
		return;
	}
	const work = makeAgainUnder(context, surface, {
		label: 'remove.command',
		words: WORDS,
		coverage: () => {
			keepToArea(surface, footprint, area);
			return { canvas: footprint, box };
		},
	})
		.catch((error: unknown) => {
			reportFailure(context, surface, error);
		})
		.finally(done);
	context.document.pending(work);
};

/** The Remove tool's behavior on a raster layer, holding the stroke under way. */
export const removeBehavior = (): ToolBehavior => {
	const active = cell<Stroke | undefined>(undefined);

	return withBrushOutline({
		begin: (context, sample) => {
			const at = pointOf(sample);
			const radius = radiusOf(context.options);
			const surface = guardedSurface(context);
			if (surface === undefined) return;
			if (makingAgain()) {
				context.notify(t('remove.busy'));
				return;
			}
			const serial = claimScreen();
			context.screen.canvas.style.setProperty('opacity', String(HIGHLIGHT_OPACITY));
			const first: Stroke = {
				surface,
				area: areaOf(context),
				footprint: footprintCanvas(surface.canvas),
				toFootprint: affineOf(surface.toPixel),
				radius,
				last: at,
				box: sweepBox(at, at, radius),
				reached: false,
				serial,
			};
			// The dab where the stroke begins: a click that never moves is this alone.
			active.current = extend(context, first, at);
		},
		move: (context, sample) => {
			const stroke = active.current;
			if (stroke === undefined) return;
			active.current = extend(context, stroke, pointOf(sample));
		},
		end: (context, sample) => {
			const stroke = active.current;
			active.current = undefined;
			if (stroke === undefined) return;
			finish(context, extend(context, stroke, pointOf(sample)));
		},
		cancel: (context) => {
			const stroke = active.current;
			active.current = undefined;
			if (stroke === undefined) return;
			releaseCanvas(stroke.footprint);
			clearScreen(context.screen);
		},
	});
};
