import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import { editLayer } from '../../document/commands.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import {
	boxContains,
	constrainLine,
	distance,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
	type Point,
} from './geometry.js';
import { activeLayerElement, guardLayer, layerSpace, targetLayer } from './guard.js';
import { paintedColor } from './hit.js';
import {
	insertPoint,
	isSmooth,
	moveAnchors,
	moveHandle,
	pullHandles,
	removeAnchor,
} from './path/edit.js';
import { formatPath } from './path/format.js';
import {
	handlePoint,
	insideFill,
	nearestAnchor,
	nearestHandle,
	nearestOnPath,
	shownHandles,
} from './path/hit.js';
import { anchorMark, handleMarks, outlineMark, REACH_PX, SEGMENT_REACH_PX } from './path/marks.js';
import {
	anchorAt,
	type AnchorRef,
	boundsOf,
	type HandleRef,
	mapPath,
	type PathData,
	sameRef,
} from './path/model.js';
import { GEOMETRY, hasPoints, pathDataOf } from './path/shapes.js';
import { createSvg } from './svg.js';

/**
 * The node tool on a vector layer (docs/decisions/0004-the-interface.md):
 * a path's points and handles, moved, as Illustrator's direct selection and
 * Figma's vector edit do it. A click on a path, or on a shape, which becomes a
 * `<path>` on its first edit, shows its anchors; a drag of an anchor moves it
 * and its handles, Shift-click chooses several to drag together, and the
 * handles of the chosen anchors show and reshape the curve, the opposite
 * handle of a smooth point turning with the one dragged unless Alt is held. A
 * click on a segment puts a point in there, and a drag from it moves it at
 * once; Alt-click on an anchor takes it out, and Alt-drag from one pulls
 * handles out of it. A click on nothing lets go. A double press on a path or
 * a shape under the select tool brings it here with its anchors shown
 * (`edit`), as a double-click does in Illustrator, Figma and Inkscape.
 *
 * While a drag lasts the element shows it, a shape by the path it will
 * become standing in its place; at the end the element is put back as it was
 * and one command makes the change, so the layer is as the command's
 * snapshot expects it (docs/ARCHITECTURE.md §7, "Commands and history").
 * Everything is worked out in the drawing's units, where the pointer and the
 * overlay are, and taken back into the element's own when it is written, so
 * a path in a moved layer or a turned group is edited where it is seen.
 */

/** A press that moves less than this, in CSS pixels, is a click. */
const DRAG_PX = 3;

/** The attribute that marks the node tool's marks on the overlay. */
const MARK = 'data-draw-nodes';

/** The path being edited: its layer, its live element and where that sits under the layer, and the chosen anchors. */
type Chosen = Readonly<{
	layerId: string;
	element: Element;
	address: readonly number[];
	anchors: readonly AnchorRef[];
}>;

/** An element with points, as it is now: its points in the drawing's units, and the matrix that put them there. */
type Target = Readonly<{
	layer: Element;
	element: Element;
	address: readonly number[];
	space: Mat;
	data: PathData;
}>;

type Base = Target &
	Readonly<{
		from: Point;
		/** A path's `d` before the drag, to put back; a shape has none. */
		original: string | null;
		/** The points the drag starts from: as they were, or with the point a press put in. */
		start: PathData;
		moved: boolean;
		/** The path a shape will become, in its place while it is dragged. */
		standIn: Element | undefined;
	}>;

type Drag =
	| (Base & Readonly<{ kind: 'anchors'; refs: readonly AnchorRef[]; inserted: boolean }>)
	| (Base & Readonly<{ kind: 'handle'; handle: HandleRef; smooth: boolean }>)
	| (Base & Readonly<{ kind: 'alt'; ref: AnchorRef }>);

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The elements under a layer that have points, in paint order: into plain groups, never into what only defines things. */
const editableIn = (element: Element): readonly Element[] => {
	if (element.namespaceURI !== SVG_NAMESPACE) return [];
	if (element.localName === 'g') return [...element.children].flatMap(editableIn);
	return hasPoints(element.localName) ? [element] : [];
};

/** Where an element sits under the layer, by its place among its parent's children at each level. */
const addressOf = (layer: Element, element: Element): readonly number[] => {
	const parent = element.parentElement;
	if (element === layer || parent === null) return [];
	return [...addressOf(layer, parent), [...parent.children].indexOf(element)];
};

const elementAt = (layer: Element, address: readonly number[]): Element | undefined =>
	address.reduce<Element | undefined>((element, index) => element?.children[index], layer);

/**
 * Where an element's points are drawn: in the layer's space (`layerSpace`),
 * then by each group's `transform` below the layer, then by its own.
 */
const placementIn = (layer: Element, element: Element): Mat => {
	const container = layer.localName === 'g' ? layer : layer.parentElement;
	const below = (each: Element | null): Mat =>
		each === null || each === container
			? IDENTITY
			: multiply(below(each.parentElement), parseTransform(each.getAttribute('transform')));
	return multiply(layerSpace(layer).outOf, below(element));
};

const targetOf = (layer: Element, element: Element): Target | undefined => {
	const own = pathDataOf(element);
	if (own === undefined) return undefined;
	const space = placementIn(layer, element);
	return { layer, element, address: addressOf(layer, element), space, data: mapPath(space, own) };
};

/**
 * A shape as the `<path>` it draws: every attribute but its geometry kept,
 * its id among them and in their order, with `d` where the geometry began.
 */
const asPath = (shape: Element, d: string): Element => {
	const path = shape.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
	const geometry = GEOMETRY[shape.localName] ?? [];
	const isGeometry = (attribute: Attr): boolean =>
		attribute.namespaceURI === null && geometry.includes(attribute.localName);
	const attributes = [...shape.attributes];
	const at = attributes.findIndex(isGeometry);
	attributes.forEach((attribute, i) => {
		if (i === at) path.setAttribute('d', d);
		if (!isGeometry(attribute)) {
			path.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
		}
	});
	if (at < 0) path.setAttribute('d', d);
	return path;
};

const isFilled = (element: Element, layer: Element): boolean => {
	const fill = paintedColor(element, 'fill', layer, '#000000').toLowerCase();
	return fill !== 'none' && fill !== 'transparent';
};

/**
 * The topmost element with points under `p`, of those in `within`: one whose
 * outline passes within reach first, so a thin line over a filled shape can
 * be picked, then one whose fill holds it. By the shapes themselves rather
 * than their boxes, so paths that overlap are told apart.
 */
const elementUnder = (
	context: ToolContext,
	layer: Element,
	p: Point,
	within: Element = layer
): Target | undefined => {
	const reach = SEGMENT_REACH_PX / context.viewport.scale;
	const near = editableIn(within)
		.flatMap((element) => targetOf(layer, element) ?? [])
		.filter((target) => {
			const box = boundsOf(target.data);
			return box !== undefined && boxContains(box, p, reach);
		});
	return (
		near.filter((target) => nearestOnPath(target.data, p, reach) !== undefined).at(-1) ??
		near
			.filter((target) => isFilled(target.element, layer) && insideFill(target.data, p))
			.at(-1)
	);
};

/**
 * The element with points the node tool would take up at `p`, in the drawing's
 * units, of those inside `within` (a group in the layer): for the select
 * tool's double press on a group, which goes into it.
 */
export const pointsElementAt = (
	context: ToolContext,
	layer: Element,
	p: Point,
	within: Element
): Element | undefined => elementUnder(context, layer, p, within)?.element;

/** Whether the node tool edits an element of this name: a path, or a shape it makes one of. */
export const hasNodes = (element: Element): boolean =>
	element.namespaceURI === SVG_NAMESPACE && hasPoints(element.localName);

const validAnchors = (anchors: readonly AnchorRef[], data: PathData): readonly AnchorRef[] =>
	anchors.filter((ref) => anchorAt(data, ref) !== undefined);

/** The drag's points written in the element's own units. */
const textOf = (drag: Drag, data: PathData): string =>
	formatPath(mapPath(invert(drag.space), data));

/** A handle's drag: the handle follows the pointer from where it was taken, Shift holding it to 45° about its anchor. */
const handleDragged = (
	drag: Extract<Drag, { kind: 'handle' }>,
	sample: PointerSample
): PathData => {
	const anchor = anchorAt(drag.start, drag.handle);
	const grabbed = handlePoint(drag.start, drag.handle);
	if (anchor === undefined || grabbed === undefined) return drag.start;
	const to = {
		x: grabbed.x + sample.x - drag.from.x,
		y: grabbed.y + sample.y - drag.from.y,
	};
	return moveHandle(
		drag.start,
		drag.handle,
		constrainLine(anchor.point, to, sample.shiftKey),
		drag.smooth && !sample.altKey
	);
};

/** The points the drag has made: from where the pointer is, or for a press that did not move, what a click does. */
const pointsAfter = (drag: Drag, sample: PointerSample): PathData => {
	if (drag.kind === 'handle') return drag.moved ? handleDragged(drag, sample) : drag.start;
	if (drag.kind === 'alt') {
		const anchor = anchorAt(drag.start, drag.ref);
		if (!drag.moved || anchor === undefined) return removeAnchor(drag.start, drag.ref);
		return pullHandles(
			drag.start,
			drag.ref,
			constrainLine(anchor.point, pointOf(sample), sample.shiftKey)
		);
	}
	if (!drag.moved) return drag.start;
	const to = constrainLine(drag.from, pointOf(sample), sample.shiftKey);
	return moveAnchors(drag.start, drag.refs, { x: to.x - drag.from.x, y: to.y - drag.from.y });
};

/** The anchors chosen once the drag is done. */
const anchorsAfter = (drag: Drag): readonly AnchorRef[] => {
	if (drag.kind === 'anchors') return drag.refs;
	if (drag.kind === 'handle') return [{ subpath: drag.handle.subpath, index: drag.handle.index }];
	return drag.moved ? [drag.ref] : [];
};

/** The drag shown on the live element: a path's `d` set, a shape stood in for by the path it will become. */
const showLive = (drag: Drag, data: PathData): Drag => {
	const d = textOf(drag, data);
	if (drag.element.localName === 'path') {
		drag.element.setAttribute('d', d);
		return drag;
	}
	if (drag.standIn !== undefined) {
		drag.standIn.setAttribute('d', d);
		return drag;
	}
	const standIn = asPath(drag.element, d);
	drag.element.replaceWith(standIn);
	return { ...drag, standIn };
};

/** The live element as it was before the drag. */
const restoreLive = (drag: Drag): void => {
	if (drag.standIn !== undefined) {
		drag.standIn.replaceWith(drag.element);
		return;
	}
	if (drag.element.localName !== 'path') return;
	if (drag.original === null) {
		drag.element.removeAttribute('d');
		return;
	}
	drag.element.setAttribute('d', drag.original);
};

const clearMarks = (overlay: SVGSVGElement): void => {
	overlay.querySelectorAll(`[${MARK}]`).forEach((element) => element.remove());
};

/** The path's outline, the handles of the chosen anchors and every anchor, drawn afresh. */
const drawMarks = (
	context: ToolContext,
	data: PathData | undefined,
	anchors: readonly AnchorRef[]
): void => {
	clearMarks(context.overlay);
	if (data === undefined) return;
	const scale = context.viewport.scale;
	const owner = context.overlay.ownerDocument;
	const handles = shownHandles(data, anchors).flatMap((handle) => {
		const anchor = anchorAt(data, handle);
		return anchor === undefined ? [] : handleMarks(anchor.point, anchor[handle.side], scale);
	});
	const points = data.flatMap((subpath, s) =>
		subpath.anchors.map((anchor, index) =>
			anchorMark(
				anchor.point,
				scale,
				anchors.some((ref) => sameRef(ref, { subpath: s, index }))
			)
		)
	);
	const group = createSvg(owner, 'g', { [MARK]: '', 'pointer-events': 'none' });
	group.replaceChildren(
		...[outlineMark(formatPath(data)), ...handles, ...points].map((mark) =>
			createSvg(owner, mark.name, mark.attributes)
		)
	);
	context.overlay.appendChild(group);
};

export const createNode = (): ToolBehavior => {
	const chosen = cell<Chosen | undefined>(undefined);
	const drag = cell<Drag | undefined>(undefined);

	const choose = (layerId: string, target: Target, anchors: readonly AnchorRef[]): void => {
		chosen.current = {
			layerId,
			element: target.element,
			address: target.address,
			anchors,
		};
	};

	/**
	 * The chosen path as the drawing has it now: found again where it sat if
	 * an undo put a copy of its layer in place of the one it was in; none if
	 * it is gone, or the active layer is another.
	 */
	const resolve = (context: ToolContext): Target | undefined => {
		const current = chosen.current;
		if (current === undefined || context.layer?.id !== current.layerId) return undefined;
		const layer = activeLayerElement(context);
		if (layer === undefined) return undefined;
		const element = layer.contains(current.element)
			? current.element
			: elementAt(layer, current.address);
		return element === undefined || !hasPoints(element.localName)
			? undefined
			: targetOf(layer, element);
	};

	/** The chosen path's marks as it is now; let go of where it is gone. */
	const redraw = (context: ToolContext): void => {
		const current = chosen.current;
		const target = resolve(context);
		if (current === undefined || target === undefined) {
			chosen.current = undefined;
			drawMarks(context, undefined, []);
			return;
		}
		const anchors = validAnchors(current.anchors, target.data);
		choose(current.layerId, target, anchors);
		drawMarks(context, target.data, anchors);
	};

	/**
	 * The change made by one command. A loose layer is wrapped first
	 * (`targetLayer`), its element the first in the new group then; a shape
	 * becomes a path, with its children; a path left with no points goes.
	 */
	const commit = (
		context: ToolContext,
		current: Drag,
		data: PathData,
		anchors: readonly AnchorRef[]
	): void => {
		const d = textOf(current, data);
		if (current.element.localName === 'path' && d === current.original) {
			redraw(context);
			return;
		}
		const layer = targetLayer(context);
		if (layer === undefined) {
			redraw(context);
			return;
		}
		const address = layer === current.layer ? current.address : [0, ...current.address];
		context.document.execute(
			editLayer(layer.id, 'tools.node', (g: Element) => {
				const element = elementAt(g, address);
				if (element === undefined) return;
				if (d === '') {
					element.remove();
					return;
				}
				if (element.localName === 'path') {
					element.setAttribute('d', d);
					return;
				}
				const path = asPath(element, d);
				path.append(...element.childNodes);
				element.replaceWith(path);
			})
		);
		const live = context.document.layer(layer.id);
		const element = live === undefined || d === '' ? undefined : elementAt(live, address);
		chosen.current =
			element === undefined ? undefined : { layerId: layer.id, element, address, anchors };
		redraw(context);
	};

	const baseOf = (target: Target, from: Point): Base => ({
		...target,
		from,
		original: target.element.localName === 'path' ? target.element.getAttribute('d') : null,
		start: target.data,
		moved: false,
		standIn: undefined,
	});

	/** A press on an anchor of the chosen path: Alt takes it out or pulls handles from it, Shift adds it to the choice or takes it from it. */
	const pressAnchor = (
		context: ToolContext,
		sample: PointerSample,
		target: Target,
		ref: AnchorRef,
		anchors: readonly AnchorRef[]
	): void => {
		const layerId = chosen.current?.layerId ?? '';
		const base = baseOf(target, pointOf(sample));
		if (sample.altKey) {
			choose(layerId, target, [ref]);
			drag.current = { ...base, kind: 'alt', ref };
			drawMarks(context, target.data, [ref]);
			return;
		}
		const isChosen = anchors.some((each) => sameRef(each, ref));
		if (sample.shiftKey && isChosen) {
			const rest = anchors.filter((each) => !sameRef(each, ref));
			choose(layerId, target, rest);
			drawMarks(context, target.data, rest);
			return;
		}
		const refs = sample.shiftKey ? [...anchors, ref] : isChosen ? anchors : [ref];
		choose(layerId, target, refs);
		drag.current = { ...base, kind: 'anchors', refs, inserted: false };
		drawMarks(context, target.data, refs);
	};

	/** A press on the chosen path, nearest first: a handle shown, an anchor, a segment. Whether it was on it. */
	const pressChosen = (context: ToolContext, sample: PointerSample, target: Target): boolean => {
		const point = pointOf(sample);
		const scale = context.viewport.scale;
		const reach = REACH_PX / scale;
		const anchors = validAnchors(chosen.current?.anchors ?? [], target.data);
		const handle = nearestHandle(target.data, shownHandles(target.data, anchors), point, reach);
		if (handle !== undefined) {
			const anchor = anchorAt(target.data, handle);
			drag.current = {
				...baseOf(target, point),
				kind: 'handle',
				handle,
				smooth: anchor !== undefined && isSmooth(anchor),
			};
			return true;
		}
		const ref = nearestAnchor(target.data, point, reach);
		if (ref !== undefined) {
			pressAnchor(context, sample, target, ref, anchors);
			return true;
		}
		const on = nearestOnPath(target.data, point, SEGMENT_REACH_PX / scale);
		const inserted = on === undefined ? undefined : insertPoint(target.data, on, on.t);
		if (inserted === undefined) return false;
		choose(chosen.current?.layerId ?? '', target, [inserted.ref]);
		drag.current = {
			...baseOf(target, point),
			start: inserted.data,
			kind: 'anchors',
			refs: [inserted.ref],
			inserted: true,
		};
		drawMarks(context, inserted.data, [inserted.ref]);
		return true;
	};

	const movedBy = (current: Drag, context: ToolContext, sample: PointerSample): Drag =>
		current.moved || distance(current.from, pointOf(sample)) * context.viewport.scale >= DRAG_PX
			? { ...current, moved: true }
			: current;

	/** The drag abandoned: the live element put back as it was. */
	const letGo = (): void => {
		const current = drag.current;
		drag.current = undefined;
		if (current !== undefined) restoreLive(current);
	};

	return {
		begin: (context, sample) => {
			letGo();
			const info = guardLayer(context);
			if (info === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined) return;
			const target = resolve(context);
			if (target !== undefined && pressChosen(context, sample, target)) return;
			const hit = elementUnder(context, layer, pointOf(sample));
			if (hit !== undefined) {
				const keep = sample.shiftKey && hit.element === target?.element;
				const anchors = keep ? (chosen.current?.anchors ?? []) : [];
				choose(info.id, hit, anchors);
				drawMarks(context, hit.data, anchors);
				return;
			}
			chosen.current = undefined;
			drawMarks(context, undefined, []);
			if (target === undefined) context.notify(t('paths.chooseAPath'));
		},

		move: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			const moving = movedBy(current, context, sample);
			if (!moving.moved) return;
			const data = pointsAfter(moving, sample);
			drag.current = showLive(moving, data);
			drawMarks(context, data, anchorsAfter(moving));
		},

		end: (context, sample) => {
			const current = drag.current;
			if (current === undefined) return;
			drag.current = undefined;
			const done = movedBy(current, context, sample);
			const data = pointsAfter(done, sample);
			// The layer goes back to how it was before the drag, so the
			// command's snapshot of it is the state before the change.
			restoreLive(current);
			const clicked = done.kind === 'alt' || (done.kind === 'anchors' && done.inserted);
			if (!done.moved && !clicked) {
				redraw(context);
				return;
			}
			commit(context, done, data, anchorsAfter(done));
		},

		cancel: (context) => {
			letGo();
			redraw(context);
		},

		// What the select tool was double-pressed on: its anchors shown, none chosen.
		edit: (context, { element }) => {
			letGo();
			const info = guardLayer(context);
			if (info === undefined) return;
			const layer = activeLayerElement(context);
			if (layer === undefined || !editableIn(layer).includes(element)) return;
			const target = targetOf(layer, element);
			if (target === undefined) return;
			choose(info.id, target, []);
			drawMarks(context, target.data, []);
		},

		// The viewport empties the overlay when the tool changes, and an undo
		// replaces the layer: the marks come back with the first movement.
		hover: (context) => {
			const current = chosen.current;
			if (current === undefined) return;
			if (
				current.element.isConnected &&
				context.overlay.querySelector(`[${MARK}]`) !== null
			) {
				return;
			}
			redraw(context);
		},
	};
};
