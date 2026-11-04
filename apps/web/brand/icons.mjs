// The default brand's icons, drawn in plain Node with no dependencies: a tile
// of the brand color with a pen stroke across it, at the six names and sizes
// in `BRAND_ICONS` (`brand.ts`). How `icons/` was made, and how to make a set
// on another color:
//
//   node apps/web/brand/icons.mjs apps/web/brand/icons '#4B5563'
//
// The favicons are a rounded tile with a transparent corner; every other icon
// is a full square, since the platforms that show them round or crop it
// themselves, and the maskable one keeps the stroke inside the central 80%.

import { Buffer } from 'node:buffer';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { deflateSync } from 'node:zlib';

const [, , outDir, hex = '#4B5563'] = process.argv;
if (outDir === undefined) {
	process.stderr.write("usage: node icons.mjs <out dir> ['#RRGGBB']\n");
	process.exit(2);
}

const brand = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
const white = [255, 255, 255];

// ---- PNG, the little of it an icon needs ----------------------------------

const crcTable = Array.from(
	{ length: 256 },
	(_, n) =>
		Array.from({ length: 8 }).reduce((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n) >>> 0
);
const crc32 = (bytes) =>
	(bytes.reduce((c, b) => crcTable[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;

const uint32 = (value) => {
	const out = Buffer.alloc(4);
	out.writeUInt32BE(value);
	return out;
};

const chunk = (type, data) => {
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	return Buffer.concat([uint32(data.length), typed, uint32(crc32(typed))]);
};

/** An RGBA PNG of `size` square, each pixel from `pixel(x, y)` at its center. */
const png = (size, pixel) => {
	const rows = Array.from({ length: size }, (_, y) =>
		Buffer.from([0, ...Array.from({ length: size }, (_, x) => pixel(x + 0.5, y + 0.5)).flat()])
	);
	const ihdr = Buffer.concat([uint32(size), uint32(size), Buffer.from([8, 6, 0, 0, 0])]);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
		chunk('IEND', Buffer.alloc(0)),
	]);
};

// ---- The artwork ------------------------------------------------------------

/** How much of a pixel a shape covers, sampled sixteen times, for soft edges. */
const OFFSETS = [-0.375, -0.125, 0.125, 0.375];
const coverage = (x, y, inside) =>
	OFFSETS.flatMap((dx) => OFFSETS.map((dy) => inside(x + dx, y + dy))).filter(Boolean).length /
	16;

const mix = (from, to, t) => from.map((c, i) => Math.round(c + (to[i] - c) * t));

/** A square with `radius` of its side rounded off each corner. */
const tile = (size, radius) => (x, y) => {
	const r = size * radius;
	const cx = Math.min(Math.max(x, r), size - r);
	const cy = Math.min(Math.max(y, r), size - r);
	return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

/**
 * The stroke: a pen's line from lower left to upper right, a quadratic curve
 * with round caps, and a dot where the pen lifted. `inset` is the share of the
 * tile the glyph keeps clear on each side.
 */
const stroke = (size, inset) => {
	const s = size * (1 - 2 * inset);
	const o = size * inset;
	const p0 = [o + s * 0.18, o + s * 0.72];
	const p1 = [o + s * 0.42, o + s * 0.1];
	const p2 = [o + s * 0.82, o + s * 0.3];
	const width = s * 0.16;
	const points = Array.from({ length: 64 }, (_, i) => {
		const t = i / 63;
		return [
			(1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
			(1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
		];
	});
	const dot = [o + s * 0.84, o + s * 0.78];
	return (x, y) =>
		points.some(([px, py]) => (x - px) ** 2 + (y - py) ** 2 <= (width / 2) ** 2) ||
		(x - dot[0]) ** 2 + (y - dot[1]) ** 2 <= (width * 0.55) ** 2;
};

const draw = (size, { rounded, inset, opaque }) => {
	const inTile = tile(size, rounded);
	const inStroke = stroke(size, inset);
	return png(size, (x, y) => [
		...mix(brand, white, coverage(x, y, inStroke)),
		Math.round(255 * (opaque ? 1 : coverage(x, y, inTile))),
	]);
};

const ICONS = [
	['favicon-16x16.png', 16, { rounded: 0.22, inset: 0.08, opaque: false }],
	['favicon-32x32.png', 32, { rounded: 0.22, inset: 0.08, opaque: false }],
	['apple-touch-icon.png', 180, { rounded: 0, inset: 0.12, opaque: true }],
	['pwa-192x192.png', 192, { rounded: 0, inset: 0.12, opaque: true }],
	['pwa-512x512.png', 512, { rounded: 0, inset: 0.12, opaque: true }],
	['pwa-maskable-512x512.png', 512, { rounded: 0, inset: 0.22, opaque: true }],
];

mkdirSync(outDir, { recursive: true });
ICONS.forEach(([file, size, options]) => {
	writeFileSync(join(outDir, file), draw(size, options));
});
process.stdout.write(`wrote ${String(ICONS.length)} icons to ${outDir}\n`);
