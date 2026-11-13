import type { DrawingSize } from '@skysa/draw-core';
import { cell } from '@skysa/storage';

import {
	attributesOf,
	resetAttributes,
	type SavedAttribute,
	savedBytes,
	SMALL_COMMAND_BYTES,
} from './dom.js';
import type { Command } from './model.js';

/**
 * The canvas (docs/ARCHITECTURE.md §3, "The drawing file": "`viewBox` is the
 * canvas; `width` and `height` beside it say the same in user units"), and
 * the crop, which is the canvas moved (docs/decisions/0004-the-interface.md:
 * "Crop … the canvas's `viewBox`"). Nothing drawn is resampled or cut: what
 * falls outside the new box is still in the file, out of sight, and comes back
 * with a larger one.
 */

export type CanvasBox = Readonly<{ x: number; y: number; width: number; height: number }>;

/** The root's `viewBox` as four numbers, a positive width and height, or nothing. */
const viewBoxOf = (root: Element): CanvasBox | undefined => {
	const numbers = (root.getAttribute('viewBox') ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const [x = Number.NaN, y = Number.NaN, width = Number.NaN, height = Number.NaN] = numbers;
	const valid =
		numbers.length === 4 &&
		[x, y, width, height].every(Number.isFinite) &&
		width > 0 &&
		height > 0;
	return valid ? { x, y, width, height } : undefined;
};

/** The canvas in user units: the root's `viewBox`, or the size the file was opened at from the origin. */
export const canvasBoxOf = (root: Element, opened: DrawingSize): CanvasBox =>
	viewBoxOf(root) ?? { x: 0, y: 0, width: opened.width, height: opened.height };

/** Enough places for any canvas, and no float noise. */
const round = (value: number): number => Number(value.toFixed(3)) + 0;

const LENGTH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i;

/**
 * A `width` or `height` scaled by `factor` in its own unit, `210mm` to
 * `105mm`; a percentage, or anything else that is not a length, as it was.
 */
const scaledLength = (value: string, factor: number): string => {
	const match = LENGTH.exec(value);
	if (match?.[1] === undefined) return value;
	return `${String(round(Number(match[1]) * factor))}${match[2] ?? ''}`;
};

/**
 * The canvas set to `box`: the root's `viewBox`, and its `width` and `height`
 * where it has them, scaled by as much as the box, so a file that says its
 * size in millimeters still says it in millimeters. `from` is the canvas as it
 * is, which a file with no `viewBox` has only by its size. Undo puts the
 * root's attributes back as they were, in their order.
 */
export const cropCanvas = (box: CanvasBox, from: CanvasBox): Command => {
	const saved = cell<readonly SavedAttribute[] | undefined>(undefined);
	return {
		label: 'tools.crop',
		apply: (root) => {
			saved.current = attributesOf(root);
			root.setAttribute(
				'viewBox',
				[box.x, box.y, box.width, box.height].map((n) => String(round(n))).join(' ')
			);
			const width = root.getAttribute('width');
			const height = root.getAttribute('height');
			if (width !== null)
				root.setAttribute('width', scaledLength(width, box.width / from.width));
			if (height !== null) {
				root.setAttribute('height', scaledLength(height, box.height / from.height));
			}
		},
		revert: (root) => {
			if (saved.current !== undefined) resetAttributes(root, saved.current);
		},
		get bytes() {
			return saved.current === undefined
				? 0
				: SMALL_COMMAND_BYTES + savedBytes(saved.current);
		},
	};
};
