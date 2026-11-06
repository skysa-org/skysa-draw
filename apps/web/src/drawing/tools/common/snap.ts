import { cell } from '@skysa/draw-core';

import type { EditorDocument, LayerInfo } from '../../document/model.js';
import { canvasBox } from '../../export/box.js';
import { layerExtentIn } from '../../viewport/layerExtent.js';
import type { PointerSample, ToolContext } from '../types.js';
import { type Box, unionBox } from '../vector/geometry.js';
import { createSvg } from '../vector/svg.js';
import type { LayerExtent, Offset } from './align.js';

/**
 * Snapping, as Photoshop's View › Snap with its smart guides
 * (docs/ARCHITECTURE.md §7, "The editor"): while the move tool drags, the box
 * of what moves is pulled onto the nearest line of the canvas or of another
 * layer within `SNAP_PX` on the screen. Across, the lines are each box's left
 * edge, center and right edge; down, its top, middle and bottom; any of the
 * moving box's three goes to any of a target's three. Each axis snaps on its
 * own, by the smallest pull within reach, the first found on a tie: the
 * canvas first, then what else is on the layer of elements that move, then
 * the layers as they were measured, and a target's near edge before its
 * center before its far edge.
 *
 * A guide shows each line the box sits on once it snapped, for as long as it
 * holds, in Photoshop's smart-guide magenta (`viewport.css`): along that
 * line, from the box to what it snapped to, which for the canvas is its whole
 * side. Every target with a line where the box's line now is shares the
 * guide, and every line of the box that meets one shows, so a box snapped
 * by its left edge whose right edge then meets another layer's shows both.
 * The guides are on the tools' overlay, in the root's user units, a hairline
 * whatever the zoom.
 *
 * What moves and what it may snap to are measured as the drag begins
 * (`DragSnap`), by what they paint, in the root's user units (`LayerExtent`,
 * `viewport/layerExtent.ts`). The measures are promises, since a raster
 * layer's picture is decoded to be measured, so a drag snaps once the box
 * that moves is in, and to each layer as its measure comes in; the canvas is
 * there from the start. The layers it may snap to are the others in sight:
 * not hidden, nor in a hidden group, and neither moving nor inside a layer
 * that moves nor a group that holds one, whose box would move with it. A
 * drag of elements on a vector layer snaps the box around them, as the
 * select tool measures it, to those and to the layer's other elements.
 *
 * A drag snaps once the pointer has gone `STILL_PX` from its press, so a
 * click moves nothing. With Snap off in the options a drag measures nothing
 * and never snaps, and Control held, on every platform, keeps it from
 * snapping for as long as it is held, as Photoshop's does; the arrows' nudge
 * never snaps.
 */

/** How near on the screen, in CSS pixels, a line pulls the box onto it. */
export const SNAP_PX = 6;

/**
 * How far on the screen, in CSS pixels, the pointer goes from its press
 * before the drag snaps, and from then on until it ends: a click, or a pen's
 * tremor on a tap, moves nothing by snapping.
 */
export const STILL_PX = 3;

type Axis = 'x' | 'y';

/**
 * A guide: the line at `at` along `axis`, where the box snapped, drawn from
 * `from` to `to` along the other axis. One along `x` is upright.
 */
export type Guide = Readonly<{ axis: Axis; at: number; from: number; to: number }>;

/** A drag's offset snapped, and the guides that show where it snapped. */
export type Snapped = Readonly<{ offset: Offset; guides: readonly Guide[] }>;

/** Two lines nearer than this, in user units, are one: the noise of sums of fractions. */
const SAME = 1e-6;

const STILL: Offset = [0, 0];

const startOf = (box: Box, axis: Axis): number => (axis === 'x' ? box.x : box.y);

const sizeOf = (box: Box, axis: Axis): number => (axis === 'x' ? box.width : box.height);

const endOf = (box: Box, axis: Axis): number => startOf(box, axis) + sizeOf(box, axis);

const across = (axis: Axis): Axis => (axis === 'x' ? 'y' : 'x');

/** The box's three lines along `axis`: its near edge, its center and its far edge. */
const linesOf = (box: Box, axis: Axis): readonly number[] => [
	startOf(box, axis),
	startOf(box, axis) + sizeOf(box, axis) / 2,
	endOf(box, axis),
];

const shifted = (box: Box, [dx, dy]: Offset): Box => ({ ...box, x: box.x + dx, y: box.y + dy });

/**
 * How far along `axis` the box must go for one of its lines to sit on the
 * nearest line of `targets` within `reach`: the smallest pull, the first
 * found on a tie; none where every line is out of reach.
 */
const pullAlong = (
	box: Box,
	targets: readonly Box[],
	axis: Axis,
	reach: number
): number | undefined => {
	const own = linesOf(box, axis);
	return targets
		.flatMap((target) =>
			linesOf(target, axis).flatMap((line) => own.map((mine) => line - mine))
		)
		.reduce<number | undefined>(
			(best, pull) =>
				Math.abs(pull) <= reach && (best === undefined || Math.abs(pull) < Math.abs(best))
					? pull
					: best,
			undefined
		);
};

/**
 * The guides along `axis` of the box where it is: one for each of its lines
 * that a target has too, spanning the box and every target with that line.
 * A box with no size along the axis has one line there, and one guide.
 */
const guidesAlong = (box: Box, targets: readonly Box[], axis: Axis): readonly Guide[] => {
	const other = across(axis);
	return linesOf(box, axis)
		.filter((at, index, all) => all.findIndex((each) => Math.abs(each - at) <= SAME) === index)
		.flatMap((at) => {
			const met = targets.filter((target) =>
				linesOf(target, axis).some((line) => Math.abs(line - at) <= SAME)
			);
			if (met.length === 0) return [];
			const spanned = [box, ...met];
			return [
				{
					axis,
					at,
					from: Math.min(...spanned.map((each) => startOf(each, other))),
					to: Math.max(...spanned.map((each) => endOf(each, other))),
				},
			];
		});
};

/**
 * The offset of a drag snapped: `moving` is the box of what moves as the
 * drag began, `offset` how far the pointer has taken it, `targets` the boxes
 * it may snap to, the canvas among them, and `reach` how near a line pulls,
 * all in the root's user units. Each axis is pulled on its own, or left as
 * the pointer has it where nothing is in reach; the guides are those of the
 * axes that snapped.
 */
export const snapOffset = (
	moving: Box,
	offset: Offset,
	targets: readonly Box[],
	reach: number
): Snapped => {
	const proposed = shifted(moving, offset);
	const pullX = pullAlong(proposed, targets, 'x', reach);
	const pullY = pullAlong(proposed, targets, 'y', reach);
	const snapped: Offset = [offset[0] + (pullX ?? 0), offset[1] + (pullY ?? 0)];
	const box = shifted(moving, snapped);
	return {
		offset: snapped,
		guides: [
			...(pullX === undefined ? [] : guidesAlong(box, targets, 'x')),
			...(pullY === undefined ? [] : guidesAlong(box, targets, 'y')),
		],
	};
};

/** `layer` and every group it is in, outward. */
const lineageOf = (
	byId: ReadonlyMap<string, LayerInfo>,
	layer: LayerInfo
): readonly LayerInfo[] => {
	const parent = layer.parentId === undefined ? undefined : byId.get(layer.parentId);
	return parent === undefined ? [layer] : [layer, ...lineageOf(byId, parent)];
};

/**
 * The layers a drag of the layers `moving` may snap to, in paint order: every
 * one in sight, neither hidden itself nor in a hidden group, that is not
 * moving, not inside a layer that is, and not a group that holds one.
 */
export const snapTargetIds = (
	layers: readonly LayerInfo[],
	moving: readonly string[]
): readonly string[] => {
	const byId = new Map(layers.map((layer) => [layer.id, layer]));
	const holding = new Set(
		moving.flatMap((id) => {
			const layer = byId.get(id);
			return layer === undefined ? [] : lineageOf(byId, layer).map((each) => each.id);
		})
	);
	return layers
		.filter(
			(layer) =>
				!holding.has(layer.id) &&
				lineageOf(byId, layer).every((each) => !each.hidden && !moving.includes(each.id))
		)
		.map((layer) => layer.id);
};

/** The attribute that marks the guides on the overlay. */
const GUIDES_MARK = 'data-snap-guides';

const guidesOf = (overlay: SVGSVGElement): Element | null =>
	overlay.querySelector(`[${GUIDES_MARK}]`);

export const clearGuides = (overlay: SVGSVGElement): void => {
	overlay.querySelectorAll(`[${GUIDES_MARK}]`).forEach((element) => element.remove());
};

const endsOf = ({ axis, at, from, to }: Guide): Readonly<Record<string, number>> =>
	axis === 'x' ? { x1: at, y1: from, x2: at, y2: to } : { x1: from, y1: at, x2: to, y2: at };

/**
 * The guides drawn afresh over what the overlay holds, in its user units, a
 * hairline at any zoom (`viewport.css`), or taken away for none.
 */
export const drawGuides = (overlay: SVGSVGElement, guides: readonly Guide[]): void => {
	clearGuides(overlay);
	if (guides.length === 0) return;
	const owner = overlay.ownerDocument;
	const group = createSvg(owner, 'g', { [GUIDES_MARK]: '', class: 'snap-guides' });
	group.append(
		...guides.map((guide) =>
			createSvg(owner, 'line', {
				class: 'snap-guide',
				...endsOf(guide),
				'vector-effect': 'non-scaling-stroke',
			})
		)
	);
	overlay.append(group);
};

/** The guides put back over whatever was drawn on the overlay after them: a selection's box. */
export const raiseGuides = (overlay: SVGSVGElement): void => {
	const group = guidesOf(overlay);
	if (group !== null && overlay.lastElementChild !== group) overlay.append(group);
};

/** What measures the layers of a document: the browser, as `layerExtentIn` asks it, or a test in its place. */
export type ExtentOf = (document: EditorDocument) => LayerExtent;

/**
 * One drag's snapping, for the drag to ask at each of its steps: a drag of
 * layers whole (`layersMove.ts`, `raster/select.ts`) or of elements on a
 * vector layer (`vector/select.ts`).
 */
export type DragSnap = Readonly<{
	/** A drag of the layers `ids` whole begins: what moves is what they paint, together. */
	beginLayers: (context: ToolContext, ids: readonly string[]) => void;
	/**
	 * A drag of what `moving` boxes on the layer `layerId` begins, in the
	 * root's units: what it may snap to is the canvas, the other layers, and
	 * `beside`, the boxes of what else is on that layer.
	 */
	beginBox: (
		context: ToolContext,
		moving: Box | undefined,
		layerId: string,
		beside: readonly Box[]
	) => void;
	/**
	 * The drag's offset so far, `proposed` as the pointer has it in the root's
	 * user units, snapped where it may be, with its guides shown; the drag
	 * moves what it moves by this, live.
	 */
	move: (context: ToolContext, sample: PointerSample, proposed: Offset) => Offset;
	/** The drag's last offset, snapped as `move` would snap it, and its guides gone. */
	end: (context: ToolContext, sample: PointerSample, proposed: Offset) => Offset;
	/** The drag abandoned: its guides gone. */
	cancel: (context: ToolContext) => void;
}>;

/** The screen's pixels per user unit, or 1 where the view has not said. */
const scaleOf = (context: ToolContext): number => {
	const { scale } = context.viewport;
	return Number.isFinite(scale) && scale > 0 ? scale : 1;
};

/** How many times, at most, what moves is measured before the drag goes on without snapping. */
const MEASURES = 3;

/** What a layer paints, as a drag found it: a box, or none for nothing; none at all where it could not be told. */
type Found = readonly Box[] | undefined;

/**
 * A drag's snapping, measuring by `extentOf`, the browser's by default. Each
 * drag is numbered, so a measure that comes in after its drag ended, or after
 * another began, is let go of.
 */
export const createDragSnap = (extentOf: ExtentOf = layerExtentIn): DragSnap => {
	const serial = cell(0);
	/** The box of what moves, where it was as the drag began; none until it is measured. */
	const moving = cell<Box | undefined>(undefined);
	const targets = cell<readonly Box[]>([]);
	/** The offset last given, which the drag has moved its layers by, live. */
	const applied = cell<Offset>(STILL);
	/** How many steps the drags have made, which a measure of what moves is read against. */
	const steps = cell(0);
	/** Whether the pointer has gone `STILL_PX` from its press, after which the drag snaps. */
	const away = cell(false);

	/** The drag before, if any, let go of, and a new one numbered, with the canvas to snap to. */
	const restart = (context: ToolContext): number => {
		serial.current = serial.current + 1;
		moving.current = undefined;
		targets.current = [canvasBox(context.document)];
		applied.current = STILL;
		away.current = false;
		return serial.current;
	};

	/** The layers `ids`, measured one by one, each joining the drag's targets as it comes in. */
	const join = (drag: number, extent: LayerExtent, ids: readonly string[]): void => {
		ids.forEach((id) => {
			void extent(id)
				.catch(() => undefined)
				.then((box) => {
					if (box !== undefined && serial.current === drag) {
						targets.current = [...targets.current, box];
					}
				});
		});
	};

	/**
	 * Where what `id` paints was as the drag began. The drag moves the layer
	 * live, and a measure says where it is at some moment between its asking
	 * and its answer, which it does not say: a raster layer's picture may be
	 * decoded meanwhile. So a measure is taken only where no step of the drag
	 * came between the two, and then by the offset the drag had all the
	 * while; where one did, it is asked again, `MEASURES` times in all, and
	 * after that what moves is not known. Not known either for a drag that
	 * ended before it was in.
	 */
	const asItBegan = (
		drag: number,
		extent: LayerExtent,
		id: string,
		tries = 1
	): Promise<Found> => {
		const step = steps.current;
		const [dx, dy] = applied.current;
		return extent(id)
			.catch(() => undefined)
			.then((box) => {
				if (serial.current !== drag) return undefined;
				if (steps.current !== step) {
					return tries < MEASURES ? asItBegan(drag, extent, id, tries + 1) : undefined;
				}
				return box === undefined ? [] : [shifted(box, [-dx, -dy])];
			});
	};

	const stop = (context: ToolContext): void => {
		serial.current = serial.current + 1;
		moving.current = undefined;
		targets.current = [];
		applied.current = STILL;
		away.current = false;
		clearGuides(context.overlay);
	};

	const snappedFor = (context: ToolContext, sample: PointerSample, proposed: Offset): Snapped => {
		const box = moving.current;
		const scale = scaleOf(context);
		away.current = away.current || Math.hypot(...proposed) * scale >= STILL_PX;
		if (box === undefined || !away.current || !context.options.snap || sample.controlKey) {
			return { offset: proposed, guides: [] };
		}
		return snapOffset(box, proposed, targets.current, SNAP_PX / scale);
	};

	return {
		beginLayers: (context, ids) => {
			const drag = restart(context);
			if (!context.options.snap) return;
			const extent = extentOf(context.document);
			const layers = context.document.snapshot().layers;
			// What moves is asked first, so its pictures are read before the targets'.
			const found = ids.map((id) => asItBegan(drag, extent, id));
			void Promise.all(found).then((each) => {
				if (serial.current !== drag || each.some((boxes) => boxes === undefined)) return;
				moving.current = unionBox(each.flatMap((boxes) => boxes ?? []));
			});
			join(drag, extent, snapTargetIds(layers, ids));
		},
		beginBox: (context, box, layerId, beside) => {
			const drag = restart(context);
			if (!context.options.snap) return;
			targets.current = [...targets.current, ...beside];
			// Once the press's turn is over, as a layer's measure would come in,
			// so a drag of elements snaps as a drag of layers does: from its
			// first move, never in the turn that began it.
			void Promise.resolve().then(() => {
				if (serial.current === drag) moving.current = box;
			});
			const layers = context.document.snapshot().layers;
			join(drag, extentOf(context.document), snapTargetIds(layers, [layerId]));
		},
		move: (context, sample, proposed) => {
			const { offset, guides } = snappedFor(context, sample, proposed);
			steps.current = steps.current + 1;
			applied.current = offset;
			drawGuides(context.overlay, guides);
			return offset;
		},
		end: (context, sample, proposed) => {
			const { offset } = snappedFor(context, sample, proposed);
			stop(context);
			return offset;
		},
		cancel: stop,
	};
};
