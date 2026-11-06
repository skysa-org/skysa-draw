import { t } from '../../../i18n/t.js';
import { outermostLayers } from '../../document/arrange.js';
import { layerById } from '../../document/layers.js';
import { canvasBox } from '../../export/box.js';
import { areaPolygons, boundsOf } from '../raster/area.js';
import type { AlignTo, ToolContext } from '../types.js';
import { type Box, unionBox } from '../vector/geometry.js';
import { draggingLayers, mayMove, movedIds, moveLayersBy } from './layersMove.js';

/**
 * The move tool's alignment, as Photoshop's options bar has it
 * (docs/decisions/0004-the-interface.md, "Align and distribute"): six buttons
 * that line the layers up by an edge or a center, and a menu that
 * distributes them by an edge, a center or the gaps between them, aligned
 * to the selection or to the canvas.
 *
 * The layers are the ones a drag of the move tool moves (`layersMove.ts`):
 * the outermost of those chosen in the panel where there are several, else
 * the active layer alone, refused whole in the drag's own words where one may
 * not move. Each is measured by what it paints (`LayerExtent`), in the root's
 * user units, and one that paints nothing is left where it is. Each then
 * moves by a distance of its own in the root's units, written in front of its
 * own `transform` in its parent's units as a drag writes it, so a layer in a
 * scaled or turned group goes where the measure says; one command moves them
 * all, and one undo puts them back. A layer already where it would go is left
 * out of the command, and with none left nothing runs.
 *
 * Aligned to the selection, the layers line up with the area where one is
 * selected, which is the canvas where it is inverted; else with the box
 * around them all, where two or more were measured; else, one alone, with the
 * canvas, as Photoshop's has since 2019. Aligned to the canvas, they line up
 * with the canvas.
 *
 * A distribution by an edge or a center orders the layers by that coordinate,
 * those level in the order given, and spaces the coordinate evenly from the
 * first to the last. Aligned to the selection, the first and the last stay,
 * so it takes three; aligned to the canvas, the first goes flush with the
 * canvas's left or top side and the last with its right or bottom, so two
 * will do. A distribution of the spacing orders the layers by their centers,
 * which reads the same either way round, and puts the same gap between each
 * one's far edge and the next one's near edge, across the span from the
 * first's near edge to the last's far edge, or across the canvas; the gap is
 * less than nothing where the layers are wider than the span, and they
 * overlap.
 *
 * The measures are a promise, since a raster layer's picture is decoded to
 * be measured. Anything that changes the document before they are in, a
 * second press among them, or a drag of the layers then under way, would
 * leave them untrue, and the arrangement does nothing; a layer whose measure
 * fails is taken as one that paints nothing.
 */

/** Photoshop's six alignments, in its options bar's order. */
export const ALIGN_EDGES = ['left', 'centerX', 'right', 'top', 'centerY', 'bottom'] as const;
export type AlignEdge = (typeof ALIGN_EDGES)[number];

/** Photoshop's distributions, in its menu's order: by an edge or a center, then the even gaps. */
export const DISTRIBUTIONS = [
	'top',
	'centerY',
	'bottom',
	'left',
	'centerX',
	'right',
	'spaceY',
	'spaceX',
] as const;
export type Distribution = (typeof DISTRIBUTIONS)[number];

/** One press of the options bar: an alignment, or a distribution. */
export type Arrangement =
	| Readonly<{ kind: 'align'; edge: AlignEdge }>
	| Readonly<{ kind: 'distribute'; how: Distribution }>;

/** How far one layer moves, in the root's user units. */
export type Offset = readonly [number, number];

/**
 * What a layer paints, measured: the box of it in the root's user units,
 * through its `transform` and its groups'; none for a layer that paints
 * nothing (`viewport/layerExtent.ts`). A promise, since a raster layer's
 * picture is decoded to be measured.
 */
export type LayerExtent = (id: string) => Promise<Box | undefined>;

type Axis = 'x' | 'y';

/** Where an edge or a center is on a box: along which axis, and how far across the box, 0 to 1. */
type Along = Readonly<{ axis: Axis; at: number }>;

const ALONG: Readonly<Record<AlignEdge, Along>> = {
	left: { axis: 'x', at: 0 },
	centerX: { axis: 'x', at: 0.5 },
	right: { axis: 'x', at: 1 },
	top: { axis: 'y', at: 0 },
	centerY: { axis: 'y', at: 0.5 },
	bottom: { axis: 'y', at: 1 },
};

/** The box's near edge along `axis`: its left, or its top. */
const startOf = (box: Box, axis: Axis): number => (axis === 'x' ? box.x : box.y);

/** The box's size along `axis`: its width, or its height. */
const sizeOf = (box: Box, axis: Axis): number => (axis === 'x' ? box.width : box.height);

/** The box's far edge along `axis`: its right, or its bottom. */
const endOf = (box: Box, axis: Axis): number => startOf(box, axis) + sizeOf(box, axis);

/** The coordinate of the box's edge or center. */
const coordOf = (box: Box, { axis, at }: Along): number =>
	startOf(box, axis) + sizeOf(box, axis) * at;

/** A move of `by` along `axis`, and none across it. */
const offsetAlong = (axis: Axis, by: number): Offset => (axis === 'x' ? [by, 0] : [0, by]);

const STILL: Offset = [0, 0];

/** How few layers a distribution takes: three between the outermost, which stay, or two across a box. */
const fewest = (across: boolean): number => (across ? 2 : 3);

/**
 * Which arrangements apply to `count` layers, the ones the move tool moves
 * (`arrangedIds`), aligned to `alignTo`: an alignment to any one or more,
 * since one alone goes to the area or the canvas; a distribution to three or
 * more between the outermost of them, or to two or more across the canvas.
 */
export const arrangementsFor = (
	count: number,
	alignTo: AlignTo
): Readonly<{ align: boolean; distribute: boolean }> => ({
	align: count > 0,
	distribute: count >= fewest(alignTo === 'canvas'),
});

/**
 * The layers an arrangement moves, as the move tool's drag moves them: the
 * outermost of those chosen in the panel where there are several, in paint
 * order, bottom first, as `ToolContext.layers` has them, whatever order they
 * were chosen in; else the active layer alone; none with no layer.
 */
export const arrangedIds = (
	root: Element,
	chosen: readonly string[],
	active: string | undefined
): readonly string[] => {
	const outermost = outermostLayers(root, chosen);
	if (outermost.length > 1) return outermost;
	return active === undefined || layerById(root, active) === undefined ? [] : [active];
};

/** How far each box moves for its `edge` to meet `target`'s, along that edge's axis alone, in the order given. */
export const alignOffsets = (
	boxes: readonly Box[],
	target: Box,
	edge: AlignEdge
): readonly Offset[] => {
	const along = ALONG[edge];
	const goal = coordOf(target, along);
	return boxes.map((box) => offsetAlong(along.axis, goal - coordOf(box, along)));
};

const SPACINGS: Readonly<Record<'spaceX' | 'spaceY', Axis>> = { spaceX: 'x', spaceY: 'y' };

const isSpacing = (how: Distribution): how is keyof typeof SPACINGS =>
	how === 'spaceX' || how === 'spaceY';

/** The box's center along `axis`. */
const centerOf = (box: Box, axis: Axis): number => startOf(box, axis) + sizeOf(box, axis) / 2;

/** What a distribution orders the boxes by: the coordinate it names, or, for the spacing, the center. */
const keyOf = (how: Distribution): ((box: Box) => number) => {
	if (isSpacing(how)) return (box) => centerOf(box, SPACINGS[how]);
	const along = ALONG[how];
	return (box) => coordOf(box, along);
};

type Ranked = Readonly<{ box: Box; index: number }>;

/** The boxes in order of `key`, those level with each other in the order given. */
const rankedBy = (boxes: readonly Box[], key: (box: Box) => number): readonly Ranked[] =>
	boxes
		.map((box, index) => ({ box, index }))
		.sort((a, b) => key(a.box) - key(b.box) || a.index - b.index);

/** The boxes in order, and the first and the last of them. */
type Order = Readonly<{ ranked: readonly Ranked[]; first: Box; last: Box }>;

/** Where the box of a rank goes, as how far it moves along the distribution's axis. */
type Placing = (rank: number, box: Box) => number;

/**
 * Distributed by an edge or a center: the coordinate goes evenly from the
 * first's to the last's, which stay, or, `within` a box, from where the first
 * is flush with its near side to where the last is flush with its far side.
 */
const byEdge = ({ ranked, first, last }: Order, along: Along, within: Box | undefined): Placing => {
	const { axis, at } = along;
	const from =
		within === undefined
			? coordOf(first, along)
			: startOf(within, axis) + sizeOf(first, axis) * at;
	const to =
		within === undefined
			? coordOf(last, along)
			: endOf(within, axis) - sizeOf(last, axis) * (1 - at);
	const step = (to - from) / (ranked.length - 1);
	return (rank, box) => from + step * rank - coordOf(box, along);
};

const sum = (values: readonly number[]): number =>
	values.reduce((total, value) => total + value, 0);

/**
 * Distributed by the spacing: the same gap between each box and the next,
 * across the span from the first's near edge to the last's far edge, which
 * stay, or across `within`.
 */
const bySpacing = (
	{ ranked, first, last }: Order,
	axis: Axis,
	within: Box | undefined
): Placing => {
	const from = startOf(within ?? first, axis);
	const to = endOf(within ?? last, axis);
	const sizes = ranked.map(({ box }) => sizeOf(box, axis));
	const gap = (to - from - sum(sizes)) / (ranked.length - 1);
	// Each box's near edge: after every box before it, and a gap after each.
	return (rank, box) => from + sum(sizes.slice(0, rank)) + gap * rank - startOf(box, axis);
};

/**
 * How far each box moves to be distributed `how`, in the order given: the
 * outermost two stay and the rest go evenly between, or, `within` a box (the
 * canvas), the outermost go flush with its sides and the rest evenly between.
 * Too few boxes for it, and none moves.
 */
export const distributeOffsets = (
	boxes: readonly Box[],
	how: Distribution,
	within: Box | undefined
): readonly Offset[] => {
	const ranked = rankedBy(boxes, keyOf(how));
	const first = ranked[0]?.box;
	const last = ranked[ranked.length - 1]?.box;
	if (first === undefined || last === undefined || boxes.length < fewest(within !== undefined))
		return boxes.map(() => STILL);
	const order = { ranked, first, last };
	const axis = isSpacing(how) ? SPACINGS[how] : ALONG[how].axis;
	const placing = isSpacing(how)
		? bySpacing(order, axis, within)
		: byEdge(order, ALONG[how], within);
	const byIndex = new Map(ranked.map(({ box, index }, rank) => [index, placing(rank, box)]));
	return boxes.map((_, index) => offsetAlong(axis, byIndex.get(index) ?? 0));
};

/** One layer measured, by its id. */
type Measured = Readonly<{ id: string; box: Box }>;

/** Every layer of `ids` that paints something, measured, in the order given; one whose measure fails paints nothing. */
const measure = async (
	ids: readonly string[],
	extent: LayerExtent
): Promise<readonly Measured[]> => {
	const boxes = await Promise.all(ids.map((id) => extent(id).catch(() => undefined)));
	return ids.flatMap((id, index) => {
		const box = boxes[index];
		return box === undefined ? [] : [{ id, box }];
	});
};

/** The box around the area selected: the canvas for an inverted one; none with no area, or one with no inside. */
const areaBox = (context: ToolContext): Box | undefined => {
	const region = context.region.region;
	if (region === undefined) return undefined;
	return region.inverted ? canvasBox(context.document) : boundsOf(areaPolygons(region.path));
};

/** What the layers line up with: the canvas, or the selection (the area, else their box together, else the canvas). */
const alignTarget = (context: ToolContext, alignTo: AlignTo, boxes: readonly Box[]): Box => {
	const canvas = canvasBox(context.document);
	if (alignTo === 'canvas') return canvas;
	return areaBox(context) ?? (boxes.length > 1 ? unionBox(boxes) : undefined) ?? canvas;
};

const offsetsFor = (
	context: ToolContext,
	arrangement: Arrangement,
	alignTo: AlignTo,
	boxes: readonly Box[]
): readonly Offset[] =>
	arrangement.kind === 'align'
		? alignOffsets(boxes, alignTarget(context, alignTo, boxes), arrangement.edge)
		: distributeOffsets(
				boxes,
				arrangement.how,
				alignTo === 'canvas' ? canvasBox(context.document) : undefined
			);

/**
 * The arrangement done to the layers the move tool moves (`movedIds`, from
 * the context's), each measured by `extent` and moved by its own
 * `transform`, by one command; refused whole, and said why, where a layer may
 * not move, as the move tool's drag is. Resolves to whether anything moved.
 */
export const arrangeLayers = async (
	context: ToolContext,
	arrangement: Arrangement,
	alignTo: AlignTo,
	extent: LayerExtent
): Promise<boolean> => {
	const ids = movedIds(context);
	if (ids.length === 0) {
		context.notify(t('layers.noneActive'));
		return false;
	}
	if (draggingLayers() || !mayMove(context, ids)) return false;
	const version = context.document.snapshot().version;
	const measured = await measure(ids, extent);
	if (context.document.snapshot().version !== version || draggingLayers()) return false;
	if (measured.length === 0) {
		context.notify(t('tools.align.nothing'));
		return false;
	}
	const offsets = offsetsFor(
		context,
		arrangement,
		alignTo,
		measured.map(({ box }) => box)
	);
	return moveLayersBy(
		context,
		measured.map(({ id }, index) => {
			const [dx, dy] = offsets[index] ?? STILL;
			return { id, dx, dy };
		}),
		arrangement.kind === 'align' ? 'tools.align.aligned' : 'tools.align.distributed'
	);
};
