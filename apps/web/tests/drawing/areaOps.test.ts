import { describe, expect, it } from 'vitest';

import {
	addToArea,
	type Area,
	areaHolds,
	areaPolygons,
	rectPath,
} from '../../src/drawing/tools/raster/area.js';
import { AREA_MAX_CELLS, gridAround } from '../../src/drawing/tools/raster/areaMask.js';
import {
	combineAreas,
	MODIFY_LIMITS,
	modifyArea,
	modifyRadius,
} from '../../src/drawing/tools/raster/areaOps.js';
import { outlinePath, type PixelMask, traceMask } from '../../src/drawing/tools/raster/trace.js';
import type { Region } from '../../src/drawing/tools/types.js';
import type { Box } from '../../src/drawing/tools/vector/geometry.js';

/**
 * What is done to an area's outline as a whole (`areaOps.ts`): the
 * selection tools' four modes, met with a plain area and an inverse, and
 * Modify… Each result is read back as the area reads it (`areaPolygons`,
 * `areaHolds`), cell center by cell center, and its path is checked to be
 * the area's grammar: absolute, straight, closed, two decimals, outer loops
 * clockwise and holes the other way, so `nonzero` winds once around what is
 * selected and never twice.
 */

type Point = Readonly<{ x: number; y: number }>;

const CANVAS: Box = { x: 0, y: 0, width: 200, height: 100 };

const rect = (x: number, y: number, width: number, height: number): string => {
	const path = rectPath({ x, y, width, height });
	if (path === undefined) throw new Error('the rectangle has an inside');
	return path;
};

const plain = (path: string, feather = 0): Region => ({ path, inverted: false, feather });
const inverse = (path: string, feather = 0): Region => ({ path, inverted: true, feather });

const defined = (region: Region | undefined): Region => {
	if (region === undefined) throw new Error('something is selected');
	return region;
};

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

/** A mask's outline, as the wand traces it, at `scale` units a pixel. */
const traced = (mask: PixelMask, scale = 1): string => {
	const path = outlinePath(traceMask(mask), [scale, 0, 0, scale, 0, 0]);
	if (path === undefined) throw new Error('the mask has an outline');
	return path;
};

/** A ring as the wand makes one: 30 units a side with a hole of 10 in the middle, at 10 units a pixel. */
const RING = traced(maskOf('###', '#.#', '###'), 10);

/** The area as a stroke holds it, enough of it for `areaHolds`. */
const areaOf = (region: Region, canvas: Box = CANVAS): Area => ({
	path: region.path,
	inverted: region.inverted,
	feather: region.feather,
	canvas,
	polygons: areaPolygons(region.path),
	bounds: undefined,
	shape: undefined,
});

/** How many times the path winds around a point, as `nonzero` counts it. */
const windingAt = (path: string, p: Point): number =>
	areaPolygons(path).reduce(
		(total, polygon) =>
			total +
			polygon.reduce((sum, a, i) => {
				const b = polygon[(i + 1) % polygon.length] ?? a;
				const cross = (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y);
				if (a.y <= p.y && b.y > p.y && cross > 0) return sum + 1;
				if (a.y > p.y && b.y <= p.y && cross < 0) return sum - 1;
				return sum;
			}, 0),
		0
	);

/** Every unit's center in a box. */
const centersIn = (box: Box): readonly Point[] =>
	Array.from({ length: box.height }, (_, j) =>
		Array.from({ length: box.width }, (_, i) => ({ x: box.x + i + 0.5, y: box.y + j + 0.5 }))
	).flat();

/** Whether a region selects the unit whose center is `p`, as the ants draw it. */
const holds = (region: Region | undefined, p: Point, canvas: Box = CANVAS): boolean =>
	region !== undefined && areaHolds(areaOf(region, canvas), p);

/** The centers in `box` where what the region selects is not what `expected` says. */
const mismatches = (
	region: Region | undefined,
	box: Box,
	expected: (p: Point) => boolean,
	canvas: Box = CANVAS
): readonly Point[] => centersIn(box).filter((p) => holds(region, p, canvas) !== expected(p));

/** Whether a point is inside a box, its left and top edges in and its right and bottom ones out. */
const inBox = (box: Box, p: Point): boolean =>
	p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height;

/** The distance from a unit's center to the nearest center of a box of whole units. */
const distanceToBox = (box: Box, p: Point): number => {
	const dx = Math.max(0, box.x + 0.5 - p.x, p.x - (box.x + box.width - 0.5));
	const dy = Math.max(0, box.y + 0.5 - p.y, p.y - (box.y + box.height - 0.5));
	return Math.hypot(dx, dy);
};

/** Twice the signed area: positive for a polygon wound clockwise on a y-down screen. */
const signedArea2 = (polygon: readonly Point[]): number =>
	polygon.reduce((sum, p, i) => {
		const q = polygon[(i + 1) % polygon.length] ?? p;
		return sum + p.x * q.y - q.x * p.y;
	}, 0);

const NUMBER = String.raw`-?\d+(?:\.\d{1,2})?`;
const PAIR = `${NUMBER} ${NUMBER}`;
const SUBPATH = `M ${PAIR}(?: L ${PAIR})+ Z`;
const GRAMMAR = new RegExp(`^${SUBPATH}(?: ${SUBPATH})*$`);

/**
 * That a path is the area's grammar and winds once around what it selects:
 * at every unit's center in `box`, 0 or 1, never more and never less, so its
 * outer loops are clockwise and its holes are not.
 */
const expectWellFormed = (path: string, box: Box): void => {
	expect(path).toMatch(GRAMMAR);
	const windings = new Set(centersIn(box).map((p) => windingAt(path, p)));
	expect([...windings].every((w) => w === 0 || w === 1)).toBe(true);
	areaPolygons(path).forEach((polygon) => expect(signedArea2(polygon)).not.toBe(0));
};

describe('combineAreas: a click', () => {
	const there = plain(rect(10, 10, 50, 30), 4);

	it('drops the area in new', () => {
		expect(combineAreas(there, undefined, 'new')).toBeUndefined();
	});

	it('leaves the area as it was in the other modes', () => {
		expect(combineAreas(there, undefined, 'add')).toBe(there);
		expect(combineAreas(there, undefined, 'subtract')).toBe(there);
		expect(combineAreas(there, undefined, 'intersect')).toBe(there);
		expect(combineAreas(undefined, undefined, 'add')).toBeUndefined();
	});
});

describe('combineAreas: new', () => {
	it('is the outline made, plain and hard, whatever was there', () => {
		const made = rect(5, 5, 10, 10);
		expect(combineAreas(inverse(rect(0, 0, 50, 50), 8), made, 'new')).toEqual(plain(made));
		expect(combineAreas(undefined, made, 'new')).toEqual(plain(made));
	});
});

describe('combineAreas: with nothing selected', () => {
	const made = rect(5, 5, 10, 10);

	it('adds the outline made, as new does', () => {
		expect(combineAreas(undefined, made, 'add')).toEqual(plain(made));
	});

	it('subtracts from nothing, and intersects with nothing, to nothing', () => {
		expect(combineAreas(undefined, made, 'subtract')).toBeUndefined();
		expect(combineAreas(undefined, made, 'intersect')).toBeUndefined();
	});
});

describe('combineAreas on a plain area', () => {
	const there = plain(rect(0, 0, 100, 50), 3);

	it('adds by the two outlines as one, exactly, and keeps the feather', () => {
		const made = 'M 10.25 10.75 L 120.5 30 L 40 80 Z';
		expect(combineAreas(there, made, 'add')).toEqual(plain(addToArea(there.path, made), 3));
	});

	it('subtracts a rectangle on whole units exactly', () => {
		expect(combineAreas(there, rect(50, -10, 100, 70), 'subtract')).toEqual(
			plain('M 0 0 L 50 0 L 50 50 L 0 50 Z', 3)
		);
	});

	it('subtracts what lies inside as a hole, wound the other way', () => {
		const ring = defined(
			combineAreas(plain(rect(0, 0, 100, 100)), rect(25, 25, 50, 50), 'subtract')
		);
		expect(ring.path).toBe(
			'M 0 0 L 100 0 L 100 100 L 0 100 Z M 25 25 L 25 75 L 75 75 L 75 25 Z'
		);
		const [outer, hole] = areaPolygons(ring.path);
		expect(signedArea2(outer ?? [])).toBeGreaterThan(0);
		expect(signedArea2(hole ?? [])).toBeLessThan(0);
		expect(holds(ring, { x: 50, y: 50 })).toBe(false);
		expect(holds(ring, { x: 10, y: 50 })).toBe(true);
	});

	it('subtracts everything to nothing', () => {
		expect(combineAreas(there, rect(-10, -10, 200, 200), 'subtract')).toBeUndefined();
	});

	it('leaves an outline whose box the subtracted one misses untouched', () => {
		const lasso = plain('M 0.33 0.5 L 40.1 2 L 20.7 30.25 Z', 1);
		expect(combineAreas(lasso, rect(60, 0, 10, 10), 'subtract')).toEqual(lasso);
	});

	it('intersects to what both select, exactly on whole units', () => {
		expect(combineAreas(there, rect(50, -10, 100, 70), 'intersect')).toEqual(
			plain('M 50 0 L 100 0 L 100 50 L 50 50 Z', 3)
		);
	});

	it('intersects with what it does not meet to nothing', () => {
		expect(combineAreas(there, rect(150, 0, 10, 10), 'intersect')).toBeUndefined();
		expect(combineAreas(there, rect(100, 0, 10, 10), 'intersect')).toBeUndefined();
	});

	it('takes a slanted edge to the units it covers, a staircase', () => {
		const triangle = 'M 0 0 L 40 0 L 0 40 Z';
		const result = defined(combineAreas(plain(rect(0, 0, 40, 40)), triangle, 'subtract'));
		const box = { x: -2, y: -2, width: 44, height: 44 };
		expectWellFormed(result.path, box);
		expect(
			mismatches(
				result,
				box,
				(p) => inBox({ x: 0, y: 0, width: 40, height: 40 }, p) && p.x + p.y >= 40
			)
		).toEqual([]);
		areaPolygons(result.path)
			.flat()
			.forEach((p) => {
				expect(Number.isInteger(p.x) && Number.isInteger(p.y)).toBe(true);
			});
	});
});

describe('combineAreas on an inverted area', () => {
	const hole = rect(50, 25, 100, 50);
	const there = inverse(hole, 2);

	it('adds as an inverse of the outline less what is added', () => {
		expect(combineAreas(there, rect(0, 0, 100, 100), 'add')).toEqual(
			inverse('M 100 25 L 150 25 L 150 75 L 100 75 Z', 2)
		);
	});

	it('adds what covers the outline to the whole canvas, an inverse of nothing', () => {
		const all = defined(combineAreas(there, rect(0, 0, 200, 100), 'add'));
		expect(all).toEqual(inverse('', 2));
		expect(mismatches(all, CANVAS, () => true)).toEqual([]);
	});

	it('subtracts as an inverse of the two outlines as one, exactly', () => {
		const made = 'M 10.5 10.5 L 30 10.5 L 20 40 Z';
		expect(combineAreas(there, made, 'subtract')).toEqual(inverse(`${hole} ${made}`, 2));
		expect(combineAreas(inverse('', 2), made, 'subtract')).toEqual(inverse(made, 2));
	});

	it('intersects to what is made less the outline, a plain area', () => {
		const made = rect(0, 0, 100, 100);
		const result = defined(combineAreas(there, made, 'intersect'));
		expect(result.inverted).toBe(false);
		expect(result.feather).toBe(2);
		expect(
			mismatches(
				result,
				CANVAS,
				(p) =>
					inBox({ x: 0, y: 0, width: 100, height: 100 }, p) &&
					!inBox({ x: 50, y: 25, width: 100, height: 50 }, p)
			)
		).toEqual([]);
		expectWellFormed(result.path, CANVAS);
	});

	it('selects the same units as the algebra says, mode by mode', () => {
		const made = 'M 20 10 L 120 10 L 120 60 L 20 60 Z';
		const madeHolds = (p: Point): boolean => inBox({ x: 20, y: 10, width: 100, height: 50 }, p);
		const thereHolds = (p: Point): boolean =>
			!inBox({ x: 50, y: 25, width: 100, height: 50 }, p);
		expect(
			mismatches(
				combineAreas(there, made, 'add'),
				CANVAS,
				(p) => thereHolds(p) || madeHolds(p)
			)
		).toEqual([]);
		expect(
			mismatches(
				combineAreas(there, made, 'subtract'),
				CANVAS,
				(p) => thereHolds(p) && !madeHolds(p)
			)
		).toEqual([]);
		expect(
			mismatches(
				combineAreas(there, made, 'intersect'),
				CANVAS,
				(p) => thereHolds(p) && madeHolds(p)
			)
		).toEqual([]);
	});
});

describe('combineAreas on an outline with holes', () => {
	const ring = plain(RING, 1);
	const ringHolds = (p: Point): boolean =>
		inBox({ x: 0, y: 0, width: 30, height: 30 }, p) &&
		!inBox({ x: 10, y: 10, width: 10, height: 10 }, p);
	const box = { x: -5, y: -5, width: 40, height: 40 };

	it('keeps the hole a hole when something across it is subtracted', () => {
		const result = defined(combineAreas(ring, rect(0, 0, 15, 30), 'subtract'));
		expect(mismatches(result, box, (p) => ringHolds(p) && p.x >= 15)).toEqual([]);
		expectWellFormed(result.path, box);
	});

	it('intersects to a smaller ring, its hole kept', () => {
		expect(combineAreas(ring, rect(5, 5, 20, 20), 'intersect')).toEqual(
			plain('M 5 5 L 25 5 L 25 25 L 5 25 Z M 10 10 L 10 20 L 20 20 L 20 10 Z', 1)
		);
	});

	it('fills the hole by adding over an inverse of the ring', () => {
		const result = defined(combineAreas(inverse(RING), rect(0, 0, 15, 15), 'add'));
		expect(result.inverted).toBe(true);
		expect(
			mismatches(
				result,
				CANVAS,
				(p) => !ringHolds(p) || inBox({ x: 0, y: 0, width: 15, height: 15 }, p)
			)
		).toEqual([]);
		expectWellFormed(result.path, CANVAS);
	});
});

describe('modifyArea: expand', () => {
	const box = { x: 20, y: 30, width: 40, height: 20 };
	const view = { x: 0, y: 0, width: 100, height: 80 };

	it('grows by the distance from the area, so its sides move out exactly and its corners round', () => {
		const result = defined(modifyArea(plain(rect(20, 30, 40, 20), 5), 'expand', 7, CANVAS));
		expect(result.feather).toBe(5);
		expect(mismatches(result, view, (p) => distanceToBox(box, p) <= 7)).toEqual([]);
		expectWellFormed(result.path, view);
		expect(holds(result, { x: 13.5, y: 40.5 })).toBe(true);
		expect(holds(result, { x: 12.5, y: 40.5 })).toBe(false);
		expect(holds(result, { x: 13.5, y: 23.5 })).toBe(false);
	});

	it('grows an outline with holes, closing a hole smaller than twice the radius', () => {
		const result = defined(modifyArea(plain(RING), 'expand', 5, CANVAS));
		expect(holds(result, { x: 15, y: 15 })).toBe(true);
		expect(result.path).toMatch(GRAMMAR);
		expect(areaPolygons(result.path)).toHaveLength(1);
	});

	it('on an inverse, contracts the outline and stays an inverse', () => {
		expect(modifyArea(inverse(rect(50, 25, 100, 50), 2), 'expand', 10, CANVAS)).toEqual(
			inverse('M 60 35 L 140 35 L 140 65 L 60 65 Z', 2)
		);
	});

	it('on an inverse whose outline it contracts away, selects the whole canvas', () => {
		expect(modifyArea(inverse(rect(50, 25, 10, 10)), 'expand', 10, CANVAS)).toEqual(
			inverse('')
		);
	});
});

describe('modifyArea: contract', () => {
	it('shrinks a rectangle on whole units to a rectangle, exactly', () => {
		expect(modifyArea(plain(rect(0, 0, 100, 50), 1), 'contract', 10, CANVAS)).toEqual(
			plain('M 10 10 L 90 10 L 90 40 L 10 40 Z', 1)
		);
	});

	it('leaves nothing of what is no wider than twice the radius', () => {
		expect(modifyArea(plain(rect(0, 0, 100, 20)), 'contract', 10, CANVAS)).toBeUndefined();
	});

	it('widens a hole', () => {
		const result = defined(modifyArea(plain(rect(0, 0, 100, 100)), 'contract', 5, CANVAS));
		const ring = defined(
			modifyArea(
				defined(
					combineAreas(plain(rect(0, 0, 100, 100)), rect(40, 40, 20, 20), 'subtract')
				),
				'contract',
				5,
				CANVAS
			)
		);
		expect(result.path).toBe('M 5 5 L 95 5 L 95 95 L 5 95 Z');
		const view = { x: 0, y: 0, width: 100, height: 100 };
		const hole = { x: 40, y: 40, width: 20, height: 20 };
		expect(
			mismatches(
				ring,
				view,
				(p) => inBox({ x: 5, y: 5, width: 90, height: 90 }, p) && distanceToBox(hole, p) > 5
			)
		).toEqual([]);
		expectWellFormed(ring.path, view);
	});

	it('on an inverse, expands the outline and stays an inverse', () => {
		const result = defined(modifyArea(inverse(rect(50, 25, 100, 50)), 'contract', 10, CANVAS));
		expect(result.inverted).toBe(true);
		const outline = { x: 50, y: 25, width: 100, height: 50 };
		expect(mismatches(result, CANVAS, (p) => distanceToBox(outline, p) > 10)).toEqual([]);
	});

	it('on an inverse, leaves nothing where the outline grown covers the canvas', () => {
		expect(modifyArea(inverse(rect(50, 25, 100, 50)), 'contract', 60, CANVAS)).toBeUndefined();
		expect(modifyArea(inverse(rect(50, 25, 100, 50)), 'contract', 40, CANVAS)).toBeDefined();
	});
});

describe('modifyArea: border', () => {
	it('is a band centered on the outline, half inside and half outside', () => {
		const result = defined(modifyArea(plain(rect(20, 20, 60, 40), 3), 'border', 10, CANVAS));
		const outline = { x: 20, y: 20, width: 60, height: 40 };
		const inner = { x: 25, y: 25, width: 50, height: 30 };
		const view = { x: 0, y: 0, width: 100, height: 80 };
		expect(result.feather).toBe(3);
		expect(
			mismatches(result, view, (p) => distanceToBox(outline, p) <= 5 && !inBox(inner, p))
		).toEqual([]);
		const [, hole] = areaPolygons(result.path);
		expect(signedArea2(hole ?? [])).toBeLessThan(0);
		expect(result.path.endsWith('M 25 25 L 25 55 L 75 55 L 75 25 Z')).toBe(true);
		expectWellFormed(result.path, view);
	});

	it('of 1 is the ring of units just inside the outline', () => {
		expect(modifyArea(plain(rect(0, 0, 10, 10)), 'border', 1, CANVAS)).toEqual(
			plain('M 0 0 L 10 0 L 10 10 L 0 10 Z M 1 1 L 1 9 L 9 9 L 9 1 Z')
		);
	});

	it('of an inverse is the band on its outline, a plain area', () => {
		const result = defined(modifyArea(inverse(rect(50, 25, 100, 50), 2), 'border', 4, CANVAS));
		expect(result.inverted).toBe(false);
		expect(result.feather).toBe(2);
		const outline = { x: 50, y: 25, width: 100, height: 50 };
		expect(
			mismatches(
				result,
				CANVAS,
				(p) =>
					distanceToBox(outline, p) <= 2 &&
					!inBox({ x: 52, y: 27, width: 96, height: 46 }, p)
			)
		).toEqual([]);
	});

	it('of an inverse of nothing is nothing', () => {
		expect(modifyArea(inverse(''), 'border', 4, CANVAS)).toBeUndefined();
	});
});

describe('modifyArea: smooth', () => {
	// A square with a notch a unit wide in its top edge, and a speck apart from it.
	const notched = 'M 0 0 L 20 0 L 20 1 L 21 1 L 21 0 L 40 0 L 40 40 L 0 40 Z';
	const speck = rect(60, 60, 1, 1);
	const region = plain(addToArea(notched, speck), 6);

	it('takes off a speck, fills a notch and rounds a corner', () => {
		const result = defined(modifyArea(region, 'smooth', 2, CANVAS));
		expect(result.feather).toBe(6);
		expect(holds(result, { x: 60.5, y: 60.5 })).toBe(false);
		expect(holds(result, { x: 20.5, y: 0.5 })).toBe(true);
		expect(holds(result, { x: 0.5, y: 0.5 })).toBe(false);
		expect(holds(result, { x: 1.5, y: 0.5 })).toBe(false);
		expect(holds(result, { x: 2.5, y: 0.5 })).toBe(true);
		expect(holds(result, { x: 1.5, y: 1.5 })).toBe(true);
		expect(holds(result, { x: 20, y: 20 })).toBe(true);
		expectWellFormed(result.path, { x: -2, y: -2, width: 70, height: 70 });
	});

	it('leaves a rectangle larger than the square alone but for its corners', () => {
		const result = defined(modifyArea(plain(rect(0, 0, 40, 40)), 'smooth', 1, CANVAS));
		expect(result.path).toBe(
			'M 1 0 L 39 0 L 39 1 L 40 1 L 40 39 L 39 39 L 39 40 L 1 40 L 1 39 L 0 39 L 0 1 L 1 1 Z'
		);
	});

	it('takes off what is smaller than the square, to nothing', () => {
		expect(modifyArea(plain(rect(0, 0, 3, 3)), 'smooth', 5, CANVAS)).toBeUndefined();
	});

	it('on an inverse, smooths the outline and stays an inverse', () => {
		const result = defined(modifyArea(inverse(addToArea(notched, speck)), 'smooth', 2, CANVAS));
		expect(result.inverted).toBe(true);
		expect(holds(result, { x: 60.5, y: 60.5 })).toBe(true);
		expect(holds(result, { x: 20.5, y: 0.5 })).toBe(false);
	});

	it('on an inverse whose outline it takes off, selects the whole canvas', () => {
		expect(modifyArea(inverse(speck), 'smooth', 2, CANVAS)).toEqual(inverse(''));
	});
});

describe('modifyArea: radius', () => {
	it('has Photoshop’s limits', () => {
		expect(MODIFY_LIMITS).toEqual({
			expand: { min: 1, max: 500 },
			contract: { min: 1, max: 500 },
			smooth: { min: 1, max: 500 },
			border: { min: 1, max: 200 },
		});
	});

	it('is rounded to whole units and held to them', () => {
		expect(modifyRadius('expand', 0)).toBe(1);
		expect(modifyRadius('expand', -3)).toBe(1);
		expect(modifyRadius('contract', 2.4)).toBe(2);
		expect(modifyRadius('smooth', 2.5)).toBe(3);
		expect(modifyRadius('expand', 1000)).toBe(500);
		expect(modifyRadius('border', 1000)).toBe(200);
		expect(modifyRadius('smooth', Number.NaN)).toBe(1);
		expect(modifyRadius('border', Number.POSITIVE_INFINITY)).toBe(200);
		expect(modifyRadius('contract', Number.NEGATIVE_INFINITY)).toBe(1);
	});

	it('is held as modifyArea takes it', () => {
		const there = plain(rect(0, 0, 2000, 2000));
		expect(modifyArea(there, 'contract', 10_000, CANVAS)).toEqual(
			plain('M 500 500 L 1500 500 L 1500 1500 L 500 1500 Z')
		);
		expect(modifyArea(plain(rect(0, 0, 10, 10)), 'contract', 0, CANVAS)).toEqual(
			modifyArea(plain(rect(0, 0, 10, 10)), 'contract', 1, CANVAS)
		);
		expect(modifyArea(plain(rect(0, 0, 10, 10)), 'contract', 0, CANVAS)).toEqual(
			plain('M 1 1 L 9 1 L 9 9 L 1 9 Z')
		);
	});
});

describe('the bytes', () => {
	const lasso = 'M 3.3 2.1 L 77.7 9.9 L 52.25 61.5 L 14 40.75 Z';

	it('are the same for the same input, every time', () => {
		const runs = (): readonly (Region | undefined)[] => [
			combineAreas(plain(RING), lasso, 'subtract'),
			combineAreas(plain(rect(0, 0, 50, 50)), lasso, 'intersect'),
			combineAreas(inverse(lasso), rect(10, 10, 30, 30), 'add'),
			modifyArea(plain(lasso), 'expand', 6, CANVAS),
			modifyArea(plain(lasso), 'contract', 6, CANVAS),
			modifyArea(plain(lasso), 'smooth', 6, CANVAS),
			modifyArea(plain(lasso), 'border', 6, CANVAS),
		];
		const first = runs();
		expect(runs()).toEqual(first);
		first.forEach((region) => {
			expectWellFormed(defined(region).path, { x: -10, y: -10, width: 100, height: 90 });
		});
	});
});

describe('a grid too large for a unit a cell', () => {
	it('takes the fewest whole units a cell that keep it under the most cells', () => {
		const grid = gridAround({ x: 0, y: 0, width: 8000, height: 4000 }, 0);
		expect(grid.cell).toBe(2);
		expect(grid.width * grid.height).toBeLessThanOrEqual(AREA_MAX_CELLS);
		const small = gridAround({ x: 3, y: 7, width: 1000, height: 1000 }, 50, 10_000);
		expect(small.width * small.height).toBeLessThanOrEqual(10_000);
		expect(small.cell).toBeGreaterThan(10);
		expect(Number.isInteger(small.x / small.cell)).toBe(true);
		expect(Number.isInteger(small.y / small.cell)).toBe(true);
		expect(gridAround({ x: 0, y: 0, width: 4000, height: 3000 }, 10).cell).toBe(1);
	});

	it('is worked on larger cells, its edges on them', () => {
		const result = defined(
			combineAreas(plain(rect(0, 0, 6000, 3000)), rect(1001, 1001, 1000, 1000), 'subtract')
		);
		expect(result.path).toBe(
			'M 0 0 L 6000 0 L 6000 3000 L 0 3000 Z M 1000 1000 L 1000 2000 L 2000 2000 L 2000 1000 Z'
		);
	});
});
