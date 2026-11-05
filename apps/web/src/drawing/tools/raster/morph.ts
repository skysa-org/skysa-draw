/**
 * Morphology over a mask of cells (`areaMask.ts`), row by row, 1 in and 0
 * out, for Modify… (`areaOps.ts`): which cells are within a distance of a
 * selected cell, or of an unselected one, by the exact Euclidean distance
 * between their centers, and which cells most of the square around them is
 * selected in.
 *
 * The distance is the transform of Felzenszwalb and Huttenlocher ("Distance
 * Transforms of Sampled Functions", Theory of Computing 8, 2012): down the
 * columns, each cell's distance to the nearest cell of the kind in its
 * column; then along each row the lower envelope of the parabolas those
 * distances make, each cell's squared distance read off the one beneath it.
 * Linear in the cells, whatever the radius. Only whether a cell is within
 * the radius is asked, so a column's distance is kept to one past it, in 16
 * bits, and a parabola that starts past it is left out of the envelope: it
 * can bring no cell within, so the answer is exact, at a quarter of the
 * memory and with a row far from everything passed over at once.
 *
 * The majority is a box sum, separable: a running sum along each row of
 * the square's width, then a running sum of those down the columns. The
 * square's side is odd, so there is no tie, and what is out of the grid
 * counts as unselected.
 */

/** The farthest a column's distance is kept, in its 16 bits. */
const FARTHEST = 0xffff;

/* eslint-disable functional/no-loop-statements, functional/no-let, functional/immutable-data -- a pass over every cell of a grid of millions, in plain loops over typed arrays written in place: a closure a cell is several times slower */

/**
 * Each cell's distance in cells to the nearest cell of `kind` in its own
 * column, kept to `far`: down the rows, then back up. Every row is read
 * whole and in order, so neither pass strides across the grid.
 */
const columnDistances = (
	mask: Uint8Array,
	width: number,
	height: number,
	kind: number,
	far: number
): Uint16Array => {
	const down = new Uint16Array(width * height);
	const cells = width * height;
	for (let i = 0; i < Math.min(width, cells); i++) down[i] = mask[i] === kind ? 0 : far;
	for (let i = width; i < cells; i++) {
		down[i] = mask[i] === kind ? 0 : Math.min(far, (down[i - width] ?? far) + 1);
	}
	for (let i = cells - width - 1; i >= 0; i--) {
		down[i] = Math.min(down[i] ?? far, (down[i + width] ?? far) + 1);
	}
	return down;
};

/** Room for one row's envelope: each parabola's column, its height there plus the column squared, and where it begins. */
type Envelope = Readonly<{ at: Int32Array; lift: Float64Array; from: Float64Array }>;

/** Where the parabola of column `q`, lifted by `lift`, passes below the envelope's `k`th, along the row. */
const meeting = (envelope: Envelope, k: number, q: number, lift: number): number =>
	(lift - (envelope.lift[k] ?? 0)) / (2 * (q - (envelope.at[k] ?? 0)));

/**
 * One row of the answer: the lower envelope of the parabolas of the
 * row's column distances that are within `far`, then each cell `near` where
 * the envelope beneath it is within `limit`, the squared radius, and the
 * other way where it is not.
 */
const envelopeRow = (
	down: Uint16Array,
	offset: number,
	width: number,
	far: number,
	limit: number,
	near: number,
	envelope: Envelope,
	out: Uint8Array
): void => {
	const { at, lift, from } = envelope;
	let count = 0;
	for (let q = 0; q < width; q++) {
		const g = down[offset + q] ?? far;
		if (g >= far) continue;
		const own = g * g + q * q;
		while (count > 0 && meeting(envelope, count - 1, q, own) <= (from[count - 1] ?? 0)) count--;
		from[count] = count === 0 ? -Infinity : meeting(envelope, count - 1, q, own);
		at[count] = q;
		lift[count] = own;
		count++;
	}
	if (count === 0) {
		out.fill(near ^ 1, offset, offset + width);
		return;
	}
	let k = 0;
	for (let x = 0; x < width; x++) {
		while (k + 1 < count && (from[k + 1] ?? 0) < x) k++;
		const q = at[k] ?? 0;
		out[offset + x] = x * x - 2 * x * q + (lift[k] ?? 0) <= limit ? near : near ^ 1;
	}
};

/**
 * Each cell `near` where it is within `radius` cells of a cell of `kind`,
 * by the distance between their centers, and the other way where it is not.
 */
const distanceTest = (
	mask: Uint8Array,
	width: number,
	height: number,
	kind: number,
	radius: number,
	near: number
): Uint8Array => {
	const far = Math.min(FARTHEST, Math.floor(radius) + 1);
	const down = columnDistances(mask, width, height, kind, far);
	const out = new Uint8Array(width * height);
	const envelope: Envelope = {
		at: new Int32Array(width),
		lift: new Float64Array(width),
		from: new Float64Array(width),
	};
	const limit = radius * radius;
	for (let row = 0; row < height; row++) {
		envelopeRow(down, row * width, width, far, limit, near, envelope, out);
	}
	return out;
};

/** Each row's running sum of the `2 * radius + 1` cells centered on each cell, those off the row counted as 0. */
const rowSums = (mask: Uint8Array, width: number, height: number, radius: number): Uint16Array => {
	const sums = new Uint16Array(width * height);
	for (let row = 0; row < height; row++) {
		const offset = row * width;
		let sum = 0;
		for (let x = 0; x < Math.min(radius, width); x++) sum += mask[offset + x] ?? 0;
		for (let x = 0; x < width; x++) {
			sum += x + radius < width ? (mask[offset + x + radius] ?? 0) : 0;
			sums[offset + x] = sum;
			sum -= x - radius >= 0 ? (mask[offset + x - radius] ?? 0) : 0;
		}
	}
	return sums;
};

/** A row's sums added to the running sums down the columns, or, with a `sign` of -1, taken from them. */
const addRow = (
	columns: Int32Array,
	sums: Uint16Array,
	row: number,
	width: number,
	sign: number
): void => {
	const offset = row * width;
	for (let x = 0; x < width; x++) columns[x] = (columns[x] ?? 0) + sign * (sums[offset + x] ?? 0);
};

/** One row of the majority: in where more than half the square holds. */
const majorityRow = (
	columns: Int32Array,
	row: number,
	width: number,
	half: number,
	out: Uint8Array
): void => {
	const offset = row * width;
	for (let x = 0; x < width; x++) out[offset + x] = (columns[x] ?? 0) > half ? 1 : 0;
};

/**
 * The cells most of the square `2 * radius + 1` cells a side centered on
 * them is selected in: Photoshop's Smooth, which takes off what is smaller
 * than the square and fills in what is narrower, and rounds a corner.
 */
export const majorityOf = (
	mask: Uint8Array,
	width: number,
	height: number,
	radius: number
): Uint8Array => {
	const r = Math.max(0, Math.floor(radius));
	const sums = rowSums(mask, width, height, r);
	const columns = new Int32Array(width);
	const out = new Uint8Array(width * height);
	const half = ((2 * r + 1) * (2 * r + 1) - 1) / 2;
	for (let row = 0; row < Math.min(r, height); row++) addRow(columns, sums, row, width, 1);
	for (let row = 0; row < height; row++) {
		if (row + r < height) addRow(columns, sums, row + r, width, 1);
		majorityRow(columns, row, width, half, out);
		if (row - r >= 0) addRow(columns, sums, row - r, width, -1);
	}
	return out;
};

/* eslint-enable functional/no-loop-statements, functional/no-let, functional/immutable-data */

/** The cells within `radius` cells of a selected one, the selected ones too: a dilation by a disc. */
export const nearOf = (
	mask: Uint8Array,
	width: number,
	height: number,
	radius: number
): Uint8Array => distanceTest(mask, width, height, 1, radius, 1);

/**
 * The selected cells farther than `radius` cells from every unselected one:
 * an erosion by a disc. Cells off the grid are not read, so a grid that
 * must count them as unselected has a ring of them of its own.
 */
export const deepOf = (
	mask: Uint8Array,
	width: number,
	height: number,
	radius: number
): Uint8Array => distanceTest(mask, width, height, 0, radius, 0);
