import { cell } from '@skysa/storage';

import { softEdge, withBrushOutline } from '../common/brushOutline.js';
import type { PointerSample, ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import {
	type Box,
	distance,
	followsPressure,
	pressureWidth,
	unionBox,
} from '../vector/geometry.js';
import { inkOf } from '../vector/svg.js';
import { type Area, areaOf, reachesArea } from './area.js';
import { type Brush, paintSegment, paintStamp, targetsOf } from './brushEngine.js';
import { claimScreen, clearScreen, guardedSurface, releaseScreen, reportFailure } from './guard.js';
import type { Point } from './pixels.js';
import { clearCanvas, type CompositeMode, type RasterSurface } from './surface.js';

/**
 * The brush, the pencil and the eraser on a raster layer
 * (docs/decisions/0004-the-interface.md): one engine, three settings, each
 * reading the options its strip shows. The brush is soft, follows pressure
 * and paints in the fill color; the pencil is hard, does not follow pressure
 * and draws in the stroke color, as both do on a vector layer; the eraser is
 * the brush committed as `destination-out`, so what it stamps is taken away
 * instead of put down. Where an area is selected (`ToolContext.region`) all
 * three paint inside it, and a stroke that never reaches it writes nothing.
 * The brush and the pencil paint anywhere on the drawing's canvas, and a
 * stroke past the layer's pixels grows them to hold it (`RasterSurface`);
 * the eraser takes away only what is there.
 * The size is in the drawing's user units on any layer (`brushEngine.ts`), and
 * the pointer of all three is the brush's outline, which shows it
 * (`tools/common/brushOutline.ts`).
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
	/** The area selected when the stroke began; none for anywhere. */
	readonly area: Area | undefined;
	/** Whether any stamp reached the area, so the stroke may have changed a pixel. */
	readonly reached: boolean;
	/** What the stroke's stamps cover so far, in user units: how far it may grow the layer's pixels. */
	readonly box: Box;
	/** Whether what it paints may land past the layer's pixels and grow them: not the eraser's. */
	readonly grows: boolean;
}

/** The screen cannot show pixels going away, so the eraser's live stroke is a neutral veil. */
const ERASER_MIRROR = 'rgba(128, 128, 128, 0.5)';

const BLACK = '#000000';

/** How far behind the pointer a stroke at full smoothing is drawn, in screen pixels. */
const SLACK_PX = 24;

/** What a segment's stamps cover, in user units: the box around its two ends, grown by the radius. */
const segmentBox = (from: Point, to: Point, radius: number): Box => ({
	x: Math.min(from.x, to.x) - radius,
	y: Math.min(from.y, to.y) - radius,
	width: Math.abs(to.x - from.x) + 2 * radius,
	height: Math.abs(to.y - from.y) + 2 * radius,
});

/**
 * The brush for one sample. The width is a diameter; on the brush, a pen's
 * pressure takes it from a quarter to the whole, as on a vector layer
 * (`followsPressure`). The eraser
 * shows only a size and a hardness, so it erases fully and follows no
 * pressure: the brush's opacity and pressure are not its.
 */
const brushOf = (kind: BrushKind, options: ToolOptions, sample: PointerSample): Brush => {
	const width =
		kind === 'brush'
			? pressureWidth(
					options.size,
					sample.pressure,
					followsPressure(options.pressure, sample.pointerType)
				)
			: options.size;
	const color = kind === 'eraser' ? BLACK : inkOf(options, kind === 'pencil' ? 'stroke' : 'fill');
	return {
		radius: width / 2,
		hardness: kind === 'pencil' ? 1 : options.hardness,
		color,
		mirror: kind === 'eraser' ? ERASER_MIRROR : color,
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

/** The stroke carried on to `to`: where it last stamped, what it covers and whether it reached the area. */
const carriedTo = (stroke: Stroke, to: Point, brush: Brush): Stroke => {
	const segment = segmentBox(stroke.last, to, brush.radius);
	return {
		...stroke,
		last: { x: to.x, y: to.y },
		box: unionBox([stroke.box, segment]) ?? segment,
		reached: stroke.reached || reachesArea(stroke.area, segment),
	};
};

export const brushBehavior = (kind: BrushKind): ToolBehavior => {
	const active = cell<Stroke | undefined>(undefined);
	const label = `tools.${kind}`;
	const mode: CompositeMode = kind === 'eraser' ? 'destination-out' : 'source-over';

	// The stroke stays on the screen canvas until the new href has landed, and
	// is cleared then, unless a later stroke is on the canvas too: that one
	// clears it when its own pixels land. A save waits for the whole of it.
	// One that never reached the area changed nothing, and writes nothing.
	const finish = (context: ToolContext, stroke: Stroke): void => {
		const clear = (): void => releaseScreen(context.screen, stroke.serial);
		if (!stroke.reached) {
			clearCanvas(stroke.surface.stroke);
			clear();
			return;
		}
		const work = stroke.surface
			.commit(label, mode, opacityOf(kind, context.options), stroke.area, stroke.box)
			.then(clear, (error: unknown) => {
				clear();
				reportFailure(context, stroke.surface, error);
			});
		context.document.pending(work);
	};

	return withBrushOutline(
		{
			begin: (context, sample) => {
				const surface = guardedSurface(context);
				if (surface === undefined) return;
				const serial = claimScreen(context.screen, context.layer?.id);
				const area = areaOf(context);
				const brush = brushOf(kind, context.options, sample);
				// The live stroke's opacity, applied to the whole stroke at once as
				// the commit will, rather than to each stamp.
				context.screen.canvas.style.setProperty(
					'opacity',
					String(opacityOf(kind, context.options))
				);
				const grows = kind !== 'eraser';
				paintStamp(targetsOf(context, surface, area, grows), sample.x, sample.y, brush);
				const last = { x: sample.x, y: sample.y };
				const box = segmentBox(last, last, brush.radius);
				active.current = {
					surface,
					last,
					carry: 0,
					serial,
					area,
					reached: reachesArea(area, box),
					box,
					grows,
				};
			},
			move: (context, sample) => {
				const stroke = active.current;
				if (stroke === undefined) return;
				const to = pulled(stroke.last, sample, slackOf(kind, context));
				const brush = brushOf(kind, context.options, sample);
				const carry = paintSegment(
					targetsOf(context, stroke.surface, stroke.area, stroke.grows),
					stroke.last,
					to,
					brush,
					stroke.carry
				);
				active.current = { ...carriedTo(stroke, to, brush), carry };
			},
			end: (context, sample) => {
				const stroke = active.current;
				if (stroke === undefined) return;
				active.current = undefined;
				// To where the pointer lifted, however far behind the smoothing left
				// the stroke: it keeps its reach, as a smoothed vector stroke does.
				const brush = brushOf(kind, context.options, sample);
				paintSegment(
					targetsOf(context, stroke.surface, stroke.area, stroke.grows),
					stroke.last,
					sample,
					brush,
					stroke.carry
				);
				finish(context, carriedTo(stroke, sample, brush));
			},
			cancel: (context) => {
				const stroke = active.current;
				active.current = undefined;
				if (stroke === undefined) return;
				clearCanvas(stroke.surface.stroke);
				clearScreen(context.screen);
			},
		},
		kind === 'pencil' ? undefined : softEdge
	);
};
