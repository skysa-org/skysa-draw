import { cell } from '@skysa/storage';

import { editLayer } from '../../document/commands.js';
import { setTransform, transformElements } from '../../document/elements.js';
import { layerExtentIn } from '../../viewport/layerExtent.js';
import type { Offset } from '../common/align.js';
import { createDragSnap, type ExtentOf, raiseGuides } from '../common/snap.js';
import type { Handover, PointerSample, ToolBehavior, ToolContext, ToolId } from '../types.js';
import { isDoublePress, near, type Press, pressOf } from './doublePress.js';
import {
	type Box,
	formatTransform,
	type Mat,
	multiply,
	parseTransform,
	type Point,
	rectFrom,
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
	clearSelectionBox,
	drawSelectionBox,
	type Handle,
	handleAt,
	hasSelectionBox,
	hiddenAsSeen,
	resizeMatrix,
	rotateMatrix,
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
 * history"); that command touches their `transform`s alone, on the same
 * nodes through an undo and a redo, so they stay selected
 * (`transformElements`, `document/elements.ts`). Shift adds to a selection, keeps a resize to the ratio and snaps
 * a rotation to 15°. A move snaps the box of what is selected to the canvas,
 * to the other layers and to the layer's other elements (`snap.ts`).
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
	topmostAt(elementsOf(layer), point, measure, HIT_SLOP_PX / scale, layerSpace(layer).outOf);

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

const restore = (item: Item): void => setTransform(item.element, item.attribute ?? '');

/** Whether the active layer is out of sight, where no box is drawn and no handle is pressed (`hiddenAsSeen`). */
const activeHidden = (context: ToolContext): boolean =>
	hiddenAsSeen(context.document.snapshot().layers, context.layer?.id);

/**
 * What is selected on the active layer. A selection made on another layer, or
 * one an undo left behind, is not this layer's to change: a command of this
 * layer's that touched it could not undo it.
 */
const selectedOn = (layer: Element, context: ToolContext): readonly Element[] => {
	const own = elementsOf(layer);
	return context.selection.elements.filter((element) => own.includes(element));
};

/**
 * What the drag does so far, in the drawing's units, where the box and its
 * handles are drawn, so a resize follows the box the user sees
 * (`resizeMatrix`, `rotateMatrix`, which Transform selection drags by too).
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
): Box | undefined => unionBox(elements.map((element) => placedBox(measure, element, space.outOf)));

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
	if (layer === undefined || activeHidden(context)) return false;
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
 * The boxes, in the drawing's units, of the elements of `layer` other than
 * `elements`, as the select tool measures them: what else is on the layer,
 * which a move of those snaps to. One with no size at all, which is not drawn
 * yet, is left out.
 */
const besideBoxes = (
	measure: Measure,
	layer: Element,
	elements: readonly Element[],
	space: LayerSpace
): readonly Box[] =>
	elementsOf(layer)
		.filter((element) => !elements.includes(element))
		.map((element) => placedBox(measure, element, space.outOf))
		.filter((box) => box.width > 0 || box.height > 0);

/**
 * An element's own `transform` once `delta`, in the drawing's units, has moved
 * it where `space` places it: into the layer, after the delta, after where the
 * element was in the drawing.
 */
export const movedBy = (delta: Mat, space: LayerSpace, matrix: Mat): string =>
	formatTransform(multiply(space.into, multiply(delta, multiply(space.outOf, matrix))));

/**
 * The select tool, measuring elements by `measure` and, for a move's
 * snapping, the other layers by `extentOf`, by the same `measure` where none
 * is given.
 */
export const createSelect = (
	measure: Measure,
	extentOf: ExtentOf = (document) => layerExtentIn(document, { measure })
): ToolBehavior => {
	const drag = cell<Drag | undefined>(undefined);
	const snap = createDragSnap(extentOf);
	/** The last press on an element, which the next may make a double press of. */
	const lastPress = cell<Press | undefined>(undefined);
	/** A double press, to hand over as the pointer lifts. */
	const handing = cell<Handing | undefined>(undefined);

	const boxOf = (elements: readonly Element[], space: LayerSpace): Box | undefined =>
		selectionBox(measure, elements, space);

	/**
	 * What the drag does so far, in the drawing's units: a move snapped where
	 * it may be, for its `last` step with the guides gone; a resize or a turn
	 * as the handle has it.
	 */
	const dragDelta = (
		context: ToolContext,
		sample: PointerSample,
		current: TransformDrag,
		last: boolean
	): Mat => {
		if (current.kind !== 'move') return deltaOf(current, sample);
		const proposed: Offset = [sample.x - current.from.x, sample.y - current.from.y];
		const [dx, dy] = last
			? snap.end(context, sample, proposed)
			: snap.move(context, sample, proposed);
		return translate(dx, dy);
	};

	/** The box around `elements`, drawn over the active layer; none while it is out of sight. */
	const redraw = (context: ToolContext, elements: readonly Element[]): void => {
		drawSelectionBox(
			context.overlay,
			activeHidden(context)
				? undefined
				: boxOf(elements, layerSpace(activeLayerElement(context))),
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
		const space = layerSpace(layer);
		context.selection.set(chosen);
		drag.current = {
			kind: 'move',
			from: pointOf(sample),
			items: itemsOf(layer, chosen),
			space,
		};
		snap.beginBox(
			context,
			boxOf(chosen, space),
			layer.id,
			besideBoxes(measure, layer, chosen, space)
		);
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
		const found = elementsIn(
			elementsOf(layer),
			rectFrom(current.from, pointOf(sample)),
			measure,
			layerSpace(layer).outOf
		);
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
		const delta = dragDelta(context, sample, current, true);
		const elements = current.items.map((item) => item.element);
		// The elements go back to how they were before the drag, so what the
		// command keeps for its undo is the state before the change.
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
		context.document.execute(transformElements(layer.id, 'tools.select', finals));
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
		snap.cancel(context);
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
			const delta = dragDelta(context, sample, current, false);
			current.items.forEach((item) =>
				setTransform(item.element, movedBy(delta, current.space, item.matrix))
			);
			redraw(
				context,
				current.items.map((item) => item.element)
			);
			raiseGuides(context.overlay);
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

		// The viewport empties the overlay when the tool changes, and takes the
		// box away while the layer is hidden; it comes back with the first
		// movement over the canvas, once the layer is in sight.
		hover: (context) => {
			if (context.selection.elements.length === 0 || hasSelectionBox(context.overlay)) return;
			if (activeHidden(context)) return;
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
