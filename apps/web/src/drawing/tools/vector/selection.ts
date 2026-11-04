import type { Box, Point } from './geometry.js';
import { CHROME_STYLE, createSvg } from './svg.js';

/**
 * The selection's box on the overlay (docs/decisions/0004-the-interface.md):
 * a dashed rectangle around what is selected, eight square handles to resize by
 * and one above to rotate by, as Figma and Illustrator draw it. The overlay is
 * in the drawing's user units, so anything that should stay the same size on
 * screen is divided by the viewport's scale.
 */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate'];

/** A handle's side on screen, in CSS pixels. */
const HANDLE_PX = 8;

/** How far above the box the rotate handle sits, in CSS pixels. */
const ROTATE_OFFSET_PX = 24;

/** The attribute that marks the selection's group, so it can be found and replaced. */
const MARK = 'data-draw-selection';

/** Where each handle sits around `box`. */
const handlePositions = (box: Box, scale: number): Readonly<Record<Handle, Point>> => {
	const { x, y, width, height } = box;
	const right = x + width;
	const bottom = y + height;
	const middle = x + width / 2;
	return {
		nw: { x, y },
		n: { x: middle, y },
		ne: { x: right, y },
		e: { x: right, y: y + height / 2 },
		se: { x: right, y: bottom },
		s: { x: middle, y: bottom },
		sw: { x, y: bottom },
		w: { x, y: y + height / 2 },
		rotate: { x: middle, y: y - ROTATE_OFFSET_PX / scale },
	};
};

/**
 * The handle under `point`, if any: within a handle's own side of its center,
 * which is twice the handle, since a finger is wider than a handle is drawn.
 */
export const handleAt = (box: Box, point: Point, scale: number): Handle | undefined => {
	const positions = handlePositions(box, scale);
	const reach = HANDLE_PX / scale;
	return HANDLES.find((handle) => {
		const at = positions[handle];
		return Math.abs(point.x - at.x) <= reach && Math.abs(point.y - at.y) <= reach;
	});
};

const OPPOSITE: Readonly<Record<Handle, Handle>> = {
	nw: 'se',
	n: 's',
	ne: 'sw',
	e: 'w',
	se: 'nw',
	s: 'n',
	sw: 'ne',
	w: 'e',
	rotate: 'rotate',
};

/** The point a resize by `handle` keeps still: the corner or the edge's middle across from it. */
export const anchorOf = (box: Box, handle: Handle, scale: number): Point =>
	handlePositions(box, scale)[OPPOSITE[handle]];

/** Whether a resize by `handle` changes the width, and whether the height. */
export const axesOf = (handle: Handle): Readonly<{ x: boolean; y: boolean }> => ({
	x: handle.includes('w') || handle.includes('e'),
	y: handle.includes('n') || handle.includes('s'),
});

export const clearSelectionBox = (overlay: SVGSVGElement): void => {
	overlay.querySelectorAll(`[${MARK}]`).forEach((element) => element.remove());
};

export const hasSelectionBox = (overlay: SVGSVGElement): boolean =>
	overlay.querySelector(`[${MARK}]`) !== null;

/** The box drawn afresh around `box`, or taken away where there is nothing selected. */
export const drawSelectionBox = (
	overlay: SVGSVGElement,
	box: Box | undefined,
	scale: number
): void => {
	clearSelectionBox(overlay);
	if (box === undefined) return;
	const owner = overlay.ownerDocument;
	const side = HANDLE_PX / scale;
	const positions = handlePositions(box, scale);
	const group = createSvg(owner, 'g', {
		[MARK]: '',
		style: CHROME_STYLE,
		'pointer-events': 'none',
	});
	group.appendChild(
		createSvg(owner, 'rect', {
			x: box.x,
			y: box.y,
			width: box.width,
			height: box.height,
			fill: 'none',
			'stroke-dasharray': '4 4',
			'vector-effect': 'non-scaling-stroke',
		})
	);
	group.appendChild(
		createSvg(owner, 'line', {
			x1: positions.n.x,
			y1: positions.n.y,
			x2: positions.rotate.x,
			y2: positions.rotate.y,
			'vector-effect': 'non-scaling-stroke',
		})
	);
	HANDLES.filter((handle) => handle !== 'rotate').forEach((handle) => {
		const at = positions[handle];
		group.appendChild(
			createSvg(owner, 'rect', {
				'data-handle': handle,
				x: at.x - side / 2,
				y: at.y - side / 2,
				width: side,
				height: side,
				'vector-effect': 'non-scaling-stroke',
			})
		);
	});
	group.appendChild(
		createSvg(owner, 'circle', {
			'data-handle': 'rotate',
			cx: positions.rotate.x,
			cy: positions.rotate.y,
			r: side / 2,
			'vector-effect': 'non-scaling-stroke',
		})
	);
	overlay.appendChild(group);
};
