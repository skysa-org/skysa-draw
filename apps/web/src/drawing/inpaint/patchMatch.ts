import { type Level, walkInward } from './level.js';

/**
 * PatchMatch (Barnes, Shechtman, Finkelstein and Goldman, "PatchMatch: A
 * Randomized Correspondence Algorithm for Structural Image Editing", SIGGRAPH
 * 2009) over one level of the pyramid, and the vote of Wexler, Shechtman and
 * Irani ("Space-Time Completion of Video", IEEE PAMI 2007) that makes the
 * hole again from the patches matched. Every patch that overlaps the hole, a
 * target, is matched to a patch of known pixels, a source; each pixel of the
 * hole is then the mean of what the targets over it say it is, each target
 * counted by how well it matched and by how near the known pixels it is.
 *
 * Random numbers come from a xorshift generator whose state is passed in, so
 * the same picture and mask give the same bytes every time.
 */

/** The next state of a 32-bit xorshift generator (Marsaglia, "Xorshift RNGs", 2003). */
const xorshift = (state: number): number => {
	const a = (state ^ (state << 13)) >>> 0;
	const b = (a ^ (a >>> 17)) >>> 0;
	return (b ^ (b << 5)) >>> 0;
};

/* eslint-disable functional/no-loop-statements, functional/no-let, functional/immutable-data -- the inner loops of PatchMatch run hundreds of millions of times a fill: plain loops over typed arrays written in place, since a closure a pixel misses the time budget several times over */

/**
 * The sum of squared differences between the patch on target `t` and the patch
 * on source `s`, over the four premultiplied channels and the target's pixels
 * inside the picture. Stops once it reaches `best`, since past it the source
 * can only lose.
 */
const patchDistance = (level: Level, t: number, s: number, best: number): number => {
	const { width, height, radius, color } = level;
	const tx = t % width;
	const ty = (t - tx) / width;
	const left = Math.min(radius, tx);
	const span = (left + Math.min(radius, width - 1 - tx) + 1) * 4;
	let sum = 0;
	for (let dy = -Math.min(radius, ty); dy <= Math.min(radius, height - 1 - ty); dy++) {
		const a = (t + dy * width - left) * 4;
		const b = (s + dy * width - left) * 4;
		for (let k = 0; k < span; k += 4) {
			const dr = (color[a + k] ?? 0) - (color[b + k] ?? 0);
			const dg = (color[a + k + 1] ?? 0) - (color[b + k + 1] ?? 0);
			const db = (color[a + k + 2] ?? 0) - (color[b + k + 2] ?? 0);
			const da = (color[a + k + 3] ?? 0) - (color[b + k + 3] ?? 0);
			sum += dr * dr + dg * dg + db * db + da * da;
		}
		if (sum >= best) return sum;
	}
	return sum;
};

/** Source `s` matched to target `t` if it is a source and nearer than the match it has. */
const consider = (level: Level, t: number, s: number): void => {
	if (level.source[s] !== 1) return;
	const best = level.distance[t] ?? 0;
	const distance = patchDistance(level, t, s, best);
	if (distance >= best) return;
	level.matches[t] = s;
	level.distance[t] = distance;
};

/** A source drawn at random for every target that has no match yet. The generator's next state comes back. */
export const matchAtRandom = (level: Level, state: number): number => {
	const { targets, sources, matches } = level;
	let seed = state;
	for (let k = 0; k < targets.length; k++) {
		const t = targets[k] ?? 0;
		seed = xorshift(seed);
		matches[t] =
			(matches[t] ?? -1) >= 0 ? (matches[t] ?? 0) : (sources[seed % sources.length] ?? 0);
	}
	return seed;
};

/**
 * Every target of `fine` matched where the target under it on `coarse` was,
 * at twice the offset, so what was found at the coarse level is where the
 * search at the fine one starts; a match that lands off the sources is
 * drawn at random. The generator's next state comes back.
 */
export const matchFromCoarser = (coarse: Level, fine: Level, state: number): number => {
	const { width, radius, targets, sources, matches, source } = fine;
	let seed = state;
	for (let k = 0; k < targets.length; k++) {
		const t = targets[k] ?? 0;
		const x = t % width;
		const y = (t - x) / width;
		const cx = Math.min(x >> 1, coarse.width - 1);
		const cy = Math.min(y >> 1, coarse.height - 1);
		const parent = coarse.matches[cy * coarse.width + cx] ?? -1;
		const px = parent % coarse.width;
		const py = (parent - px) / coarse.width;
		const sx = Math.min(Math.max(2 * px + (x - 2 * cx), radius), width - 1 - radius);
		const sy = Math.min(Math.max(2 * py + (y - 2 * cy), radius), fine.height - 1 - radius);
		const s = sy * width + sx;
		seed = xorshift(seed);
		const kept = parent >= 0 && source[s] === 1;
		matches[t] = kept ? s : (sources[seed % sources.length] ?? 0);
	}
	return seed;
};

/** Every target's distance from its match, measured again: the hole has changed under them. */
export const measureMatches = (level: Level): void => {
	const { targets, matches, distance } = level;
	for (let k = 0; k < targets.length; k++) {
		const t = targets[k] ?? 0;
		distance[t] = patchDistance(level, t, matches[t] ?? 0, Number.POSITIVE_INFINITY);
	}
};

/**
 * The source drawn by `seed` from the window `reach` pixels either way of
 * `(sx, sy)`, kept to where a patch of the level fits: one sample of
 * PatchMatch's random search.
 */
const drawNear = (level: Level, sx: number, sy: number, reach: number, seed: number): number => {
	const { width, height, radius } = level;
	const x0 = Math.max(radius, sx - reach);
	const y0 = Math.max(radius, sy - reach);
	const across = Math.min(width - 1 - radius, sx + reach) - x0 + 1;
	const down = Math.min(height - 1 - radius, sy + reach) - y0 + 1;
	const x = x0 + (((seed & 0xffff) * across) >>> 16);
	const y = y0 + (((seed >>> 16) * down) >>> 16);
	return y * width + x;
};

/**
 * PatchMatch's random search around target `t`'s match: one source drawn
 * from a window around it, the window halved each time from `widest` down
 * to a pixel. The generator's next state comes back.
 */
const searchAround = (level: Level, t: number, widest: number, state: number): number => {
	const start = level.matches[t] ?? 0;
	const sx = start % level.width;
	const sy = (start - sx) / level.width;
	let seed = state;
	for (let reach = widest; reach >= 1; reach >>= 1) {
		seed = xorshift(seed);
		consider(level, t, drawNear(level, sx, sy, reach, seed));
	}
	return seed;
};

/**
 * One pass of PatchMatch over every target, in scan order or, when `backward`,
 * in reverse: each target tries the match of the neighbor before it, moved
 * on by one pixel (propagation), then sources at random around its own
 * (random search). The generator's next state comes back.
 */
export const matchPass = (level: Level, backward: boolean, state: number): number => {
	const { width, targets, matches } = level;
	const step = backward ? -1 : 1;
	const widest = Math.max(level.width, level.height);
	let seed = state;
	for (let k = 0; k < targets.length; k++) {
		const t = targets[backward ? targets.length - 1 - k : k] ?? 0;
		const x = t % width;
		const beside = matches[t - step] ?? -1;
		const sideways = backward ? x < width - 1 : x > 0;
		if (sideways && beside >= 0) consider(level, t, beside + step);
		const above = matches[t - step * width] ?? -1;
		if (above >= 0) consider(level, t, above + step * width);
		seed = searchAround(level, t, widest, seed);
	}
	return seed;
};

/**
 * The sum of squared differences between the patch on target `t` and the patch
 * on source `s`, each of the target's pixels counted by `filled`: 1 for one
 * known or already filled as the hole is filled from its edge inward, less
 * for one that is only a guess.
 */
const partialDistance = (
	level: Level,
	filled: Float32Array,
	t: number,
	s: number,
	best: number
): number => {
	const { width, height, radius, color } = level;
	const tx = t % width;
	const ty = (t - tx) / width;
	const left = Math.min(radius, tx);
	const across = left + Math.min(radius, width - 1 - tx) + 1;
	const offset = (s - t) * 4;
	let sum = 0;
	for (let dy = -Math.min(radius, ty); dy <= Math.min(radius, height - 1 - ty); dy++) {
		const row = t + dy * width - left;
		for (let k = 0; k < across; k++) {
			const seen = filled[row + k] ?? 0;
			const a = (row + k) * 4;
			const dr = (color[a] ?? 0) - (color[a + offset] ?? 0);
			const dg = (color[a + 1] ?? 0) - (color[a + offset + 1] ?? 0);
			const db = (color[a + 2] ?? 0) - (color[a + offset + 2] ?? 0);
			const da = (color[a + 3] ?? 0) - (color[a + offset + 3] ?? 0);
			sum += seen * (dr * dr + dg * dg + db * db + da * da);
		}
		if (sum >= best) return sum;
	}
	return sum;
};

/** `consider`, measured by `partialDistance` by `filled`. */
const considerFilled = (level: Level, filled: Float32Array, t: number, s: number): void => {
	if (level.source[s] !== 1) return;
	const best = level.distance[t] ?? 0;
	const distance = partialDistance(level, filled, t, s, best);
	if (distance >= best) return;
	level.matches[t] = s;
	level.distance[t] = distance;
};

/** The eight neighbors of a pixel, as steps across and down. */
const AROUND_X = [-1, 0, 1, -1, 1, -1, 0, 1] as const;
const AROUND_Y = [-1, -1, -1, 0, 0, 1, 1, 1] as const;

/** How many sources drawn at random a pixel of the edge tries before the search around the best of them. */
const EDGE_DRAWS = 8;

/**
 * Hole pixel `p` matched over what is known or filled around it: the matches
 * of the neighbors filled before it, moved on to it, sources at random, and
 * the random search around the best. The generator's next state comes back.
 */
const matchOnEdge = (level: Level, filled: Float32Array, p: number, state: number): number => {
	const { width, height, hole, matches, sources } = level;
	const x = p % width;
	const y = (p - x) / width;
	level.distance[p] = Number.POSITIVE_INFINITY;
	for (let k = 0; k < AROUND_X.length; k++) {
		const nx = x + (AROUND_X[k] ?? 0);
		const ny = y + (AROUND_Y[k] ?? 0);
		const q = ny * width + nx;
		const inside = nx >= 0 && ny >= 0 && nx < width && ny < height;
		const from = inside && hole[q] === 1 ? (matches[q] ?? -1) : -1;
		if (from >= 0) considerFilled(level, filled, p, from + (p - q));
	}
	let seed = state;
	for (let k = 0; k < EDGE_DRAWS; k++) {
		seed = xorshift(seed);
		considerFilled(level, filled, p, sources[seed % sources.length] ?? 0);
	}
	const start = matches[p] ?? 0;
	const sx = start % width;
	const sy = (start - sx) / width;
	for (let reach = Math.max(width, height); reach >= 1; reach >>= 1) {
		seed = xorshift(seed);
		considerFilled(level, filled, p, drawNear(level, sx, sy, reach, seed));
	}
	return seed;
};

/**
 * The hole filled from its edge inward, in place, ring by ring, each pixel
 * copied from the middle of the source that best matches what is known or
 * already filled of its patch (the "onion peel" of Newson, Almansa, Gousseau
 * and Pérez, "Non-Local Patch-Based Image Inpainting", IPOL 2017). So a line
 * that meets the hole is carried into it from either side, rather than
 * blurred across it. A pixel of the hole not filled yet counts by `guide`, 0
 * to 1: nothing at the coarsest level, where it is nothing yet, and a little
 * at a finer one, where it is the guess from the level below. The
 * generator's next state comes back.
 */
export const fillFromEdge = (level: Level, state: number, guide = 0): number => {
	const { hole, color, matches } = level;
	const filled = new Float32Array(hole.length);
	for (let i = 0; i < hole.length; i++) filled[i] = (hole[i] ?? 0) === 0 ? 1 : guide;
	let seed = state;
	const { order } = walkInward(level);
	for (let k = 0; k < order.length; k++) {
		const p = order[k] ?? 0;
		seed = matchOnEdge(level, filled, p, seed);
		const s = (matches[p] ?? 0) * 4;
		color.copyWithin(p * 4, s, s + 4);
		filled[p] = 1;
	}
	return seed;
};

/**
 * Each target's weight in the vote, `exp(−d / 2σ²)`, `d` its distance per
 * channel and `σ²` the 75th percentile of them all, as Wexler, Shechtman and
 * Irani weigh theirs: a patch that matched badly counts for little. Where
 * every patch matched exactly, they count the same.
 */
/** How many distances the percentile in `weighMatches` is taken over, at most about. */
const PERCENTILE_SAMPLE = 8192;

const weighMatches = (level: Level): void => {
	const { width, height, radius, targets, distance, weight } = level;
	const perChannel = new Float64Array(targets.length);
	for (let k = 0; k < targets.length; k++) {
		const t = targets[k] ?? 0;
		const x = t % width;
		const y = (t - x) / width;
		const across = Math.min(radius, x) + Math.min(radius, width - 1 - x) + 1;
		const down = Math.min(radius, y) + Math.min(radius, height - 1 - y) + 1;
		perChannel[k] = (distance[t] ?? 0) / (across * down * 4);
	}
	// The percentile of an even sample of them, so a large hole sorts thousands rather than millions.
	const every = Math.max(1, Math.floor(perChannel.length / PERCENTILE_SAMPLE));
	const sorted = perChannel.filter((_, k) => k % every === 0).sort();
	const spread = 2 * (sorted[Math.floor((sorted.length - 1) * 0.75)] ?? 0);
	for (let k = 0; k < targets.length; k++) {
		const scaled = spread > 0 ? (perChannel[k] ?? 0) / spread : 0;
		weight[targets[k] ?? 0] = Math.exp(-scaled) + 1e-30;
	}
};

/**
 * How much more a patch counts in the vote for each ring nearer the known
 * pixels its center is: Wexler, Shechtman and Irani's `α`, so what is known
 * at the hole's edge carries inward from one round to the next.
 */
const NEARER = 1.3;

/**
 * Pixel `i` of the hole made again: the weighted mean of what every target
 * whose patch covers it says it is, the pixel at the same place in that
 * target's source. A target counts by how well it matched and by how much
 * nearer the known pixels than `i` it is, `NEARER` to the power of the rings
 * between them, read from `nearer`, which is indexed by that difference plus
 * the radius: a target is never more than a radius of rings either way.
 */
const votePixel = (level: Level, nearer: Float64Array, i: number): void => {
	const { width, height, radius, color, matches, weight, depth } = level;
	const x = i % width;
	const y = (i - x) / width;
	const dx0 = Math.max(-radius, x - (width - 1));
	const dx1 = Math.min(radius, x);
	const own = (depth[i] ?? 0) + radius;
	let r = 0;
	let g = 0;
	let b = 0;
	let a = 0;
	let total = 0;
	for (let dy = Math.max(-radius, y - (height - 1)); dy <= Math.min(radius, y); dy++) {
		for (let dx = dx0; dx <= dx1; dx++) {
			// The target `(dx, dy)` before this pixel sees it at `(dx, dy)` in its patch.
			const t = i - dy * width - dx;
			const w = (weight[t] ?? 0) * (nearer[own - (depth[t] ?? 0)] ?? 0);
			const p = ((matches[t] ?? 0) + dy * width + dx) * 4;
			r += w * (color[p] ?? 0);
			g += w * (color[p + 1] ?? 0);
			b += w * (color[p + 2] ?? 0);
			a += w * (color[p + 3] ?? 0);
			total += w;
		}
	}
	color[i * 4] = r / total;
	color[i * 4 + 1] = g / total;
	color[i * 4 + 2] = b / total;
	color[i * 4 + 3] = a / total;
};

/**
 * The vote: every pixel of the hole made again from the targets over it, in
 * place. A source is all known pixels, so no pixel voted is read by the vote.
 */
export const vote = (level: Level): void => {
	weighMatches(level);
	const nearer = Float64Array.from(
		{ length: 2 * level.radius + 1 },
		(_, k) => NEARER ** (k - level.radius)
	);
	for (let k = 0; k < level.holes.length; k++) votePixel(level, nearer, level.holes[k] ?? 0);
};
/* eslint-enable functional/no-loop-statements, functional/no-let, functional/immutable-data */
