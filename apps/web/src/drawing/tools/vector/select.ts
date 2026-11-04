import { cell } from '@skysa/draw-core';

import { editLayer } from '../../document/commands.js';
import type { Handover, PointerSample, ToolBehavior, ToolContext, ToolId } from '../types.js';
import { isDoublePress, near, type Press, pressOf } from './doublePress.js';
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
import { hasNodes, pointsElementAt } from './node.js';
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
 * resizes about the opposite side or rotates about the center; a drag from
 * nothing is a marquee that selects what it crosses. While the drag lasts the
 * elements carry the live transform so the user sees it; at the end the
 * originals are put back and one command sets the final ones, so the layer is
 * as the command's snapshot expects it (docs/ARCHITECTURE.md §7, "Commands and
 * history"). Shift adds to a selection, keeps a resize to the ratio and snaps
 * a rotation to 15°.
 *
 * A double press edits what it is on, in the tool that edits it, as a
 * double-click does in Illustrator, Figma and Inkscape (`doublePress.ts`): a
 * text in the text tool, its caret at the press; a path or a shape in the
 * node tool, its anchors shown; a group in the layer goes in, to the path
 * under the press. The first press selects as any press; the second starts
 * no drag, and as the pointer lifts the other tool is put in hand
 * (`ToolContext.useTool`), so a second finger that turns it into a pinch
 * changes nothing.
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
	| (Transforming & Readonly<{ kind: 'rotate'; center: Point }>);

type TransformDrag = Exclude<Drag, { kind: 'marquee' }>;

/** What a double press hands over as the pointer lifts: the tool, and what it is to edit. */
type Handing = Readonly<{ id: ToolId; handover: Handover }>;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/**
 * The element of `layer` a press at `point`, in the drawing's units, is on:
 * the topmost whose box, grown by `HIT_SLOP_PX` on the screen, holds it. The
 * select tool's own hit, which its Auto-Select reads too, so a press that
 * picks a layer by an element is on that element (`tools/common/autoSelect.ts`).
 * `scale` is screen pixels per user unit.
 */
export const elementAt = (
	measure: Measure,
	layer: Element,
	point: Point,
	scale: number
): Element | undefined =>
	topmostAt(
		elementsOf(layer),
		apply(layerSpace(layer).into, point),
		measure,
		HIT_SLOP_PX / scale
	);

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
	drag: Transforming & Readonly<{ center: Point }>,
	to: Point,
	snap: boolean
): Mat => {
	const start = Math.atan2(drag.from.y - drag.center.y, drag.from.x - drag.center.x);
	const now = Math.atan2(to.y - drag.center.y, to.x - drag.center.x);
	const degrees = ((now - start) * 180) / Math.PI;
	return rotate(snap ? Math.round(degrees / ROTATE_STEP) * ROTATE_STEP : degrees, drag.center);
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

/** The box around `elements` in the drawing's units, as the overlay shows it; none for none. */
const selectionBox = (
	measure: Measure,
	elements: readonly Element[],
	space: LayerSpace
): Box | undefined => {
	const box = unionBox(elements.map((element) => placedBox(measure, element)));
	return box === undefined ? undefined : transformBox(space.outOf, box);
};

/**
 * Whether a press at `point`, in the drawing's units, is on a handle of the
 * box around what is selected on the active layer, where it resizes or rotates
 * that, whatever is under it: Auto-Select picks no layer there
 * (`tools/common/autoSelect.ts`), as Photoshop's transform controls take the
 * press before it.
 */
export const onSelectionHandle = (
	measure: Measure,
	context: ToolContext,
	point: Point
): boolean => {
	const layer = activeLayerElement(context);
	if (layer === undefined) return false;
	const box = selectionBox(measure, selectedOn(layer, context), layerSpace(layer));
	return box !== undefined && handleAt(box, point, context.viewport.scale) !== undefined;
};

/**
 * What a double press on `hit` hands to another tool: a text to the text
 * tool, a path or a shape to the node tool, and for a group in the layer the
 * path or shape in it under the press, which is going into the group; nothing
 * for anything else, which a double press only selects.
 */
const handingOf = (
	context: ToolContext,
	layer: Element,
	hit: Element,
	at: Point
): Handing | undefined => {
	if (hit.localName === 'text') return { id: 'text', handover: { element: hit, at } };
	const element =
		hit.localName === 'g' && hit !== layer ? pointsElementAt(context, layer, at, hit) : hit;
	return element !== undefined && hasNodes(element)
		? { id: 'node', handover: { element, at } }
		: undefined;
};

/**
 * An element's own `transform` once `delta`, in the drawing's units, has moved
 * it where `space` places it: into the layer, after the delta, after where the
 * element was in the drawing.
 */
const movedBy = (delta: Mat, space: LayerSpace, matrix: Mat): string =>
	formatTransform(multiply(space.into, multiply(delta, multiply(space.outOf, matrix))));

export const createSelect = (measure: Measure): ToolBehavior => {
	const drag = cell<Drag | undefined>(undefined);
	/** The last press on an element, which the next may make a double press of. */
	const lastPress = cell<Press | undefined>(undefined);
	/** A double press, to hand over as the pointer lifts. */
	const handing = cell<Handing | undefined>(undefined);

	const boxOf = (elements: readonly Element[], space: LayerSpace): Box | undefined =>
		selectionBox(measure, elements, space);

	/** The box around `elements`, drawn over the active layer. */
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
						center: { x: box.x + box.width / 2, y: box.y + box.height / 2 },
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

	/**
	 * Whether this press, on `hit`, makes a double press with the last one,
	 * and there is a tool to hand `hit` to: then it is kept for the lift, and
	 * a third press starts afresh. Shift adds to the selection, and is never
	 * a double press.
	 */
	const doublePressed = (
		context: ToolContext,
		sample: PointerSample,
		layer: Element,
		hit: Element | undefined
	): boolean => {
		const press = hit === undefined ? undefined : pressOf(hit, sample);
		const first = lastPress.current;
		lastPress.current = press;
		if (press === undefined || sample.shiftKey || context.useTool === undefined) return false;
		if (!isDoublePress(first, press, context.viewport.scale)) return false;
		const next = handingOf(context, layer, press.element, press.at);
		if (next === undefined) return false;
		lastPress.current = undefined;
		handing.current = next;
		return true;
	};

	/** The drag abandoned: its preview gone, and what it moved put back as it was. */
	const abandon = (context: ToolContext): void => {
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
			abandon(context);
			handing.current = undefined;
			if (guardLayer(context) === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const space = layerSpace(layer);
			const point = pointOf(sample);
			const hit = elementAt(measure, layer, point, context.viewport.scale);
			if (doublePressed(context, sample, layer, hit)) return;
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
			const handed = handing.current;
			handing.current = undefined;
			if (handed !== undefined) {
				context.useTool?.(handed.id, handed.handover);
				return;
			}
			// A press that dragged is not the first of a double press.
			const first = lastPress.current;
			if (first !== undefined && !near(first, pointOf(sample), context.viewport.scale)) {
				lastPress.current = undefined;
			}
			const current = drag.current;
			if (current === undefined) return;
			drag.current = undefined;
			if (current.kind === 'marquee') {
				endMarquee(context, sample, current);
				return;
			}
			endTransform(context, sample, current);
		},

		cancel: (context) => {
			handing.current = undefined;
			lastPress.current = undefined;
			abandon(context);
		},

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
