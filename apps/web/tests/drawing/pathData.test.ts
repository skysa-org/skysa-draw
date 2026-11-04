import { describe, expect, it } from 'vitest';

import { distance, type Point } from '../../src/drawing/tools/vector/geometry.js';
import { nearestOnCubic, pointAt, splitCubic } from '../../src/drawing/tools/vector/path/bezier.js';
import {
	insertPoint,
	isSmooth,
	moveAnchors,
	moveHandle,
	removeAnchor,
} from '../../src/drawing/tools/vector/path/edit.js';
import { formatPath } from '../../src/drawing/tools/vector/path/format.js';
import {
	insideFill,
	nearestAnchor,
	nearestHandle,
	nearestOnPath,
	shownHandles,
} from '../../src/drawing/tools/vector/path/hit.js';
import { anchorMark, handleMarks } from '../../src/drawing/tools/vector/path/marks.js';
import {
	type Anchor,
	boundsOf,
	corner,
	type Cubic,
	mapPath,
	type PathData,
	segmentOf,
} from '../../src/drawing/tools/vector/path/model.js';
import { arcToCubics, parsePath } from '../../src/drawing/tools/vector/path/parse.js';
import { hasPoints, pathDataOf } from '../../src/drawing/tools/vector/path/shapes.js';

/**
 * A path's points (docs/decisions/0004-the-interface.md), as arithmetic: any
 * `d` read into anchors with handles and written back compactly, the shapes
 * as the paths they draw, and the geometry the pen and the node tool hit-test
 * and edit with.
 */

const p = (x: number, y: number): Point => ({ x, y });

/** The anchors' points of each subpath, rounded to the hundredth. */
const pointsOf = (data: PathData): number[][][] =>
	data.map((subpath) =>
		subpath.anchors.map((anchor) => [
			Math.round(anchor.point.x * 100) / 100,
			Math.round(anchor.point.y * 100) / 100,
		])
	);

/** What `d` reads as, written back. */
const normal = (d: string): string => formatPath(parsePath(d));

const element = (localName: string, attributes: Record<string, string>) => ({
	localName,
	getAttribute: (name: string) => attributes[name] ?? null,
});

describe('reading a path', () => {
	it('reads moveto and lineto, absolute and relative', () => {
		expect(normal('M 10 20 L 30 40')).toBe('M 10 20 L 30 40');
		expect(normal('m 10 20 l 30 40')).toBe('M 10 20 L 40 60');
		expect(normal('M 10 20 l 5 5 L 0 0')).toBe('M 10 20 L 15 25 L 0 0');
	});

	it('reads horizontal and vertical lines, absolute and relative', () => {
		expect(normal('M 10 10 H 50 V 30 h -10 v -5')).toBe(
			'M 10 10 L 50 10 L 50 30 L 40 30 L 40 25'
		);
	});

	it('reads cubics, absolute and relative, with their handles', () => {
		const data = parsePath('M 0 0 C 10 0 20 10 20 20 c 0 10 -10 20 -20 20');
		expect(formatPath(data)).toBe('M 0 0 C 10 0 20 10 20 20 C 20 30 10 40 0 40');
		const middle = data[0]?.anchors[1];
		expect(middle?.in).toEqual(p(20, 10));
		expect(middle?.out).toEqual(p(20, 30));
	});

	it('reflects the last control point for S, and starts from the point where nothing came before', () => {
		expect(normal('M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0')).toBe(
			'M 0 0 C 0 10 10 10 10 0 C 10 -10 20 -10 20 0'
		);
		expect(normal('M 0 0 s 10 10 20 0')).toBe('M 0 0 C 0 0 10 10 20 0');
		expect(normal('M 0 0 L 5 0 S 10 10 20 0')).toBe('M 0 0 L 5 0 C 5 0 10 10 20 0');
	});

	it('raises quadratics to cubics, and reflects for T', () => {
		// Q 15 15 30 0 from 0 0: the handles two-thirds of the way to the control point.
		expect(normal('M 0 0 Q 15 15 30 0')).toBe('M 0 0 C 10 10 20 10 30 0');
		expect(normal('M 0 0 q 15 15 30 0 t 30 0')).toBe(
			'M 0 0 C 10 10 20 10 30 0 C 40 -10 50 -10 60 0'
		);
		expect(normal('M 0 0 T 30 0')).toBe('M 0 0 L 30 0');
	});

	it('reads implicit repeats: pairs after a moveto are linetos, and any command repeats', () => {
		expect(normal('M 0 0 10 0 10 10')).toBe('M 0 0 L 10 0 L 10 10');
		expect(normal('m 5 5 10 0 0 10')).toBe('M 5 5 L 15 5 L 15 15');
		expect(normal('M 0 0 L 1 1 2 2 3 3')).toBe('M 0 0 L 1 1 L 2 2 L 3 3');
		expect(normal('M 0 0 c 0 1 1 1 1 0 0 1 1 1 1 0')).toBe('M 0 0 C 0 1 1 1 1 0 C 1 1 2 1 2 0');
		expect(normal('M 0 0 h 1 2 3')).toBe('M 0 0 L 1 0 L 3 0 L 6 0');
	});

	it('reads numbers as SVG writes them: exponents, signs as separators, points run together', () => {
		expect(normal('M 1e-3 2E2 L 1.5e+1 0')).toBe('M 0 200 L 15 0');
		expect(normal('M-.5.5L10-5')).toBe('M -0.5 0.5 L 10 -5');
		expect(normal('M0,0L10,10,20,0')).toBe('M 0 0 L 10 10 L 20 0');
		expect(normal('  M 1 1 l.5.5')).toBe('M 1 1 L 1.5 1.5');
	});

	it('closes a subpath, and a command after a close starts again where it began', () => {
		const data = parsePath('M 0 0 L 10 0 L 10 10 Z l 5 5');
		expect(data).toHaveLength(2);
		expect(data[0]?.closed).toBe(true);
		expect(pointsOf(data)).toEqual([
			[
				[0, 0],
				[10, 0],
				[10, 10],
			],
			[
				[0, 0],
				[5, 5],
			],
		]);
		expect(normal('M 0 0 L 10 0 L 10 10 z m 20 0 l 5 0')).toBe(
			'M 0 0 L 10 0 L 10 10 Z M 20 0 L 25 0'
		);
	});

	it('makes one anchor of a closed subpath that ends where it began', () => {
		const data = parsePath('M 0 0 L 10 0 L 10 10 L 0 0 Z');
		expect(pointsOf(data)).toEqual([
			[
				[0, 0],
				[10, 0],
				[10, 10],
			],
		]);
		expect(formatPath(data)).toBe('M 0 0 L 10 0 L 10 10 Z');
		const loop = parsePath('M 0 0 C 10 0 10 10 0 0 Z');
		expect(loop[0]?.anchors).toHaveLength(1);
		expect(formatPath(loop)).toBe('M 0 0 C 10 0 10 10 0 0 Z');
	});

	it('keeps a dot, a path whose one segment has no length', () => {
		expect(normal('M 5 5 L 5 5')).toBe('M 5 5 L 5 5');
	});

	it('reads data in error as far as the last whole command, as a browser draws it', () => {
		expect(normal('M 0 0 L 10 10 L 20')).toBe('M 0 0 L 10 10');
		expect(normal('M 0 0 L 10 10 20 20 30')).toBe('M 0 0 L 10 10 L 20 20');
		expect(normal('M 0 0 L 10 10 X 5 L 9 9')).toBe('M 0 0 L 10 10');
		expect(normal('M 0 0 L 10 10 L 3 x')).toBe('M 0 0 L 10 10');
		expect(normal('M 0 0 L 10 10 Z 4')).toBe('M 0 0 L 10 10 Z');
		expect(parsePath('L 10 10')).toEqual([]);
		expect(parsePath('10 10 M 0 0')).toEqual([]);
		expect(parsePath('')).toEqual([]);
	});
});

describe('arcs', () => {
	const K = (4 / 3) * Math.tan(Math.PI / 8);

	it('turns a quarter circle into one cubic whose handles are about 0.5523 of the radius', () => {
		expect(K).toBeCloseTo(0.5523, 4);
		const [only, ...rest] = parsePath('M 10 0 A 10 10 0 0 1 0 10')[0]?.anchors ?? [];
		expect(rest).toHaveLength(1);
		const end = rest[0];
		expect(only?.point).toEqual(p(10, 0));
		expect(end?.point).toEqual(p(0, 10));
		expect(only?.out.x).toBeCloseTo(10, 6);
		expect(only?.out.y).toBeCloseTo(10 * K, 6);
		expect(end?.in.x).toBeCloseTo(10 * K, 6);
		expect(end?.in.y).toBeCloseTo(10, 6);
	});

	it('goes the other way around without the sweep flag, and the long way with the large one', () => {
		const short = parsePath('M 10 0 A 10 10 0 0 0 0 10');
		// Counterclockwise on screen from (10, 0) to (0, 10), about (10, 10): the handle leaves to the left.
		expect(short[0]?.anchors[0]?.out.x).toBeCloseTo(10 - 10 * K, 6);
		expect(short[0]?.anchors[0]?.out.y).toBeCloseTo(0, 6);
		const long = parsePath('M 10 0 A 10 10 0 1 1 0 10');
		// Three quarters of a turn about (10, 10): three pieces.
		expect(long[0]?.anchors).toHaveLength(4);
		const middle = long[0]?.anchors.slice(1, -1).map((anchor) => anchor.point) ?? [];
		middle.forEach((point) => {
			expect(Math.hypot(point.x - 10, point.y - 10)).toBeCloseTo(10, 6);
		});
	});

	it('reads relative arcs, and flags run into the numbers after them', () => {
		const spaced = parsePath('M 10 0 a 10 10 0 0 1 -10 10');
		const packed = parsePath('M10 0a10 10 0 01-10 10');
		expect(formatPath(packed)).toBe(formatPath(spaced));
		expect(pointsOf(packed)).toEqual([
			[
				[10, 0],
				[0, 10],
			],
		]);
		expect(formatPath(parsePath('M0 0a5 5 0 1010 0'))).toBe(
			formatPath(parsePath('M 0 0 A 5 5 0 1 0 10 0'))
		);
	});

	it('grows radii too small to reach, draws a line for a zero radius and nothing between equal ends', () => {
		const grown = parsePath('M 0 0 A 1 1 0 0 1 20 0');
		const top = grown[0]?.anchors[1]?.point;
		// A half circle of radius 10, its middle 10 from the center (10, 0).
		expect(top === undefined ? undefined : distance(top, p(10, 0))).toBeCloseTo(10, 6);
		expect(normal('M 0 0 A 0 5 0 0 1 20 0')).toBe('M 0 0 L 20 0');
		expect(arcToCubics(p(3, 3), { rx: 5, ry: 5 }, 0, false, true, p(3, 3))).toEqual([]);
		expect(normal('M 3 3 A 5 5 0 0 1 3 3 L 4 4')).toBe('M 3 3 L 4 4');
	});

	it('turns the ellipse by its rotation', () => {
		const turned = parsePath('M 0 0 A 20 10 90 0 1 0 40');
		// Turned a quarter, the long axis is upright, and clockwise from the top the half ellipse bulges right.
		const middle = turned[0]?.anchors[1]?.point;
		expect(middle?.x).toBeCloseTo(10, 6);
		expect(middle?.y).toBeCloseTo(20, 6);
	});

	it('reads a circle of two arcs as one closed run of anchors', () => {
		const circle = parsePath('M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0 Z');
		expect(circle[0]?.closed).toBe(true);
		expect(circle[0]?.anchors).toHaveLength(4);
	});
});

describe('writing a path', () => {
	it('writes L where both handles sit on the anchors, C otherwise, to two decimals', () => {
		const data: PathData = [
			{
				anchors: [
					corner(p(0, 0)),
					{ point: p(10.123, 0), in: p(10.123, 0), out: p(15.555, 5) },
					corner(p(20, 20)),
				],
				closed: false,
			},
		];
		expect(formatPath(data)).toBe('M 0 0 L 10.12 0 C 15.56 5 20 20 20 20');
	});

	it('writes a straight close as Z, a curved one as its curve and Z, and -0 as 0', () => {
		const square: PathData = [
			{ anchors: [corner(p(0, 0)), corner(p(10, 0)), corner(p(10, 10))], closed: true },
		];
		expect(formatPath(square)).toBe('M 0 0 L 10 0 L 10 10 Z');
		const curved: PathData = [
			{
				anchors: [{ point: p(0, 0), in: p(-5, 5), out: p(0, 0) }, corner(p(10, 0))],
				closed: true,
			},
		];
		expect(formatPath(curved)).toBe('M 0 0 L 10 0 C 10 0 -5 5 0 0 Z');
		expect(formatPath([{ anchors: [corner(p(-0.001, 0))], closed: false }])).toBe('M 0 0');
	});

	it('round-trips what it writes', () => {
		const written = [
			'M 0 0 L 10 0 L 10 10 Z',
			'M 0 0 C 10 0 20 10 20 20 C 20 30 10 40 0 40',
			'M 1.5 2.25 L 3 4 Z M 10 10 C 11 11 12 12 13 10',
			'M 0 0 C 10 0 10 10 0 0 Z',
			'M 5 5 L 5 5',
		];
		written.forEach((d) => {
			expect(normal(d)).toBe(d);
		});
		const circle = normal('M 10 0 A 10 10 0 1 1 -10 0 A 10 10 0 1 1 10 0 Z');
		expect(normal(circle)).toBe(circle);
	});
});

describe('shapes as paths', () => {
	it('draws a rectangle from its top left, clockwise', () => {
		const rect = element('rect', { x: '10', y: '20', width: '30', height: '40' });
		expect(formatPath(pathDataOf(rect) ?? [])).toBe('M 10 20 L 40 20 L 40 60 L 10 60 Z');
	});

	it('rounds a rectangle’s corners by rx and ry, one standing for both, clamped to half a side', () => {
		const rounded = pathDataOf(element('rect', { width: '40', height: '20', rx: '5' }));
		expect(rounded?.[0]?.anchors).toHaveLength(8);
		expect(rounded?.[0]?.closed).toBe(true);
		expect(pointsOf(rounded ?? [])[0]?.slice(0, 3)).toEqual([
			[5, 0],
			[35, 0],
			[40, 5],
		]);
		// ry from rx, and at half the height: the short sides are all corner.
		const pill = pathDataOf(element('rect', { width: '40', height: '20', rx: '10' }));
		expect(pill?.[0]?.anchors).toHaveLength(6);
		// Both clamped to half a side: an ellipse.
		const oval = pathDataOf(element('rect', { width: '40', height: '20', ry: '50' }));
		expect(oval?.[0]?.anchors).toHaveLength(4);
		const circle = pathDataOf(element('rect', { width: '20', height: '20', rx: '10' }));
		expect(circle?.[0]?.anchors).toHaveLength(4);
	});

	it('draws an ellipse and a circle as four quarter arcs', () => {
		const ellipse = pathDataOf(element('ellipse', { cx: '50', cy: '50', rx: '20', ry: '10' }));
		expect(pointsOf(ellipse ?? [])).toEqual([
			[
				[70, 50],
				[50, 60],
				[30, 50],
				[50, 40],
			],
		]);
		const circle = pathDataOf(element('circle', { cx: '0', cy: '0', r: '10' }));
		const first = circle?.[0]?.anchors[0];
		expect(first?.out.y).toBeCloseTo(10 * 0.5523, 3);
		expect(circle?.[0]?.closed).toBe(true);
	});

	it('draws a line, a polyline and a polygon', () => {
		expect(
			formatPath(pathDataOf(element('line', { x1: '1', y1: '2', x2: '3', y2: '4' })) ?? [])
		).toBe('M 1 2 L 3 4');
		expect(
			formatPath(pathDataOf(element('polyline', { points: '0,0 10,0 10,10 7' })) ?? [])
		).toBe('M 0 0 L 10 0 L 10 10');
		expect(formatPath(pathDataOf(element('polygon', { points: '0 0 10 0 10 10' })) ?? [])).toBe(
			'M 0 0 L 10 0 L 10 10 Z'
		);
	});

	it('has nothing to edit where a shape draws nothing, or is sized in a unit it would have to guess', () => {
		expect(pathDataOf(element('rect', { width: '0', height: '10' }))).toBeUndefined();
		expect(pathDataOf(element('rect', { width: '50%', height: '10' }))).toBeUndefined();
		expect(pathDataOf(element('circle', { r: '2em' }))).toBeUndefined();
		expect(pathDataOf(element('circle', { r: '10px' }))).toBeDefined();
		expect(pathDataOf(element('path', { d: '' }))).toBeUndefined();
		expect(pathDataOf(element('text', { x: '0' }))).toBeUndefined();
		expect(hasPoints('polygon')).toBe(true);
		expect(hasPoints('text')).toBe(false);
		expect(hasPoints('toString')).toBe(false);
	});
});

describe('Bézier geometry', () => {
	const curve: Cubic = [p(0, 0), p(0, 10), p(10, 10), p(10, 0)];

	it('splits a cubic at t into two that draw the same curve', () => {
		const [left, right] = splitCubic(curve, 0.25);
		expect(left[0]).toEqual(curve[0]);
		expect(right[3]).toEqual(curve[3]);
		expect(left[3]).toEqual(pointAt(curve, 0.25));
		expect(right[0]).toEqual(left[3]);
		[0.2, 0.5, 0.9].forEach((t) => {
			expect(distance(pointAt(left, t), pointAt(curve, t * 0.25))).toBeLessThan(1e-9);
			expect(distance(pointAt(right, t), pointAt(curve, 0.25 + t * 0.75))).toBeLessThan(1e-9);
		});
	});

	it('finds the nearest point on a cubic', () => {
		const top = nearestOnCubic(curve, p(5, 20));
		expect(top.t).toBeCloseTo(0.5, 3);
		expect(top.point.x).toBeCloseTo(5, 3);
		expect(top.point.y).toBeCloseTo(7.5, 3);
		expect(top.distance).toBeCloseTo(12.5, 3);
		expect(nearestOnCubic(curve, p(-5, -5)).t).toBe(0);
	});
});

describe('hitting and editing points', () => {
	const square = parsePath('M 0 0 L 100 0 L 100 100 L 0 100 Z');
	const wave = parsePath('M 0 0 C 0 -20 40 -20 40 0 C 40 20 80 20 80 0');

	it('finds the anchor and the handle nearest within reach', () => {
		expect(nearestAnchor(square, p(98, 3), 5)).toEqual({ subpath: 0, index: 1 });
		expect(nearestAnchor(square, p(50, 50), 5)).toBeUndefined();
		const shown = shownHandles(wave, [{ subpath: 0, index: 1 }]);
		expect(shown).toEqual(
			expect.arrayContaining([
				{ subpath: 0, index: 1, side: 'in' },
				{ subpath: 0, index: 1, side: 'out' },
				{ subpath: 0, index: 0, side: 'out' },
				{ subpath: 0, index: 2, side: 'in' },
			])
		);
		expect(shown).toHaveLength(4);
		expect(nearestHandle(wave, shown, p(41, 19), 5)).toEqual({
			subpath: 0,
			index: 1,
			side: 'out',
		});
		// A corner has no handles to show.
		expect(shownHandles(square, [{ subpath: 0, index: 0 }])).toEqual([]);
	});

	it('finds the nearest point on the path, on the closing segment too', () => {
		const top = nearestOnPath(square, p(50, 4), 5);
		expect(top?.segment).toBe(0);
		expect(top?.t).toBeCloseTo(0.5, 2);
		const left = nearestOnPath(square, p(2, 50), 5);
		expect(left?.segment).toBe(3);
		expect(nearestOnPath(square, p(50, 50), 5)).toBeUndefined();
	});

	it('tells the inside of a fill from the outside', () => {
		expect(insideFill(square, p(50, 50))).toBe(true);
		expect(insideFill(square, p(150, 50))).toBe(false);
		// An open path is filled as though closed.
		expect(insideFill(parsePath('M 0 0 L 100 0 L 100 100'), p(80, 20))).toBe(true);
	});

	it('puts a corner into a straight segment, and a smooth point into a curve that keeps its shape', () => {
		const straight = insertPoint(square, { subpath: 0, segment: 0 }, 0.5);
		expect(straight?.ref).toEqual({ subpath: 0, index: 1 });
		expect(formatPath(straight?.data ?? [])).toBe('M 0 0 L 50 0 L 100 0 L 100 100 L 0 100 Z');
		const closing = insertPoint(square, { subpath: 0, segment: 3 }, 0.5);
		expect(formatPath(closing?.data ?? [])).toBe('M 0 0 L 100 0 L 100 100 L 0 100 L 0 50 Z');
		const curved = insertPoint(wave, { subpath: 0, segment: 0 }, 0.5);
		const added = curved?.data[0]?.anchors[1];
		expect(added?.point.x).toBeCloseTo(20, 6);
		expect(added?.point.y).toBeCloseTo(-15, 6);
		expect(added === undefined ? false : isSmooth(added)).toBe(true);
		const before = segmentOf(wave[0] ?? { anchors: [], closed: false }, 0);
		const halves = [0, 1].map((i) =>
			segmentOf(curved?.data[0] ?? { anchors: [], closed: false }, i)
		);
		expect(
			before && halves[0] && distance(pointAt(halves[0], 0.5), pointAt(before, 0.25))
		).toBeLessThan(1e-9);
	});

	it('takes a point out, and a subpath left with one point goes', () => {
		expect(formatPath(removeAnchor(square, { subpath: 0, index: 1 }))).toBe(
			'M 0 0 L 100 100 L 0 100 Z'
		);
		const line = parsePath('M 0 0 L 10 0 M 5 5 L 6 6');
		expect(formatPath(removeAnchor(line, { subpath: 0, index: 0 }))).toBe('M 5 5 L 6 6');
	});

	it('moves anchors with their handles', () => {
		const moved = moveAnchors(wave, [{ subpath: 0, index: 1 }], p(0, 10));
		expect(formatPath(moved)).toBe('M 0 0 C 0 -20 40 -10 40 10 C 40 30 80 20 80 0');
	});

	it('turns the opposite handle of a smooth point, and leaves it with the mirror broken', () => {
		const handle = { subpath: 0, index: 1, side: 'out' as const };
		const smooth = moveHandle(wave, handle, p(40, 40), true);
		const turned: Anchor | undefined = smooth[0]?.anchors[1];
		// The handles were 20 either side: kept equal, so the in handle mirrors the out.
		expect(turned?.out).toEqual(p(40, 40));
		expect(turned?.in.x).toBeCloseTo(40, 9);
		expect(turned?.in.y).toBeCloseTo(-40, 9);
		const broken = moveHandle(wave, handle, p(60, 20), false);
		expect(broken[0]?.anchors[1]?.in).toEqual(p(40, -20));
		// Of unequal lengths, the other handle turns and keeps its own.
		const uneven = moveHandle(
			parsePath('M 0 0 C 0 0 40 -10 40 0 C 40 30 80 0 80 0'),
			handle,
			p(70, 0),
			true
		);
		expect(uneven[0]?.anchors[1]?.in.x).toBeCloseTo(30, 9);
		expect(uneven[0]?.anchors[1]?.in.y).toBeCloseTo(0, 9);
	});

	it('maps a path by a matrix, and boxes it by its control points', () => {
		const moved = mapPath([2, 0, 0, 2, 10, 0], square);
		expect(boundsOf(moved)).toEqual({ x: 10, y: 0, width: 200, height: 200 });
		expect(boundsOf([])).toBeUndefined();
	});

	it('sizes the marks to stay the same on screen', () => {
		expect(anchorMark(p(10, 10), 2, false).attributes.width).toBe(3.5);
		expect(handleMarks(p(0, 0), p(10, 0), 2)[1]?.attributes.r).toBe(1.75);
	});
});
