import { describe, expect, it } from 'vitest';

import { addToArea, areaPolygons, rectPath } from '../../src/drawing/tools/raster/area.js';
import { outlinePath, type PixelMask, traceMask } from '../../src/drawing/tools/raster/trace.js';
import {
	IDENTITY,
	type Mat,
	multiply,
	rotate,
	scale,
	translate,
} from '../../src/drawing/tools/vector/geometry.js';

/**
 * A pixel mask's outline (`trace.ts`), which the magic wand makes the area
 * selection of: traced along the pixels' edges, straight runs merged, outer
 * boundaries clockwise on a y-down screen and holes the other way, so that
 * under `nonzero` it is exactly the pixels, and a subpath the marquee adds is
 * a union with it. Read back as the area reads it (`areaPolygons`) and filled
 * as the canvas fills it.
 */

type Point = Readonly<{ x: number; y: number }>;

/** A mask from rows of text: `#` selected, anything else not. */
const maskOf = (...rows: readonly string[]): PixelMask => {
	const width = rows[0]?.length ?? 0;
	const selected = new Uint8Array(width * rows.length);
	rows.forEach((row, y) => {
		[...row].forEach((cell, x) => {
			selected[y * width + x] = cell === '#' ? 1 : 0;
		});
	});
	return { selected, width, height: rows.length };
};

const pathOf = (mask: PixelMask, matrix: Mat = IDENTITY): string => {
	const path = outlinePath(traceMask(mask), matrix);
	if (path === undefined) throw new Error('the mask has an outline');
	return path;
};

/** Twice the signed area: positive for a polygon wound clockwise on a y-down screen. */
const signedArea2 = (polygon: readonly Point[]): number =>
	polygon.reduce((sum, p, i) => {
		const q = polygon[(i + 1) % polygon.length] ?? p;
		return sum + p.x * q.y - q.x * p.y;
	}, 0);

/** How many times the path winds around a point, as `nonzero` counts it. */
const windingAt = (path: string, x: number, y: number): number =>
	areaPolygons(path).reduce(
		(total, polygon) =>
			total +
			polygon.reduce((sum, a, i) => {
				const b = polygon[(i + 1) % polygon.length] ?? a;
				const cross = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
				if (a.y <= y && b.y > y && cross > 0) return sum + 1;
				if (a.y > y && b.y <= y && cross < 0) return sum - 1;
				return sum;
			}, 0),
		0
	);

/** The winding at every pixel's center, row by row. */
const windings = (path: string, width: number, height: number): number[] =>
	Array.from({ length: width * height }, (_, i) =>
		windingAt(path, (i % width) + 0.5, Math.floor(i / width) + 0.5)
	);

/** A mask of noise, the same each run. */
const noise = (width: number, height: number, density: number, seed: number): PixelMask => {
	let state = seed;
	const selected = new Uint8Array(width * height).map(() => {
		state = (state * 1103515245 + 12345) % 2147483648;
		return state / 2147483648 < density ? 1 : 0;
	});
	return { selected, width, height };
};

describe('outlinePath', () => {
	it('outlines one pixel as a square, clockwise, as the marquee writes one', () => {
		expect(pathOf(maskOf('#'))).toBe('M 0 0 L 1 0 L 1 1 L 0 1 Z');
		expect(pathOf(maskOf('#'))).toBe(rectPath({ x: 0, y: 0, width: 1, height: 1 }));
	});

	it('merges every straight run, so a rectangle of pixels is four corners', () => {
		const path = pathOf(maskOf('......', '.####.', '.####.', '.####.', '......'));
		expect(path).toBe('M 1 1 L 5 1 L 5 4 L 1 4 Z');
		expect(pathOf(maskOf('##', '#.'))).toBe('M 0 0 L 2 0 L 2 1 L 1 1 L 1 2 L 0 2 Z');
	});

	it('is nothing for a mask with nothing selected', () => {
		expect(outlinePath(traceMask(maskOf('...', '...')), IDENTITY)).toBeUndefined();
		expect(
			outlinePath(traceMask({ selected: new Uint8Array(0), width: 0, height: 0 }), IDENTITY)
		).toBeUndefined();
	});

	it('keeps a ring’s hole: the outer boundary clockwise, the hole counter-clockwise', () => {
		const ring = maskOf('#####', '#...#', '#...#', '#####');
		const path = pathOf(ring);
		const polygons = areaPolygons(path);
		expect(polygons).toHaveLength(2);
		expect(polygons.map((polygon) => polygon.length)).toEqual([4, 4]);
		expect(signedArea2(polygons[0] ?? [])).toBeGreaterThan(0);
		expect(signedArea2(polygons[1] ?? [])).toBeLessThan(0);
		expect(windings(path, 5, 4)).toEqual([...ring.selected]);
	});

	it('stays a union when the marquee adds a rectangle with Shift, over the hole and outside', () => {
		const ring = maskOf('#####', '#...#', '#...#', '#####', '.....', '.....');
		const added = rectPath({ x: 2, y: 2, width: 2, height: 4 });
		if (added === undefined) throw new Error('the rectangle has an inside');
		const union = addToArea(pathOf(ring), added);
		const inRect = (x: number, y: number) => x >= 2 && x < 4 && y >= 2 && y < 6;
		const expected = [...ring.selected].map((on, i) =>
			on === 1 || inRect(i % 5, Math.floor(i / 5)) ? 1 : 0
		);
		expect(windings(union, 5, 6).map((winding) => (winding === 0 ? 0 : 1))).toEqual(expected);
		// The hole is still a hole where the rectangle does not reach it.
		expect(windingAt(union, 1.5, 1.5)).toBe(0);
		expect(windingAt(union, 2.5, 1.5)).toBe(0);
		expect(windingAt(union, 2.5, 2.5)).toBe(1);
		expect(windingAt(union, 0.5, 0.5)).toBe(1);
	});

	it('keeps a ring inside a ring’s hole, an island in a lake', () => {
		const rings = maskOf(
			'#######',
			'#.....#',
			'#.###.#',
			'#.#.#.#',
			'#.###.#',
			'#.....#',
			'#######'
		);
		const path = pathOf(rings);
		expect(areaPolygons(path)).toHaveLength(4);
		expect(windings(path, 7, 7)).toEqual([...rings.selected]);
	});

	it('makes two loops of two pixels that touch only at a corner, as the flood joins by sides', () => {
		const path = pathOf(maskOf('#.', '.#'));
		expect(path).toBe('M 0 0 L 1 0 L 1 1 L 0 1 Z M 1 1 L 2 1 L 2 2 L 1 2 Z');
		const other = pathOf(maskOf('.#', '#.'));
		expect(areaPolygons(other)).toHaveLength(2);
		expect(windings(other, 2, 2)).toEqual([0, 1, 1, 0]);
	});

	it('winds exactly once around every selected pixel and never around another, for any mask', () => {
		[1, 2, 3, 4, 5, 6].forEach((seed) => {
			const mask = noise(23, 17, 0.5, seed);
			const path = pathOf(mask);
			expect(windings(path, 23, 17)).toEqual([...mask.selected]);
			areaPolygons(path).forEach((polygon) => {
				// No three corners in a row on one line: every run is merged.
				polygon.forEach((p, i) => {
					const q = polygon[(i + 1) % polygon.length] ?? p;
					const r = polygon[(i + 2) % polygon.length] ?? p;
					expect((q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x)).not.toBe(0);
				});
			});
		});
	});

	it('takes the corners into user units by the matrix, written to two decimals', () => {
		const square = maskOf('##', '##');
		expect(pathOf(square, translate(5, 7))).toBe('M 5 7 L 7 7 L 7 9 L 5 9 Z');
		expect(pathOf(square, multiply(translate(1, 0), scale(1 / 3, 1 / 3)))).toBe(
			'M 1 0 L 1.67 0 L 1.67 0.67 L 1 0.67 Z'
		);
		expect(pathOf(square, translate(-0.001, 0))).toBe('M 0 0 L 2 0 L 2 2 L 0 2 Z');
	});

	it('keeps an outer boundary clockwise through a matrix that turns or mirrors', () => {
		const ring = maskOf('####', '#..#', '####');
		[
			rotate(90),
			rotate(-30, { x: 2, y: 1 }),
			scale(-1, 1),
			scale(1, -2),
			multiply(rotate(45), scale(-1, 1)),
		].forEach((matrix) => {
			const [outer, hole] = areaPolygons(pathOf(ring, matrix));
			expect(signedArea2(outer ?? [])).toBeGreaterThan(0);
			expect(signedArea2(hole ?? [])).toBeLessThan(0);
		});
	});

	it('walks a loop as long as the picture without recursing', () => {
		// A comb whose teeth are joined at alternate ends: one loop round 2000 × 1000 pixels.
		const width = 2000;
		const height = 1000;
		const selected = new Uint8Array(width * height).map((_, i) => {
			const x = i % width;
			const y = Math.floor(i / width);
			if (x % 2 === 0) return 1;
			return (x % 4 === 1 && y === 0) || (x % 4 === 3 && y === height - 1) ? 1 : 0;
		});
		const outline = traceMask({ selected, width, height });
		expect(outline.ends).toHaveLength(1);
		expect(outline.corners.length).toBeGreaterThan(3999);
		const path = outlinePath(outline, IDENTITY) ?? '';
		expect(areaPolygons(path)).toHaveLength(1);
	});

	it('traces a checkerboard, the most corners a mask can have, in one pass', () => {
		const width = 1000;
		const selected = new Uint8Array(width * width).map(
			(_, i) => ((i % width) + Math.floor(i / width)) % 2
		);
		const outline = traceMask({ selected, width, height: width });
		expect(outline.ends).toHaveLength((width * width) / 2);
		expect(outline.corners).toHaveLength(2 * width * width);
	});
});
