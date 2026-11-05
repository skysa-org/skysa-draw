import { cell } from '@skysa/draw-core';

import { clipStateOf } from '../document/clip.js';
import {
	isLayerElement,
	layerBlendOf,
	layerById,
	layerOpacityOf,
	styleValue,
} from '../document/layers.js';
import { quoted } from '../tools/raster/hole.js';
import { shadowOf } from './shadow.js';

/**
 * The layers over a live raster stroke (docs/ARCHITECTURE.md §7, "Tools"). A
 * stroke, a smudge or a move is painted on a canvas over the drawing while it
 * lasts (`LiveCanvas`), and on its own that canvas is over every layer, so
 * what is painted on a layer under another would show over it, and go under
 * it only once it landed. While the canvas shows a layer's paint, the layers
 * painted after that one are lifted over the canvas: they are shown on a copy
 * of the drawing on a stage of their own over it (`StageCover`), every other
 * layer of the copy made clear, and made clear in the drawing under it by a
 * rule beside its root, as the move's hole is (`hole.ts`). The root itself is
 * never touched, so a save while it lasts writes the drawing as it is.
 *
 * Layers painted plainly over one another look the same however they are
 * grouped, so the copy shows them as the drawing would. A layer is lifted
 * only in a run of them at the top that are each painted plainly: `normal`,
 * with nothing in them blended with what is under them, which would be
 * nothing on the copy. A group that takes its layers as one picture, with an
 * opacity, a blend, a mask, a filter or a clip, is lifted whole or not at
 * all, and a layer clipped to the one below it only with that one. What is
 * not lifted stays under the stroke, as everything did before.
 */

/** Whether an element says how it is painted onto what is under it in this way. */
const says = (element: Element, property: string): boolean =>
	element.hasAttribute(property) || styleValue(element, property) !== undefined;

/** Whether a group, or the root, paints its layers as if each were painted on its own. */
const isPassThrough = (element: Element): boolean =>
	layerOpacityOf(element) >= 1 &&
	layerBlendOf(element) === 'normal' &&
	!['mask', 'filter', 'clip-path'].some((property) => says(element, property));

/** The element and the groups it is in, innermost first, up to the root's child. */
const chainOf = (root: Element, element: Element): readonly Element[] => {
	const parent = element.parentElement;
	if (parent === null) return [];
	return parent === root ? [element] : [element, ...chainOf(root, parent)];
};

const siblingsOf = (element: Element): readonly Element[] => [
	...(element.parentElement?.children ?? []),
];

/** The layers painted after an element among its siblings, in paint order. */
const layersAfter = (element: Element): readonly Element[] => {
	const siblings = siblingsOf(element);
	return siblings.slice(siblings.indexOf(element) + 1).filter(isLayerElement);
};

/** The layer under this one among its siblings, which a clip shows it through (`clip.ts`). */
const layerUnder = (layer: Element): Element | undefined => {
	const siblings = siblingsOf(layer);
	return siblings.slice(0, siblings.indexOf(layer)).filter(isLayerElement).at(-1);
};

/** Whether a layer, and everything in it, is painted over what is under it as it is. */
const paintsPlainly = (layer: Element): boolean =>
	layer.id !== '' &&
	layerBlendOf(layer) === 'normal' &&
	layer.querySelector('[style*="blend"]') === null;

/** The longest run at the end of `layers` whose every one keeps. */
const topRun = (
	layers: readonly Element[],
	keeps: (layer: Element) => boolean
): readonly Element[] =>
	layers.slice(layers.reduce((cut, layer, index) => (keeps(layer) ? cut : index + 1), 0));

/** The run from above any layer clipped to one that is not in it. */
const withTheirClips = (root: Element, run: readonly Element[]): readonly Element[] =>
	run.slice(
		run.reduce((cut, layer, index) => {
			if (clipStateOf(root, layer) !== 'clipped') return cut;
			const under = layerUnder(layer);
			return under !== undefined && run.slice(cut, index).includes(under) ? cut : index + 1;
		}, 0)
	);

/**
 * The layers lifted over a live stroke on `layer`, in paint order, each a
 * whole one: none where the root itself takes its layers as one picture.
 */
export const liftedOver = (root: Element, layer: Element): readonly Element[] => {
	if (!isPassThrough(root)) return [];
	const chain = chainOf(root, layer);
	const closed = chain
		.slice(1)
		.filter((group) => !isPassThrough(group))
		.at(-1);
	const levels = chain.slice(closed === undefined ? 0 : chain.indexOf(closed));
	return withTheirClips(root, topRun(levels.flatMap(layersAfter), paintsPlainly));
};

/** In the copy, every layer made clear but those lifted and the groups they are in. */
const keepOnly = (
	parent: Element,
	lifted: ReadonlySet<string>,
	holding: ReadonlySet<string>
): void => {
	[...parent.children].filter(isLayerElement).forEach((layer) => {
		if (lifted.has(layer.id)) return;
		if (holding.has(layer.id)) {
			keepOnly(layer, lifted, holding);
			return;
		}
		layer.style.setProperty('opacity', '0', 'important');
	});
};

/** The pictures the copy shows, which it waits for, so a lifted layer never blinks out. */
const picturesIn = (copy: Element, lifted: ReadonlySet<string>): readonly Element[] =>
	[...lifted]
		.map((id) => layerById(copy, id))
		.flatMap((layer) =>
			layer === undefined
				? []
				: [
						...(layer.localName === 'image' ? [layer] : []),
						...layer.querySelectorAll('image'),
					]
		);

/** How long the copy waits for its pictures before it is shown anyway, in milliseconds. */
export const PICTURE_WAIT_MS = 250;

/** `done` once every picture has loaded or failed to, or after `PICTURE_WAIT_MS`. */
const whenLoaded = (pictures: readonly Element[], done: () => void): void => {
	if (pictures.length === 0) {
		done();
		return;
	}
	const left = cell(pictures.length);
	const one = (): void => {
		left.current -= 1;
		if (left.current === 0) done();
	};
	pictures.forEach((picture) => {
		picture.addEventListener('load', one, { once: true });
		picture.addEventListener('error', one, { once: true });
	});
	setTimeout(done, PICTURE_WAIT_MS);
};

/** Where a cover lifts: the drawing, where it is mounted, and where the copy goes. */
type CoverPlace = Readonly<{
	/** The drawing's root, the document's own. */
	root: SVGSVGElement;
	/** The shadow root the drawing is mounted in, where the rule goes. */
	drawing: ShadowRoot | undefined;
	/** The element the copy is mounted on, in a shadow root of its own. */
	host: HTMLElement | null;
	/** The live canvas, hidden while the copy waits for its pictures. */
	canvas: HTMLElement | null;
}>;

export type Cover = Readonly<{
	/**
	 * The layers over the one with this id lifted over the live canvas, which
	 * shows that layer's paint; `undefined` puts them back, as the canvas is
	 * cleared. Lifting again for what is lifted does nothing.
	 */
	lift: (layerId: string | undefined, place?: CoverPlace) => void;
}>;

type Shown = Readonly<{
	layerId: string;
	root: Element;
	copy: Element;
	rule: Element;
	/** What is hidden while the copy waits: the copy's own element, and the live canvas. */
	waiting: readonly HTMLElement[];
}>;

export const createCover = (): Cover => {
	const shown = cell<Shown | undefined>(undefined);

	const putBack = (): void => {
		const now = shown.current;
		if (now === undefined) return;
		shown.current = undefined;
		now.rule.remove();
		now.copy.remove();
		now.waiting.forEach((each) => each.style.removeProperty('visibility'));
	};

	const lift = (layerId: string | undefined, place?: CoverPlace): void => {
		const was = shown.current;
		if (was !== undefined && was.layerId === layerId && was.root === place?.root) return;
		putBack();
		if (layerId === undefined || place === undefined) return;
		const { root, drawing, host, canvas } = place;
		const layer = layerById(root, layerId);
		if (layer === undefined || drawing === undefined || host === null) return;
		const lifted = liftedOver(root, layer);
		if (lifted.length === 0) return;
		const ids = new Set(lifted.map((each) => each.id));
		const holding = new Set(
			lifted.flatMap((each) => chainOf(root, each).slice(1)).map((each) => each.id)
		);
		const copy = root.cloneNode(true) as SVGSVGElement;
		keepOnly(copy, ids, holding);
		const rule = root.ownerDocument.createElement('style');
		rule.append(
			`${[...ids].map((id) => `[id=${quoted(id)}]`).join(', ')} { opacity: 0 !important; }`
		);
		// Hidden until its pictures are there, then shown in the same turn as the
		// rule clears the drawing's, so a lifted layer is never shown twice, nor
		// not at all; the live canvas with it, so what it paints meanwhile is
		// shown a frame late rather than over the layers it will be under.
		const waiting = canvas === null ? [host] : [host, canvas];
		waiting.forEach((each) => each.style.setProperty('visibility', 'hidden'));
		shadowOf(host).append(copy);
		const now: Shown = { layerId, root, copy, rule, waiting };
		shown.current = now;
		whenLoaded(picturesIn(copy, ids), () => {
			if (shown.current !== now || rule.isConnected) return;
			waiting.forEach((each) => each.style.removeProperty('visibility'));
			drawing.append(rule);
		});
	};

	return { lift };
};
