import { describe, expect, it } from 'vitest';

import {
	colourDistance,
	floodFill,
	parseColour,
	pixelGrid,
	placePicture,
	type Rgba,
	stampsAlong,
	stampSpacing,
	toCss,
} from '../../src/drawing/tools/raster/pixels.js';

/**
 * The arithmetic of a raster layer (docs/ARCHITECTURE.md §3, "Layers"), which
 * needs no canvas: the pixel grid, the brush's stamps, the flood fill, the
 * colours, and where a picture from elsewhere sits in its box.
 */

describe('pixelGrid', () => {
	it('is one pixel per user unit while the longer side fits RASTER_MAX_SIDE', () => {
		expect(pixelGrid({ width: 1600, height: 1000 })).toEqual({
			ppu: 1,
			width: 1600,
			height: 1000,
		});
		expect(pixelGrid({ width: 4096, height: 10 })).toEqual({ ppu: 1, width: 4096, height: 10 });
	});

	it('has fewer pixels than units past it, the longer side at the limit', () => {
		expect(pixelGrid({ width: 10000, height: 5000 })).toEqual({
			ppu: 0.4096,
			width: 4096,
			height: 2048,
		});
		expect(pixelGrid({ width: 100, height: 400 }, 40)).toEqual({
			ppu: 0.1,
			width: 10,
			height: 40,
		});
	});

	it('is never smaller than a pixel', () => {
		expect(pixelGrid({ width: 0.2, height: 0.1 })).toEqual({ ppu: 1, width: 1, height: 1 });
	});
});

describe('stampSpacing', () => {
	it('is a fraction of the radius, and never under a pixel', () => {
		expect(stampSpacing(100)).toBe(15);
		expect(stampSpacing(2)).toBe(1);
	});
});

describe('stampsAlong', () => {
	it('places stamps at the spacing and carries the leftover into the next segment', () => {
		const first = stampsAlong({ x: 0, y: 0 }, { x: 0, y: 2.5 }, 1, 0);
		expect(first.stamps.map((p) => p.y)).toEqual([1, 2]);
		expect(first.carry).toBeCloseTo(0.5);

		const second = stampsAlong({ x: 0, y: 2.5 }, { x: 0, y: 5 }, 1, first.carry);
		expect(second.stamps.map((p) => p.y)).toEqual([3, 4, 5]);
		expect(second.carry).toBeCloseTo(0);
	});

	it('stamps nothing on a segment shorter than what is left to travel, and carries it', () => {
		const along = stampsAlong({ x: 0, y: 0 }, { x: 0.3, y: 0 }, 1, 0.2);
		expect(along.stamps).toEqual([]);
		expect(along.carry).toBeCloseTo(0.5);
	});

	it('follows the segment’s direction', () => {
		const along = stampsAlong({ x: 0, y: 0 }, { x: 3, y: 4 }, 2.5, 0);
		expect(along.stamps).toHaveLength(2);
		expect(along.stamps[0]?.x).toBeCloseTo(1.5);
		expect(along.stamps[0]?.y).toBeCloseTo(2);
		expect(along.stamps[1]?.x).toBeCloseTo(3);
		expect(along.stamps[1]?.y).toBeCloseTo(4);
	});

	it('is one stamp at the end for a spacing of nothing, rather than forever', () => {
		expect(stampsAlong({ x: 0, y: 0 }, { x: 5, y: 0 }, 0, 0)).toEqual({
			stamps: [{ x: 5, y: 0 }],
			carry: 0,
		});
	});
});

describe('colourDistance', () => {
	it('is 0 for the same colour and 1 for the furthest two', () => {
		expect(colourDistance([10, 20, 30, 40], [10, 20, 30, 40])).toBe(0);
		expect(colourDistance([0, 0, 0, 0], [255, 255, 255, 255])).toBe(1);
	});

	it('counts every channel alike', () => {
		expect(colourDistance([0, 0, 0, 255], [255, 255, 255, 255])).toBeCloseTo(Math.sqrt(3) / 2);
		expect(colourDistance([0, 0, 0, 0], [0, 0, 0, 255])).toBeCloseTo(0.5);
	});
});

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** A 4×4 picture: `rows` of colours, left to right, top to bottom. */
const picture = (rows: readonly (readonly Rgba[])[]): Uint8ClampedArray => {
	const data = new Uint8ClampedArray(16 * 4);
	rows.forEach((row, y) => row.forEach((rgba, x) => data.set(rgba, (y * 4 + x) * 4)));
	return data;
};

const pixelAt = (data: Uint8ClampedArray, x: number, y: number): Rgba => {
	const i = (y * 4 + x) * 4;
	return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
};

describe('floodFill', () => {
	// A red wall down the third column, so the left two columns and the right
	// one are two regions.
	const walled = () =>
		picture([
			[CLEAR, CLEAR, RED, CLEAR],
			[CLEAR, CLEAR, RED, CLEAR],
			[CLEAR, CLEAR, RED, CLEAR],
			[CLEAR, CLEAR, RED, CLEAR],
		]);

	it('fills the connected region of the seed’s colour, in place, and nothing beyond it', () => {
		const data = walled();
		expect(floodFill(data, 4, 4, 0, 0, BLUE, 0)).toBe(8);
		for (let y = 0; y < 4; y += 1) {
			expect(pixelAt(data, 0, y)).toEqual(BLUE);
			expect(pixelAt(data, 1, y)).toEqual(BLUE);
			expect(pixelAt(data, 2, y)).toEqual(RED);
			expect(pixelAt(data, 3, y)).toEqual(CLEAR);
		}
	});

	it('is 4-connected: a diagonal does not join two regions', () => {
		const data = picture([
			[CLEAR, RED, RED, RED],
			[RED, CLEAR, RED, RED],
			[RED, RED, CLEAR, RED],
			[RED, RED, RED, CLEAR],
		]);
		floodFill(data, 4, 4, 0, 0, BLUE, 0);
		expect(pixelAt(data, 0, 0)).toEqual(BLUE);
		expect(pixelAt(data, 1, 1)).toEqual(CLEAR);
		expect(pixelAt(data, 2, 2)).toEqual(CLEAR);
	});

	it('takes colours within the tolerance with the seed, and leaves ones outside it', () => {
		const nearly: Rgba = [0, 0, 0, 10];
		const build = () =>
			picture([
				[CLEAR, nearly, RED, CLEAR],
				[CLEAR, CLEAR, RED, CLEAR],
				[CLEAR, CLEAR, RED, CLEAR],
				[CLEAR, CLEAR, RED, CLEAR],
			]);
		const strict = build();
		floodFill(strict, 4, 4, 0, 0, BLUE, 0);
		expect(pixelAt(strict, 1, 0)).toEqual(nearly);
		expect(pixelAt(strict, 0, 1)).toEqual(BLUE);

		const lenient = build();
		floodFill(lenient, 4, 4, 0, 0, BLUE, 0.05);
		expect(pixelAt(lenient, 1, 0)).toEqual(BLUE);
		expect(pixelAt(lenient, 2, 0)).toEqual(RED);

		const everything = build();
		expect(floodFill(everything, 4, 4, 0, 0, BLUE, 1)).toBe(16);
		expect(pixelAt(everything, 2, 0)).toEqual(BLUE);
		expect(pixelAt(everything, 3, 3)).toEqual(BLUE);
	});

	it('changes nothing, and says so, where the region is the fill colour already', () => {
		const data = walled();
		const before = Array.from(data);
		expect(floodFill(data, 4, 4, 3, 0, CLEAR, 0)).toBe(0);
		expect(Array.from(data)).toEqual(before);
	});

	it('counts only the pixels whose colour changed, where some were the fill colour already', () => {
		const data = walled();
		expect(floodFill(data, 4, 4, 0, 0, RED, 1)).toBe(12);
		expect(pixelAt(data, 3, 3)).toEqual(RED);
	});

	it('fills nothing from a point outside the picture', () => {
		const data = walled();
		const before = Array.from(data);
		expect(floodFill(data, 4, 4, -1, 0, BLUE, 1)).toBe(0);
		expect(floodFill(data, 4, 4, 4, 0, BLUE, 1)).toBe(0);
		expect(floodFill(data, 4, 4, 0, 4.5, BLUE, 1)).toBe(0);
		expect(Array.from(data)).toEqual(before);
	});

	it('takes a fractional point as the pixel it falls in', () => {
		const data = walled();
		floodFill(data, 4, 4, 3.9, 2.2, BLUE, 0);
		expect(pixelAt(data, 3, 0)).toEqual(BLUE);
		expect(pixelAt(data, 0, 0)).toEqual(CLEAR);
	});
});

describe('parseColour', () => {
	it('reads the hex forms, short and long, with and without alpha', () => {
		expect(parseColour('#f00')).toEqual([255, 0, 0, 255]);
		expect(parseColour('#f008')).toEqual([255, 0, 0, 136]);
		expect(parseColour('#1A2B3C')).toEqual([26, 43, 60, 255]);
		expect(parseColour('#ff000080')).toEqual([255, 0, 0, 128]);
	});

	it('reads rgb() and rgba(), with commas or spaces, numbers or percentages', () => {
		expect(parseColour('rgb(1, 2, 3)')).toEqual([1, 2, 3, 255]);
		expect(parseColour('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3, 128]);
		expect(parseColour('rgb(100% 0% 50% / 50%)')).toEqual([255, 0, 128, 128]);
		expect(parseColour(' rgb(300, -1, 2) ')).toEqual([255, 0, 2, 255]);
	});

	it('is undefined for none, a name, or nonsense', () => {
		expect(parseColour('none')).toBeUndefined();
		expect(parseColour('red')).toBeUndefined();
		expect(parseColour('#12')).toBeUndefined();
		expect(parseColour('')).toBeUndefined();
	});
});

describe('toCss', () => {
	it('writes #rrggbb and drops the alpha, since the colour field has none', () => {
		expect(toCss([255, 128, 0, 10])).toBe('#ff8000');
		expect(toCss([0, 0, 0, 255])).toBe('#000000');
	});

	it('round-trips with parseColour', () => {
		const parsed = parseColour('#1a2b3c');
		expect(parsed).toBeDefined();
		expect(toCss(parsed ?? [0, 0, 0, 0])).toBe('#1a2b3c');
		expect(parseColour(toCss([26, 43, 60, 255]))).toEqual([26, 43, 60, 255]);
	});
});

describe('placePicture', () => {
	const box = { width: 200, height: 100 };
	const square = { width: 50, height: 50 };

	it('stretches the picture over the box for none', () => {
		expect(placePicture('none', box, square)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
	});

	it('fits it inside, centred, where the attribute is absent, as SVG’s default does', () => {
		const centred = { x: 50, y: 0, width: 100, height: 100 };
		expect(placePicture(null, box, square)).toEqual(centred);
		expect(placePicture('xMidYMid meet', box, square)).toEqual(centred);
		expect(placePicture('nonsense slice', box, square)).toEqual(centred);
	});

	it('aligns it to the start or the end of the spare room', () => {
		expect(placePicture('xMinYMin', box, square)).toEqual({
			x: 0,
			y: 0,
			width: 100,
			height: 100,
		});
		expect(placePicture('defer xMaxYMax meet', box, square)).toEqual({
			x: 100,
			y: 0,
			width: 100,
			height: 100,
		});
	});

	it('covers the box for slice, overflowing it on the other side', () => {
		expect(placePicture('xMidYMin slice', box, square)).toEqual({
			x: 0,
			y: 0,
			width: 200,
			height: 200,
		});
		expect(placePicture('xMidYMax slice', box, square).y).toBe(-100);
	});

	it('stretches a picture that says no size, which cannot be fitted', () => {
		expect(placePicture('xMidYMid meet', box, { width: 0, height: 0 })).toEqual({
			x: 0,
			y: 0,
			width: 200,
			height: 100,
		});
	});
});
