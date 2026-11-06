import { cell } from '@skysa/draw-core';

import {
	formatTransform,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
} from '../tools/vector/geometry.js';
import {
	compound,
	copyOf,
	placeCopy,
	previousLayerSibling,
	removeLayer,
	swap,
	withLayerId,
} from './commands.js';
import {
	attributesOf,
	isSpace,
	placeAfter,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
	spaceBefore,
} from './dom.js';
import { groupLayer } from './groups.js';
import {
	freeLayerId,
	freeLayerIdAmong,
	idsIn,
	isLayerElement,
	layerById,
	layerElementsOf,
	layerKindOf,
} from './layers.js';
import type { Command } from './model.js';

/**
 * Layers moved about the stack as a selection (docs/ARCHITECTURE.md §3,
 * "Layers"; docs/decisions/0003-layers.md): dragged to another place in the
 * layers panel, into or out of a group, moved up or down together, grouped
 * together, deleted or duplicated together. Every function takes the ids of
 * the chosen layers in any order, and acts on the outermost of them
 * (`outermostLayers`): a layer inside a group that is chosen too goes where
 * its group goes. Each is one command, so one undo puts everything back.
 *
 * Like the commands beside them, these work out what to do from the live root
 * on every apply, find every layer by its id, and remember only what undo
 * needs: where each layer was, as its parent's id and its place among the
 * parent's nodes, which the history has put back exactly by the time it is
 * read, whatever later steps replaced in between.
 */

/**
 * Where layers go in the stack: in the group `parentId`, or at the root for
 * none, directly above its layer `aboveId` in paint order, which is directly
 * after it in document order, or under all of that parent's layers, at its
 * bottom, for none. "Above" is as the panel shows it: higher in the list.
 */
export type LayerPlace = Readonly<{ parentId: string | undefined; aboveId: string | undefined }>;

const idOf = (element: Element): string => element.getAttribute('id') ?? '';

const layerChildren = (parent: Element): readonly SVGGraphicsElement[] =>
	[...parent.children].filter(isLayerElement);

const isGroup = (element: Element): boolean =>
	element.localName === 'g' && layerKindOf(element) === 'group';

/** Whether a group around `element`, short of the root, is one of `chosen`. */
const isInside = (root: Element, element: Element, chosen: ReadonlySet<Element>): boolean => {
	const parent = element.parentElement;
	if (parent === null || parent === root) return false;
	return chosen.has(parent) || isInside(root, parent, chosen);
};

/**
 * The ids among `ids` that are layers of the document and not inside another
 * of them, once each, in paint order, bottom first.
 */
export const outermostLayers = (root: Element, ids: readonly string[]): readonly string[] => {
	const wanted = new Set(ids);
	const chosen = layerElementsOf(root).filter((layer) => wanted.has(idOf(layer)));
	const elements = new Set<Element>(chosen);
	const outermost = chosen.filter((layer) => !isInside(root, layer, elements)).map(idOf);
	return [...new Set(outermost)];
};

const elementsOf = (root: Element, ids: readonly string[]): readonly SVGGraphicsElement[] =>
	ids.flatMap((id) => layerById(root, id) ?? []);

/** What a move does: the layers, in paint order, into `parent`, just after `anchor` or at the bottom. */
type Plan = Readonly<{
	parent: Element;
	anchor: Element | undefined;
	moved: readonly SVGGraphicsElement[];
}>;

/** The layer under `anchor` among its siblings that is not moved, the anchor itself where it is not. */
const unmovedFrom = (
	anchor: Element | undefined,
	moved: ReadonlySet<Element>
): Element | undefined =>
	anchor === undefined || !moved.has(anchor)
		? anchor
		: unmovedFrom(previousLayerSibling(anchor), moved);

/** The root for none, or the group `id` names; `undefined` where it names no group. */
const parentOf = (root: Element, id: string | undefined): Element | undefined => {
	if (id === undefined) return root;
	const parent = layerById(root, id);
	return parent !== undefined && isGroup(parent) ? parent : undefined;
};

/** The layer `id` names in `parent`: none for the bottom, `false` where it names no layer there. */
const anchorIn = (
	root: Element,
	parent: Element,
	id: string | undefined
): Element | undefined | false => {
	if (id === undefined) return undefined;
	const anchor = layerById(root, id);
	return anchor?.parentNode === parent ? anchor : false;
};

/** The parent's layers as they would be after the move, by element. */
const orderAfter = (plan: Plan): readonly Element[] => {
	const moved = new Set<Element>(plan.moved);
	const staying: readonly Element[] = layerChildren(plan.parent).filter(
		(layer) => !moved.has(layer)
	);
	const at = plan.anchor === undefined ? 0 : staying.indexOf(plan.anchor) + 1;
	return [...staying.slice(0, at), ...plan.moved, ...staying.slice(at)];
};

/** The move, where it can be made and changes anything; `undefined` otherwise. */
const planOf = (root: Element, ids: readonly string[], place: LayerPlace): Plan | undefined => {
	const moved = elementsOf(root, outermostLayers(root, ids));
	const parent = parentOf(root, place.parentId);
	if (moved.length === 0 || parent === undefined) return undefined;
	if (moved.some((layer) => layer.contains(parent))) return undefined;
	const anchor = anchorIn(root, parent, place.aboveId);
	if (anchor === false) return undefined;
	const plan = { parent, anchor: unmovedFrom(anchor, new Set(moved)), moved };
	const before = layerChildren(parent);
	const after = orderAfter(plan);
	const same = after.length === before.length && after.every((layer, i) => layer === before[i]);
	return same ? undefined : plan;
};

/**
 * Whether the layers can go to `place` and it would change anything: the
 * parent is the root or a group of the document that is neither one of them
 * nor inside one; the anchor, where there is one, is a layer of that parent;
 * and the outermost of them are not already there, in that order.
 */
export const canPlaceLayers = (root: Element, ids: readonly string[], place: LayerPlace): boolean =>
	planOf(root, ids, place) !== undefined;

/**
 * Where a layer in `container` is drawn: the `transform` of the container and
 * of every group around it, the outermost first, as one matrix. The root's own
 * is left out, since every layer is under it wherever it goes. Only the
 * attribute is read: a `transform` in `style` is not something the app writes,
 * and §3 says position is the attribute.
 */
const placementOf = (root: Element, container: Element | null): Mat =>
	container === null || container === root
		? IDENTITY
		: multiply(
				placementOf(root, container.parentElement),
				parseTransform(container.getAttribute('transform'))
			);

const EPSILON = 1e-9;

const sameMatrix = (one: Mat, other: Mat): boolean =>
	one.every((value, i) => Math.abs(value - (other[i] ?? 0)) < EPSILON);

/**
 * The layer's own `transform` given the difference between where it was drawn
 * and where its new parent draws, so it is drawn where it was: one `matrix(…)`,
 * or no attribute where that comes to nothing. Where the two are the same the
 * layer is not touched, and nothing is kept; otherwise its attributes as they
 * were, for undo.
 */
const keepDrawn = (
	root: Element,
	layer: Element,
	target: Mat
): readonly SavedAttribute[] | undefined => {
	const from = placementOf(root, layer.parentElement);
	if (sameMatrix(from, target)) return undefined;
	const attributes = attributesOf(layer);
	const own = parseTransform(layer.getAttribute('transform'));
	const written = formatTransform(multiply(invert(target), multiply(from, own)));
	if (written === '') layer.removeAttribute('transform');
	else layer.setAttribute('transform', written);
	return attributes;
};

/** One layer moved: where it came from, and what undo gives back to it. */
type Moved = Readonly<{
	id: string;
	/** The group it was in, or none for the root. */
	from: string | undefined;
	/** Where among the parent's nodes it, or the indentation before it, was. */
	index: number;
	/** Its indentation there, which went with it. */
	space: Text | undefined;
	/** Whether it was given an indentation where it went, the node just before it. */
	indented: boolean;
	attributes: readonly SavedAttribute[] | undefined;
}>;

type Removed = Omit<Moved, 'indented'>;

/** The layer out of its parent, with the indentation before it, as `removeLayer` takes one. */
const takeOut = (
	root: Element,
	layer: Element,
	attributes: readonly SavedAttribute[] | undefined
): Removed => {
	const parent = layer.parentElement ?? root;
	const space = spaceBefore(layer);
	const index = [...parent.childNodes].indexOf(space ?? layer);
	space?.remove();
	layer.remove();
	return {
		id: idOf(layer),
		from: parent === root ? undefined : idOf(parent),
		index,
		space,
		attributes,
	};
};

/**
 * The layer at the bottom of `parent`: before its first layer, indented as
 * that one is; in a parent with no layers, after its last element, as that one
 * is, or first in it with no indentation where it holds no element at all.
 */
const putAtBottom = (parent: Element, layer: Element): Text | undefined => {
	const [first] = layerChildren(parent);
	if (first === undefined) {
		const last = parent.lastElementChild;
		if (last !== null) return placeAfter(last, layer);
		parent.prepend(layer);
		return undefined;
	}
	const space = spaceBefore(first);
	const indentation = space?.cloneNode() as Text | undefined;
	parent.insertBefore(layer, space ?? first);
	if (indentation !== undefined) layer.before(indentation);
	return indentation;
};

/**
 * The layers moved together: each drawn where it was, taken out with its
 * indentation, and put in the parent in paint order, directly above the anchor
 * or at the bottom, each with the indentation of the place it goes to.
 */
const carryOut = (root: Element, plan: Plan): readonly Moved[] => {
	const target = placementOf(root, plan.parent);
	const removed = plan.moved.map((layer) => ({
		layer,
		taken: takeOut(root, layer, keepDrawn(root, layer, target)),
	}));
	return removed.map(({ layer, taken }, index) => {
		const after = removed[index - 1]?.layer ?? plan.anchor;
		const space =
			after === undefined ? putAtBottom(plan.parent, layer) : placeAfter(after, layer);
		return { ...taken, indented: space !== undefined };
	});
};

/**
 * Undo of `carryOut`: every layer taken out of where it went, with the
 * indentation it was given there, then each put back in the reverse order it
 * was taken out, at its place among its old parent's nodes, with its own
 * indentation and its attributes as they were.
 */
const carryBack = (root: Element, moves: readonly Moved[]): void => {
	const found = moves.map((move) => ({ move, layer: layerById(root, move.id) }));
	found.forEach(({ move, layer }) => {
		const space = layer?.previousSibling ?? null;
		if (move.indented && isSpace(space)) space.remove();
		layer?.remove();
	});
	[...found].reverse().forEach(({ move, layer }) => {
		const parent = move.from === undefined ? root : layerById(root, move.from);
		if (layer === undefined || parent === undefined) return;
		parent.insertBefore(layer, [...parent.childNodes][move.index] ?? null);
		if (move.space !== undefined) layer.before(move.space);
		if (move.attributes !== undefined) resetAttributes(layer, move.attributes);
	});
};

/**
 * The outermost of the layers moved to `place` together, in their paint order
 * among themselves, in one command labeled `label`. Each is drawn where it
 * was: where the transforms of its new parent and its ancestors differ from
 * those of its old ones, its own `transform` takes the difference, written as
 * one `matrix(…)` (`formatTransform`), or taken away where the difference
 * leaves the identity, and where they do not, it is not touched. An anchor
 * that is itself among the layers moved is read as the nearest layer under it
 * that is not, or the bottom where there is none. Each layer leaves its
 * indentation behind and takes that of the layer it goes above, or of the
 * parent's bottom layer. Undo puts each back where it was, among the same
 * siblings, with the very attributes and indentation it had. Nothing, costing
 * nothing, where `canPlaceLayers` says no when the command runs.
 */
export const placeLayers = (
	root: SVGSVGElement,
	ids: readonly string[],
	place: LayerPlace,
	label = 'layers.move'
): Command => {
	const chosen = outermostLayers(root, ids);
	const done = cell<readonly Moved[] | undefined>(undefined);
	return {
		label,
		apply: (live) => {
			const plan = planOf(live, chosen, place);
			done.current = plan === undefined ? undefined : carryOut(live, plan);
		},
		revert: (live) => {
			if (done.current !== undefined) carryBack(live, done.current);
		},
		get bytes() {
			const moves = done.current;
			return moves === undefined
				? 0
				: moves.reduce(
						(total, move) => total + savedBytes(move.attributes ?? []),
						SMALL_COMMAND_BYTES
					);
		},
	};
};

/** Two layers, by id, that trade places. */
type Swap = readonly [string, string];

/** The chosen run just before `index` in `siblings`, nearest first. */
const runBefore = (
	siblings: readonly string[],
	chosen: ReadonlySet<string>,
	index: number
): readonly string[] => {
	const previous = siblings[index - 1];
	return previous !== undefined && chosen.has(previous)
		? [previous, ...runBefore(siblings, chosen, index - 1)]
		: [];
};

/**
 * The trades a step makes: in each parent, read in the direction of the step,
 * every layer not chosen that comes just after a run of chosen ones trades
 * places with each of the run in turn, the nearest first, which carries it to
 * the other side of the run and leaves the run in its order.
 */
const swapsOf = (
	root: Element,
	ids: readonly string[],
	direction: 'up' | 'down'
): readonly Swap[] => {
	const chosen = new Set(outermostLayers(root, ids));
	const parents = new Set(
		elementsOf(root, [...chosen]).map((layer) => layer.parentElement ?? root)
	);
	return [...parents].flatMap((parent) => {
		const inPaintOrder = layerChildren(parent).map(idOf);
		const siblings = direction === 'up' ? inPaintOrder : [...inPaintOrder].reverse();
		return siblings.flatMap((id, index) =>
			chosen.has(id)
				? []
				: runBefore(siblings, chosen, index).map((other): Swap => [id, other])
		);
	});
};

const trade = (root: Element, [one, other]: Swap): void => {
	const first = layerById(root, one);
	const second = layerById(root, other);
	if (first !== undefined && second !== undefined) swap(first, second);
};

/** Whether `stepLayers` would move anything. */
export const canStepLayers = (
	root: Element,
	ids: readonly string[],
	direction: 'up' | 'down'
): boolean => swapsOf(root, ids, direction).length > 0;

/**
 * Move up or Move down for a selection: among the siblings of each, every run
 * of chosen layers next to one another trades places with the next layer not
 * chosen in that direction, so the chosen keep their order among themselves
 * and never leave their group; a run with none there stays where it is. The
 * layers trade places as `moveLayer`'s do, the whitespace staying put. One
 * command labeled `layers.moveUp` or `layers.moveDown`; for one layer, what
 * `moveLayer` does.
 */
export const stepLayers = (
	root: SVGSVGElement,
	ids: readonly string[],
	direction: 'up' | 'down'
): Command => {
	const chosen = outermostLayers(root, ids);
	const swaps = cell<readonly Swap[]>([]);
	return {
		label: direction === 'up' ? 'layers.moveUp' : 'layers.moveDown',
		apply: (live) => {
			swaps.current = swapsOf(live, chosen, direction);
			swaps.current.forEach((each) => trade(live, each));
		},
		revert: (live) => {
			[...swaps.current].reverse().forEach((each) => trade(live, each));
		},
		get bytes() {
			return swaps.current.length > 0 ? SMALL_COMMAND_BYTES : 0;
		},
	};
};

/**
 * The outermost of the layers in one new group, made where the topmost of
 * them is, in that one's parent: the group takes the next free `layer-n`,
 * given back as `id` for the caller to make active, and holds them in their
 * paint order, each drawn where it was, as `placeLayers` keeps them. The
 * topmost is grouped as `groupLayer` groups one, and the others are moved
 * into the group under it, so the group holds them with no indentation, as
 * `groupLayer` writes it. Labeled `layers.group`. For one layer, what
 * `groupLayer` does, to the byte.
 */
export const groupLayers = (
	root: SVGSVGElement,
	ids: readonly string[]
): Command & Readonly<{ id: string }> => {
	const chosen = outermostLayers(root, ids);
	const topmost = chosen.at(-1);
	if (topmost === undefined) return withLayerId(freeLayerId(root), compound('layers.group', []));
	const grouped = groupLayer(root, topmost);
	if (chosen.length === 1) return grouped;
	const others = chosen.slice(0, -1);
	const into = placeLayers(
		root,
		others,
		{ parentId: grouped.id, aboveId: undefined },
		'layers.group'
	);
	return withLayerId(grouped.id, compound('layers.group', [grouped, into]));
};

/** The outermost of the layers deleted, in one command labeled as `removeLayer` labels one. */
export const removeLayers = (root: SVGSVGElement, ids: readonly string[]): Command =>
	compound('layers.delete', outermostLayers(root, ids).map(removeLayer));

type Copy = Readonly<{ original: string; copy: string }>;

/** Each original with the next free `layer-n` for its copy, none the same as another's. */
const copiesOf = (root: Element, originals: readonly string[]): readonly Copy[] => {
	const taken = idsIn(root);
	return originals.reduce<readonly Copy[]>((made, original) => {
		const copy = freeLayerIdAmong(new Set([...taken, ...made.map((each) => each.copy)]));
		return [...made, { original, copy }];
	}, []);
};

/**
 * The outermost of the layers duplicated, each copy directly above its
 * original, in one command labeled as `duplicateLayer` labels one; `ids` are
 * the copies', in paint order, for the caller to choose. The copies' ids are
 * chosen now, all of them, so the layers inside a copied group, numbered as
 * the copy is made, never take the number of a copy made after it. For one
 * layer, what `duplicateLayer` does.
 */
export const duplicateLayers = (
	root: SVGSVGElement,
	ids: readonly string[]
): Command & Readonly<{ ids: readonly string[] }> => {
	const copies = copiesOf(root, outermostLayers(root, ids));
	const reserved = new Set(copies.map((each) => each.copy));
	const parts = copies.map(({ original, copy }) =>
		placeCopy(original, 'layers.duplicate', (live, element) =>
			copyOf(live, element, copy, undefined, reserved)
		)
	);
	const command = compound('layers.duplicate', parts);
	return {
		ids: copies.map((each) => each.copy),
		label: command.label,
		apply: command.apply,
		revert: command.revert,
		get bytes() {
			return command.bytes;
		},
	};
};
