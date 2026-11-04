import { type BlendMode, cell, type LayerKind, layerNumber, SVG_NAMESPACE } from '@skysa/draw-core';

import {
	attributesOf,
	declaring,
	markupSize,
	placeAfter,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
	spaceBefore,
	undeclare,
} from './dom.js';
import {
	freeLayerId,
	freeLayerIdAmong,
	idsIn,
	isLayerElement,
	layerById,
	layersWithin,
	writeLayerBlend,
	writeLayerHidden,
	writeLayerKind,
	writeLayerLocked,
	writeLayerName,
	writeLayerOpacity,
} from './layers.js';
import type { Command } from './model.js';
import { XLINK_NAMESPACE } from './namespaces.js';

/**
 * The commands (docs/ARCHITECTURE.md §7, "Commands and history"): every change
 * the editor makes to a drawing, each with its inverse, as the document
 * executes them. A command names its layer by id and finds it on every apply
 * and every revert, never holding the element across an undo that replaced
 * it. Each puts the document back exactly as it found it, attribute order and
 * whitespace included, so that undoing every step gives the opened text back
 * and a step undone and redone is the same tree. The labels are catalog keys,
 * for an undo menu.
 *
 * A command that finds nothing to do, a layer gone or a move past the end,
 * costs nothing (`bytes` is 0), and the document does not record it.
 */

/**
 * A change to one layer's markup, by a tool (§7: "a vector command keeps the
 * layer's markup before and after"). The first apply copies the live layer,
 * changes it in place with `mutate`, and copies it again; undo and redo put a
 * fresh copy of the one or the other in the live layer's place. The copies are
 * the DOM's own, `cloneNode`, rather than text to parse again: they keep every
 * namespace and prefix exactly, cost no parse, and share their attribute
 * strings with the layer, so a raster layer's picture is not copied by an edit
 * beside it. A tool puts the live layer back as it was before it executes this:
 * a live preview is not a change.
 */
export const editLayer = (
	layerId: string,
	label: string,
	mutate: (layer: SVGGraphicsElement) => void
): Command => {
	const states = cell<Readonly<{ before: Element; after: Element; bytes: number }> | undefined>(
		undefined
	);
	const putBack = (root: SVGSVGElement, state: Element): void => {
		layerById(root, layerId)?.replaceWith(state.cloneNode(true));
	};
	return {
		label,
		apply: (root) => {
			const known = states.current;
			if (known !== undefined) {
				putBack(root, known.after);
				return;
			}
			const layer = layerById(root, layerId);
			if (layer === undefined) return;
			const before = layer.cloneNode(true) as Element;
			mutate(layer);
			const after = layer.cloneNode(true) as Element;
			states.current = { before, after, bytes: markupSize(before) + markupSize(after) };
		},
		revert: (root) => {
			if (states.current !== undefined) putBack(root, states.current.before);
		},
		get bytes() {
			return states.current?.bytes ?? 0;
		},
	};
};

const firstImage = (layer: Element): Element | undefined =>
	[...layer.children].find(
		(child) => child.namespaceURI === SVG_NAMESPACE && child.localName === 'image'
	);

type RasterImage = Readonly<{
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
}>;

/**
 * A raster layer's pixels, re-encoded (§7: "a raster command keeps the image's
 * `href` before and after"): the layer's `<image>`, or one made on a layer that
 * had none yet, given the new `href` and place and `preserveAspectRatio="none"`
 * every time, since a raster image always has it (§3) and the surface writes
 * the picture into the whole box. `href` replaces an `xlink:href`, which SVG 2
 * does not need. Undo puts the old attributes back as they were, an absent
 * `preserveAspectRatio` absent again, or takes away the image it made.
 */
export const replaceRasterImage = (layerId: string, label: string, image: RasterImage): Command => {
	const saved = cell<
		Readonly<{ made: boolean; attributes: readonly SavedAttribute[] }> | undefined
	>(undefined);
	return {
		label,
		apply: (root) => {
			const layer = layerById(root, layerId);
			if (layer === undefined) return;
			const existing = firstImage(layer);
			saved.current = {
				made: existing === undefined,
				attributes: existing === undefined ? [] : attributesOf(existing),
			};
			const target = existing ?? root.ownerDocument.createElementNS(SVG_NAMESPACE, 'image');
			target.removeAttributeNS(XLINK_NAMESPACE, 'href');
			target.setAttribute('href', image.href);
			target.setAttribute('x', String(image.x));
			target.setAttribute('y', String(image.y));
			target.setAttribute('width', String(image.width));
			target.setAttribute('height', String(image.height));
			target.setAttribute('preserveAspectRatio', 'none');
			if (existing === undefined) layer.appendChild(target);
		},
		revert: (root) => {
			const layer = layerById(root, layerId);
			const target = layer === undefined ? undefined : firstImage(layer);
			const before = saved.current;
			if (target === undefined || before === undefined) return;
			if (before.made) {
				target.remove();
				return;
			}
			resetAttributes(target, before.attributes);
		},
		get bytes() {
			const before = saved.current;
			return before === undefined ? 0 : image.href.length + savedBytes(before.attributes);
		},
	};
};

const ADD_LABELS: Readonly<Record<LayerKind, string>> = {
	vector: 'layers.add',
	raster: 'layers.addRaster',
	group: 'layers.addGroup',
};

/**
 * A new, empty layer of `kind`: a `<g>` with the smallest free `layer-n` and
 * `draw:kind`, above the layer named, in its parent, or on top of everything.
 * The id is chosen now, so the caller can make the new layer the active one.
 */
export const addLayer = (
	root: SVGSVGElement,
	kind: LayerKind,
	position?: Readonly<{ above?: string }>
): Command & Readonly<{ id: string }> => {
	const id = freeLayerId(root);
	const made = cell<
		| Readonly<{ layer: Element; space: Text | undefined; declared: string | undefined }>
		| undefined
	>(undefined);
	return {
		id,
		label: ADD_LABELS[kind],
		apply: (live) => {
			const layer = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
			layer.setAttribute('id', id);
			const declared = declaring(live, () => writeLayerKind(live, layer, kind));
			const above =
				position?.above === undefined ? undefined : layerById(live, position.above);
			const anchor = above ?? live.lastElementChild ?? undefined;
			const space = anchor === undefined ? undefined : placeAfter(anchor, layer);
			if (anchor === undefined) live.appendChild(layer);
			made.current = { layer, space, declared };
		},
		revert: (live) => {
			const done = made.current;
			if (done === undefined) return;
			done.layer.remove();
			done.space?.remove();
			undeclare(live, done.declared);
		},
		bytes: SMALL_COMMAND_BYTES,
	};
};

/** A layer taken out, with its indentation, and put back exactly where it was. */
export const removeLayer = (id: string): Command => {
	const removed = cell<
		| Readonly<{
				layer: Element;
				parent: Node;
				next: Node | null;
				space: Text | undefined;
				bytes: number;
		  }>
		| undefined
	>(undefined);
	return {
		label: 'layers.delete',
		apply: (root) => {
			const layer = layerById(root, id);
			const parent = layer?.parentNode;
			if (layer === undefined || parent === null || parent === undefined) {
				removed.current = undefined;
				return;
			}
			const space = spaceBefore(layer);
			removed.current = {
				layer,
				parent,
				next: layer.nextSibling,
				space,
				bytes: markupSize(layer),
			};
			space?.remove();
			layer.remove();
		},
		revert: () => {
			const done = removed.current;
			if (done === undefined) return;
			done.parent.insertBefore(done.layer, done.next);
			if (done.space !== undefined) done.parent.insertBefore(done.space, done.layer);
		},
		get bytes() {
			return removed.current?.bytes ?? 0;
		},
	};
};

const nextLayerSibling = (element: Element | null): Element | undefined => {
	const next = element?.nextElementSibling ?? null;
	if (next === null) return undefined;
	return isLayerElement(next) ? next : nextLayerSibling(next);
};

export const previousLayerSibling = (element: Element | null): Element | undefined => {
	const previous = element?.previousElementSibling ?? null;
	if (previous === null) return undefined;
	return isLayerElement(previous) ? previous : previousLayerSibling(previous);
};

/** Two siblings trade places, each where the other was, the whitespace staying put. */
const swap = (one: Element, other: Element): void => {
	const mark = one.ownerDocument.createTextNode('');
	one.replaceWith(mark);
	other.replaceWith(one);
	mark.replaceWith(other);
};

/**
 * Up is toward the top of the drawing, later in document order: the layer
 * trades places with the next layer among its siblings, so it never leaves its
 * group. At the end there is nothing to trade with, and nothing is done.
 */
export const moveLayer = (id: string, direction: 'up' | 'down'): Command => {
	const moved = cell(false);
	const neighbor = (layer: Element, way: 'up' | 'down'): Element | undefined =>
		way === 'up' ? nextLayerSibling(layer) : previousLayerSibling(layer);
	return {
		label: direction === 'up' ? 'layers.moveUp' : 'layers.moveDown',
		apply: (root) => {
			const layer = layerById(root, id);
			const other = layer === undefined ? undefined : neighbor(layer, direction);
			moved.current = layer !== undefined && other !== undefined;
			if (layer !== undefined && other !== undefined) swap(layer, other);
		},
		revert: (root) => {
			if (!moved.current) return;
			const layer = layerById(root, id);
			const other =
				layer === undefined
					? undefined
					: neighbor(layer, direction === 'up' ? 'down' : 'up');
			if (layer !== undefined && other !== undefined) swap(layer, other);
		},
		get bytes() {
			return moved.current ? SMALL_COMMAND_BYTES : 0;
		},
	};
};

/**
 * A change to a layer's own attributes, through one of the writers in
 * `layers.ts`. The layer's attributes are kept before it, all of them in
 * order, so undo gives back the very attributes it had, and a namespace the
 * writer declared on the root is taken away again.
 */
export const attributeCommand = (
	id: string,
	label: string,
	write: (root: SVGSVGElement, layer: SVGGraphicsElement) => void
): Command => {
	const before = cell<
		| Readonly<{ attributes: readonly SavedAttribute[]; declared: string | undefined }>
		| undefined
	>(undefined);
	return {
		label,
		apply: (root) => {
			const layer = layerById(root, id);
			if (layer === undefined) {
				before.current = undefined;
				return;
			}
			const attributes = attributesOf(layer);
			before.current = { attributes, declared: declaring(root, () => write(root, layer)) };
		},
		revert: (root) => {
			const kept = before.current;
			const layer = layerById(root, id);
			if (kept === undefined || layer === undefined) return;
			resetAttributes(layer, kept.attributes);
			undeclare(root, kept.declared);
		},
		get bytes() {
			const kept = before.current;
			return kept === undefined ? 0 : SMALL_COMMAND_BYTES + savedBytes(kept.attributes);
		},
	};
};

/** `draw:name`; never `inkscape:label`, which is read and not written (§3). */
export const renameLayer = (id: string, name: string): Command =>
	attributeCommand(id, 'layers.rename', (root, layer) => writeLayerName(root, layer, name));

export const setLayerHidden = (id: string, hidden: boolean): Command =>
	attributeCommand(id, hidden ? 'layers.hide' : 'layers.show', (_root, layer) =>
		writeLayerHidden(layer, hidden)
	);

export const setLayerLocked = (id: string, locked: boolean): Command =>
	attributeCommand(id, locked ? 'layers.lock' : 'layers.unlock', (root, layer) =>
		writeLayerLocked(root, layer, locked)
	);

export const setLayerOpacity = (id: string, opacity: number): Command =>
	attributeCommand(id, 'layers.opacity', (_root, layer) => writeLayerOpacity(layer, opacity));

export const setLayerBlend = (id: string, blend: BlendMode): Command =>
	attributeCommand(id, 'layers.blend', (_root, layer) => writeLayerBlend(layer, blend));

/** `base-copy`, or `base-copy-2`, `base-copy-3`, … where that is taken. */
const copyId = (base: string, taken: ReadonlySet<string>): string =>
	Array.from({ length: taken.size + 1 }, (_, index) =>
		index === 0 ? `${base}-copy` : `${base}-copy-${index + 1}`
	).find((candidate) => !taken.has(candidate)) ?? `${base}-copy-${taken.size + 2}`;

const URL_REFERENCE = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g;

/** A value with every `url(#old)`, and a whole `#old` link, pointing at the new id instead. */
const rewriteReferences = (attribute: Attr, renamed: ReadonlyMap<string, string>): string => {
	const value = attribute.value.replace(URL_REFERENCE, (whole, quote: string, old: string) => {
		const next = renamed.get(old);
		return next === undefined ? whole : `url(${quote}#${next}${quote})`;
	});
	const isLink =
		attribute.localName === 'href' &&
		(attribute.namespaceURI === null || attribute.namespaceURI === XLINK_NAMESPACE);
	const linked = isLink && value.startsWith('#') ? renamed.get(value.slice(1)) : undefined;
	return linked === undefined ? value : `#${linked}`;
};

/**
 * A deep copy of a layer with ids of its own: `id` for the copy itself, the
 * next free `layer-n` for each layer inside a copied group, and `old-copy`
 * for anything else inside that has an id. Every reference inside the copy to
 * something copied with it, a gradient's `url(#…)` or a `<use>`'s `#…`, is
 * pointed at the copy; references to things outside stay as they were. An
 * element `kept` says of keeps its id, and what refers to it still does: for
 * what is moved rather than copied, which leaves the original behind.
 */
export const copyOf = (
	root: Element,
	original: Element,
	id: string,
	kept: (element: Element, copy: Element) => boolean = () => false
): Element => {
	const copy = original.cloneNode(true) as Element;
	const taken = new Set([...idsIn(root), id]);
	const renamed = new Map<string, string>();
	const originalId = original.getAttribute('id');
	if (originalId !== null && originalId !== '') renamed.set(originalId, id);
	copy.setAttribute('id', id);
	const layers = new Set<Element>(layersWithin(copy));
	[...copy.querySelectorAll('[id]')].forEach((element) => {
		const old = element.getAttribute('id') ?? '';
		if (old === '' || kept(element, copy)) return;
		const next = layers.has(element) ? freeLayerIdAmong(taken) : copyId(old, taken);
		taken.add(next);
		renamed.set(old, next);
		element.setAttribute('id', next);
	});
	[copy, ...copy.querySelectorAll('*')].forEach((element) =>
		[...element.attributes].forEach((attribute) => {
			const value = rewriteReferences(attribute, renamed);
			if (value !== attribute.value)
				element.setAttributeNS(attribute.namespaceURI, attribute.name, value);
		})
	);
	return copy;
};

/**
 * A copy of the layer `id` just above it, in the same parent: `make` builds
 * it from the live original the first time, and redo puts the same copy back.
 */
export const placeCopy = (
	id: string,
	label: string,
	make: (root: SVGSVGElement, original: Element) => Element
): Command => {
	const made = cell<
		Readonly<{ copy: Element; space: Text | undefined; bytes: number }> | undefined
	>(undefined);
	return {
		label,
		apply: (live) => {
			const original = layerById(live, id);
			if (original === undefined) return;
			const copy = made.current?.copy ?? make(live, original);
			const space = placeAfter(original, copy);
			made.current = { copy, space, bytes: made.current?.bytes ?? markupSize(copy) };
		},
		revert: () => {
			const done = made.current;
			if (done === undefined) return;
			done.copy.remove();
			done.space?.remove();
		},
		get bytes() {
			return made.current?.bytes ?? 0;
		},
	};
};

/**
 * A command that says the id of the layer it makes, for the caller to make
 * active. Its cost is read through, never copied, since it is known only once
 * the command has run.
 */
export const withLayerId = (id: string, command: Command): Command & Readonly<{ id: string }> => ({
	id,
	label: command.label,
	apply: command.apply,
	revert: command.revert,
	get bytes() {
		return command.bytes;
	},
});

/** A copy of the layer just above it, in the same parent, under the next free `layer-n`. */
export const duplicateLayer = (
	root: SVGSVGElement,
	id: string
): Command & Readonly<{ id: string }> => {
	const copyIdentifier = freeLayerId(root);
	return withLayerId(
		copyIdentifier,
		placeCopy(id, 'layers.duplicate', (live, original) =>
			copyOf(live, original, copyIdentifier)
		)
	);
};

/**
 * A loose element, a graphics element at the root that is not a `<g>`, put in
 * a vector `<g>` of its own where it was, the first time it is edited (§3).
 * An id of the form `layer-n` was given on open, so it goes to the group, and
 * the layer keeps its number and stays the active one; any other id is the
 * file's own, which something may refer to, so it stays on the element and the
 * group gets the next free `layer-n`. Undo takes the element out again with
 * its attributes as they were.
 */
export const wrapLooseLayer = (
	root: SVGSVGElement,
	id: string
): Command & Readonly<{ id: string }> => {
	const givesId = layerNumber(id) !== undefined;
	const groupId = givesId ? id : freeLayerId(root);
	const wrapped = cell<
		| Readonly<{ attributes: readonly SavedAttribute[]; declared: string | undefined }>
		| undefined
	>(undefined);
	return {
		id: groupId,
		label: 'layers.wrap',
		apply: (live) => {
			const element = layerById(live, id);
			if (element === undefined || element.localName === 'g') return;
			const attributes = attributesOf(element);
			const group = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
			if (givesId) element.removeAttribute('id');
			group.setAttribute('id', groupId);
			const declared = declaring(live, () => writeLayerKind(live, group, 'vector'));
			element.replaceWith(group);
			group.appendChild(element);
			wrapped.current = { attributes, declared };
		},
		revert: (live) => {
			const kept = wrapped.current;
			const group = layerById(live, groupId);
			const element = group?.firstElementChild ?? null;
			if (kept === undefined || group === undefined || element === null) return;
			group.replaceWith(element);
			resetAttributes(element, kept.attributes);
			undeclare(live, kept.declared);
		},
		get bytes() {
			const kept = wrapped.current;
			return kept === undefined ? 0 : SMALL_COMMAND_BYTES + savedBytes(kept.attributes);
		},
	};
};

/**
 * Several commands as one step of the history: applied in order, reverted in
 * the reverse, so a picture placed as a new layer, or a merge that makes one
 * layer of two, is one undo. Each part still finds its elements by id.
 */
export const compound = (label: string, parts: readonly Command[]): Command => ({
	label,
	apply: (root) => {
		parts.forEach((part) => part.apply(root));
	},
	revert: (root) => {
		[...parts].reverse().forEach((part) => part.revert(root));
	},
	get bytes() {
		return parts.reduce((total, part) => total + part.bytes, 0);
	},
});
