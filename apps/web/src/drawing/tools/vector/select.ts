import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehaviour, ToolContext } from '../types.js';
import {
	apply,
	type Box,
	formatTransform,
	type Mat,
	multiply,
	parseTransform,
	type Point,
	rectFrom,
	rotate,
	scale,
	transformBox,
	translate,
	unionBox,
} from './geometry.js';
import {
	activeLayerElement,
	guardLayer,
	type LayerSpace,
	layerSpace,
	targetLayer,
} from './guard.js';
import {
	elementsAtPositions,
	elementsIn,
	elementsOf,
	placedBox,
	positionsIn,
	topmostAt,
} from './hit.js';
import type { Measure } from './measure.js';
import {
	anchorOf,
	axesOf,
	clearSelectionBox,
	drawSelectionBox,
	type Handle,
	handleAt,
	hasSelectionBox,
} from './selection.js';
import { CHROME_STYLE, createSvg, setAttributes } from './svg.js';

/**
 * The select tool on a vector layer (docs/decisions/0004-the-interface.md):
 * pick, move, resize and rotate elements, each as a `transform`. A drag of a
 * selected element moves it; a drag of a handle of the selection's box
 * resizes about the opposite side or rotates about the centre; a drag from
 * nothing is a marquee that selects what it crosses. While the drag lasts the
 * elements carry the live transform so the user sees it; at the end the
 * originals are put back and one command sets the final ones, so the layer is
 * as the command's snapshot expects it (docs/ARCHITECTURE.md §7, "Commands and
 * history"). Shift adds to a selection, keeps a resize to the ratio and snaps
 * a rotation to 15°.
 */

/** How near a click may be to an element's box and still hit it, in CSS pixels. */
const HIT_SLOP_PX = 4;

/** A rotation with Shift snaps to this many degrees. */
const ROTATE_STEP = 15;

/** A resize is never made smaller than this fraction, which would flatten the element. */
const LEAST_SCALE = 0.01;

/** One selected element: where it is among the layer's elements, and its `transform` before the drag. */
type Item = Readonly<{ element: Element; position: number; attribute: string | null; matrix: Mat }>;

/** A drag that changes `transform`s: where it began, in the drawing's units, and what it changes. */
type Transforming = Readonly<{ from: Point; items: readonly Item[]; space: LayerSpace }>;

type Drag =
	| Readonly<{ kind: 'marquee'; from: Point; preview: SVGElement }>
	| (Transforming & Readonly<{ kind: 'move' }>)
	| (Transforming & Readonly<{ kind: 'resize'; handle: Handle; anchor: Point }>)
	| (Transforming & Readonly<{ kind: 'rotate'; centre: Point }>);

type TransformDrag = Exclude<Drag, { kind: 'marquee' }>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

const itemsOf = (layer: Element, elements: readonly Element[]): readonly Item[] => {
	const own = elementsOf(layer);
	return elements.map((element) => {
		const attribute = element.getAttribute('transform');
		return {
			element,
			position: own.indexOf(element),
			attribute,
			matrix: parseTransform(attribute),
		};
	});
};

const setTransform = (element: Element, value: string): void => {
	if (value === '') {
		element.removeAttribute('transform');
		return;
	}
	element.setAttribute('transform', value);
};

const restore = (item: Item): void => setTransform(item.element, item.attribute ?? '');

/**
 * What is selected on the active layer. A selection made on another layer, or
 * one an undo left behind, is not this layer's to change: a command of this
 * layer's that touched it could not undo it.
 */
const selectedOn = (layer: Element, context: ToolContext): readonly Element[] => {
	const own = elementsOf(layer);
	return context.selection.elements.filter((element) => own.includes(element));
};

/** A factor kept away from zero, with its sign. */
const safeScale = (factor: number): number =>
	Math.abs(factor) < LEAST_SCALE ? (factor < 0 ? -LEAST_SCALE : LEAST_SCALE) : factor;

/** The factor a drag from `from` to `to` scales by about `anchor`, along one axis. */
const factorOf = (from: number, to: number, anchor: number): number =>
	Math.abs(from - anchor) < 1e-9 ? 1 : safeScale((to - anchor) / (from - anchor));

const resizeMatrix = (
	drag: Transforming & Readonly<{ handle: Handle; anchor: Point }>,
	to: Point,
	keepRatio: boolean
): Mat => {
	const axes = axesOf(drag.handle);
	const sx = axes.x ? factorOf(drag.from.x, to.x, drag.anchor.x) : 1;
	const sy = axes.y ? factorOf(drag.from.y, to.y, drag.anchor.y) : 1;
	if (!keepRatio) return scale(sx, sy, drag.anchor);
	// The ratio kept: both sides by the factor the drag changed more, or the one axis it has.
	const uniform = !axes.y || (axes.x && Math.abs(sx - 1) >= Math.abs(sy - 1)) ? sx : sy;
	return scale(uniform, uniform, drag.anchor);
};

const rotateMatrix = (
	drag: Transforming & Readonly<{ centre: Point }>,
	to: Point,
	snap: boolean
): Mat => {
	const start = Math.atan2(drag.from.y - drag.centre.y, drag.from.x - drag.centre.x);
	const now = Math.atan2(to.y - drag.centre.y, to.x - drag.centre.x);
	const degrees = ((now - start) * 180) / Math.PI;
	return rotate(snap ? Math.round(degrees / ROTATE_STEP) * ROTATE_STEP : degrees, drag.centre);
};

/**
 * What the drag does so far, in the drawing's units, where the box and its
 * handles are drawn, so a resize follows the box the user sees.
 */
const deltaOf = (drag: TransformDrag, sample: PointerSample): Mat => {
	const to = pointOf(sample);
	if (drag.kind === 'resize') return resizeMatrix(drag, to, sample.shiftKey);
	if (drag.kind === 'rotate') return rotateMatrix(drag, to, sample.shiftKey);
	return translate(to.x - drag.from.x, to.y - drag.from.y);
};

/**
 * An element's own `transform` once `delta`, in the drawing's units, has moved
 * it where `space` places it: into the layer, after the delta, after where the
 * element was in the drawing.
 */
const movedBy = (delta: Mat, space: LayerSpace, matrix: Mat): string =>
	formatTransform(multiply(space.into, multiply(delta, multiply(space.outOf, matrix))));

export const createSelect = (measure: Measure): ToolBehaviour => {
	const drag = cell<Drag | undefined>(undefined);

	/** The box round `elements` in the drawing's units, as the overlay shows it; none for none. */
	const boxOf = (elements: readonly Element[], space: LayerSpace): Box | undefined => {
		const box = unionBox(elements.map((element) => placedBox(measure, element)));
		return box === undefined ? undefined : transformBox(space.outOf, box);
	};

	/** The box round `elements`, drawn over the active layer. */
	const redraw = (context: ToolContext, elements: readonly Element[]): void => {
		drawSelectionBox(
			context.overlay,
			boxOf(elements, layerSpace(activeLayerElement(context))),
			context.viewport.scale
		);
	};

	const beginMarquee = (context: ToolContext, sample: PointerSample): void => {
		const from = pointOf(sample);
		const preview = createSvg(context.overlay.ownerDocument, 'rect', {
			x: from.x,
			y: from.y,
			width: 0,
			height: 0,
			style: CHROME_STYLE,
			'fill-opacity': 0.1,
			'stroke-dasharray': '4 4',
			'vector-effect': 'non-scaling-stroke',
			'pointer-events': 'none',
		});
		context.overlay.appendChild(preview);
		drag.current = { kind: 'marquee', from, preview };
	};

	const beginHandle = (
		context: ToolContext,
		handle: Handle,
		box: Box,
		common: Transforming
	): void => {
		drag.current =
			handle === 'rotate'
				? {
						...common,
						kind: 'rotate',
						centre: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
					}
				: {
						...common,
						kind: 'resize',
						handle,
						anchor: anchorOf(box, handle, context.viewport.scale),
					};
	};

	const beginOnElement = (
		context: ToolContext,
		sample: PointerSample,
		hit: Element,
		selected: readonly Element[],
		layer: Element
	): void => {
		if (sample.shiftKey) {
			const next = selected.includes(hit)
				? selected.filter((element) => element !== hit)
				: [...selected, hit];
			context.selection.set(next);
			redraw(context, next);
			return;
		}
		const chosen = selected.includes(hit) ? selected : [hit];
		context.selection.set(chosen);
		drag.current = {
			kind: 'move',
			from: pointOf(sample),
			items: itemsOf(layer, chosen),
			space: layerSpace(layer),
		};
		redraw(context, chosen);
	};

	const endMarquee = (
		context: ToolContext,
		sample: PointerSample,
		current: Extract<Drag, { kind: 'marquee' }>
	): void => {
		current.preview.remove();
		const layer = activeLayerElement(context);
		if (layer === undefined) return;
		const region = transformBox(
			layerSpace(layer).into,
			rectFrom(current.from, pointOf(sample))
		);
		const found = elementsIn(elementsOf(layer), region, measure);
		const next = sample.shiftKey
			? [...new Set([...selectedOn(layer, context), ...found])]
			: found;
		context.selection.set(next);
		redraw(context, next);
	};

	const endTransform = (
		context: ToolContext,
		sample: PointerSample,
		current: TransformDrag
	): void => {
		const delta = deltaOf(current, sample);
		const elements = current.items.map((item) => item.element);
		// The layer goes back to how it was before the drag, so the command's
		// snapshot of it is the state before the change.
		current.items.forEach(restore);
		const moved = current.items.some(
			(item) => movedBy(delta, current.space, item.matrix) !== formatTransform(item.matrix)
		);
		const layer = moved ? targetLayer(context) : undefined;
		if (layer === undefined) {
			redraw(context, elements);
			return;
		}
		// Found again, and their space read again, after the wrapping of a loose
		// layer, which may have moved them and their `transform`.
		const space = layerSpace(layer);
		const finals = current.items.flatMap(({ position }) =>
			elementsAtPositions(layer, [position]).map((element) => ({
				position,
				value: movedBy(delta, space, parseTransform(element.getAttribute('transform'))),
			}))
		);
		context.document.execute(
			editLayer(layer.id, 'tools.select', (g: Element) => {
				finals.forEach(({ position, value }) =>
					elementsAtPositions(g, [position]).forEach((element) =>
						setTransform(element, value)
					)
				);
			})
		);
		const now = elementsAtPositions(
			context.document.layer(layer.id),
			finals.map(({ position }) => position)
		);
		context.selection.set(now);
		redraw(context, now);
	};

	/** The drag abandoned: its preview gone, and what it moved put back as it was. */
	const cancel = (context: ToolContext): void => {
		const current = drag.current;
		drag.current = undefined;
		if (current === undefined) return;
		if (current.kind === 'marquee') {
			current.preview.remove();
			return;
		}
		current.items.forEach(restore);
		redraw(
			context,
			current.items.map((item) => item.element)
		);
	};

	return {
		begin: (context, sample) => {
			cancel(context);
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const space = layerSpace(layer);
			const point = pointOf(sample);
			const selected = selectedOn(layer, context);
			const box = boxOf(selected, space);
			const handle =
				box === undefined ? undefined : handleAt(box, point, context.viewport.scale);
			if (handle !== undefined && box !== undefined) {
				beginHandle(context, handle, box, {
					from: point,
					items: itemsOf(layer, selected),
					space,
				});
				return;
			}
			const hit = topmostAt(
				elementsOf(layer),
				apply(space.into, point),
				measure,
				HIT_SLOP_PX / context.viewport.scale
			);
			if (hit !== undefined) {
				beginOnElement(context, sample, hit, selected, layer);
				return;
			}
			if (!sample.shiftKey) {
				context.selection.clear();
				redraw(context, []);
			}
			beginMarquee(context, sample);
		},

		move: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			if (current.kind === 'marquee') {
				setAttributes(current.preview, rectFrom(current.from, pointOf(sample)));
				return;
			}
			const delta = deltaOf(current, sample);
			current.items.forEach((item) =>
				setTransform(item.element, movedBy(delta, current.space, item.matrix))
			);
			redraw(
				context,
				current.items.map((item) => item.element)
			);
		},

		end: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			drag.current = undefined;
			if (current.kind === 'marquee') {
				endMarquee(context, sample, current);
				return;
			}
			endTransform(context, sample, current);
		},

		cancel,

		// The viewport empties the overlay when the tool changes; the box comes
		// back with the first movement over the canvas.
		hover: (context) => {
			if (context.selection.elements.length === 0 || hasSelectionBox(context.overlay)) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			redraw(context, selectedOn(layer, context));
		},
	};
};

/**
 * What Delete does with a selection, for the frame to call
 * (docs/decisions/0004-the-interface.md): the selected elements of the active
 * layer removed by one command, and the selection and its box gone with them.
 * A locked or a hidden layer says so and keeps them.
 */
export const deleteSelection = (context: ToolContext): void => {
	if (context.selection.elements.length === 0) return;
	if (guardLayer(context) === undefined) return;
	const layer = activeLayerElement(context);
	if (layer === undefined) return;
	const positions = positionsIn(layer, context.selection.elements);
	if (positions.length === 0) return;
	const target = targetLayer(context);
	if (target === undefined) return;
	context.document.execute(
		editLayer(target.id, 'tools.select', (g: Element) => {
			elementsAtPositions(g, positions).forEach((element) => element.remove());
		})
	);
	context.selection.clear();
	clearSelectionBox(context.overlay);
};
