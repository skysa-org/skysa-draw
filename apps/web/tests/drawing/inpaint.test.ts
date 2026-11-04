import { describe, expect, it } from 'vitest';

import { bandAround } from '../../src/drawing/inpaint/engine.js';
import { inpaint, type Pixels } from '../../src/drawing/inpaint/index.js';

/**
 * Content-aware fill (docs/ARCHITECTURE.md §7, "Tools"), on synthetic
 * pictures whose right answer is known: the hole is made again from the rest
 * of the picture, so a flat color, stripes and a gradient carry on through
 * it, transparency stays transparent, and the same input gives the same
 * bytes. Under jsdom there is no `Worker`, so this is the engine run on this
 * thread; tests/drawing/inpaintWorker.test.ts drives the worker's side.
 */

type Rgba = readonly [number, number, number, number];

const picture = (width: number, height: number, paint: (x: number, y: number) => Rgba): Pixels => {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) data.set(paint(x, y), (y * width + x) * 4);
	}
	return { width, height, data };
};

const maskOf = (width: number, height: number, inHole: (x: number, y: number) => boolean) => {
	const mask = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) mask[y * width + x] = inHole(x, y) ? 255 : 0;
	}
	return mask;
};

const box =
	(x0: number, y0: number, x1: number, y1: number) =>
	(x: number, y: number): boolean =>
		x >= x0 && x < x1 && y >= y0 && y < y1;

const at = (data: Uint8ClampedArray, width: number, x: number, y: number): Rgba => {
	const i = (y * width + x) * 4;
	return [data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, data[i + 3] ?? 0];
};

/** Every pixel of the hole, with what the fill made of it and what it should be. */
const holePixels = (
	out: Uint8ClampedArray,
	image: Pixels,
	mask: Uint8Array,
	expected: (x: number, y: number) => Rgba
) =>
	[...mask.keys()]
		.filter((i) => mask[i] !== 0)
		.map((i) => {
			const x = i % image.width;
			const y = Math.floor(i / image.width);
			return { got: at(out, image.width, x, y), want: expected(x, y) };
		});

const worstChannel = (got: Rgba, want: Rgba): number =>
	Math.max(...got.map((value, c) => Math.abs(value - (want[c] ?? 0))));

/** A pseudo-random channel offset, the same for the same pixel. */
const grain = (x: number, y: number): number => {
	const h = Math.imul(x * 374_761_393 + y * 668_265_263, 1_274_126_177) >>> 0;
	return ((h >>> 8) % 41) - 20;
};

describe('inpaint', () => {
	it.each([
		['opaque', [90, 140, 200, 255]],
		['half transparent', [200, 100, 50, 128]],
	] as const)('fills a hole in a flat %s color with that color exactly', async (_, color) => {
		const image = picture(48, 40, () => color);
		const mask = maskOf(48, 40, box(18, 14, 32, 28));
		const out = await inpaint(image, mask);
		const wrong = holePixels(out, image, mask, () => color).filter(
			({ got, want }) => worstChannel(got, want) > 0
		);
		expect(wrong).toEqual([]);
	});

	it('leaves every known pixel as it was, and the picture it was given untouched', async () => {
		const image = picture(40, 40, (x, y) => [x * 6, y * 6, 100 + grain(x, y), 255]);
		const before = new Uint8ClampedArray(image.data);
		const mask = maskOf(40, 40, box(12, 12, 24, 24));
		const out = await inpaint(image, mask);
		expect(image.data).toEqual(before);
		const kept = [...mask.keys()].filter((i) => mask[i] === 0);
		expect(
			kept.every((i) => [0, 1, 2, 3].every((c) => out[i * 4 + c] === before[i * 4 + c]))
		).toBe(true);
		expect(out).not.toBe(image.data);
	});

	it('carries vertical stripes on through a hole across them', async () => {
		const stripe = (x: number): Rgba =>
			Math.floor(x / 4) % 2 === 0 ? [20, 20, 20, 255] : [235, 235, 235, 255];
		const image = picture(64, 48, stripe);
		const mask = maskOf(64, 48, box(22, 16, 42, 32));
		const out = await inpaint(image, mask);
		const pixels = holePixels(out, image, mask, stripe);
		const right = pixels.filter(({ got, want }) => worstChannel(got, want) <= 8);
		expect(right.length / pixels.length).toBeGreaterThanOrEqual(0.98);
	});

	it('fills a hole across a horizontal gradient within a small error of it', async () => {
		const ramp = (x: number): Rgba => [
			Math.round((x * 255) / 79),
			Math.round(255 - (x * 255) / 79),
			128,
			255,
		];
		const image = picture(80, 48, ramp);
		const mask = maskOf(80, 48, box(30, 16, 50, 32));
		const out = await inpaint(image, mask);
		const errors = holePixels(out, image, mask, ramp).map(({ got, want }) =>
			worstChannel(got, want)
		);
		const mean = errors.reduce((sum, error) => sum + error, 0) / errors.length;
		expect(mean).toBeLessThanOrEqual(2);
		expect(Math.max(...errors)).toBeLessThanOrEqual(8);
	});

	it.each([
		['the left edge', box(0, 18, 12, 30)],
		['a corner', box(50, 0, 64, 14)],
		['the whole bottom row', box(0, 44, 64, 48)],
	])('fills a hole touching %s', async (_, inHole) => {
		const stripe = (x: number): Rgba =>
			Math.floor(x / 4) % 2 === 0 ? [30, 60, 160, 255] : [240, 220, 170, 255];
		const image = picture(64, 48, stripe);
		const mask = maskOf(64, 48, inHole);
		const out = await inpaint(image, mask);
		const pixels = holePixels(out, image, mask, stripe);
		const right = pixels.filter(({ got, want }) => worstChannel(got, want) <= 8);
		expect(right.length / pixels.length).toBeGreaterThanOrEqual(0.95);
	});

	it('keeps a hole on transparent pixels transparent', async () => {
		const disk = (x: number, y: number) => Math.hypot(x - 30, y - 30) <= 10;
		const image = picture(96, 64, (x, y) => {
			if (disk(x, y)) return [220, 30, 30, 255];
			// Another shape, kept, far enough off that the hole's own surroundings are clear.
			if (x >= 70 && x < 90 && y >= 10 && y < 50) return [30, 120, 200, 255];
			// Transparent, with a color under it that no fill should bring back.
			return [255, 255, 255, 0];
		});
		const mask = maskOf(96, 64, (x, y) => Math.hypot(x - 30, y - 30) <= 13);
		const out = await inpaint(image, mask);
		const pixels = holePixels(out, image, mask, () => [0, 0, 0, 0]);
		expect(pixels.every(({ got }) => got[3] === 0)).toBe(true);
	});

	it('settles on the picture as it was when the mask keeps nothing, or makes nothing again', async () => {
		const image = picture(16, 12, (x, y) => [x * 10, y * 10, 50, 200]);
		const all = await inpaint(image, new Uint8Array(16 * 12).fill(1));
		const none = await inpaint(image, new Uint8Array(16 * 12));
		expect(all).toEqual(image.data);
		expect(none).toEqual(image.data);
		expect(all).not.toBe(image.data);
	});

	it('gives the same bytes for the same picture and mask', async () => {
		const image = picture(72, 56, (x, y) => [
			120 + grain(x, y) * 3,
			80 + Math.round(40 * Math.sin(x / 5)) + grain(y, x),
			60 + ((x + y) % 7) * 10,
			255,
		]);
		const mask = maskOf(72, 56, (x, y) => Math.hypot(x - 36, y - 28) <= 12);
		const first = await inpaint(image, mask);
		const second = await inpaint(image, mask);
		expect(second).toEqual(first);
		// And it made something: the hole is not left as it was.
		expect(first).not.toEqual(image.data);
	});

	it('rejects with an AbortError when the signal aborts, before or during the fill', async () => {
		const image = picture(64, 48, (x, y) => [x * 4, y * 5, grain(x, y) + 128, 255]);
		const mask = maskOf(64, 48, box(20, 14, 44, 34));
		const before = new AbortController();
		before.abort();
		await expect(inpaint(image, mask, before.signal)).rejects.toMatchObject({
			name: 'AbortError',
		});
		const during = new AbortController();
		const fill = inpaint(image, mask, during.signal);
		during.abort(new Error('the dialog closed'));
		const error: unknown = await fill.catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(DOMException);
		expect(error).toMatchObject({ name: 'AbortError' });
	});

	it('rejects a mask that is not the picture’s size', async () => {
		const image = picture(8, 8, () => [0, 0, 0, 255]);
		await expect(inpaint(image, new Uint8Array(10))).rejects.toBeInstanceOf(RangeError);
	});
});

describe('bandAround', () => {
	it('grows the hole’s box by its longer side on every side, inside the picture', () => {
		expect(bandAround({ x: 800, y: 550, width: 400, height: 400 }, 2000, 1500)).toEqual({
			x: 400,
			y: 150,
			width: 1200,
			height: 1200,
		});
		expect(bandAround({ x: 0, y: 1400, width: 300, height: 100 }, 2000, 1500)).toEqual({
			x: 0,
			y: 1100,
			width: 600,
			height: 400,
		});
	});

	it('reaches at least 32 pixels past a small hole', () => {
		expect(bandAround({ x: 100, y: 100, width: 4, height: 2 }, 2000, 1500)).toEqual({
			x: 68,
			y: 68,
			width: 68,
			height: 66,
		});
	});
});
