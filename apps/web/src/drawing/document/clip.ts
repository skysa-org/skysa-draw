import { SVG_NAMESPACE } from '@skysa/draw-core';

import { attributeCommand, compound, previousLayerSibling } from './commands.js';
import { removeUnreferenced, setDefinition } from './definitions.js';
import { definitionById, freeIdFrom, isSvgElement, soleReference } from './dom.js';
import { idsIn, layerById, styleValue } from './layers.js';
import type { Command } from './model.js';

/**
 * A layer clipped to the one below it (docs/decisions/0003-layers.md: "a
 * mask, a clip and an adjustment are `mask`, `clip-path` and `filter`
 * referring into the root's `<defs>`"): Photoshop's clipping mask, which shows
 * the layer only where the layer below has paint, said SVG's way. The layer
 * gets `mask="url(#clip-<its id>)"`, and the `<defs>` a mask of that id whose
 * one child is a `<use>` of the layer below, read by its alpha:
 *
 * ```xml
 * <mask id="clip-layer-3" style="mask-type:alpha"><use href="#layer-2"/></mask>
 * ```
 *
 * The mask names the layer below by its id, as everything here does, so the
 * clip follows that layer when either is moved, and a layer clipped to one
 * that is deleted shows nothing until the clip is released. A mask of the
 * file's own, or of another tool's, is never touched.
 */

const CLIP_PREFIX = 'clip-';

type ClipState = 'none' | 'clipped' | 'foreign';

/** A `<mask>` that is the app's clip: its id says so, and it holds one `<use>` of a `#…`. */
const isOwnClip = (mask: Element, id: string): boolean => {
	const children = [...mask.children];
	const [only] = children;
	return (
		id.startsWith(CLIP_PREFIX) &&
		children.length === 1 &&
		isSvgElement(only ?? null, 'use') &&
		(only?.getAttribute('href') ?? '').startsWith('#')
	);
};

/** The id of the app's clip mask the layer uses, or nothing. */
const ownClipId = (root: Element, layer: Element): string | undefined => {
	const id = soleReference(layer.getAttribute('mask'));
	if (id === undefined || styleValue(layer, 'mask') !== undefined) return undefined;
	const mask = definitionById(root, id, 'mask');
	return mask !== undefined && isOwnClip(mask, id) ? id : undefined;
};

/** Whether the layer is clipped by the app, masked some other way, or neither. */
export const clipStateOf = (root: Element, layer: Element): ClipState => {
	if (ownClipId(root, layer) !== undefined) return 'clipped';
	const masked = layer.hasAttribute('mask') || styleValue(layer, 'mask') !== undefined;
	return masked ? 'foreign' : 'none';
};

/** The layer below this one among its siblings, which a clip would show it through. */
export const layerBelow = (root: Element, id: string): Element | undefined => {
	const layer = layerById(root, id);
	return layer === undefined ? undefined : previousLayerSibling(layer);
};

/**
 * The layer clipped to the one below it, as one step: the mask made in the
 * `<defs>`, then the attribute on the layer. Nothing, costing nothing, for a
 * layer at the bottom of its group, or one already masked; the panel says why
 * for one masked by another tool (CLAUDE.md: never rewrite what the app did
 * not write).
 */
export const clipToBelow = (root: SVGSVGElement, id: string): Command => {
	const layer = layerById(root, id);
	const below = layerBelow(root, id)?.getAttribute('id') ?? '';
	if (layer === undefined || below === '' || clipStateOf(root, layer) !== 'none') {
		return compound('layers.clip', []);
	}
	const maskId = freeIdFrom(`${CLIP_PREFIX}${id}`, idsIn(root));
	const make = (live: SVGSVGElement): Element => {
		const mask = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'mask');
		mask.setAttribute('id', maskId);
		mask.setAttribute('style', 'mask-type:alpha');
		const use = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'use');
		use.setAttribute('href', `#${below}`);
		mask.appendChild(use);
		return mask;
	};
	return compound('layers.clip', [
		setDefinition(maskId, 'mask', make),
		attributeCommand(id, 'layers.clip', (_root, target) =>
			target.setAttribute('mask', `url(#${maskId})`)
		),
	]);
};

/**
 * The clip taken off: the attribute first, then the mask, unless something
 * else still uses it, a copy of the layer made by duplicating it.
 */
export const releaseClip = (root: SVGSVGElement, id: string): Command => {
	const layer = layerById(root, id);
	const maskId = layer === undefined ? undefined : ownClipId(root, layer);
	if (maskId === undefined) return compound('layers.unclip', []);
	return compound('layers.unclip', [
		attributeCommand(id, 'layers.unclip', (_root, target) => target.removeAttribute('mask')),
		removeUnreferenced([{ id: maskId, localName: 'mask' }]),
	]);
};
