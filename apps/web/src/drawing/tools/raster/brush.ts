import { cell } from '@skysa/draw-core';

import type { PointerSample, ToolBehaviour, ToolContext, ToolOptions } from '../types.js';
import { distance, pressureWidth } from '../vector/geometry.js';
import { inkOf } from '../vector/svg.js';
import { type Brush, paintSegment, paintStamp, targetsOf } from './brushEngine.js';
import { clearScreen, guardedSurface, reportFailure } from './guard.js';
import type { Point } from './pixels.js';
import { clearCanvas, type CompositeMode, type RasterSurface } from './surface.js';

/**
 * The brush, the pencil and the eraser on a raster layer
 * (docs/decisions/0004-the-interface.md): one engine, three settings, each
 * reading the options its strip shows. The brush is soft, follows pressure
 * and paints in the fill colour; the pencil is hard, does not follow pressure
 * and draws in the stroke colour, as both do on a vector layer; the eraser is
 * the brush committed as `destination-out`, so what it stamps is taken away
 * instead of put down.
 */

type BrushKind = 'brush' | 'pencil' | 'eraser';

interface Stroke {
	readonly surface: RasterSurface;
	/** Where the last stamp went: behind the pointer by the smoothing's slack. */
	readonly last: Point;
	/** What `stampsAlong` carries between segments. */
	readonly carry: number;
	/** Which stroke this is among all begun, so only the latest clears the screen. */
	readonly serial: number;
}

/** The screen cannot show pixels going away, so the eraser's live stroke is a neutral veil. */
const ERASER_MIRROR = 'rgba(128, 128, 128, 0.5)';

const BLACK = '#000000';

/** How far behind the pointer a stroke at full smoothing is drawn, in screen pixels. */
const SLACK_PX = 24;

/**
 * Strokes begun, by any of the three: one screen canvas shows them all, so a
 * stroke that lands clears it only when no stroke has begun since.
 */
const begun = cell(0);

/**
 * The brush for one sample. The width is a diameter; on the brush, pressure
 * takes it from a quarter to the whole, as on a vector layer. The eraser
 * shows only a size and a hardness, so it erases fully and follows no
 * pressure: the brush's opacity and pressure are not its.
 */
const brushOf = (kind: BrushKind, options: ToolOptions, sample: PointerSample): Brush => {
	const width =
		kind === 'brush'
			? pressureWidth(options.size, sample.pressure, options.pressure)
			: options.size;
	const colour =
		kind === 'eraser' ? BLACK : inkOf(options, kind === 'pencil' ? 'stroke' : 'fill');
	return {
		radius: width / 2,
		hardness: kind === 'pencil' ? 1 : options.hardness,
		colour,
		mirror: kind === 'eraser' ? ERASER_MIRROR : colour,
	};
};

const opacityOf = (kind: BrushKind, options: ToolOptions): number =>
	kind === 'eraser' ? 1 : options.opacity;

/** The smoothing's string, in user units, so it is the same length on screen at any zoom. */
const slackOf = (kind: BrushKind, context: ToolContext): number => {
	const { scale } = context.viewport;
	if (kind === 'eraser' || !(scale > 0)) return 0;
	return (context.options.smoothing * SLACK_PX) / scale;
};

/**
 * Where the stroke goes next: the pointer pulls it along on a string of
 * `slack`, so a tremor shorter than the string is never drawn and a corner is
 * rounded; with no slack, the pointer itself. Measured by distance rather
 * than by samples, so a pen that reports four times as often is smoothed alike.
 */
const pulled = (from: Point, to: PointerSample, slack: number): Point => {
	const gap = distance(from, to);
	if (gap <= slack) return from;
	const along = (gap - slack) / gap;
	return { x: from.x + (to.x - from.x) * along, y: from.y + (to.y - from.y) * along };
};

export const brushBehaviour = (kind: BrushKind): ToolBehaviour => {
	const active = cell<Stroke | undefined>(undefined);
	const label = `tools.${kind}`;
	const mode: CompositeMode = kind === 'eraser' ? 'destination-out' : 'source-over';

	// The stroke stays on the screen canvas until the new href has landed, and
	// is cleared then, unless a later stroke is on the canvas too: that one
	// clears it when its own pixels land. A save waits for the whole of it.
	const finish = (context: ToolContext, stroke: Stroke): void => {
		const clear = (): void => {
			if (begun.current === stroke.serial) clearScreen(context.screen);
		};
		const work = stroke.surface
			.commit(label, mode, opacityOf(kind, context.options))
			.then(clear, (error: unknown) => {
				clear();
				reportFailure(context, stroke.surface, error);
			});
		context.document.pending(work);
	};

	return {
		begin: (context, sample) => {
			const surface = guardedSurface(context);
			if (surface === undefined) return;
			begun.current += 1;
			// The live stroke's opacity, applied to the whole stroke at once as
			// the commit will, rather than to each stamp.
			context.screen.canvas.style.setProperty(
				'opacity',
				String(opacityOf(kind, context.options))
			);
			paintStamp(
				targetsOf(context, surface),
				sample.x,
				sample.y,
				brushOf(kind, context.options, sample)
			);
			active.current = {
				surface,
				last: { x: sample.x, y: sample.y },
				carry: 0,
				serial: begun.current,
			};
		},
		move: (context, sample) => {
			const stroke = active.current;
			if (stroke === undefined) return;
			const to = pulled(stroke.last, sample, slackOf(kind, context));
			const carry = paintSegment(
				targetsOf(context, stroke.surface),
				stroke.last,
				to,
				brushOf(kind, context.options, sample),
				stroke.carry
			);
			active.current = { ...stroke, last: to, carry };
		},
		end: (context, sample) => {
			const stroke = active.current;
			if (stroke === undefined) return;
			active.current = undefined;
			// To where the pointer lifted, however far behind the smoothing left
			// the stroke: it keeps its reach, as a smoothed vector stroke does.
			paintSegment(
				targetsOf(context, stroke.surface),
				stroke.last,
				sample,
				brushOf(kind, context.options, sample),
				stroke.carry
			);
			finish(context, stroke);
		},
		cancel: (context) => {
			const stroke = active.current;
			active.current = undefined;
			if (stroke === undefined) return;
			clearCanvas(stroke.surface.stroke);
			clearScreen(context.screen);
		},
	};
};
