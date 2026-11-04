import type { ToolContext } from '../types.js';
import {
	type Box,
	boxContains,
	boxesIntersect,
	invert,
	type Mat,
	multiply,
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

/** A rectangle as a subpath; none for one with no width or no height. */
export const rectPath = (box: Box): string | undefined =>
	polygonPath([
		{ x: box.x, y: box.y },
		{ x: box.x + box.width, y: box.y },
		{ x: box.x + box.width, y: box.y + box.height },
		{ x: box.x, y: box.y + box.height },
	]);

/** The area made larger by another: the second as a subpath after the first, a union under `nonzero`. */
export const addToArea = (existing: string | undefined, added: string): string =>
	existing === undefined ? added : `${existing} ${added}`;

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

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

/** The box round every corner; none for an area with no subpath. */
const boundsOf = (polygons: readonly (readonly Point[])[]): Box | undefined => {
	const points = polygons.flat();
	if (points.length === 0) return undefined;
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	const x = Math.min(...xs);
	const y = Math.min(...ys);
	return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
};

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

const cornersOf = (box: Box): readonly Point[] => [
	{ x: box.x, y: box.y },
	{ x: box.x + box.width, y: box.y },
	{ x: box.x + box.width, y: box.y + box.height },
	{ x: box.x, y: box.y + box.height },
];

/**
 * Whether a polygon and a box share any point: a corner of the polygon in
 * the box, a corner of the box in the polygon, or two edges crossing. What a
 * lasso round an element's box, or through it, takes.
 */
const polygonTouchesBox = (polygon: readonly Point[], box: Box): boolean => {
	if (polygon.some((p) => boxContains(box, p))) return true;
	const corners = cornersOf(box);
	if (corners.some((corner) => insidePolygon(polygon, corner))) return true;
	return polygon.some((a, i) => {
		const b = polygon[(i + 1) % polygon.length] ?? a;
		return corners.some((c, j) => segmentsMeet(a, b, c, corners[(j + 1) % 4] ?? c));
	});
};

/** Whether the area, a union of its subpaths, shares any point with a box. */
export const areaTouchesBox = (polygons: readonly (readonly Point[])[], box: Box): boolean =>
	polygons.some((polygon) => polygonTouchesBox(polygon, box));

/** The area as a raster stroke holds it, read once when the stroke begins. */
export interface Area {
	readonly path: string;
	/** The box round it in user units; none for a path with no inside, which takes no paint. */
	readonly bounds: Box | undefined;
	/** The path for the canvas; none where the browser has no `Path2D`. */
	readonly shape: Path2D | undefined;
}

/** The area set now, for a tool to paint inside; none when nothing is selected. */
export const areaOf = (context: ToolContext): Area | undefined => {
	const path = context.region.path;
	if (path === undefined) return undefined;
	return {
		path,
		bounds: boundsOf(areaPolygons(path)),
		shape: typeof Path2D === 'function' ? new Path2D(path) : undefined,
	};
};

/** Whether a box in user units reaches the area: any box does where there is none. */
export const reachesArea = (area: Area | undefined, box: Box): boolean =>
	area === undefined || (area.bounds !== undefined && boxesIntersect(area.bounds, box));

/** A map from user units that is affine, as a matrix, read off where it sends three points. */
const affineOf = (map: (x: number, y: number) => readonly [number, number]): Mat => {
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
 * `ctx` clipped to the area, its path drawn through `map`, which takes user
 * units to the context's pixels; whether it was, which it is not where the
 * browser has no `Path2D`. The clip stays until the caller's `restore()`; the
 * transform is the identity after.
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
 * How much of each of the surface's pixels the area covers, as a canvas whose
 * alpha is the coverage, anti-aliased at the edge: for a tool that writes
 * pixels itself, which a clip does not reach. None without `Path2D`.
 */
export const areaMask = (surface: RasterSurface, area: Area): HTMLCanvasElement | undefined => {
	if (area.shape === undefined) return undefined;
	const canvas = document.createElement('canvas');
	canvas.width = surface.canvas.width;
	canvas.height = surface.canvas.height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	const [a, b, c, d, e, f] = affineOf(surface.toPixel);
	ctx.setTransform(a, b, c, d, e, f);
	ctx.fillStyle = '#000000';
	ctx.fill(area.shape, 'nonzero');
	return canvas;
};

/** The area's box in the surface's pixels, whole pixels and inside the canvas; none where it misses. */
export const areaPixelBox = (surface: RasterSurface, area: Area): Box | undefined => {
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
