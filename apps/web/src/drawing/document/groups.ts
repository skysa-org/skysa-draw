import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { compound, removeLayer } from './commands.js';
import {
	attributesOf,
	declaring,
	isSpace,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
	undeclare,
} from './dom.js';
import {
	freeLayerId,
	isLayerElement,
	layerById,
	layerKindOf,
	styleValue,
	writeLayerKind,
} from './layers.js';
import type { Command } from './model.js';

/**
 * Groups (docs/decisions/0003-layers.md: "a `group` is a `<g>` of layers …
 * for the folders every layers panel has"): a layer put in a new group of its
 * own where it was, and a group's layers put back in its parent where it was.
 * Moving a layer up or down keeps it among its siblings (`moveLayer`); a
 * drag in the layers panel moves it into or out of a group (`arrange.ts`).
 */

/**
 * The layer in a new `<g draw:kind="group">` in its place, under the next free
 * `layer-n`, which the caller makes the active layer. Undo takes the layer
 * out of the group again and the group away.
 */
export const groupLayer = (root: SVGSVGElement, id: string): Command & Readonly<{ id: string }> => {
	const groupId = freeLayerId(root);
	const declared = cell<string | undefined>(undefined);
	const grouped = cell(false);
	return {
		id: groupId,
		label: 'layers.group',
		apply: (live) => {
			const layer = layerById(live, id);
			grouped.current = layer !== undefined;
			if (layer === undefined) return;
			const group = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'g');
			group.setAttribute('id', groupId);
			declared.current = declaring(live, () => writeLayerKind(live, group, 'group'));
			layer.replaceWith(group);
			group.appendChild(layer);
		},
		revert: (live) => {
			const group = layerById(live, groupId);
			const layer = [...(group?.children ?? [])].find(
				(child) => child.getAttribute('id') === id
			);
			if (group === undefined || layer === undefined) return;
			group.replaceWith(layer);
			undeclare(live, declared.current);
		},
		get bytes() {
			return grouped.current ? SMALL_COMMAND_BYTES : 0;
		},
	};
};

/** `display` values that change nothing: Inkscape writes `display:inline` on every layer. */
const SHOWN = new Set(['inline', 'block', 'inherit', 'initial', 'unset']);

/**
 * Why the group cannot be undone without changing the picture, or nothing. Its
 * layers take its place and its transform, each, and lose everything else it
 * says: an opacity, a blend mode, a filter, a mask, a fill they inherit, or
 * its being hidden. So a group that says any of that keeps its layers.
 */
export const ungroupProblem = (root: Element, id: string): 'notGroup' | 'styled' | undefined => {
	const group = layerById(root, id);
	if (group === undefined || group.localName !== 'g' || layerKindOf(group) !== 'group') {
		return 'notGroup';
	}
	const styled = [...group.attributes].some((attribute) => {
		if (attribute.namespaceURI !== null) return false;
		if (attribute.name === 'id' || attribute.name === 'transform') return false;
		if (attribute.name !== 'style') return true;
		const display = styleValue(group, 'display');
		const others = attribute.value
			.split(';')
			.filter((declaration) => declaration.trim() !== '')
			.some((declaration) => !/^\s*display\s*:/i.test(declaration));
		return others || (display !== undefined && !SHOWN.has(display.toLowerCase()));
	});
	return styled ? 'styled' : undefined;
};

/** A node the history can find again: a layer by its id, anything else as itself. */
type Anchor = Readonly<{ id: string }> | Readonly<{ node: Node }>;

const anchorOf = (node: Node): Anchor => {
	const id = node instanceof Element && isLayerElement(node) ? node.getAttribute('id') : null;
	return id === null || id === '' ? { node } : { id };
};

const resolve = (root: Element, anchor: Anchor): Node | undefined =>
	'id' in anchor ? layerById(root, anchor.id) : anchor.node;

/** The siblings from `first` to `last`, both included. */
const runFrom = (first: Node | null, last: Node): readonly Node[] => {
	if (first === null) return [];
	return first === last ? [first] : [first, ...runFrom(first.nextSibling, last)];
};

type Ungrouped = Readonly<{
	/** The group, out of the document, holding the indentation of its first and last lines. */
	group: Element;
	trail: Node | undefined;
	first: Anchor;
	last: Anchor;
	/** Each layer's attributes as they were before the group's transform went onto it. */
	layers: readonly Readonly<{ id: string; attributes: readonly SavedAttribute[] }>[];
}>;

/**
 * The group's contents in its place, and the group gone: everything it held
 * but the indentation before its first child and after its last, which go
 * with it, and its `transform`, if it has one, before each layer's own, so
 * every layer stays where it was drawn. A group with nothing in it is just
 * deleted. Nothing, costing nothing, for a group `ungroupProblem` names.
 */
export const ungroupLayer = (root: SVGSVGElement, id: string): Command => {
	if (ungroupProblem(root, id) !== undefined) return compound('layers.ungroup', []);
	const group = layerById(root, id);
	const holds = [...(group?.childNodes ?? [])].some((node) => !isSpace(node));
	if (!holds) return compound('layers.ungroup', [removeLayer(id)]);
	const done = cell<Ungrouped | undefined>(undefined);
	return {
		label: 'layers.ungroup',
		apply: (live) => {
			const element = layerById(live, id);
			if (element === undefined) return;
			const nodes = [...element.childNodes];
			const lead = isSpace(nodes[0] ?? null) ? nodes[0] : undefined;
			const end = nodes.at(-1);
			const trail = nodes.length > 1 && isSpace(end ?? null) ? end : undefined;
			const moved = nodes.filter((node) => node !== lead && node !== trail);
			const [first] = moved;
			const last = moved.at(-1);
			if (first === undefined || last === undefined) return;
			const layers = moved.filter(
				(node): node is SVGGraphicsElement =>
					node instanceof Element && isLayerElement(node)
			);
			const transform = element.getAttribute('transform')?.trim() ?? '';
			done.current = {
				group: element,
				trail,
				first: anchorOf(first),
				last: anchorOf(last),
				layers: layers.map((layer) => ({
					id: layer.getAttribute('id') ?? '',
					attributes: attributesOf(layer),
				})),
			};
			if (transform !== '') {
				layers.forEach((layer) => {
					const own = layer.getAttribute('transform')?.trim() ?? '';
					layer.setAttribute('transform', own === '' ? transform : `${transform} ${own}`);
				});
			}
			element.before(...moved);
			element.remove();
		},
		revert: (live) => {
			const kept = done.current;
			if (kept === undefined) return;
			const first = resolve(live, kept.first);
			const last = resolve(live, kept.last);
			const parent = first?.parentNode ?? null;
			if (first === undefined || last === undefined || parent === null) return;
			const run = runFrom(first, last);
			parent.insertBefore(kept.group, first);
			run.forEach((node) => kept.group.insertBefore(node, kept.trail ?? null));
			kept.layers.forEach(({ id: layerId, attributes }) => {
				const layer = layerById(live, layerId);
				if (layer !== undefined) resetAttributes(layer, attributes);
			});
		},
		get bytes() {
			const kept = done.current;
			return kept === undefined
				? 0
				: kept.layers.reduce(
						(total, layer) =>
							total + SMALL_COMMAND_BYTES + savedBytes(layer.attributes),
						SMALL_COMMAND_BYTES
					);
		},
	};
};
