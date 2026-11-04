import { RASTER_MAX_SIDE } from '@skysa/draw-core';

/**
 * The arithmetic of a raster layer (docs/ARCHITECTURE.md §3, "Layers"; §7,
 * "The editor"), with no canvas in it, so it runs and is tested in Node: the
 * pixel grid a layer's bounds get, where a brush stamps along a stroke, the
 * flood fill, and the colours as the tools read and write them.
 */

export interface Point {
	readonly x: number;
	readonly y: number;
}

/** A rectangle in user units: an `<image>`'s geometry, or the canvas's. */
export interface Bounds {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** A colour as a canvas holds it: four channels, each 0 to 255. */
export type Rgba = readonly [number, number, number, number];

export interface PixelGrid {
	/** Pixels per user unit: 1 until the longer side would pass `maxSide`, fewer past it. */
	readonly ppu: number;
	readonly width: number;
	readonly height: number;
}

/**
 * The pixels a layer of these bounds gets: one per user unit up to `maxSide`
 * on the longer side (`RASTER_MAX_SIDE`), past which a canvas has fewer
 * pixels than units rather than a bitmap no phone can hold. Never smaller
 * than one pixel either way.
 */
export const pixelGrid = (
	bounds: Readonly<{ width: number; height: number }>,
	maxSide = RASTER_MAX_SIDE
): PixelGrid => {
	const ppu = Math.min(1, maxSide / Math.max(bounds.width, bounds.height));
	return {
		ppu,
		width: Math.max(1, Math.round(bounds.width * ppu)),
		height: Math.max(1, Math.round(bounds.height * ppu)),
	};
};

/**
 * How far apart a brush stamps, in pixels: a small fraction of the radius, so
 * a stroke is a continuous mark and not a row of discs, and never under a
 * pixel, so a hairline does not stamp a thousand times per unit.
 */
export const stampSpacing = (radiusPx: number): number => Math.max(1, radiusPx * 0.15);

/**
 * The points along a segment at an even spacing. `carry` is how far the
 * stroke has travelled since its last stamp, so a spacing that does not divide
 * one segment carries into the next and the stamps stay even across every
 * sample the pointer gave. The first stamp of a stroke is the caller's: it
 * stamps the pointer's first point and starts with a carry of 0.
 */
export const stampsAlong = (
	from: Point,
	to: Point,
	spacing: number,
	carry: number
): Readonly<{ stamps: readonly Point[]; carry: number }> => {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	// A spacing of nothing would stamp forever; one point is what it means.
	if (!(spacing > 0)) return { stamps: [to], carry: 0 };
	const first = spacing - carry;
	if (length < first) return { stamps: [], carry: carry + length };
	const count = Math.floor((length - first) / spacing) + 1;
	const stamps = Array.from({ length: count }, (_, i) => {
		const distance = first + i * spacing;
		return { x: from.x + (dx * distance) / length, y: from.y + (dy * distance) / length };
	});
	return { stamps, carry: length - (first + (count - 1) * spacing) };
};

/** The furthest two colours can be: opaque white from transparent black. */
const FURTHEST = Math.hypot(255, 255, 255, 255);

/** How far apart two colours are, over all four channels, 0 for the same to 1 for the furthest. */
export const colourDistance = (a: Rgba, b: Rgba): number =>
	Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]) / FURTHEST;

const channel = (data: Uint8ClampedArray, offset: number): number => data[offset] ?? 0;

/** The distance of the pixel at `index` from `seed`, read in place: a fill tests millions of these. */
const distanceAt = (data: Uint8ClampedArray, index: number, seed: Rgba): number => {
	const offset = index * 4;
	return (
		Math.hypot(
			channel(data, offset) - seed[0],
			channel(data, offset + 1) - seed[1],
			channel(data, offset + 2) - seed[2],
			channel(data, offset + 3) - seed[3]
		) / FURTHEST
	);
};

/* eslint-disable functional/immutable-data -- pixels are written in place; a copy per pixel would be the whole picture */
/**
 * The 4-connected region around pixel `seedIndex` whose colours are within
 * `tolerance` of the seed's, recoloured `rgba`; how many pixels that changed.
 * A breadth-first walk over a queue the size of the picture: every pixel is
 * tested once, so the queue never outgrows it, and the walk is one pass over
 * the queue rather than a recursion as deep as the region is long.
 */
const fillRegion = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	seedIndex: number,
	rgba: Rgba,
	tolerance: number
): number => {
	const count = width * height;
	const seed: Rgba = [
		channel(data, seedIndex * 4),
		channel(data, seedIndex * 4 + 1),
		channel(data, seedIndex * 4 + 2),
		channel(data, seedIndex * 4 + 3),
	];
	const tested = new Uint8Array(count);
	const queue = new Uint32Array(count);
	// [the queue's length, the pixels changed]
	const tally = new Uint32Array(2);
	const consider = (index: number): void => {
		if (tested[index] === 1) return;
		tested[index] = 1;
		if (distanceAt(data, index, seed) > tolerance) return;
		queue[tally[0] ?? 0] = index;
		tally[0] = (tally[0] ?? 0) + 1;
	};
	consider(seedIndex);
	queue.forEach((index, position) => {
		if (position >= (tally[0] ?? 0)) return;
		const offset = index * 4;
		if (distanceAt(data, index, rgba) > 0) tally[1] = (tally[1] ?? 0) + 1;
		data[offset] = rgba[0];
		data[offset + 1] = rgba[1];
		data[offset + 2] = rgba[2];
		data[offset + 3] = rgba[3];
		const x = index % width;
		if (x > 0) consider(index - 1);
		if (x + 1 < width) consider(index + 1);
		if (index >= width) consider(index - width);
		if (index + width < count) consider(index + width);
	});
	return tally[1] ?? 0;
};
/* eslint-enable functional/immutable-data */

/**
 * Flood fill: the pixels connected to `(x, y)` by sides whose colour is within
 * `tolerance` (0 to 1, `colourDistance`) of the one there, set to `rgba`, in
 * place. How many pixels changed colour comes back, so a fill that changed
 * none writes nothing; a point outside the picture fills nothing.
 */
export const floodFill = (
	data: Uint8ClampedArray,
	width: number,
	height: number,
	x: number,
	y: number,
	rgba: Rgba,
	tolerance: number
): number => {
	const px = Math.floor(x);
	const py = Math.floor(y);
	if (px < 0 || py < 0 || px >= width || py >= height) return 0;
	return fillRegion(data, width, height, py * width + px, rgba, Math.max(0, tolerance));
};

const HEX = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * `rgb(…)` or `rgba(…)`, the channels separated by commas or spaces, the alpha
 * after a comma or a slash; a channel out of range, negative among them, is
 * clamped, as CSS does.
 */
const RGB =
	/^rgba?\(\s*(-?[\d.]+%?)\s*[,\s]\s*(-?[\d.]+%?)\s*[,\s]\s*(-?[\d.]+%?)\s*(?:[,/]\s*(-?[\d.]+%?)\s*)?\)$/i;

const clamp255 = (value: number): number => Math.min(255, Math.max(0, Math.round(value)));

/** A colour channel as `rgb()` writes it: a number to 255, or a percentage. */
const channelOf = (text: string): number =>
	text.endsWith('%') ? clamp255((Number(text.slice(0, -1)) * 255) / 100) : clamp255(Number(text));

/** An alpha as `rgba()` writes it: 0 to 1, or a percentage, as a channel. */
const alphaOf = (text: string | undefined): number => {
	if (text === undefined) return 255;
	return text.endsWith('%')
		? clamp255((Number(text.slice(0, -1)) * 255) / 100)
		: clamp255(Number(text) * 255);
};

/** `#rgb` and `#rgba` doubled to eight digits, `#rrggbb` given its alpha. */
const eightDigits = (hex: string): string => {
	if (hex.length === 6) return `${hex}ff`;
	if (hex.length === 8) return hex;
	const doubled = [...hex].map((digit) => `${digit}${digit}`).join('');
	return hex.length === 3 ? `${doubled}ff` : doubled;
};

/**
 * A CSS colour as the tools write one, `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`,
 * `rgb()` or `rgba()`, as channels; `undefined` for anything else, `'none'`
 * among them. Named colours are not read: the colour field never writes one.
 */
export const parseColour = (css: string): Rgba | undefined => {
	const text = css.trim();
	const hex = HEX.exec(text);
	if (hex?.[1] !== undefined) {
		const digits = eightDigits(hex[1]);
		const at = (i: number): number => Number.parseInt(digits.slice(i, i + 2), 16);
		return [at(0), at(2), at(4), at(6)];
	}
	const rgb = RGB.exec(text);
	if (rgb?.[1] === undefined || rgb[2] === undefined || rgb[3] === undefined) return undefined;
	return [channelOf(rgb[1]), channelOf(rgb[2]), channelOf(rgb[3]), alphaOf(rgb[4])];
};

const twoDigits = (value: number): string => clamp255(value).toString(16).padStart(2, '0');

/** A colour as the colour field shows it, `#rrggbb`; the alpha is dropped, since the field has none. */
export const toCss = (rgba: Rgba): string =>
	`#${twoDigits(rgba[0])}${twoDigits(rgba[1])}${twoDigits(rgba[2])}`;

type Size = Readonly<{ width: number; height: number }>;

const ALIGN = /^x(Min|Mid|Max)Y(Min|Mid|Max)$/;

/** How far into the spare room an edge sits: at its start, its middle or its end. */
const offset = (room: number, where: string | undefined): number => {
	if (where === 'Min') return 0;
	return where === 'Max' ? room : room / 2;
};

/**
 * Where a picture of `natural` size is drawn in a box, in the box's own units,
 * as an `<image>`'s `preserveAspectRatio` places it: stretched for `none`,
 * scaled to fit inside for `meet` and to cover for `slice`, and aligned by
 * `xMinYMin` … `xMaxYMax`; `xMidYMid meet` where the attribute is absent or
 * not understood, as SVG says. So a picture from another tool is decoded onto
 * the layer's pixels where the browser showed it, and still looks the same
 * once it is written back with `none`.
 * https://svgwg.org/svg2-draft/coords.html#PreserveAspectRatioAttribute
 */
export const placePicture = (
	preserveAspectRatio: string | null | undefined,
	box: Size,
	natural: Size
): Bounds => {
	const whole = { x: 0, y: 0, width: box.width, height: box.height };
	const words = (preserveAspectRatio ?? '').trim().split(/\s+/);
	const [first = '', second = ''] = words[0] === 'defer' ? words.slice(1) : words;
	if (first === 'none' || !(natural.width > 0) || !(natural.height > 0)) return whole;
	// An align that is not one is the default, meet and all.
	const align = ALIGN.exec(first);
	const fits = [box.width / natural.width, box.height / natural.height];
	const scale = align !== null && second === 'slice' ? Math.max(...fits) : Math.min(...fits);
	const width = natural.width * scale;
	const height = natural.height * scale;
	return {
		x: offset(box.width - width, align?.[1]),
		y: offset(box.height - height, align?.[2]),
		width,
		height,
	};
};
