import { describe, expect, it } from 'vitest';

import {
	apply,
	boxContains,
	boxesIntersect,
	constrainLine,
	constrainRect,
	distance,
	formatTransform,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
	type Point,
	pressureWidth,
	rectFrom,
	rotate,
	scale,
	simplify,
	smoothPath,
	strokeOutline,
	transformBox,
	translate,
	unionBox,
} from '../../src/drawing/tools/vector/geometry.js';

/**
 * The vector tools' geometry (docs/ARCHITECTURE.md §7, "The editor"): what a
 * freehand stroke becomes, how a brush stroke is outlined, what Shift holds a
 * shape to, and the matrix behind every `transform`. Pure arithmetic, so no DOM.
 */

const commandsOf = (d: string): string[] => d.match(/[MLCAZ]/g) ?? [];

const near = (a: number, b: number, within = 1e-6): boolean => Math.abs(a - b) <= within;

const expectMatrix = (actual: Mat, expected: Mat, within = 1e-6): void => {
	actual.forEach((value, i) => {
		expect(
			near(value, expected[i] ?? Number.NaN, within),
			`[${i}] ${value} ≈ ${expected[i]}`
		).toBe(true);
	});
};

/** A wavy line: enough points, none of them collinear, for simplification to bite. */
const wave = (count: number): Point[] =>
	Array.from({ length: count }, (_, i) => ({
		x: i * 4,
		y: 50 + 3 * Math.sin(i / 2) + (i % 2 === 0 ? 0.8 : -0.8),
	}));

describe('distance', () => {
	it('is the straight line between two points', () => {
		expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
		expect(distance({ x: 1, y: 1 }, { x: 1, y: 1 })).toBe(0);
	});
});

describe('smoothPath', () => {
	it('is nothing for no points, and a dot for one', () => {
		expect(smoothPath([], 0.5)).toBe('');
		expect(smoothPath([{ x: 10.004, y: 20 }], 0.5)).toBe('M 10 20 L 10 20');
		expect(
			smoothPath(
				[
					{ x: 5, y: 5 },
					{ x: 5, y: 5 },
				],
				0.5
			)
		).toBe('M 5 5 L 5 5');
	});

	it('joins the points with lines at no smoothing, and with cubics otherwise', () => {
		const points = wave(12);
		const straight = smoothPath(points, 0);
		expect(commandsOf(straight)).toEqual(['M', ...Array<string>(11).fill('L')]);
		const curved = smoothPath(points, 0.3);
		expect(curved.startsWith('M 0 50')).toBe(true);
		expect(commandsOf(curved)[1]).toBe('C');
		expect(curved).not.toContain('L');
	});

	it('keeps fewer points as the smoothing grows', () => {
		const points = wave(60);
		const counts = [0.2, 0.5, 1].map(
			(smoothing) => commandsOf(smoothPath(points, smoothing)).length
		);
		expect(counts[0]).toBeGreaterThan(counts[1] ?? 0);
		expect(counts[1]).toBeGreaterThan(counts[2] ?? 0);
		expect(counts[2]).toBeGreaterThanOrEqual(2);
	});

	it('writes two decimals and no sign on a zero', () => {
		const d = smoothPath(
			[
				{ x: 0.001, y: -0.004 },
				{ x: 1.2345, y: 2.3456 },
			],
			0
		);
		expect(d).toBe('M 0 0 L 1.23 2.35');
	});

	it('ends where the stroke ended, however hard it is simplified', () => {
		const points = wave(40);
		const last = points.at(-1);
		const d = smoothPath(points, 1);
		expect(d.endsWith(`${last?.x} ${Math.round((last?.y ?? 0) * 100) / 100}`)).toBe(true);
	});
});

describe('simplify', () => {
	it('keeps the ends and whatever strays past epsilon', () => {
		const line = [
			{ x: 0, y: 0 },
			{ x: 1, y: 0.1 },
			{ x: 2, y: 0 },
			{ x: 3, y: 5 },
			{ x: 4, y: 0 },
		];
		expect(simplify(line, 0.5)).toEqual([
			{ x: 0, y: 0 },
			{ x: 2, y: 0 },
			{ x: 3, y: 5 },
			{ x: 4, y: 0 },
		]);
		expect(simplify(line, 10)).toEqual([
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
		]);
		expect(simplify(line.slice(0, 2), 10)).toEqual(line.slice(0, 2));
	});
});

describe('strokeOutline', () => {
	it('is a circle of the width for one point', () => {
		const d = strokeOutline([{ x: 10, y: 10, w: 6 }]);
		expect(d).toBe('M 13 10 A 3 3 0 1 1 7 10 A 3 3 0 1 1 13 10 Z');
		expect(strokeOutline([])).toBe('');
	});

	it('is a closed outline with a side for each point and a cap at each end', () => {
		const points = Array.from({ length: 10 }, (_, i) => ({
			x: i * 10,
			y: i % 2 ? 3 : 0,
			w: 4,
		}));
		const d = strokeOutline(points);
		expect(d.startsWith('M ')).toBe(true);
		expect(d.endsWith(' Z')).toBe(true);
		const vertices = commandsOf(d).filter((c) => c === 'M' || c === 'L').length;
		expect(vertices).toBeGreaterThanOrEqual(points.length * 2);
	});

	it('offsets a straight stroke by half its width either side', () => {
		const d = strokeOutline([
			{ x: 0, y: 0, w: 4 },
			{ x: 10, y: 0, w: 4 },
		]);
		// Left of a stroke going right is above it; right is below.
		expect(d.startsWith('M 0 -2 L 10 -2')).toBe(true);
		expect(d).toContain('L 10 2 L 0 2');
	});
});

describe('pressureWidth', () => {
	it('is a quarter of the size at no pressure and all of it at full, or the size when pressure is off', () => {
		expect(pressureWidth(8, 0, true)).toBe(2);
		expect(pressureWidth(8, 1, true)).toBe(8);
		expect(pressureWidth(8, 0.5, true)).toBe(5);
		expect(pressureWidth(8, 0, false)).toBe(8);
	});
});

describe('constrainRect', () => {
	it('is the far corner as given, or squared to the longer side keeping the direction', () => {
		const a = { x: 10, y: 10 };
		expect(constrainRect(a, { x: 50, y: 30 }, false)).toEqual({ x: 50, y: 30 });
		expect(constrainRect(a, { x: 50, y: 30 }, true)).toEqual({ x: 50, y: 50 });
		expect(constrainRect(a, { x: -20, y: 15 }, true)).toEqual({ x: -20, y: 40 });
		expect(constrainRect(a, { x: 15, y: -20 }, true)).toEqual({ x: 40, y: -20 });
	});
});

describe('constrainLine', () => {
	it('snaps the angle to a multiple of 45° and keeps the length', () => {
		const a = { x: 0, y: 0 };
		expect(constrainLine(a, { x: 10, y: 2 }, false)).toEqual({ x: 10, y: 2 });
		const flat = constrainLine(a, { x: 10, y: 2 }, true);
		expect(near(flat.x, Math.hypot(10, 2))).toBe(true);
		expect(near(flat.y, 0)).toBe(true);
		const diagonal = constrainLine(a, { x: 10, y: 8 }, true);
		expect(near(diagonal.x, diagonal.y)).toBe(true);
		expect(near(distance(a, diagonal), Math.hypot(10, 8))).toBe(true);
		const up = constrainLine(a, { x: 1, y: -20 }, true);
		expect(near(up.x, 0)).toBe(true);
		expect(up.y).toBeLessThan(0);
	});
});

describe('rectFrom', () => {
	it('is the rectangle between two corners whichever way the drag went', () => {
		expect(rectFrom({ x: 10, y: 20 }, { x: 30, y: 60 })).toEqual({
			x: 10,
			y: 20,
			width: 20,
			height: 40,
		});
		expect(rectFrom({ x: 30, y: 60 }, { x: 10, y: 20 })).toEqual({
			x: 10,
			y: 20,
			width: 20,
			height: 40,
		});
	});
});

describe('boxes', () => {
	it('unions, contains with slop, and intersects', () => {
		const a = { x: 0, y: 0, width: 10, height: 10 };
		const b = { x: 5, y: 5, width: 10, height: 10 };
		const c = { x: 20, y: 20, width: 1, height: 1 };
		expect(unionBox([])).toBeUndefined();
		expect(unionBox([a, b])).toEqual({ x: 0, y: 0, width: 15, height: 15 });
		expect(boxContains(a, { x: 10, y: 10 })).toBe(true);
		expect(boxContains(a, { x: 11, y: 10 })).toBe(false);
		expect(boxContains(a, { x: 11, y: 10 }, 2)).toBe(true);
		expect(boxesIntersect(a, b)).toBe(true);
		expect(boxesIntersect(a, c)).toBe(false);
	});

	it('boxes the corners after a transform', () => {
		const box = { x: 0, y: 0, width: 10, height: 20 };
		expect(transformBox(translate(5, 5), box)).toEqual({ x: 5, y: 5, width: 10, height: 20 });
		const turned = transformBox(rotate(90), box);
		expect(near(turned.x, -20)).toBe(true);
		expect(near(turned.y, 0)).toBe(true);
		expect(near(turned.width, 20)).toBe(true);
		expect(near(turned.height, 10)).toBe(true);
	});
});

describe('matrices', () => {
	it('apply translate, scale and rotate as SVG does', () => {
		expect(apply(translate(5, -3), { x: 1, y: 1 })).toEqual({ x: 6, y: -2 });
		expect(apply(scale(2, 3), { x: 1, y: 1 })).toEqual({ x: 2, y: 3 });
		expect(apply(scale(2, 2, { x: 10, y: 10 }), { x: 10, y: 10 })).toEqual({ x: 10, y: 10 });
		const quarter = apply(rotate(90), { x: 1, y: 0 });
		expect(near(quarter.x, 0)).toBe(true);
		expect(near(quarter.y, 1)).toBe(true);
	});

	it('multiplies so the right-hand matrix applies first', () => {
		const m = multiply(translate(10, 0), scale(2, 2));
		expect(apply(m, { x: 1, y: 1 })).toEqual({ x: 12, y: 2 });
		const n = multiply(scale(2, 2), translate(10, 0));
		expect(apply(n, { x: 1, y: 1 })).toEqual({ x: 22, y: 2 });
	});

	it('keeps the point it rotates about', () => {
		const centre = { x: 40, y: 25 };
		const turned = apply(rotate(37, centre), centre);
		expect(near(turned.x, centre.x)).toBe(true);
		expect(near(turned.y, centre.y)).toBe(true);
		const moved = apply(rotate(90, centre), { x: 50, y: 25 });
		expect(near(moved.x, 40)).toBe(true);
		expect(near(moved.y, 35)).toBe(true);
	});

	it('inverts, and treats a flattening matrix as the identity', () => {
		const m = multiply(rotate(30, { x: 3, y: 4 }), multiply(scale(2, 0.5), translate(7, -1)));
		expectMatrix(multiply(m, invert(m)), IDENTITY);
		expect(invert([0, 0, 0, 0, 5, 5])).toEqual(IDENTITY);
	});

	it('parses a transform list, applying the functions right to left as SVG reads them', () => {
		expect(parseTransform(null)).toEqual(IDENTITY);
		expect(parseTransform('')).toEqual(IDENTITY);
		expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual([1, 2, 3, 4, 5, 6]);
		expect(parseTransform('matrix(1,2,3,4,5,6)')).toEqual([1, 2, 3, 4, 5, 6]);
		expect(parseTransform('translate(10)')).toEqual(translate(10, 0));
		expect(parseTransform('translate(10, 20) scale(2)')).toEqual(
			multiply(translate(10, 20), scale(2, 2))
		);
		expectMatrix(parseTransform('rotate(90 10 10)'), rotate(90, { x: 10, y: 10 }));
		expect(parseTransform('skewX(0) nonsense(1 2) matrix(1 2 3)')).toEqual(IDENTITY);
	});

	it('formats to four decimals and the identity to nothing, and round-trips', () => {
		expect(formatTransform(IDENTITY)).toBe('');
		expect(formatTransform(translate(30, 20))).toBe('matrix(1 0 0 1 30 20)');
		expect(formatTransform([1.00004, 0, 0, 1, -0.00004, 2.5])).toBe('matrix(1 0 0 1 0 2.5)');
		const m = multiply(
			rotate(33, { x: 5, y: 6 }),
			multiply(scale(1.5, 0.75), translate(7, -1))
		);
		expectMatrix(parseTransform(formatTransform(m)), m, 1e-3);
	});
});
