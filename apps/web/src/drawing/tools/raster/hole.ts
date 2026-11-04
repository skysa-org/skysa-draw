import { cell, SVG_NAMESPACE } from '@skysa/draw-core';

import type { Box } from '../vector/geometry.js';
import { releaseCanvas } from './area.js';
import type { RasterSurface } from './surface.js';

/**
 * The hole a move of an area's pixels leaves in its layer, shown while the
 * drag lasts (docs/ARCHITECTURE.md §7, "Tools"), with no encoding per move
 * and nothing written into the drawing. The text is serialized from the
 * drawing's root after any command, and a save or a redo during the drag
 * would keep whatever the root held then, so the `<image>` is never touched:
 * the hole is a `<mask>` and a rule naming the layer's image, in an `<svg>`
 * of their own beside the root in the viewport's shadow root, which styles
 * the drawing (§7, "The editor") and which the file never holds. The mask is
 * white over the layer's box with the area's coverage in black where the
 * pixels were, as one PNG of that box, encoded once, as a `blob:` URL
 * (`img-src` allows `blob:`); the layer shows through it as far as nothing
 * was taken. Where the root is not in a shadow root, as in a test that does
 * not mount it, there is no hole to show.
 */

export type Hole = Readonly<{ remove: () => void }>;

/** No hole: a copy leaves none. */
export const NO_HOLE: Hole = { remove: () => undefined };

/** Marks the hole's `<svg>`, for a test to find and nothing else. */
export const HOLE_MARK = 'data-draw-move-hole';

/** Where a layer's pixels are in its own user units. */
type Place = Pick<RasterSurface, 'bounds' | 'ppu'>;

/** Holes made so far, so each mask's id is its own. */
const made = cell(0);

/** A value as a CSS string, for an attribute selector. */
const quoted = (value: string): string =>
	`"${value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')}"`;

/**
 * The coverage as luminance, `cover`'s size: black as far as each pixel was
 * taken, white where it was not.
 */
const keepOf = (cover: HTMLCanvasElement): HTMLCanvasElement | undefined => {
	const canvas = document.createElement('canvas');
	canvas.width = cover.width;
	canvas.height = cover.height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	ctx.drawImage(cover, 0, 0);
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = '#000000';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.globalCompositeOperation = 'destination-over';
	ctx.fillStyle = '#ffffff';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.globalCompositeOperation = 'source-over';
	return canvas;
};

const svgElement = (
	owner: Document,
	name: string,
	attributes: Readonly<Record<string, string | number>>
): Element => {
	const element = owner.createElementNS(SVG_NAMESPACE, name);
	Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
	return element;
};

/** The hole's `<svg>`: the rule that masks the layer's image, and the mask. */
const holeElement = (
	owner: Document,
	layerId: string,
	place: Place,
	at: Box,
	url: string
): Element => {
	made.current += 1;
	const id = `draw-move-hole-${made.current}`;
	const { bounds, ppu } = place;
	const svg = svgElement(owner, 'svg', {
		[HOLE_MARK]: '',
		width: 0,
		height: 0,
		'aria-hidden': 'true',
		style: 'position: absolute; overflow: hidden; pointer-events: none',
	});
	const style = svgElement(owner, 'style', {});
	style.append(
		owner.createTextNode(`[id=${quoted(layerId)}] > image { mask: url(#${id}) !important; }`)
	);
	const mask = svgElement(owner, 'mask', { id, maskUnits: 'userSpaceOnUse', ...bounds });
	mask.append(
		svgElement(owner, 'rect', { ...bounds, fill: '#ffffff' }),
		svgElement(owner, 'image', {
			href: url,
			x: bounds.x + at.x / ppu,
			y: bounds.y + at.y / ppu,
			width: at.width / ppu,
			height: at.height / ppu,
			preserveAspectRatio: 'none',
		})
	);
	svg.append(style, mask);
	return svg;
};

/**
 * The layer's image shown with a hole as far as `cover`, a coverage the size
 * of `at`, covers the pixels at `at`, once its mask is encoded; until
 * `remove`, which takes it away whenever it is called, before the mask is
 * ready or after.
 */
export const showHole = (
	root: SVGSVGElement,
	layerId: string,
	place: Place,
	cover: HTMLCanvasElement,
	at: Box
): Hole => {
	const parent = root.parentNode;
	if (!(parent instanceof ShadowRoot) || typeof URL.createObjectURL !== 'function') {
		return NO_HOLE;
	}
	const keep = keepOf(cover);
	if (keep === undefined) return NO_HOLE;
	const removed = cell(false);
	const shown = cell<Readonly<{ element: Element; url: string }> | undefined>(undefined);
	const take = (blob: Blob | null): void => {
		releaseCanvas(keep);
		if (blob === null || removed.current) return;
		const url = URL.createObjectURL(blob);
		const element = holeElement(root.ownerDocument, layerId, place, at, url);
		parent.insertBefore(element, root);
		shown.current = { element, url };
	};
	try {
		keep.toBlob(take, 'image/png');
	} catch {
		take(null);
	}
	return {
		remove: () => {
			removed.current = true;
			const was = shown.current;
			shown.current = undefined;
			if (was === undefined) return;
			was.element.remove();
			URL.revokeObjectURL(was.url);
		},
	};
};
