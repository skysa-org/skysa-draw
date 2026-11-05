import type { LayerInfo } from '../../document/model.js';
import { type Box, type Mat, type Point, rotate, scale as scaleBy } from './geometry.js';
import { CHROME_STYLE, createSvg } from './svg.js';

/**
 * The selection's box on the overlay (docs/decisions/0004-the-interface.md):
 * a dashed rectangle around what is selected, eight square handles to resize by
 * and one above to rotate by, as Figma and Illustrator draw it. The overlay is
 * in the drawing's user units, so anything that should stay the same size on
 * screen is divided by the viewport's scale. What a drag of a handle does is
 * here too (`resizeMatrix`, `rotateMatrix`), so the select tool's box and
 * Transform selection's (`tools/raster/areaTransform.ts`) are dragged alike.
 */
export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'rotate';

export const HANDLES: readonly Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w', 'rotate'];

/** A handle's side on screen, in CSS pixels. */
const HANDLE_PX = 8;

/** How far above the box the rotate handle sits, in CSS pixels. */
const ROTATE_OFFSET_PX = 24;

/** The attribute that marks the selection's group, so it can be found and replaced. */
const MARK = 'data-draw-selection';

/** Where each handle sits around `box`. */
export const handlePositions = (box: Box, scale: number): Readonly<Record<Handle, Point>> => {
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
const axesOf = (handle: Handle): Readonly<{ x: boolean; y: boolean }> => ({
	x: handle.includes('w') || handle.includes('e'),
	y: handle.includes('n') || handle.includes('s'),
});

/** A rotation with Shift snaps to this many degrees. */
const ROTATE_STEP = 15;

/** A resize is never made smaller than this fraction, which would flatten the element. */
const LEAST_SCALE = 0.01;

/** A factor kept away from zero, with its sign. */
const safeScale = (factor: number): number =>
	Math.abs(factor) < LEAST_SCALE ? (factor < 0 ? -LEAST_SCALE : LEAST_SCALE) : factor;

/** The factor a drag from `from` to `to` scales by about `anchor`, along one axis. */
const factorOf = (from: number, to: number, anchor: number): number =>
	Math.abs(from - anchor) < 1e-9 ? 1 : safeScale((to - anchor) / (from - anchor));

/**
 * A resize by `handle`, dragged from `from` to `to`, about `anchor`, in the
 * drawing's units: along the axes the handle changes, and with `keepRatio`
 * (Shift) both by the factor the drag changed more, or the one axis it has.
 */
export const resizeMatrix = (
	drag: Readonly<{ from: Point; handle: Handle; anchor: Point }>,
	to: Point,
	keepRatio: boolean
): Mat => {
	const axes = axesOf(drag.handle);
	const sx = axes.x ? factorOf(drag.from.x, to.x, drag.anchor.x) : 1;
	const sy = axes.y ? factorOf(drag.from.y, to.y, drag.anchor.y) : 1;
	if (!keepRatio) return scaleBy(sx, sy, drag.anchor);
	// The ratio kept: both sides by the factor the drag changed more, or the one axis it has.
	const uniform = !axes.y || (axes.x && Math.abs(sx - 1) >= Math.abs(sy - 1)) ? sx : sy;
	return scaleBy(uniform, uniform, drag.anchor);
};

/**
 * A rotation about `center` by the angle a drag from `from` to `to` turned
 * through, with `snap` (Shift) to a multiple of 15°.
 */
export const rotateMatrix = (
	drag: Readonly<{ from: Point; center: Point }>,
	to: Point,
	snap: boolean
): Mat => {
	const start = Math.atan2(drag.from.y - drag.center.y, drag.from.x - drag.center.x);
	const now = Math.atan2(to.y - drag.center.y, to.x - drag.center.x);
	const degrees = ((now - start) * 180) / Math.PI;
	return rotate(snap ? Math.round(degrees / ROTATE_STEP) * ROTATE_STEP : degrees, drag.center);
};

/**
 * Whether the layer is out of sight: hidden, or in a group that is. What is
 * selected on it stays selected, and its box is not drawn until the layer is
 * shown again, as Photoshop's transform controls go with a hidden layer: a
 * handle there would move nothing the user sees, and a tool refuses a hidden
 * layer anyway (`guardLayer`).
 */
export const hiddenAsSeen = (layers: readonly LayerInfo[], id: string | undefined): boolean => {
	const layer = id === undefined ? undefined : layers.find((each) => each.id === id);
	return layer !== undefined && (layer.hidden || hiddenAsSeen(layers, layer.parentId));
};

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
