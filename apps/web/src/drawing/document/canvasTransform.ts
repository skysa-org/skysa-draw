import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { hrefOf, imageOf } from '../tools/raster/surface.js';
import { IDENTITY, invert, type Mat, multiply, parseTransform } from '../tools/vector/geometry.js';
import {
	attributesOf,
	idsReferencedIn,
	isSvgElement,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
} from './dom.js';
import { isLayerElement, layerKindOf, layersWithin } from './layers.js';
import type { Command } from './model.js';
import { XLINK_NAMESPACE } from './namespaces.js';

/**
 * Everything drawn moved by one matrix, for the Image operations that turn,
 * flip or scale the whole drawing (`canvasOps.ts`). Position is `transform`
 * (docs/ARCHITECTURE.md §3, "Layers"), so each element drawn at the root, a
 * layer, a group or a loose element, takes the matrix in front of its own
 * `transform`, and whatever it refers to in its own user space, a mask, a
 * clip, a gradient, a pattern or a filter, goes with it untouched.
 *
 * What draws nothing is left where it is: a layer with nothing in it yet,
 * and a raster layer with no picture yet, which covers whatever the canvas is
 * (`boundsFor`), so what is painted on it afterward is upright and at one
 * pixel a unit. A raster layer with no picture inside a group that moves is
 * given the inverse, in its parent's units, so it stays where it was too.
 *
 * A `<use>` draws what it names with that element's own `transform`, so a
 * `<use>` of an element at the root that moved would move twice: the clip of
 * a layer to the one below (`clip.ts`) is one, drawn in the clipped layer's
 * user space. Each `<use>` of an element that moved, where what it draws
 * moves with the drawing, inside an element that moved or inside a definition
 * one of those reaches, takes the inverse after its own `transform` and its
 * `x` and `y`, so every clip shows the layer below where that layer is drawn.
 *
 * A `transform` that is a plain list of SVG's functions is folded with the
 * matrix into one `matrix(…)`; anything else, units or a function this does
 * not know, is kept as written, the matrix beside it. Not seen: a transform
 * in `style` or in a stylesheet, which beats the attribute, and the root's
 * own `mask`, `clip-path` and `filter`, which are in the root's units and do
 * not move with the drawing.
 */

/**
 * Nine places, past which a sine of a right angle is noise, so a layer moved
 * and the `<use>` that undoes the move meet to a hundred-thousandth of a unit
 * on the largest canvas.
 */
export const tidy = (value: number): number => Math.round(value * 1e9) / 1e9 || 0;

const isIdentity = (m: Mat): boolean =>
	m.every((value, index) => Math.abs(value - (IDENTITY[index] ?? 0)) < 1e-9);

/** `matrix(a b c d e f)` to nine places; the empty string for the identity, which is no attribute. */
export const matrixText = (m: Mat): string =>
	isIdentity(m) ? '' : `matrix(${m.map((value) => String(tidy(value))).join(' ')})`;

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

const ONE_NUMBER = new RegExp(`^${NUMBER}$`);

const FUNCTION = /([A-Za-z]+)\s*\(([^)]*)\)/g;

/** How many numbers each of SVG's transform functions takes. */
const ARITY = new Map<string, readonly number[]>([
	['matrix', [6]],
	['translate', [1, 2]],
	['scale', [1, 2]],
	['rotate', [1, 3]],
	['skewX', [1]],
	['skewY', [1]],
]);

const argumentsOf = (text: string): readonly string[] => {
	const trimmed = text.trim();
	return trimmed === '' ? [] : trimmed.split(/\s*,\s*|\s+/);
};

/**
 * Whether a `transform` is SVG's own list and nothing else, each function
 * with as many plain numbers as it takes, so it reads as one matrix exactly
 * (`parseTransform`).
 */
export const isPlainTransform = (text: string): boolean =>
	/^[\s,]*$/.test(text.replace(FUNCTION, ',')) &&
	[...text.matchAll(FUNCTION)].every(([, name = '', values = '']) => {
		const numbers = argumentsOf(values);
		return (
			(ARITY.get(name) ?? []).includes(numbers.length) &&
			numbers.every((number) => ONE_NUMBER.test(number))
		);
	});

/**
 * A `transform` with `front` applied after it and `back` before it, as SVG
 * reads `front <original> back`: one `matrix(…)` where the original is a
 * plain list, the original kept as written between the two otherwise. The
 * empty string for the identity.
 */
export const retransformed = (original: string | null, front: Mat, back: Mat): string => {
	const text = original?.trim() ?? '';
	if (text === '') return matrixText(multiply(front, back));
	if (isPlainTransform(text)) {
		return matrixText(multiply(multiply(front, parseTransform(text)), back));
	}
	return [matrixText(front), text, matrixText(back)].filter((part) => part !== '').join(' ');
};

/** One element's attributes changed by `write`, inside a command. */
export type Rewrite = Readonly<{ element: Element; write: (element: Element) => void }>;

type Rewritten = Readonly<{
	path: readonly number[];
	before: readonly SavedAttribute[];
	after: readonly SavedAttribute[];
}>;

/** Where an element is under the root: the place of each element above it among its parent's children. */
const pathOf = (root: Element, element: Element): readonly number[] => {
	const parent = element.parentElement;
	if (element === root || parent === null) return [];
	return [...pathOf(root, parent), [...parent.children].indexOf(element)];
};

const elementAt = (root: Element, path: readonly number[]): Element | undefined =>
	path.reduce<Element | undefined>((at, index) => at?.children.item(index) ?? undefined, root);

const sameAttributes = (
	one: readonly SavedAttribute[],
	other: readonly SavedAttribute[]
): boolean =>
	one.length === other.length &&
	one.every(
		(attribute, index) =>
			attribute.namespace === other[index]?.namespace &&
			attribute.name === other[index].name &&
			attribute.value === other[index].value
	);

/**
 * The attributes of many elements changed as one step of the history: `plan`
 * names them on the first apply, from the live root, and each is kept before
 * and after, all its attributes in order, so undo gives back the very bytes
 * and redo the very same result. An element is found again by where it is
 * under the root, which every command before and after this one puts back as
 * it found it; few of these have an id, the `<use>` in a clip none. An
 * element `write` left as it was is not kept, and with none changed the
 * command costs nothing.
 */
export const rewriteCommand = (
	label: string,
	plan: (root: SVGSVGElement) => readonly Rewrite[]
): Command => {
	const done = cell<readonly Rewritten[] | undefined>(undefined);
	const reset =
		(root: Element, pick: (each: Rewritten) => readonly SavedAttribute[]) =>
		(each: Rewritten): void => {
			const element = elementAt(root, each.path);
			if (element !== undefined) resetAttributes(element, pick(each));
		};
	return {
		label,
		apply: (root) => {
			const known = done.current;
			if (known !== undefined) {
				known.forEach(reset(root, (each) => each.after));
				return;
			}
			done.current = plan(root)
				.map(({ element, write }) => {
					const before = attributesOf(element);
					write(element);
					return { path: pathOf(root, element), before, after: attributesOf(element) };
				})
				.filter(({ before, after }) => !sameAttributes(before, after));
		},
		revert: (root) => {
			[...(done.current ?? [])].reverse().forEach(reset(root, (each) => each.before));
		},
		get bytes() {
			const known = done.current ?? [];
			return known.length === 0
				? 0
				: known.reduce(
						(total, { before, after }) =>
							total + savedBytes(before) + savedBytes(after),
						SMALL_COMMAND_BYTES
					);
		},
	};
};

/** What draws at the root: a layer, a group, a loose element, and a link around any of them. */
const isDrawnAtRoot = (element: Element): boolean =>
	isLayerElement(element) || isSvgElement(element, 'a');

/** A raster layer that holds no picture yet. */
const isBlankRaster = (element: Element): boolean =>
	element.localName === 'g' &&
	layerKindOf(element) === 'raster' &&
	hrefOf(imageOf(element)) === undefined;

/**
 * Whether an element drawn at the root draws nothing: a raster layer with no
 * picture, or a `<g>` with nothing in it but such, at any depth.
 */
const drawsNothing = (element: Element): boolean => {
	if (element.localName !== 'g') return false;
	if (layerKindOf(element) === 'raster') return isBlankRaster(element);
	return [...element.children].filter(isDrawnAtRoot).every(drawsNothing);
};

/** Where the user units of `element` are in the root's: its `transform` and every one above it. */
export const placeOf = (root: Element, element: Element | null): Mat =>
	element === null || element === root
		? IDENTITY
		: multiply(
				placeOf(root, element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

/** The child of the root `element` is in, itself where it is one. */
const topOf = (root: Element, element: Element): Element | undefined => {
	const parent = element.parentElement;
	if (parent === null) return undefined;
	return parent === root ? element : topOf(root, parent);
};

/** `element` and every element above it short of the root. */
const ancestry = (root: Element, element: Element | null): readonly Element[] =>
	element === null || element === root ? [] : [element, ...ancestry(root, element.parentElement)];

/** Every id that `start` reaches, through the definitions each one it names refers to in turn. */
const reached = (
	start: Iterable<string>,
	onward: (id: string) => Iterable<string>
): ReadonlySet<string> => {
	const seen = new Set<string>();
	const visit = (ids: readonly string[]): void => {
		const fresh = [...new Set(ids)].filter((id) => !seen.has(id));
		fresh.forEach((id) => seen.add(id));
		if (fresh.length > 0) visit(fresh.flatMap((id) => [...onward(id)]));
	};
	visit([...start]);
	return seen;
};

/**
 * Whether what a `<use>` draws moves with the drawing: it is inside an
 * element at the root that moves, or inside a definition that one of those
 * refers to, by `url(#…)` or by a link, directly or through other
 * definitions.
 */
const movesWithDrawing = (
	root: Element,
	moving: ReadonlySet<Element>
): ((element: Element) => boolean) => {
	const byId = new Map(
		[...root.querySelectorAll('[id]')].map((element) => [
			element.getAttribute('id') ?? '',
			element,
		])
	);
	const isDefinition = (element: Element): boolean => {
		const top = topOf(root, element);
		return top !== undefined && !isDrawnAtRoot(top);
	};
	const ids = reached(
		[...moving].flatMap((element) => [...idsReferencedIn(element)]),
		(id) => {
			const element = byId.get(id);
			return element !== undefined && isDefinition(element) ? idsReferencedIn(element) : [];
		}
	);
	return (element) => {
		const top = topOf(root, element);
		if (top === undefined) return false;
		if (moving.has(top)) return true;
		return (
			!isDrawnAtRoot(top) &&
			ancestry(root, element).some((each) => ids.has(each.getAttribute('id') ?? ''))
		);
	};
};

/** The id a `<use>` names by `href`, or by the `xlink:href` of an older file. */
const linkOf = (use: Element): string | undefined => {
	const link = use.getAttribute('href') ?? use.getAttributeNS(XLINK_NAMESPACE, 'href') ?? '';
	return link.startsWith('#') && link.length > 1 ? link.slice(1) : undefined;
};

/** A plain number of an attribute, 0 where it is none. */
export const numberOf = (element: Element, name: string): number => {
	const value = Number(element.getAttribute(name) ?? '');
	return Number.isFinite(value) ? value : 0;
};

const translation = (x: number, y: number): Mat => [1, 0, 0, 1, x, y];

/** A raster picture made again, by its `<image>`: the new `href`, and how much its box grows each way. */
export type Remade = Readonly<{ href: string; x: number; y: number }>;

/** `transform` set, or taken off for none. */
const writeTransform = (element: Element, value: string): void => {
	if (value === '') element.removeAttribute('transform');
	else element.setAttribute('transform', value);
};

const scaled = (element: Element, name: string, by: number): void => {
	element.setAttribute(name, String(tidy(numberOf(element, name) * by)));
};

/**
 * The picture given its new `href`, and its box grown by as much as its
 * pixels were, in the layer's own units, so the layer keeps as many pixels
 * to a unit as it had and a tool that paints it later finds them all.
 */
const remadeImage = (image: Element, remade: Remade): Rewrite => ({
	element: image,
	write: (element) => {
		element.removeAttributeNS(XLINK_NAMESPACE, 'href');
		element.setAttribute('href', remade.href);
		scaled(element, 'x', remade.x);
		scaled(element, 'y', remade.y);
		scaled(element, 'width', remade.x);
		scaled(element, 'height', remade.y);
	},
});

/**
 * What changes when everything drawn is moved by `matrix`, in the root's
 * user units, the drawing's pictures remade as `remade` says: every element
 * at the root that draws, with `matrix` in front of its `transform`; every
 * raster layer with no picture inside one, with the inverse in front, so it
 * stays; each `<use>` of one of the first that moves with them, with the
 * inverse behind; and each picture remade, its box grown and its layer's
 * `transform` shrunk by as much, so it lands where it would have.
 */
export const movedPlan = (
	root: SVGSVGElement,
	matrix: Mat,
	remade: ReadonlyMap<Element, Remade> = new Map()
): readonly Rewrite[] => {
	const moving = [...root.children].filter(
		(child) => isDrawnAtRoot(child) && !drawsNothing(child)
	);
	const movingSet = new Set(moving);
	const inverse = invert(matrix);
	const blank = moving.flatMap(layersWithin).filter(isBlankRaster);
	const fronts = new Map<Element, Mat>([
		...moving.map((element): [Element, Mat] => [element, matrix]),
		...blank.map((layer): [Element, Mat] => {
			const parent = placeOf(root, layer.parentElement);
			return [layer, multiply(invert(parent), multiply(inverse, parent))];
		}),
	]);
	const movingIds = new Set(
		moving.map((element) => element.getAttribute('id') ?? '').filter((id) => id !== '')
	);
	const withDrawing = movesWithDrawing(root, movingSet);
	const uses = [...root.getElementsByTagNameNS(SVG_NAMESPACE, 'use')].filter((use) => {
		const link = linkOf(use);
		return link !== undefined && movingIds.has(link) && withDrawing(use);
	});
	const pictures = [...remade].flatMap(([image, by]) =>
		image.parentElement === null ? [] : [{ image, layer: image.parentElement, by }]
	);
	const backs = new Map<Element, Mat>([
		...uses.map((use): [Element, Mat] => {
			const at = translation(numberOf(use, 'x'), numberOf(use, 'y'));
			return [use, multiply(at, multiply(inverse, invert(at)))];
		}),
		...pictures.map(({ layer, by }): [Element, Mat] => [
			layer,
			[1 / by.x, 0, 0, 1 / by.y, 0, 0],
		]),
	]);
	const transformed = [...new Set([...fronts.keys(), ...backs.keys()])].map(
		(element): Rewrite => ({
			element,
			write: (live) =>
				writeTransform(
					live,
					retransformed(
						live.getAttribute('transform'),
						fronts.get(element) ?? IDENTITY,
						backs.get(element) ?? IDENTITY
					)
				),
		})
	);
	return [...transformed, ...pictures.map(({ image, by }) => remadeImage(image, by))];
};
