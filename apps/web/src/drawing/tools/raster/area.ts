import { canvasBoxOf } from '../../document/crop.js';
import type { Region, ToolContext } from '../types.js';
import {
	type Box,
	boxContains,
	boxesIntersect,
	invert,
	type Mat,
	multiply,
	transformBox,
} from '../vector/geometry.js';
import type { Point } from './pixels.js';
import type { RasterSurface } from './surface.js';

/**
 * The area selection (docs/decisions/0004-the-interface.md: the marquee and
 * the lasso select pixels in a region; `RegionControl` in `tools/types.ts`): a
 * closed path in the drawing's user units, which the raster tools paint
 * inside and Delete clears. The marquee, the lasso and select-all write it, as
 * straight-sided subpaths in absolute coordinates, each wound clockwise on a
 * screen whose y runs down, so that a subpath added under SVG's and the
 * canvas's `nonzero` rule is a union. The geometry here is pure; the clip and
 * the mask at the end are the canvas's, through `Path2D`, which a browser has
 * and jsdom has not.
 *
 * Two things are done to an area without redrawing it. Select inverse makes
 * it the canvas outside the outline. A clip cannot say that: the subpaths are
 * a union under `nonzero`, so where two overlap the winding is 2, and the
 * canvas's rectangle with the subpaths reversed would leave the overlap
 * selected. So an inverse is never a clip: it is a mask, the canvas filled and
 * the outline taken out of it (`areaMask`), and everything that writes
 * through the area composites by that mask. Feather fades the edge either side
 * of the outline: the outline is filled through the canvas's
 * `filter: blur()`, whose deviation is half the feather, so the coverage is
 * 98% at the feather's distance inside, a half on the outline and 2% at the
 * feather's distance outside; an inverse is taken out after the blur. A
 * browser whose canvas has no `filter` (Safari before 18) gets a hard edge.
 * The canvas's own edge, which bounds an inverse, is never feathered.
 */

/** A coordinate as the area writes it: two decimals, finer than a pixel at any zoom. */
const fmt = (n: number): string => {
	const rounded = Math.round(n * 100) / 100;
	return String(rounded === 0 ? 0 : rounded);
};

/** Twice the signed area: positive for a polygon wound clockwise on a y-down screen. */
const signedArea2 = (points: readonly Point[]): number =>
	points.reduce((sum, p, i) => {
		const q = points[(i + 1) % points.length] ?? p;
		return sum + p.x * q.y - q.x * p.y;
	}, 0);

/** Below this, in square user units, a polygon has no inside. */
const LEAST_AREA = 1e-6;

/**
 * A closed polygon as one subpath, wound clockwise whichever way it was drawn;
 * none for fewer than three distinct points or no inside at all.
 */
export const polygonPath = (points: readonly Point[]): string | undefined => {
	const kept = points.filter((p, i) => {
		const previous = points[i - 1];
		return previous === undefined || previous.x !== p.x || previous.y !== p.y;
	});
	if (kept.length < 3) return undefined;
	const twice = signedArea2(kept);
	if (Math.abs(twice) / 2 < LEAST_AREA) return undefined;
	const [first, ...rest] = twice > 0 ? kept : [...kept].reverse();
	if (first === undefined) return undefined;
	return `M ${fmt(first.x)} ${fmt(first.y)} ${rest.map((p) => `L ${fmt(p.x)} ${fmt(p.y)}`).join(' ')} Z`;
};

const cornersOf = (box: Box): readonly Point[] => [
	{ x: box.x, y: box.y },
	{ x: box.x + box.width, y: box.y },
	{ x: box.x + box.width, y: box.y + box.height },
	{ x: box.x, y: box.y + box.height },
];

/** A rectangle as a subpath; none for one with no width or no height. */
export const rectPath = (box: Box): string | undefined => polygonPath(cornersOf(box));

/** The area made larger by another: the second as a subpath after the first, a union under `nonzero`. */
export const addToArea = (existing: string | undefined, added: string): string =>
	existing === undefined ? added : `${existing} ${added}`;

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

/** One number of a path, kept by a split. */
const NUMBER_PART = /(-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i;

/**
 * The outline moved by `dx` and `dy` in user units, every number of it, as
 * `areaPolygons` reads them: in pairs, x then y, from each subpath's start,
 * so what moves is the area the tools see. The grammar the area writes is all
 * it has to read: absolute, straight, `M`, `L` and `Z` (select-all's
 * rectangle is one). Written to the area's two decimals, so a move by whole
 * units of an outline the marquee made is exact.
 */
export const translatePath = (d: string, dx: number, dy: number): string =>
	d
		.split(/([Zz])/)
		.map((subpath) =>
			subpath
				.split(NUMBER_PART)
				.map((part, i) => {
					if (i % 2 === 0) return part;
					const along = ((i - 1) / 2) % 2 === 0 ? dx : dy;
					return fmt(Number(part) + along);
				})
				.join('')
		)
		.join('');

/** Every subpath's corners, as the area writes them: absolute, straight, in pairs. */
export const areaPolygons = (d: string): readonly (readonly Point[])[] =>
	d
		.split(/[Zz]/)
		.map((subpath) => (subpath.match(NUMBER) ?? []).map(Number))
		.map((numbers) =>
			numbers
				.filter((_, i) => i % 2 === 0)
				.flatMap((x, i) => {
					const y = numbers[i * 2 + 1];
					return y === undefined ? [] : [{ x, y }];
				})
		)
		.filter((polygon) => polygon.length >= 3);

/**
 * The box around every corner; none for an area with no subpath. By `reduce`,
 * not `Math.min(...)`, which a magic wand's outline of more than a hundred
 * thousand corners would take past the engine's argument limit.
 */
export const boundsOf = (polygons: readonly (readonly Point[])[]): Box | undefined => {
	const points = polygons.flat();
	const [first] = points;
	if (first === undefined) return undefined;
	const edges = points.reduce(
		(box, p) => ({
			left: Math.min(box.left, p.x),
			top: Math.min(box.top, p.y),
			right: Math.max(box.right, p.x),
			bottom: Math.max(box.bottom, p.y),
		}),
		{ left: first.x, top: first.y, right: first.x, bottom: first.y }
	);
	return {
		x: edges.left,
		y: edges.top,
		width: edges.right - edges.left,
		height: edges.bottom - edges.top,
	};
};

/** A box made larger by `by` on every side. */
const grown = (box: Box, by: number): Box => ({
	x: box.x - by,
	y: box.y - by,
	width: box.width + 2 * by,
	height: box.height + 2 * by,
});

/** How many times a polygon winds around `p`, signed: 0 outside it under `nonzero`. */
const windingOf = (polygon: readonly Point[], p: Point): number =>
	polygon.reduce((sum, a, i) => {
		const b = polygon[(i + 1) % polygon.length] ?? a;
		const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
		if (a.y <= p.y && b.y > p.y && cross > 0) return sum + 1;
		if (a.y > p.y && b.y <= p.y && cross < 0) return sum - 1;
		return sum;
	}, 0);

/** Whether `p` is inside a polygon, by the crossings of a ray to its right. */
const insidePolygon = (polygon: readonly Point[], p: Point): boolean =>
	polygon.reduce((inside, a, i) => {
		const b = polygon[(i + 1) % polygon.length] ?? a;
		const crosses =
			a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x;
		return crosses ? !inside : inside;
	}, false);

/** Which side of the line through `a` and `b` `p` is on: the sign of the cross product. */
const side = (a: Point, b: Point, p: Point): number =>
	Math.sign((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));

/** Whether two segments cross or touch. */
const segmentsMeet = (a: Point, b: Point, c: Point, d: Point): boolean =>
	side(a, b, c) !== side(a, b, d) && side(c, d, a) !== side(c, d, b);

/** Whether an edge of the polygon crosses or touches an edge of the box whose corners these are. */
const edgesMeet = (polygon: readonly Point[], corners: readonly Point[]): boolean =>
	polygon.some((a, i) => {
		const b = polygon[(i + 1) % polygon.length] ?? a;
		return corners.some((c, j) => segmentsMeet(a, b, c, corners[(j + 1) % 4] ?? c));
	});

/**
 * Whether a polygon and a box share any point: a corner of the polygon in
 * the box, a corner of the box in the polygon, or two edges crossing. What a
 * lasso around an element's box, or through it, takes.
 */
const polygonTouchesBox = (polygon: readonly Point[], box: Box): boolean => {
	if (polygon.some((p) => boxContains(box, p))) return true;
	const corners = cornersOf(box);
	if (corners.some((corner) => insidePolygon(polygon, corner))) return true;
	return edgesMeet(polygon, corners);
};

/** Whether the area, a union of its subpaths, shares any point with a box. */
export const areaTouchesBox = (polygons: readonly (readonly Point[])[], box: Box): boolean =>
	polygons.some((polygon) => polygonTouchesBox(polygon, box));

/**
 * How far past the outline a feathered edge still covers anything, as a
 * multiple of the feather: three deviations of a blur whose deviation is half
 * the feather, where what is left is under a thousandth.
 */
const FEATHER_REACH = 1.5;

/** The area as a raster stroke holds it, read once when the stroke begins. */
export interface Area {
	readonly path: string;
	/** Select inverse: what is selected is the canvas outside `path`. */
	readonly inverted: boolean;
	/** How far either side of the outline the edge fades, in user units; 0 is hard. */
	readonly feather: number;
	/** The drawing's canvas in user units: what an inverted area is the rest of. */
	readonly canvas: Box;
	/** The outline's subpaths, as corners. */
	readonly polygons: readonly (readonly Point[])[];
	/**
	 * The box around what it selects in user units: the outline's, grown by as
	 * far as its feather reaches, or the canvas for an inverted area; none for
	 * an outline with no inside, which takes no paint.
	 */
	readonly bounds: Box | undefined;
	/** The outline for the canvas; none where the browser has no `Path2D`. */
	readonly shape: Path2D | undefined;
}

/** The area set now, for a tool to paint inside; none when nothing is selected. */
export const areaOf = (context: ToolContext): Area | undefined => {
	const region = context.region.region;
	if (region === undefined) return undefined;
	const { path, inverted } = region;
	const feather = Number.isFinite(region.feather) ? Math.max(0, region.feather) : 0;
	const polygons = areaPolygons(path);
	const canvas = canvasBoxOf(context.document.root, context.document.size);
	const outline = boundsOf(polygons);
	return {
		path,
		inverted,
		feather,
		canvas,
		polygons,
		bounds: inverted
			? canvas
			: outline === undefined
				? undefined
				: grown(outline, feather * FEATHER_REACH),
		shape: typeof Path2D === 'function' ? new Path2D(path) : undefined,
	};
};

/**
 * Whether the area is its outline and nothing more, neither inverted nor
 * feathered, so a clip to the outline is the whole of it and exact.
 */
export const isPlain = (area: Area): boolean => !area.inverted && !(area.feather > 0);

/**
 * Whether a point in user units is in the area, as the marching ants draw
 * it: inside the outline under `nonzero`, as the canvas fills it; for an
 * inverse, on the canvas and outside the outline. A feather is not read:
 * the ants are on the outline, where a feathered area covers half.
 */
export const areaHolds = (area: Area, p: Point): boolean => {
	const winding = area.polygons.reduce((sum, polygon) => sum + windingOf(polygon, p), 0);
	return area.inverted ? boxContains(area.canvas, p) && winding === 0 : winding !== 0;
};

/**
 * Whether a box in user units reaches the area: any box does where there is
 * none. By the area's bounds; for an inverted area, a box the outline fills
 * wholly, by more than the feather reaches, is in the hole and reaches
 * nothing: one that no subpath's corner or edge reaches, so the outline
 * winds around all of it as it winds around its corner, and does wind around
 * that under `nonzero`. Being inside a subpath is not enough, since the
 * magic wand's outline has holes, subpaths wound the other way.
 */
export const reachesArea = (area: Area | undefined, box: Box): boolean => {
	if (area === undefined) return true;
	if (area.bounds === undefined || !boxesIntersect(area.bounds, box)) return false;
	if (!area.inverted) return true;
	const held = grown(box, area.feather * FEATHER_REACH);
	const corners = cornersOf(held);
	const crossed = area.polygons.some(
		(polygon) => polygon.some((p) => boxContains(held, p)) || edgesMeet(polygon, corners)
	);
	const corner = corners[0] ?? held;
	return (
		crossed || area.polygons.reduce((sum, polygon) => sum + windingOf(polygon, corner), 0) === 0
	);
};

/** A map from user units that is affine, as a matrix, read off where it sends three points. */
export const affineOf = (map: (x: number, y: number) => readonly [number, number]): Mat => {
	const [ex, ey] = map(0, 0);
	const [ax, ay] = map(1, 0);
	const [cx, cy] = map(0, 1);
	return [ax - ex, ay - ey, cx - ex, cy - ey, ex, ey];
};

/**
 * From the layer's pixels to the screen canvas's: the surface's map undone and
 * the screen's applied, for a tool that shows the layer's own pixels live.
 */
export const pixelsToScreen = (
	toPixel: RasterSurface['toPixel'],
	toScreen: (x: number, y: number) => readonly [number, number]
): Mat => multiply(affineOf(toScreen), invert(affineOf(toPixel)));

/**
 * `ctx` clipped to the area's outline, its path drawn through `map`, which
 * takes user units to the context's pixels; whether it was, which it is not
 * where the browser has no `Path2D`. The whole of a plain area (`isPlain`);
 * the outline alone of any other. The clip stays until the caller's
 * `restore()`; the transform is the identity after.
 */
export const clipToArea = (
	ctx: CanvasRenderingContext2D,
	area: Area,
	map: (x: number, y: number) => readonly [number, number]
): boolean => {
	if (area.shape === undefined) return false;
	const [a, b, c, d, e, f] = affineOf(map);
	ctx.setTransform(a, b, c, d, e, f);
	ctx.clip(area.shape, 'nonzero');
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	return true;
};

/**
 * For a live preview inside an inverted area: `ctx` clipped to the canvas,
 * through `map`, and to `near`, a box in the context's own pixels around what
 * is about to be drawn, so that the outline taken out after it
 * (`takeOutline`) takes nothing further off. The transform is the identity
 * after.
 */
export const clipToInverse = (
	ctx: CanvasRenderingContext2D,
	area: Area,
	map: (x: number, y: number) => readonly [number, number],
	near: Box
): void => {
	const [a, b, c, d, e, f] = affineOf(map);
	ctx.setTransform(a, b, c, d, e, f);
	ctx.beginPath();
	ctx.rect(area.canvas.x, area.canvas.y, area.canvas.width, area.canvas.height);
	ctx.clip();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.beginPath();
	ctx.rect(near.x, near.y, near.width, near.height);
	ctx.clip();
};

/**
 * The inside of the outline taken out of what `ctx` holds, within its clip:
 * what an inverted area leaves unselected. The transform is the identity
 * after; the composite is the caller's to restore.
 */
export const takeOutline = (
	ctx: CanvasRenderingContext2D,
	area: Area,
	map: (x: number, y: number) => readonly [number, number]
): void => {
	if (area.shape === undefined) return;
	const [a, b, c, d, e, f] = affineOf(map);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'destination-out';
	ctx.setTransform(a, b, c, d, e, f);
	ctx.fill(area.shape, 'nonzero');
	ctx.setTransform(1, 0, 0, 1, 0, 0);
};

/** Whether a context can blur what it draws: `filter`, which Safari has only from 18. */
const canBlur = (ctx: CanvasRenderingContext2D): boolean => 'filter' in ctx;

/**
 * The feather's blur in a context's pixels: a deviation of half the feather,
 * by the map's scale, which is the surface's pixels per unit and any scale of
 * the layer's; none for no feather. A canvas filter's lengths are the
 * canvas's own pixels, whatever its transform.
 */
const blurOf = (feather: number, matrix: Mat): number => {
	if (!(feather > 0)) return 0;
	const [a, b, c, d] = matrix;
	const scale = Math.sqrt(Math.abs(a * d - b * c));
	return Math.round(((feather * scale) / 2) * 1000) / 1000;
};

/** The surface's map and size: all a mask needs of it. */
type Grid = Pick<RasterSurface, 'canvas' | 'toPixel'>;

/**
 * How much of each of the surface's pixels the area covers, as a canvas of
 * its size whose alpha is the coverage, anti-aliased at the edge: for a tool
 * that writes pixels itself, which a clip does not reach, and for every write
 * through an area that is inverted or feathered. The outline filled, blurred
 * by the feather where the browser can blur; for an inverted area, the canvas
 * filled and that taken out of it. Drawn with `source-over` and
 * `destination-out` alone, which no browser's bounds for a composite change.
 * None without `Path2D`.
 */
export const areaMask = (surface: Grid, area: Area): HTMLCanvasElement | undefined => {
	if (area.shape === undefined) return undefined;
	const canvas = document.createElement('canvas');
	canvas.width = surface.canvas.width;
	canvas.height = surface.canvas.height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	const matrix = affineOf(surface.toPixel);
	const [a, b, c, d, e, f] = matrix;
	ctx.setTransform(a, b, c, d, e, f);
	ctx.fillStyle = '#000000';
	if (area.inverted) {
		ctx.fillRect(area.canvas.x, area.canvas.y, area.canvas.width, area.canvas.height);
		ctx.globalCompositeOperation = 'destination-out';
	}
	const blur = blurOf(area.feather, matrix);
	const blurred = blur > 0 && canBlur(ctx);
	if (blurred) ctx.filter = `blur(${blur}px)`;
	ctx.fill(area.shape, 'nonzero');
	if (blurred) ctx.filter = 'none';
	ctx.globalCompositeOperation = 'source-over';
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	return canvas;
};

/**
 * `canvas`'s pixels kept only as far as `mask` covers them, a canvas of the
 * same size: `destination-in`, with the mask drawn whole, so what lies
 * outside it is not left to a browser's bounds for the composite.
 */
export const keepCovered = (canvas: HTMLCanvasElement, mask: HTMLCanvasElement): void => {
	const ctx = canvas.getContext('2d');
	if (ctx === null) return;
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'destination-in';
	ctx.drawImage(mask, 0, 0);
	ctx.restore();
};

/** The pixels on `ctx` taken away as far as `mask`, of the same size, covers them. */
export const eraseCovered = (ctx: CanvasRenderingContext2D, mask: HTMLCanvasElement): void => {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'destination-out';
	ctx.drawImage(mask, 0, 0);
	ctx.restore();
};

/**
 * A canvas's pixels let go of now, rather than when it is collected: Safari
 * counts every canvas still held against one limit for the page.
 */
export const releaseCanvas = (canvas: HTMLCanvasElement): void => {
	canvas.width = 0;
	canvas.height = 0;
};

/** Whether any pixel in `box` on `ctx` has color, and, with `cover`, a mask the same size covers it. */
export const holdsColor = (
	ctx: CanvasRenderingContext2D,
	box: Box,
	cover?: HTMLCanvasElement
): boolean => {
	const { data } = ctx.getImageData(box.x, box.y, box.width, box.height);
	const covered = cover?.getContext('2d')?.getImageData(box.x, box.y, box.width, box.height).data;
	return data.some((value, index) => index % 4 === 3 && value > 0 && (covered?.[index] ?? 1) > 0);
};

/** The area's box in the surface's pixels, whole pixels and inside the canvas; none where it misses. */
export const areaPixelBox = (surface: Grid, area: Area): Box | undefined => {
	if (area.bounds === undefined) return undefined;
	const corners = cornersOf(area.bounds).map((p) => surface.toPixel(p.x, p.y));
	const xs = corners.map(([x]) => x);
	const ys = corners.map(([, y]) => y);
	const left = Math.max(0, Math.floor(Math.min(...xs)));
	const top = Math.max(0, Math.floor(Math.min(...ys)));
	const right = Math.min(surface.canvas.width, Math.ceil(Math.max(...xs)));
	const bottom = Math.min(surface.canvas.height, Math.ceil(Math.max(...ys)));
	if (right <= left || bottom <= top) return undefined;
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/**
 * Whether the area covers any of a surface's pixels: its box meets them, and
 * for an inverse the layer is not wholly in the hole. The layer's box is its
 * pixels' corners in the root's user units.
 */
export const reachesSurface = (surface: Grid, area: Area): boolean => {
	if (areaPixelBox(surface, area) === undefined) return false;
	if (!area.inverted) return true;
	const { width, height } = surface.canvas;
	const layer = transformBox(invert(affineOf(surface.toPixel)), { x: 0, y: 0, width, height });
	return reachesArea(area, layer);
};

/**
 * What the marching ants trace for an area: its outline, and, for an inverted
 * one, the canvas's edge as well, since that bounds what is selected too, as
 * Photoshop shows it. The ants stay on the outline whatever the feather.
 */
export const antsPath = (region: Region, canvas: Box): string => {
	if (!region.inverted) return region.path;
	const edge = rectPath(canvas);
	return edge === undefined ? region.path : `${edge} ${region.path}`;
};
