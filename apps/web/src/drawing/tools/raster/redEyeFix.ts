/**
 * The red eye tool's correction (docs/decisions/0004-the-interface.md), with
 * no canvas in it, so it runs and is tested in Node: a pupil a flash turned
 * red, found near where the user aimed and made a dark neutral, as
 * Photoshop's Red Eye tool does by its Pupil Size and Darken Amount.
 *
 * It works in four steps, each after a method already in use.
 *
 * 1. A pixel's redness is how far its red leads the stronger of green and
 *    blue, less any lead green has over blue, as a share of its brightness:
 *    `(r − max(g, b) − max(0, g − b)) / (r + g + b)`. The red's lead is the
 *    measure red-eye tools start from; green is counted against it more
 *    than blue, as GEGL weighs the two (green 1, blue 0.19), so a warm pixel,
 *    skin, a brown iris or an orange, whose green leads its blue, is barely
 *    red at all, while a pink one keeps its redness; and as a share, so a
 *    dark red pupil is as red as a bright one.
 * 2. A pupil is found where some pixel in the search is decidedly red: by
 *    that share, and by the ratio GEGL's red-eye removal, GIMP's filter,
 *    tests at its default threshold, `0.5133 · r ≥ g`, which leaves out an
 *    orange (GEGL, `operations/common-gpl3+/red-eye-removal.c`, after Geoff
 *    Kuenning's GIMP 1.2 plug-in:
 *    https://gitlab.gnome.org/GNOME/gegl/-/blob/master/operations/common-gpl3+/red-eye-removal.c).
 *    The one nearest the aim, weighted by its redness, is the seed, so a
 *    click on one eye with both in the search corrects that one.
 * 3. The pupil is grown from the red joined to the seed by its sides, as the
 *    fill floods, through every pixel red enough: the threshold is set from
 *    that red's mean redness by Pupil size, high at 0 so only the reddest
 *    core is taken and down to a floor at 1 that takes the pink rim and
 *    stops short of skin, a brown iris and the eye's pink corner.
 * 4. Each pixel of it is moved toward a dark neutral, the mean of its green
 *    and blue in all three channels, as the LearnOpenCV red-eye remover
 *    does (Satya Mallick, "Automatic Red Eye Remover using OpenCV", 2017:
 *    https://learnopencv.com/automatic-red-eye-remover-using-opencv-cpp-python/),
 *    darkened by Darken amount, from that mean at 0 to black at 1; by as much
 *    as its redness clears the threshold, so the rim blends into the iris
 *    with no hard edge, and by as much as the area selected covers it. Alpha
 *    is kept, and a catchlight, which is white, is left as it is.
 */

/** The pixels as the canvas gives them: RGBA, straight alpha, row by row. */
export type Pixels = Readonly<{ data: Uint8ClampedArray; width: number; height: number }>;

/** A rectangle of pixels, in the pixels given. */
export type PixelBox = Readonly<{ x: number; y: number; width: number; height: number }>;

/** What to correct, all in the pixels given. */
export type RedEyeRequest = Readonly<{
	/** Where the pupil may be grown: no pixel outside them changes. */
	pixels: Pixels;
	/** Where the pupil's seed is looked for: kept inside the pixels. */
	search: PixelBox;
	/** Where the user aimed: the click, or the middle of the box dragged. */
	at: Readonly<{ x: number; y: number }>;
	/** Pupil size, 0 to 1: from the reddest core alone to all the red out to the pink rim. */
	pupilSize: number;
	/** Darken amount, 0 to 1: from the mean of green and blue to black. */
	darken: number;
	/** How much the area selected covers each pixel, as the alpha of RGBA the pixels' size; none for no area. */
	coverage?: Uint8ClampedArray;
}>;

/**
 * What came of it: a pupil corrected; none found, no pixel in the search
 * being red enough; or red found only where the area selected does not reach.
 */
export type RedEyeOutcome = 'corrected' | 'notFound' | 'outsideArea';

export type RedEyeResult = Readonly<{
	outcome: RedEyeOutcome;
	/** The pixels corrected: a copy of the ones given, the same bytes where nothing changed. */
	data: Uint8ClampedArray;
	/** How many pixels changed: none unless the outcome is `corrected`. */
	changed: number;
}>;

/** GEGL's `RED_FACTOR`: a pixel is red to it where this much of its red is at least its green. */
const RED_OVER_GREEN = 0.5133333;

/** The least redness, as a share of brightness, a pixel needs to be a pupil's seed. */
export const SEED_REDNESS = 0.25;

/** The least lead of red, of 255 (`leadAt`), a seed needs: dark noise is not a pupil. */
const SEED_LEAD = 40;

/**
 * The least redness any pixel of a pupil has, whatever the Pupil size:
 * above flushed skin (`220, 140, 130` is 0.14), a warm brown (`150, 90, 60`
 * is 0.10), a brown iris (`120, 80, 50` is 0.04) and the pink corner of the
 * eye (`220, 140, 140` is 0.16); below a pink rim (`200, 110, 120` is 0.19).
 */
export const PUPIL_FLOOR = 0.18;

/** The least lead of red, of 255 (`leadAt`), any pixel of a pupil has: near black is left as it is. */
const PUPIL_LEAD = 16;

/** How far up from the floor toward the red's mean redness the threshold is at a Pupil size of 0. */
const CORE_REACH = 0.85;

/** Of the way from the threshold to the red's mean redness, how much is the blend: past it, a pixel is wholly corrected. */
const BLEND_SPAN = 0.3;

const channel = (data: Uint8ClampedArray, offset: number): number => data[offset] ?? 0;

/** How far red leads the stronger of green and blue, less green's lead over blue, of 255: negative where it does not lead. */
const leadOf = (r: number, g: number, b: number): number => r - Math.max(g, b) - Math.max(0, g - b);

const leadAt = (data: Uint8ClampedArray, index: number): number => {
	const offset = index * 4;
	return leadOf(channel(data, offset), channel(data, offset + 1), channel(data, offset + 2));
};

/** A pixel's redness, 0 to 1 (step 1): red's lead (`leadOf`) as a share of its brightness. */
export const rednessOf = (r: number, g: number, b: number): number => {
	const sum = r + g + b;
	return sum > 0 ? Math.max(0, leadOf(r, g, b)) / sum : 0;
};

const rednessAt = (data: Uint8ClampedArray, index: number): number => {
	const offset = index * 4;
	return rednessOf(channel(data, offset), channel(data, offset + 1), channel(data, offset + 2));
};

/** Whether a pixel is red enough to be a pupil's seed, the area aside. */
const seedLike = (data: Uint8ClampedArray, index: number): boolean => {
	const offset = index * 4;
	return (
		channel(data, offset + 3) > 0 &&
		leadAt(data, index) >= SEED_LEAD &&
		rednessAt(data, index) >= SEED_REDNESS &&
		RED_OVER_GREEN * channel(data, offset) >= channel(data, offset + 1)
	);
};

/** 0 to 1, from `low` to `high`, eased at both ends: the blend over the rim. */
const smooth = (low: number, high: number, value: number): number => {
	const t = Math.min(1, Math.max(0, (value - low) / (high - low)));
	return t * t * (3 - 2 * t);
};

/** An option kept to 0 to 1; one that is not a number is `otherwise`. */
const unit = (value: number, otherwise: number): number =>
	Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : otherwise;

/** The search kept to whole pixels inside the pixels; none where nothing is left of it. */
const clampBox = (box: PixelBox, width: number, height: number): PixelBox | undefined => {
	const left = Math.max(0, Math.floor(box.x));
	const top = Math.max(0, Math.floor(box.y));
	const right = Math.min(width, Math.ceil(box.x + box.width));
	const bottom = Math.min(height, Math.ceil(box.y + box.height));
	if (!(right > left && bottom > top)) return undefined;
	return { x: left, y: top, width: right - left, height: bottom - top };
};

/* eslint-disable functional/immutable-data -- masks, queues and the pixels themselves are filled in place, as the fill's flood is; a copy per pixel would be the whole picture */
/**
 * The pixels joined by their sides to the ones `seeds` marks, through pixels
 * that are `near`: a breadth-first walk over a queue the size of the
 * picture, as the fill floods (`floodFill`), every pixel tested once and
 * nothing recursing.
 */
const flood = (
	width: number,
	height: number,
	seeds: Uint8Array,
	near: (index: number) => boolean
): Uint8Array => {
	const count = width * height;
	const reached = new Uint8Array(count);
	const tested = new Uint8Array(count);
	const queue = new Uint32Array(count);
	// [the queue's length]
	const tally = new Uint32Array(1);
	const consider = (index: number): void => {
		if (tested[index] === 1) return;
		tested[index] = 1;
		if (!near(index)) return;
		queue[tally[0] ?? 0] = index;
		tally[0] = (tally[0] ?? 0) + 1;
	};
	seeds.forEach((seed, index) => {
		if (seed === 1) consider(index);
	});
	queue.some((index, position) => {
		if (position >= (tally[0] ?? 0)) return true;
		reached[index] = 1;
		const x = index % width;
		if (x > 0) consider(index - 1);
		if (x + 1 < width) consider(index + 1);
		if (index >= width) consider(index - width);
		if (index + width < count) consider(index + width);
		return false;
	});
	return reached;
};

/** What the search found: the seed's index, or none, and whether any red there was outside the area. */
type Found = Readonly<{ seed: number | undefined; outside: boolean }>;

/**
 * The seed: of the pixels in the search red enough and covered by the area,
 * the one whose redness, less by how far it is from the aim, is greatest;
 * the falloff halves the weight a quarter of the search's longer side away.
 */
const findSeed = (
	request: RedEyeRequest,
	search: PixelBox,
	covered: (index: number) => number
): Found => {
	const { data, width } = request.pixels;
	const falloff = Math.max(1, Math.max(search.width, search.height) / 4);
	// [the best score, its index plus one, whether red was found outside the area]
	const best = new Float64Array(3);
	new Uint8Array(search.width * search.height).forEach((_, k) => {
		const x = search.x + (k % search.width);
		const y = search.y + Math.floor(k / search.width);
		const index = y * width + x;
		if (!seedLike(data, index)) return;
		if (!(covered(index) > 0)) {
			best[2] = 1;
			return;
		}
		const distance = Math.hypot(x + 0.5 - request.at.x, y + 0.5 - request.at.y);
		const score = rednessAt(data, index) / (1 + (distance / falloff) ** 2);
		if (score <= (best[0] ?? 0)) return;
		best[0] = score;
		best[1] = index + 1;
	});
	const found = best[1] ?? 0;
	return { seed: found > 0 ? found - 1 : undefined, outside: best[2] === 1 };
};

/** The pupil's pixels moved toward their dark neutral by `weight`, into a copy; how many changed. */
const corrected = (
	data: Uint8ClampedArray,
	pupil: Uint8Array,
	weight: (index: number) => number,
	darken: number
): Readonly<{ data: Uint8ClampedArray; changed: number }> => {
	const out = new Uint8ClampedArray(data);
	// [the pixels changed]
	const tally = new Uint32Array(1);
	pupil.forEach((on, index) => {
		if (on !== 1) return;
		const w = weight(index);
		if (!(w > 0)) return;
		const offset = index * 4;
		const neutral =
			((channel(data, offset + 1) + channel(data, offset + 2)) / 2) * (1 - darken);
		const next = [0, 1, 2].map((c) => {
			const value = channel(data, offset + c);
			return Math.round(value + (neutral - value) * w);
		});
		if (next.every((value, c) => value === channel(data, offset + c))) return;
		tally[0] = (tally[0] ?? 0) + 1;
		next.forEach((value, c) => {
			out[offset + c] = value;
		});
	});
	return { data: out, changed: tally[0] ?? 0 };
};
/* eslint-enable functional/immutable-data */

/** What a press that changed nothing gives back: the pixels as they were, and why. */
const unchanged = (data: Uint8ClampedArray, outcome: RedEyeOutcome): RedEyeResult => ({
	outcome,
	data: new Uint8ClampedArray(data),
	changed: 0,
});

/**
 * The red pupil near `at` corrected (the four steps above): the pixels with
 * it made a dark neutral, and how many changed. Nothing changes where no
 * pixel in the search is red enough to be a pupil, or where all that is lies
 * outside the area selected; the outcome says which.
 */
export const fixRedEye = (request: RedEyeRequest): RedEyeResult => {
	const { data, width, height } = request.pixels;
	const pupilSize = unit(request.pupilSize, 0.5);
	const darken = unit(request.darken, 0.5);
	const { coverage } = request;
	const covered = (index: number): number =>
		coverage === undefined ? 1 : channel(coverage, index * 4 + 3) / 255;
	const search = clampBox(request.search, width, height);
	if (search === undefined) return unchanged(data, 'notFound');
	const { seed, outside } = findSeed(request, search, covered);
	if (seed === undefined) return unchanged(data, outside ? 'outsideArea' : 'notFound');

	const count = width * height;
	const start = new Uint8Array(count).map((_, index) => (index === seed ? 1 : 0));
	// The red joined to the seed, as far as the area reaches: what the threshold is set from.
	const core = flood(
		width,
		height,
		start,
		(index) => seedLike(data, index) && covered(index) > 0
	);
	const size = core.reduce((sum, on) => sum + on, 0);
	const mean =
		core.reduce((sum, on, index) => (on === 1 ? sum + rednessAt(data, index) : sum), 0) / size;
	const low = PUPIL_FLOOR + (mean - PUPIL_FLOOR) * CORE_REACH * (1 - pupilSize);
	const high = low + (mean - low) * BLEND_SPAN;
	const near = (index: number): boolean =>
		channel(data, index * 4 + 3) > 0 &&
		leadAt(data, index) >= PUPIL_LEAD &&
		rednessAt(data, index) >= low;
	const pupil = flood(
		width,
		height,
		core.map((on, index) => (on === 1 && near(index) ? 1 : 0)),
		near
	);
	const made = corrected(
		data,
		pupil,
		(index) => smooth(low, high, rednessAt(data, index)) * covered(index),
		darken
	);
	if (made.changed === 0)
		return unchanged(data, coverage === undefined ? 'notFound' : 'outsideArea');
	return { outcome: 'corrected', data: made.data, changed: made.changed };
};
