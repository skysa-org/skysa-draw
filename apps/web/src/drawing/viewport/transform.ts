import type { DrawingSize } from '@skysa/draw-core';

/**
 * The view (docs/ARCHITECTURE.md §7, "The interface"): where the drawing's
 * user units land on the screen. The stage carries the CSS transform
 * `translate(tx, ty) scale(scale)` about its top-left corner, so a point is
 * `screen = user × scale + t`, and every function here is that line or its
 * inverse. Pure, so the arithmetic of panning and zooming is tested without a
 * DOM; the viewport only applies what comes out.
 */
export type View = Readonly<{
	/** Screen pixels per user unit. */
	scale: number;
	tx: number;
	ty: number;
}>;

/** The root's `viewBox`: the drawing's user units start at `x`, `y`, not always at 0. */
export type ViewBox = Readonly<{ x: number; y: number; width: number; height: number }>;

export const MIN_SCALE = 0.02;
export const MAX_SCALE = 64;
/** What a zoom in or out from a key or a button multiplies the scale by. */
export const ZOOM_STEP = 1.25;
/** The room left around a drawing fitted to the window, in screen pixels. */
export const FIT_MARGIN = 32;

export const IDENTITY_VIEW: View = { scale: 1, tx: 0, ty: 0 };

export const clampScale = (scale: number): number =>
	Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** A screen point, relative to the viewport's corner, in user units. */
export const toUser = (view: View, sx: number, sy: number): readonly [number, number] => [
	(sx - view.tx) / view.scale,
	(sy - view.ty) / view.scale,
];

/** A user point on the screen, relative to the viewport's corner. */
export const toScreen = (view: View, x: number, y: number): readonly [number, number] => [
	x * view.scale + view.tx,
	y * view.scale + view.ty,
];

/** The scale multiplied by `factor`, with the user point staying under the same screen point. */
export const zoomAbout = (view: View, factor: number, userX: number, userY: number): View => {
	const scale = clampScale(view.scale * factor);
	const [sx, sy] = toScreen(view, userX, userY);
	return { scale, tx: sx - userX * scale, ty: sy - userY * scale };
};

/** The drawing moved by a distance in user units: positive moves it right and down. */
export const panBy = (view: View, dxUser: number, dyUser: number): View => ({
	...view,
	tx: view.tx + dxUser * view.scale,
	ty: view.ty + dyUser * view.scale,
});

const measurable = (viewport: DrawingSize): boolean => viewport.width > 0 && viewport.height > 0;

const centered = (drawing: DrawingSize, viewport: DrawingSize, scale: number): View => ({
	scale,
	tx: (viewport.width - drawing.width * scale) / 2,
	ty: (viewport.height - drawing.height * scale) / 2,
});

/**
 * The whole drawing in the middle of the viewport with `margin` around it. A
 * viewport that measures nothing yet, as one does before layout and always in
 * a test, gets the identity: there is nothing to center in.
 */
export const fitView = (
	drawing: DrawingSize,
	viewport: DrawingSize,
	margin: number = FIT_MARGIN
): View => {
	if (!measurable(viewport)) return IDENTITY_VIEW;
	const roomX = Math.max(1, viewport.width - 2 * margin);
	const roomY = Math.max(1, viewport.height - 2 * margin);
	const scale = clampScale(Math.min(roomX / drawing.width, roomY / drawing.height));
	return centered(drawing, viewport, scale);
};

/** One user unit per CSS pixel, the drawing in the middle of the viewport. */
export const actualSizeView = (drawing: DrawingSize, viewport: DrawingSize): View =>
	measurable(viewport) ? centered(drawing, viewport, 1) : IDENTITY_VIEW;

/** The root's `viewBox` attribute as numbers, or nothing for one that is not four of them. */
export const parseViewBox = (value: string | null | undefined): ViewBox | undefined => {
	const parts = (value ?? '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	const [x, y, width, height] = parts;
	if (parts.length !== 4 || !parts.every(Number.isFinite)) return undefined;
	if (x === undefined || y === undefined || width === undefined || height === undefined)
		return undefined;
	return width > 0 && height > 0 ? { x, y, width, height } : undefined;
};

/**
 * The stage's CSS transform. The stage is as wide and as tall in CSS pixels as
 * the drawing is in user units, and its corner is the drawing's corner, which
 * is the `viewBox`'s origin, not always (0, 0): so the stage is translated to
 * where that user point lands on the screen.
 */
/** The transparency grid's tile on screen, in CSS px: two squares of 8 each way, as Photoshop's medium grid. */
const CHECKER_TILE_PX = 16;

/**
 * The transparency grid's tile as the stage, which the view scales, takes it:
 * in user units, so the scale brings it back to `CHECKER_TILE_PX` on screen
 * whatever the zoom.
 */
export const checkerSize = (view: View): string => {
	const side = CHECKER_TILE_PX / view.scale;
	return `${side}px ${side}px`;
};

/**
 * The drawing's canvas on the screen, as a `clip-path` for the live raster
 * canvas over the whole viewport (`.viewport-screen`): a stroke, a smudge, a
 * float of moved pixels shows only where the canvas is, as the drawing, cut
 * to its canvas, will show it once it lands.
 */
export const canvasClip = (view: View, box: ViewBox): string => {
	const [left, top] = toScreen(view, box.x, box.y);
	const [right, bottom] = toScreen(view, box.x + box.width, box.y + box.height);
	return `polygon(${left}px ${top}px, ${right}px ${top}px, ${right}px ${bottom}px, ${left}px ${bottom}px)`;
};

export const stageTransform = (view: View, origin: Readonly<{ x: number; y: number }>): string => {
	const [sx, sy] = toScreen(view, origin.x, origin.y);
	return `translate(${sx}px, ${sy}px) scale(${view.scale})`;
};
