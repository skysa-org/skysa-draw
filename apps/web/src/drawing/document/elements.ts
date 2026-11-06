import { cell } from '@skysa/draw-core';

import {
	formatFineTransform,
	formatTransform,
	IDENTITY,
	type Mat,
	multiply,
	parseTransform,
} from '../tools/vector/geometry.js';
import { layerSpace } from '../tools/vector/guard.js';
import { elementsAtPositions, elementsOf } from '../tools/vector/hit.js';
import { compound, copyOf, editLayer } from './commands.js';
import {
	attributesOf,
	placeAfter,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
	spaceBefore,
} from './dom.js';
import { isLayerHidden, isLayerLocked, layerById, layerKindOf } from './layers.js';
import type { Command } from './model.js';

/**
 * A vector layer's elements as the user arranges them, in the layers panel
 * and from the selection's menu (docs/ARCHITECTURE.md §7, "The interface"):
 * brought to the front or forward, sent backward or to the back among their
 * layer's own, as Illustrator's Object › Arrange does; duplicated in place;
 * and moved, by a drag of their rows, to another place in their layer or in
 * another vector layer, where they keep where they are seen on the canvas.
 * Elements are named by their positions among their layer's own
 * (`positionsIn`, `tools/vector/hit.ts`), which a command finds again on
 * every apply. Each change is one command, one step of the history.
 *
 * Every one is a layer edit (`editLayer`), or two for a move between layers,
 * so undo puts back the very markup there was, whitespace and all, and a
 * selection holding the elements still holds them after the first apply:
 * they are the same nodes, moved rather than copied. What is not an element
 * of the layer, a `<defs>`, a `<title>`, a `<desc>`, a `<metadata>`, stays
 * where it is, and an element moved takes the indentation before it along,
 * so the markup reads as it did.
 *
 * Where they are on the canvas is their own `transform`s, which the move
 * tool's drag, its arrows and its alignment change by one command that
 * touches that attribute alone (`transformElements`), on the same nodes
 * through an undo and a redo, so what was selected stays selected.
 */

/** Where an arrangement puts elements among their layer's own. */
export type ElementArrangement = 'front' | 'forward' | 'backward' | 'back';

/**
 * A command that says where the elements it placed are, once it has run:
 * the layer, and their positions among its elements, ascending, for the
 * caller to select them there.
 */
export type PlacingCommand = Command & Readonly<{ layerId: string; positions: readonly number[] }>;

/**
 * Where elements are moved to: among the vector layer `layerId`'s elements
 * as they are now, directly below the one at `index` in paint order, or on
 * top of them all where `index` is their count.
 */
export type ElementPlace = Readonly<{ layerId: string; index: number }>;

const LABELS = {
	arrange: 'selection.history.arrange',
	duplicate: 'selection.history.duplicate',
	move: 'selection.history.moveElements',
} as const;

/** An element's own `transform` set, or taken off for the empty string, which is the identity. */
export const setTransform = (element: Element, value: string): void => {
	if (value === '') {
		element.removeAttribute('transform');
		return;
	}
	element.setAttribute('transform', value);
};

/** Whether `element`, or a group around it short of the root, is locked or hidden. */
const heldFrom = (root: Element, element: Element | null): boolean =>
	element !== null &&
	element !== root &&
	(isLayerHidden(element) || isLayerLocked(element) || heldFrom(root, element.parentElement));

/**
 * Whether the layer `layerId` is out of reach of an edit: locked or hidden,
 * itself or by a group that holds it. Its items are shown, never selected,
 * dragged or dropped on from the layers panel.
 */
export const isLayerHeld = (root: Element, layerId: string): boolean => {
	const layer = layerById(root, layerId);
	return layer === undefined || heldFrom(root, layer);
};

/** A layer that holds elements of its own: a vector `<g>`, not a loose element, a raster layer or a group. */
const isVectorGroup = (layer: Element): boolean =>
	layer.localName === 'g' && layerKindOf(layer) === 'vector';

/** The positions among `count` that name an element, once each, ascending: the rest are ignored. */
const validPositions = (count: number, positions: readonly number[]): readonly number[] =>
	[
		...new Set(
			positions.filter(
				(position) => Number.isInteger(position) && position >= 0 && position < count
			)
		),
	].sort((a, b) => a - b);

const samePositions = (one: readonly number[], other: readonly number[]): boolean =>
	one.length === other.length && one.every((position, index) => position === other[index]);

/**
 * Forward, from the top down: each moves up one, past the next element above
 * it, unless what is there is one of them that could not move, so a run of
 * them moves up past the next one above it together, and a run at the top
 * stays.
 */
const forward = (count: number, sorted: readonly number[]): readonly number[] =>
	sorted.reduceRight<readonly number[]>((placed, position) => {
		const up = position + 1;
		return [up < count && placed[0] !== up ? up : position, ...placed];
	}, []);

/** The positions read from the other end, still ascending: what makes backward forward's mirror. */
const mirrored = (count: number, positions: readonly number[]): readonly number[] =>
	[...positions].reverse().map((position) => count - 1 - position);

/** Each arrangement, from the positions it is given, once each and ascending. */
const ARRANGED: Readonly<
	Record<ElementArrangement, (count: number, sorted: readonly number[]) => readonly number[]>
> = {
	front: (count, sorted) => sorted.map((_, index) => count - sorted.length + index),
	forward,
	backward: (count, sorted) => mirrored(count, forward(count, mirrored(count, sorted))),
	back: (_count, sorted) => sorted.map((_, index) => index),
};

/**
 * The positions the elements at `positions`, among `count`, have after
 * `how`, ascending: the front moves them all to the top and the back to the
 * bottom, keeping their order among themselves; forward moves each above the
 * next element above it that is not among them, and backward below the next
 * one below, as Illustrator's do.
 */
export const arrangedPositions = (
	count: number,
	positions: readonly number[],
	how: ElementArrangement
): readonly number[] => ARRANGED[how](count, validPositions(count, positions));

/** Whether `how` changes where any of the elements at `positions`, among `count`, are. */
export const canArrange = (
	count: number,
	positions: readonly number[],
	how: ElementArrangement
): boolean => {
	const from = validPositions(count, positions);
	return !samePositions(from, ARRANGED[how](count, from));
};

/**
 * The layer's elements in the order they are to be in: those at `from` at
 * `to`, in their order, and the others in theirs, around them.
 */
const orderWith = (
	own: readonly Element[],
	from: readonly number[],
	to: readonly number[]
): readonly Element[] => {
	const moving = from.flatMap((position) => own.slice(position, position + 1));
	const staying = own.filter((_, position) => !from.includes(position));
	return own.flatMap((_, slot) => {
		const index = to.indexOf(slot);
		const element =
			index >= 0 ? moving[index] : staying[slot - to.filter((taken) => taken < slot).length];
		return element === undefined ? [] : [element];
	});
};

/** An element with the indentation before it, which goes wherever it goes. */
const unitOf = (element: Element): readonly ChildNode[] => {
	const space = spaceBefore(element);
	return space === undefined ? [element] : [space, element];
};

/**
 * The layer's elements put in `order` by taking out those `moved`, each with
 * the indentation before it, and putting the same nodes back among those that
 * stay: each directly after the one before it in `order`, or, the first of
 * them all, directly before the first that stays. Nothing else in the layer
 * moves, so the markup changes by the lines of what moved, a `<title>` or a
 * `<desc>` keeps its place among the elements that stay, and a selection
 * that holds the elements still does. Where every element moves, their order
 * among themselves is the whole order, which a move keeps, and nothing is
 * done.
 */
const reorder = (order: readonly Element[], moved: ReadonlySet<Element>): void => {
	const first = order.find((element) => !moved.has(element));
	if (first === undefined) return;
	const units = new Map([...moved].map((element) => [element, unitOf(element)]));
	units.forEach((unit) => unit.forEach((node) => node.remove()));
	order.forEach((element, slot) => {
		const unit = units.get(element);
		if (unit === undefined) return;
		const below = order[slot - 1];
		if (below === undefined) {
			(spaceBefore(first) ?? first).before(...unit);
			return;
		}
		below.after(...unit);
	});
};

type Placed = Readonly<{ positions: readonly number[]; changed: boolean }>;

const NOTHING_PLACED: Placed = { positions: [], changed: false };

/**
 * A layer edit that says where what it placed is, once it has run, and costs
 * nothing, so the document does not record it, where `mutate` changed
 * nothing: an arrangement that leaves everything where it was.
 */
const placingEdit = (
	layerId: string,
	label: string,
	mutate: (layer: SVGGraphicsElement) => Placed
): PlacingCommand => {
	const placed = cell<Placed>(NOTHING_PLACED);
	const edit = editLayer(layerId, label, (layer) => {
		placed.current = mutate(layer);
	});
	return {
		label,
		apply: edit.apply,
		revert: edit.revert,
		get bytes() {
			return placed.current.changed ? edit.bytes : 0;
		},
		layerId,
		get positions() {
			return placed.current.positions;
		},
	};
};

/** The elements at `positions` in the vector layer `layerId` arranged by `how`. */
export const arrangeElements = (
	layerId: string,
	positions: readonly number[],
	how: ElementArrangement
): PlacingCommand =>
	placingEdit(layerId, LABELS.arrange, (layer) => {
		if (!isVectorGroup(layer)) return NOTHING_PLACED;
		const own = elementsOf(layer);
		const from = validPositions(own.length, positions);
		const to = ARRANGED[how](own.length, from);
		const changed = !samePositions(from, to);
		if (changed) reorder(orderWith(own, from, to), new Set(elementsAtPositions(layer, from)));
		return { positions: to, changed };
	});

/** A copy of each element at `positions` in the layer `layerId`, directly above it; `positions` are the copies'. */
export const duplicateElements = (
	root: SVGSVGElement,
	layerId: string,
	positions: readonly number[]
): PlacingCommand =>
	placingEdit(layerId, LABELS.duplicate, (layer) => {
		if (!isVectorGroup(layer)) return NOTHING_PLACED;
		const own = elementsOf(layer);
		const from = validPositions(own.length, positions);
		// One at a time, each in the document before the next is made, so the
		// ids each copy is given are free of the ones before it.
		from.forEach((position) => {
			const original = own[position];
			if (original !== undefined) placeAfter(original, copyOf(root, original, undefined));
		});
		return {
			positions: from.map((position, index) => position + index + 1),
			changed: from.length > 0,
		};
	});

/** A layer elements may be moved from or to: a vector `<g>` no lock or hiding holds. */
const movableLayer = (root: Element, layerId: string): SVGGraphicsElement | undefined => {
	const layer = layerById(root, layerId);
	return layer !== undefined && isVectorGroup(layer) && !heldFrom(root, layer)
		? layer
		: undefined;
};

/** A move that can be made: the elements' positions before it, and after it in the target. */
type MovePlan = Readonly<{ from: readonly number[]; to: readonly number[] }>;

/**
 * The move, where it can be made and changes anything. In the same layer the
 * slot is counted among the elements that stay, those below `index`; in
 * another, among all of the target's, which none of the moved are.
 */
const movePlan = (
	root: Element,
	layerId: string,
	positions: readonly number[],
	place: ElementPlace
): MovePlan | undefined => {
	const source = movableLayer(root, layerId);
	const target = movableLayer(root, place.layerId);
	if (source === undefined || target === undefined) return undefined;
	const from = validPositions(elementsOf(source).length, positions);
	const { index } = place;
	const inRange = Number.isInteger(index) && index >= 0 && index <= elementsOf(target).length;
	if (from.length === 0 || !inRange) return undefined;
	const same = source === target;
	const slot = same ? index - from.filter((position) => position < index).length : index;
	const to = from.map((_, offset) => slot + offset);
	return same && samePositions(from, to) ? undefined : { from, to };
};

/**
 * Whether the elements at `positions` in the layer `layerId` can be moved to
 * `to`, and would be anywhere else: `to` a vector layer that is a `<g>`, not
 * held (`isLayerHeld`), and neither is theirs.
 */
export const canMoveElements = (
	root: SVGSVGElement,
	layerId: string,
	positions: readonly number[],
	to: ElementPlace
): boolean => movePlan(root, layerId, positions, to) !== undefined;

/** Whether a matrix does more than move what it places: it turns, flips, scales or skews. */
const reshapes = (m: Mat): boolean => formatFineTransform([m[0], m[1], m[2], m[3], 0, 0]) !== '';

/**
 * The element's own `transform` with `bridge`, the way from its old layer's
 * space into its new one's, in front, so it is seen where it was. A bridge
 * that is the identity, the common case of two layers neither of them
 * placed, leaves the attribute exactly as it was. One that only moves writes
 * the matrix as a drag does (`movedBy`, `select.ts`); one that does more
 * writes it to nine places, as the inverse of a layer's placement is written
 * (`newElementSpace`, `guard.ts`), so a quarter turn is whole numbers and a
 * move there and back comes to where it began. A result that is the identity
 * is no attribute.
 */
const keepSeen = (elements: readonly Element[], bridge: Mat): void => {
	if (formatFineTransform(bridge) === '') return;
	const format = reshapes(bridge) ? formatFineTransform : formatTransform;
	elements.forEach((element) =>
		setTransform(
			element,
			format(multiply(bridge, parseTransform(element.getAttribute('transform'))))
		)
	);
};

/**
 * `elements` into the layer, in their order, directly below its element at
 * `index` in paint order, or above them all at their count, each indented as
 * the element it goes beside; in a layer with no element, after whatever
 * else it holds, as that is indented, or first in it with no indentation
 * where it holds nothing at all.
 */
const insertAt = (layer: Element, index: number, elements: readonly Element[]): void => {
	const own = elementsOf(layer);
	const above = own[index];
	if (above !== undefined) {
		const space = spaceBefore(above);
		elements.forEach((element) => {
			layer.insertBefore(element, space ?? above);
			if (space !== undefined) element.before(space.cloneNode());
		});
		return;
	}
	const last = own.at(-1) ?? layer.lastElementChild ?? undefined;
	if (last === undefined) {
		layer.prepend(...elements);
		return;
	}
	// Each just after the last, so the last placed is the first of them.
	[...elements].reverse().forEach((element) => placeAfter(last, element));
};

/** What the move from one layer to another carries between its two edits. */
type Carried = Readonly<{ elements: readonly Element[]; outOf: Mat }>;

/**
 * The move between two layers: one edit takes the elements out of theirs,
 * with their indentation, and the other puts the same nodes into the target
 * at the slot, kept where they are seen. Their ids go with them, since they
 * moved and were not copied, so what refers to them still finds them.
 */
const moveAcross = (layerId: string, to: string, plan: MovePlan): Command => {
	const carried = cell<Carried>({ elements: [], outOf: IDENTITY });
	return compound(LABELS.move, [
		editLayer(layerId, LABELS.move, (layer) => {
			const elements = elementsAtPositions(layer, plan.from);
			carried.current = { elements, outOf: layerSpace(layer).outOf };
			elements.forEach((element) => unitOf(element).forEach((node) => node.remove()));
		}),
		editLayer(to, LABELS.move, (layer) => {
			const { elements, outOf } = carried.current;
			keepSeen(elements, multiply(layerSpace(layer).into, outOf));
			insertAt(layer, plan.to[0] ?? 0, elements);
		}),
	]);
};

/** The elements at `positions` in the layer `layerId` moved to `to`, in their order; `layerId` and `positions` are where they are after. */
export const moveElements = (
	root: SVGSVGElement,
	layerId: string,
	positions: readonly number[],
	to: ElementPlace
): PlacingCommand => {
	const plan = movePlan(root, layerId, positions, to);
	if (plan === undefined) {
		// Nothing to do, and nothing recorded: the elements stay where they are.
		const source = layerById(root, layerId);
		const count = source === undefined ? 0 : elementsOf(source).length;
		return {
			label: LABELS.move,
			apply: () => undefined,
			revert: () => undefined,
			bytes: 0,
			layerId,
			positions: validPositions(count, positions),
		};
	}
	if (layerId === to.layerId) {
		return placingEdit(layerId, LABELS.move, (layer) => {
			const own = elementsOf(layer);
			const order = orderWith(own, plan.from, plan.to);
			reorder(order, new Set(elementsAtPositions(layer, plan.from)));
			return { positions: plan.to, changed: true };
		});
	}
	const command = moveAcross(layerId, to.layerId, plan);
	return {
		label: command.label,
		apply: command.apply,
		revert: command.revert,
		get bytes() {
			return command.bytes;
		},
		layerId: to.layerId,
		positions: plan.to,
	};
};

/** One element's new `transform`, by where it is among its layer's elements; the empty string for none. */
type ElementTransform = Readonly<{ position: number; value: string }>;

/**
 * What an element's undo needs: its `transform` before, `null` for none, and,
 * where the change takes the attribute off, every attribute it had, in their
 * order, since one put back anew would go last.
 */
type KeptTransform = Readonly<{
	position: number;
	transform: string | null;
	attributes: readonly SavedAttribute[] | undefined;
}>;

/**
 * The elements of the vector layer `layerId` at the positions of `changes`
 * given their new `transform`s, by one command labeled `label`: the move
 * tool's drag of them, a resize or a turn of them by its box, its arrows'
 * nudge and its alignment. Only the attribute is touched, on the very nodes
 * there are, on every apply and every revert: an undo or a redo leaves the
 * elements in the drawing, so what holds them, the selection, still does, as
 * Illustrator keeps what it moved selected through an undo; and only what
 * the undo needs is kept, the attribute before, or every attribute where the
 * change takes it off, so a nudge held down on a layer of thousands of
 * strokes costs the history a few bytes a step, not two copies of the layer
 * as a layer edit would. An element that is not at its position, or a layer
 * that is not there, is passed over; with none found nothing is recorded
 * (`bytes` is 0).
 */
export const transformElements = (
	layerId: string,
	label: string,
	changes: readonly ElementTransform[]
): Command => {
	const kept = cell<readonly KeptTransform[]>([]);
	const at = (root: Element, position: number): readonly Element[] =>
		elementsAtPositions(layerById(root, layerId), [position]);
	return {
		label,
		apply: (root) => {
			kept.current = changes.flatMap(({ position, value }) =>
				at(root, position).map((element) => {
					const transform = element.getAttribute('transform');
					const takenOff = transform !== null && value === '';
					const attributes = takenOff ? attributesOf(element) : undefined;
					setTransform(element, value);
					return { position, transform, attributes };
				})
			);
		},
		revert: (root) => {
			kept.current.forEach(({ position, transform, attributes }) =>
				at(root, position).forEach((element) => {
					if (attributes !== undefined) resetAttributes(element, attributes);
					else setTransform(element, transform ?? '');
				})
			);
		},
		get bytes() {
			return kept.current.length === 0
				? 0
				: kept.current.reduce(
						(total, { transform, attributes }) =>
							total + (transform?.length ?? 0) + savedBytes(attributes ?? []),
						SMALL_COMMAND_BYTES
					);
		},
	};
};
