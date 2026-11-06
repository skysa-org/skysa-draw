import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { invert, type Mat, multiply, parseTransform, translate } from '../tools/vector/geometry.js';
import { isPlainTransform, matrixText, numberOf, tidy } from './canvasTransform.js';
import { attributeCommand, compound, previousLayerSibling } from './commands.js';
import { removeUnreferenced, setDefinition } from './definitions.js';
import {
	attributesOf,
	definitionById,
	freeIdFrom,
	isSvgElement,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
	soleReference,
} from './dom.js';
import { idsIn, layerById, layerElementsOf, styleValue } from './layers.js';
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
 * <mask id="clip-layer-3" style="mask-type:alpha"><use href="#layer-2" transform="translate(-40 0)"/></mask>
 * ```
 *
 * The mask names the layer below by its id, as everything here does, so the
 * clip follows that layer when either is moved, and a layer clipped to one
 * that is deleted shows nothing until the clip is released. A mask of the
 * file's own, or of another tool's, is never touched.
 *
 * A mask is drawn in the user space of the element that uses it, the
 * clipped layer's own `transform` included, so the `<use>` carries the
 * inverse of that `transform` (`clipTransformOf`), none where the layer has
 * none: the layer below is drawn inside the mask exactly where it is drawn
 * on the canvas, and a move of the clipped layer moves its paint over the
 * layer below and leaves the clip's shape where it is, as Photoshop's does.
 * Inside a group nothing more is needed, since the group's `transform` is
 * common to both. Every command that changes a layer's own `transform` is
 * wrapped in `keepingClips`, which keeps this true in the same step, and a
 * drag that moves layers live shows it live (`previewClips`). A file whose
 * `<use>` does not say so, made before this or by hand, is left as it is
 * until its clipped layer's `transform` is changed.
 *
 * A duplicate of a clipped layer shares its mask. The first change that
 * would give the two different `transform`s gives the one changed a mask of
 * its own, `clip-<its id>`, as a filter two layers share is forked on its
 * first edit (`adjustments.ts`).
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

/** The one `<use>` of the app's clip mask `maskId`. */
const clipUseOf = (root: Element, maskId: string): Element | undefined => {
	const mask = definitionById(root, maskId, 'mask');
	return mask !== undefined && isOwnClip(mask, maskId)
		? (mask.firstElementChild ?? undefined)
		: undefined;
};

/** Past float noise, two transforms are the same. */
const SLACK = 1e-6;

const sameMatrix = (one: Mat, other: Mat): boolean =>
	one.every((value, index) => Math.abs(value - (other[index] ?? 0)) < SLACK);

/**
 * The matrix as a `transform`: `translate(x y)` where it only moves, as the
 * inverse of a move does, `matrix(…)` otherwise, and the empty string, no
 * attribute, for the identity.
 */
const transformText = (m: Mat): string => {
	const [a, b, c, d, e, f] = m;
	const moves = sameMatrix([a, b, c, d, 0, 0], [1, 0, 0, 1, 0, 0]);
	if (!moves) return matrixText(m);
	return sameMatrix(m, [1, 0, 0, 1, 0, 0]) ? '' : `translate(${tidy(e)} ${tidy(f)})`;
};

/**
 * The inverse of an element's own `transform`; none where it is not SVG's
 * own list of plain numbers, which cannot be read as one matrix exactly, or
 * where it flattens the plane, which draws nothing.
 */
const inverseOf = (element: Element): Mat | undefined => {
	const text = element.getAttribute('transform')?.trim() ?? '';
	if (text !== '' && !isPlainTransform(text)) return undefined;
	const m = parseTransform(text);
	return Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-12 ? undefined : invert(m);
};

/**
 * The `transform` a clip's `<use>` has for `element`, which the clip masks:
 * the inverse of the element's own `transform`, before the `<use>`'s own `x`
 * and `y`, which SVG draws after it, so the layer below is drawn inside the
 * mask where it is drawn outside it. The empty string for none; nothing
 * where the element's `transform` has no inverse to write (`inverseOf`).
 */
const clipTransformOf = (element: Element, use?: Element): string | undefined => {
	const inverse = inverseOf(element);
	if (inverse === undefined) return undefined;
	const x = use === undefined ? 0 : numberOf(use, 'x');
	const y = use === undefined ? 0 : numberOf(use, 'y');
	return transformText(multiply(inverse, translate(-x, -y)));
};

/** Whether two `transform`s, the empty string or `null` for none, are the same matrix. */
const sameTransform = (one: string | null | undefined, other: string | undefined): boolean =>
	one !== undefined &&
	other !== undefined &&
	sameMatrix(parseTransform(one), parseTransform(other));

/** `transform` set, or taken off for none. */
const writeTransform = (element: Element, value: string): void => {
	if (value === '') element.removeAttribute('transform');
	else element.setAttribute('transform', value);
};

/** The mask `maskId` as `clipToBelow` makes it: a `<use>` of `below`, carrying `transform`. */
const clipMask = (
	live: SVGSVGElement,
	maskId: string,
	below: string,
	transform: string
): Element => {
	const mask = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'mask');
	mask.setAttribute('id', maskId);
	mask.setAttribute('style', 'mask-type:alpha');
	const use = live.ownerDocument.createElementNS(SVG_NAMESPACE, 'use');
	use.setAttribute('href', `#${below}`);
	writeTransform(use, transform);
	mask.appendChild(use);
	return mask;
};

/**
 * The layer clipped to the one below it, as one step: the mask made in the
 * `<defs>`, its `<use>` carrying the inverse of the layer's `transform`
 * (`clipTransformOf`), then the attribute on the layer. Nothing, costing
 * nothing, for a layer at the bottom of its group, or one already masked;
 * the panel says why for one masked by another tool (CLAUDE.md: never
 * rewrite what the app did not write).
 */
export const clipToBelow = (root: SVGSVGElement, id: string): Command => {
	const layer = layerById(root, id);
	const below = layerBelow(root, id)?.getAttribute('id') ?? '';
	if (layer === undefined || below === '' || clipStateOf(root, layer) !== 'none') {
		return compound('layers.clip', []);
	}
	const maskId = freeIdFrom(`${CLIP_PREFIX}${id}`, idsIn(root));
	const make = (live: SVGSVGElement): Element => {
		const target = layerById(live, id);
		const transform = target === undefined ? undefined : clipTransformOf(target);
		return clipMask(live, maskId, below, transform ?? '');
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

/**
 * The `<use>` of the clip `maskId` given `transform`, none for the empty
 * string. Its attributes are kept before, all of them in order, so undo
 * gives back the very bytes.
 */
const setClipTransform = (maskId: string, transform: string): Command => {
	const before = cell<readonly SavedAttribute[] | undefined>(undefined);
	return {
		label: 'layers.clip',
		apply: (root) => {
			const use = clipUseOf(root, maskId);
			before.current = use === undefined ? undefined : attributesOf(use);
			if (use !== undefined) writeTransform(use, transform);
		},
		revert: (root) => {
			const use = clipUseOf(root, maskId);
			if (use !== undefined && before.current !== undefined) {
				resetAttributes(use, before.current);
			}
		},
		get bytes() {
			const kept = before.current;
			return kept === undefined ? 0 : SMALL_COMMAND_BYTES + savedBytes(kept);
		},
	};
};

/**
 * The layer's `mask` pointed at the clip `maskId`. Only that attribute is
 * kept and put back, and a clipped layer always has it, so it keeps its
 * place among the layer's attributes, and a drag that moves the layer's
 * `transform` meanwhile is not undone with it.
 */
const pointClip = (layerId: string, maskId: string): Command => {
	const before = cell<string | null | undefined>(undefined);
	return {
		label: 'layers.clip',
		apply: (root) => {
			const layer = layerById(root, layerId);
			before.current = layer?.getAttribute('mask');
			layer?.setAttribute('mask', `url(#${maskId})`);
		},
		revert: (root) => {
			const layer = layerById(root, layerId);
			const old = before.current;
			if (layer === undefined || old === undefined) return;
			if (old === null) layer.removeAttribute('mask');
			else layer.setAttribute('mask', old);
		},
		get bytes() {
			return before.current === undefined ? 0 : SMALL_COMMAND_BYTES;
		},
	};
};

/**
 * The layer given a mask of its own, a copy of the shared mask `from` as
 * `clip-<its id>`, or the next free id from there, its `<use>` carrying
 * `transform`.
 */
const forkClip = (
	root: SVGSVGElement,
	layerId: string,
	from: string,
	transform: string
): Command => {
	const maskId = freeIdFrom(`${CLIP_PREFIX}${layerId}`, idsIn(root));
	const make = (live: SVGSVGElement): Element => {
		const source = definitionById(live, from, 'mask');
		const copy = (source?.cloneNode(true) ??
			live.ownerDocument.createElementNS(SVG_NAMESPACE, 'mask')) as Element;
		copy.setAttribute('id', maskId);
		const use = copy.firstElementChild;
		if (use !== null) writeTransform(use, transform);
		return copy;
	};
	return compound('layers.clip', [
		setDefinition(maskId, 'mask', make),
		pointClip(layerId, maskId),
	]);
};

/** Everything that uses the mask `maskId` by its `mask` attribute. */
const usersOf = (root: Element, maskId: string): readonly Element[] =>
	[...root.querySelectorAll('[mask]')].filter(
		(element) => soleReference(element.getAttribute('mask')) === maskId
	);

/**
 * What keeps the clip of `layer` true once its `transform` changed: its
 * `<use>` given the inverse of the new one, in place where nothing else
 * uses the mask or everything that does has the same `transform`, and in a
 * mask of the layer's own where something that uses it has another;
 * nothing where it is true already, or where the layer is not clipped by
 * the app, or has no inverse to write.
 */
const keepClip = (root: SVGSVGElement, layer: Element): Command | undefined => {
	const layerId = layer.getAttribute('id') ?? '';
	const maskId = ownClipId(root, layer);
	const use = maskId === undefined ? undefined : clipUseOf(root, maskId);
	const transform = use === undefined ? undefined : clipTransformOf(layer, use);
	if (maskId === undefined || use === undefined || transform === undefined) return undefined;
	const shared = usersOf(root, maskId).some(
		(other) => other !== layer && !sameTransform(clipTransformOf(other, use), transform)
	);
	if (shared) return forkClip(root, layerId, maskId, transform);
	return sameTransform(use.getAttribute('transform'), transform)
		? undefined
		: setClipTransform(maskId, transform);
};

/** The `transform` of every layer the app clips, by id, `null` for none: what `keepClips` compares with. */
type ClipTransforms = ReadonlyMap<string, string | null>;

const clipTransformsOf = (root: SVGSVGElement): ClipTransforms =>
	new Map(
		layerElementsOf(root)
			.filter((layer) => ownClipId(root, layer) !== undefined)
			.map((layer) => [layer.getAttribute('id') ?? '', layer.getAttribute('transform')])
	);

/**
 * The clip kept true, one after another, for every layer of `before` whose
 * `transform` is not what it was, each applied as it is made so the next
 * sees what it did: the commands, applied, for a redo to apply again and an
 * undo to revert in the reverse order.
 */
const keepClips = (root: SVGSVGElement, before: ClipTransforms): readonly Command[] =>
	[...before].reduce<readonly Command[]>((kept, [id, transform]) => {
		const layer = layerById(root, id);
		if (layer === undefined || layer.getAttribute('transform') === transform) return kept;
		const keep = keepClip(root, layer);
		keep?.apply(root);
		return keep === undefined ? kept : [...kept, keep];
	}, []);

/**
 * `command`, which may change layers' own `transform`s, with the clip of
 * every one it changes kept true in the same step, so one undo puts both
 * back: a move, a nudge, an alignment, a layer carried into or out of a
 * group, an ungroup, the Image operations. What it must do is found once,
 * on the first apply, against the document as the command found it; redo
 * does the same again.
 */
export const keepingClips = (command: Command): Command => {
	const kept = cell<readonly Command[] | undefined>(undefined);
	return {
		label: command.label,
		apply: (root) => {
			const known = kept.current;
			if (known !== undefined) {
				command.apply(root);
				known.forEach((each) => each.apply(root));
				return;
			}
			const before = clipTransformsOf(root);
			command.apply(root);
			kept.current = keepClips(root, before);
		},
		revert: (root) => {
			[...(kept.current ?? [])].reverse().forEach((each) => each.revert(root));
			command.revert(root);
		},
		get bytes() {
			return (kept.current ?? []).reduce((total, each) => total + each.bytes, command.bytes);
		},
	};
};

/** The clips of layers a drag moves live, kept true as it goes, and put back as they were. */
export type ClipPreview = Readonly<{
	/** After the drag set the layers' `transform`s: every clip of a layer it moved kept true. */
	follow: () => void;
	/** Every clip as it was when the drag began, for the drag's command to find. */
	putBack: () => void;
}>;

/**
 * A preview of what `keepingClips` will do once a drag that moves layers by
 * their `transform` ends, so a clipped layer slides over the layer below
 * while the clip stays: each `follow` takes back what the last did and
 * keeps the clips again against the layers as they were when the preview
 * was made. Nothing here is in the history; `putBack` leaves the document
 * as the drag found it, but for the drag's own `transform`s.
 */
export const previewClips = (root: SVGSVGElement): ClipPreview => {
	const before = clipTransformsOf(root);
	const shown = cell<readonly Command[]>([]);
	const putBack = (): void => {
		[...shown.current].reverse().forEach((each) => each.revert(root));
		shown.current = [];
	};
	return {
		follow: () => {
			putBack();
			shown.current = keepClips(root, before);
		},
		putBack,
	};
};
