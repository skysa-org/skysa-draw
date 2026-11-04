/**
 * The pictures content-aware fill works on (docs/ARCHITECTURE.md §7, "Tools"):
 * the band of the picture around the hole, premultiplied, and the pyramid of
 * it, each level half the size of the one below, with what PatchMatch needs
 * to know of it: which patches are sources, which are targets, and where the
 * hole is. Plain arithmetic over typed arrays, so it runs in a worker, in a
 * page and in Node alike.
 */

/** Pixels, RGBA, row by row, unpremultiplied: what a canvas's `ImageData` holds. */
export type Pixels = Readonly<{ width: number; height: number; data: Uint8ClampedArray }>;

/** A rectangle of pixels. */
export interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** A picture with a hole in it, premultiplied, as one level of the pyramid holds it. */
export interface Picture {
	readonly width: number;
	readonly height: number;
	/** RGBA premultiplied by alpha, 0 to 255 a channel, so a transparent pixel is one color whatever its RGB. */
	readonly color: Float32Array;
	/** 1 where the pixel is to be made again, 0 where it is known. */
	readonly hole: Uint8Array;
}

/** A level of the pyramid, made ready for PatchMatch. */
export interface Level extends Picture {
	/** Half a patch's side: a patch is `2 × radius + 1` pixels square. */
	readonly radius: number;
	/** 1 where the patch centered on the pixel is inside the picture and all known: a source. */
	readonly source: Uint8Array;
	/** Every source, in scan order, to draw one from at random. */
	readonly sources: Int32Array;
	/** Every pixel whose patch overlaps the hole, in scan order: the patches matched. */
	readonly targets: Int32Array;
	/** Every pixel of the hole, in scan order: the pixels voted. */
	readonly holes: Int32Array;
	/** The source matched to each target's patch, by the target's pixel; -1 for a pixel that is not a target. */
	readonly matches: Int32Array;
	/** How far each target's patch is from its match: the sum of squared differences. */
	readonly distance: Float64Array;
	/** How much each target's patch counts in the vote, for how well it matched. */
	readonly weight: Float32Array;
	/** How many rings into the hole each pixel is, 0 for a known one (`walkInward`). */
	readonly depth: Int32Array;
}

/* eslint-disable functional/no-loop-statements, functional/no-let, functional/immutable-data -- a pass over every pixel of a band of millions, in plain loops over typed arrays written in place: a closure a pixel is several times slower */

/** The smallest box around the pixels that are not 0; undefined where there are none. */
export const boxOf = (hole: Uint8Array, width: number, height: number): Box | undefined => {
	let minX = width;
	let minY = height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width;
		for (let x = 0; x < width; x++) {
			const set = (hole[row + x] ?? 0) !== 0;
			minX = set && x < minX ? x : minX;
			maxX = set && x > maxX ? x : maxX;
			minY = set && y < minY ? y : minY;
			maxY = set && y > maxY ? y : maxY;
		}
	}
	if (maxX < 0) return undefined;
	return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
};

/** The band of `image` in `box`, premultiplied, with `mask`'s hole in it. */
export const cropOf = (image: Pixels, mask: Uint8Array, box: Box): Picture => {
	const color = new Float32Array(box.width * box.height * 4);
	const hole = new Uint8Array(box.width * box.height);
	for (let y = 0; y < box.height; y++) {
		const from = (box.y + y) * image.width + box.x;
		for (let x = 0; x < box.width; x++) {
			const i = y * box.width + x;
			const p = (from + x) * 4;
			const alpha = (image.data[p + 3] ?? 0) / 255;
			color[i * 4] = (image.data[p] ?? 0) * alpha;
			color[i * 4 + 1] = (image.data[p + 1] ?? 0) * alpha;
			color[i * 4 + 2] = (image.data[p + 2] ?? 0) * alpha;
			color[i * 4 + 3] = image.data[p + 3] ?? 0;
			hole[i] = (mask[from + x] ?? 0) === 0 ? 0 : 1;
		}
	}
	return { width: box.width, height: box.height, color, hole };
};

/** One pixel of the level above: the mean of the known ones of its four, and a hole if any of them is. */
const halvePixel = (picture: Picture, coarse: Picture, x: number, y: number): void => {
	let known = 0;
	let holes = 0;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	const x1 = Math.min(2 * x + 1, picture.width - 1);
	const y1 = Math.min(2 * y + 1, picture.height - 1);
	for (let fy = 2 * y; fy <= y1; fy++) {
		for (let fx = 2 * x; fx <= x1; fx++) {
			const i = fy * picture.width + fx;
			const keep = 1 - (picture.hole[i] ?? 0);
			known += keep;
			holes += 1 - keep;
			r += keep * (picture.color[i * 4] ?? 0);
			g += keep * (picture.color[i * 4 + 1] ?? 0);
			b += keep * (picture.color[i * 4 + 2] ?? 0);
			a += keep * (picture.color[i * 4 + 3] ?? 0);
		}
	}
	const i = y * coarse.width + x;
	const share = known === 0 ? 0 : 1 / known;
	coarse.color[i * 4] = r * share;
	coarse.color[i * 4 + 1] = g * share;
	coarse.color[i * 4 + 2] = b * share;
	coarse.color[i * 4 + 3] = a * share;
	coarse.hole[i] = holes === 0 ? 0 : 1;
};

/**
 * The picture at half the size, each pixel the mean of four. A pixel is known
 * only where all four are, so a source above is made of known pixels below.
 */
export const halved = (picture: Picture): Picture => {
	const width = Math.ceil(picture.width / 2);
	const height = Math.ceil(picture.height / 2);
	const coarse = {
		width,
		height,
		color: new Float32Array(width * height * 4),
		hole: new Uint8Array(width * height),
	};
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) halvePixel(picture, coarse, x, y);
	}
	return coarse;
};

/** The summed-area table of the hole: entry `(x, y)` of a table one wider and one taller counts the hole above and left of it. */
const summedHole = (picture: Picture): Int32Array => {
	const stride = picture.width + 1;
	const table = new Int32Array(stride * (picture.height + 1));
	for (let y = 0; y < picture.height; y++) {
		let row = 0;
		for (let x = 0; x < picture.width; x++) {
			row += picture.hole[y * picture.width + x] ?? 0;
			table[(y + 1) * stride + x + 1] = (table[y * stride + x + 1] ?? 0) + row;
		}
	}
	return table;
};

/** How many pixels of the hole are in the box from `(x0, y0)` to `(x1, y1)`, both included. */
const holeIn = (
	table: Int32Array,
	stride: number,
	x0: number,
	y0: number,
	x1: number,
	y1: number
): number =>
	(table[(y1 + 1) * stride + x1 + 1] ?? 0) -
	(table[y0 * stride + x1 + 1] ?? 0) -
	(table[(y1 + 1) * stride + x0] ?? 0) +
	(table[y0 * stride + x0] ?? 0);

/** 1 for every pixel whose patch of `radius` is inside the picture and all known. */
const sourceMap = (picture: Picture, table: Int32Array, radius: number): Uint8Array => {
	const { width, height } = picture;
	const source = new Uint8Array(width * height);
	for (let y = radius; y < height - radius; y++) {
		for (let x = radius; x < width - radius; x++) {
			const holes = holeIn(table, width + 1, x - radius, y - radius, x + radius, y + radius);
			source[y * width + x] = holes === 0 ? 1 : 0;
		}
	}
	return source;
};

/** The indices where `map` is not 0, in order. */
const indicesOf = (map: Uint8Array): Int32Array => {
	const list = new Int32Array(map.length);
	let count = 0;
	for (let i = 0; i < map.length; i++) {
		list[count] = i;
		count += (map[i] ?? 0) === 0 ? 0 : 1;
	}
	return list.slice(0, count);
};

/** 1 for every pixel whose patch of `radius`, as far as it is inside the picture, overlaps the hole. */
const targetMap = (picture: Picture, table: Int32Array, radius: number): Uint8Array => {
	const { width, height } = picture;
	const target = new Uint8Array(width * height);
	for (let y = 0; y < height; y++) {
		const y0 = Math.max(0, y - radius);
		const y1 = Math.min(height - 1, y + radius);
		for (let x = 0; x < width; x++) {
			const x0 = Math.max(0, x - radius);
			const x1 = Math.min(width - 1, x + radius);
			target[y * width + x] = holeIn(table, width + 1, x0, y0, x1, y1) === 0 ? 0 : 1;
		}
	}
	return target;
};

/**
 * The widest patch, up to `largest`, for which the picture has a source:
 * `largest` unless the known pixels are too thin to hold one, down to a
 * patch of one pixel, which any known pixel is.
 */
export const radiusFor = (picture: Picture, largest: number): number => {
	const table = summedHole(picture);
	for (let radius = largest; radius > 0; radius--) {
		if (sourceMap(picture, table, radius).includes(1)) return radius;
	}
	return 0;
};

/** Whether the picture has a source of `radius` at all. */
export const hasSource = (picture: Picture, radius: number): boolean =>
	sourceMap(picture, summedHole(picture), radius).includes(1);

/** A level made ready for PatchMatch, with patches of `radius`; nothing is matched yet. */
export const levelOf = (picture: Picture, radius: number): Level => {
	const table = summedHole(picture);
	const source = sourceMap(picture, table, radius);
	const count = picture.width * picture.height;
	return {
		...picture,
		radius,
		source,
		sources: indicesOf(source),
		targets: indicesOf(targetMap(picture, table, radius)),
		holes: indicesOf(picture.hole),
		matches: new Int32Array(count).fill(-1),
		distance: new Float64Array(count),
		weight: new Float32Array(count),
		depth: walkInward(picture).depth,
	};
};

/** Queues the eight neighbors of `i` the walk has not reached yet, one further in; the queue's new length. */
const reachNeighbors = (
	picture: Picture,
	depth: Int32Array,
	queue: Int32Array,
	tail: number,
	i: number
): number => {
	const { width, height } = picture;
	const x = i % width;
	const y = (i - x) / width;
	const further = (depth[i] ?? 0) + 1;
	let length = tail;
	for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
		for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
			const n = ny * width + nx;
			const fresh = depth[n] === -1;
			depth[n] = fresh ? further : (depth[n] ?? 0);
			queue[length] = n;
			length += fresh ? 1 : 0;
		}
	}
	return length;
};

/**
 * A breadth-first walk from the known pixels into the hole: the pixels of the
 * hole in the order it reaches them, ring by ring from the edge inward, and
 * how many rings in each pixel is, 0 for a known one.
 */
export const walkInward = (
	picture: Picture
): Readonly<{ order: Int32Array; depth: Int32Array }> => {
	const { hole } = picture;
	const depth = new Int32Array(hole.length);
	const queue = new Int32Array(hole.length);
	let tail = 0;
	for (let i = 0; i < hole.length; i++) {
		const known = (hole[i] ?? 0) === 0;
		depth[i] = known ? 0 : -1;
		queue[tail] = i;
		tail += known ? 1 : 0;
	}
	const start = tail;
	for (let head = 0; head < tail; head++) {
		tail = reachNeighbors(picture, depth, queue, tail, queue[head] ?? 0);
	}
	return { order: queue.slice(start, tail), depth };
};

/**
 * The hole of the finest level written into `out`, the whole picture, at
 * `box`: each pixel divided out of its alpha, and transparent black where
 * that rounds to nothing. The known pixels of `out` are left as they are.
 */
export const writeHole = (
	out: Uint8ClampedArray,
	outWidth: number,
	level: Level,
	box: Box
): void => {
	const { width, color } = level;
	for (let k = 0; k < level.holes.length; k++) {
		const i = level.holes[k] ?? 0;
		const x = i % width;
		const p = ((box.y + (i - x) / width) * outWidth + box.x + x) * 4;
		const alpha = color[i * 4 + 3] ?? 0;
		const unmultiply = Math.round(alpha) === 0 ? 0 : 255 / alpha;
		out[p] = Math.round((color[i * 4] ?? 0) * unmultiply);
		out[p + 1] = Math.round((color[i * 4 + 1] ?? 0) * unmultiply);
		out[p + 2] = Math.round((color[i * 4 + 2] ?? 0) * unmultiply);
		out[p + 3] = Math.round(alpha);
	}
};
/* eslint-enable functional/no-loop-statements, functional/no-let, functional/immutable-data */
