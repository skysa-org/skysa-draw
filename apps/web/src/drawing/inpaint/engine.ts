import {
	type Box,
	boxOf,
	cropOf,
	halved,
	hasSource,
	type Level,
	levelOf,
	type Picture,
	type Pixels,
	radiusFor,
	writeHole,
} from './level.js';
import {
	fillFromEdge,
	matchAtRandom,
	matchFromCoarser,
	matchPass,
	measureMatches,
	vote,
} from './patchMatch.js';

/**
 * Content-aware fill, the engine (docs/ARCHITECTURE.md §7, "Tools"): the
 * inpainting of Wexler, Shechtman and Irani ("Space-Time Completion of
 * Video", 2007), coarse to fine, with the nearest patches found by PatchMatch
 * (Barnes et al., 2009), as Photoshop's Content-Aware Fill is built.
 *
 * The work is cut to a band around the hole; a pyramid of it is built down
 * to where the hole is a few dozen pixels across; the hole there is filled
 * from its edge inward, and then, level by level up to the picture itself,
 * each target patch is matched to a source and the hole voted again from the
 * matches, a few times over. Each level starts from the matches of the one
 * below it and the guess they vote, and each level between the coarsest and
 * the finest is filled from its edge again with that guess as a faint guide
 * (`guide`): so the layout found where the picture is small is kept, and a
 * line too thin to be seen there still meets the edge where it should.
 */

/** What the engine is tuned by; the numbers and why are in docs/ARCHITECTURE.md §7, "Tools". */
export const INPAINT_TUNING = {
	/** Half a patch's side: patches of 7 × 7, as Wexler and PatchMatch use. */
	patchRadius: 3,
	/** How far the band reaches past the hole's box on each side, in that box's longer sides. */
	bandReach: 1,
	/** The least the band reaches past the hole's box, in pixels, so a speck still has a picture around it. */
	bandMinimum: 32,
	/** The pyramid stops once the hole's longer side is no more than this, in pixels of that level. */
	coarsestHole: 24,
	/** Nor does it make a level whose shorter side is under this. */
	smallestSide: 24,
	/** Rounds of match-and-vote at the coarsest level, at the levels between, and at the finest. */
	rounds: { coarsest: 8, between: 4, finest: 2 },
	/** PatchMatch passes a round, alternately forward and backward. */
	passes: 2,
	/**
	 * How much the guess from the level below counts, against a pixel known or
	 * already filled, when a level between the coarsest and the finest has its
	 * hole filled again from its edge: enough to keep the layout found where
	 * the picture was small, little enough that a line too thin to be seen
	 * there is carried in from the edge.
	 */
	guide: 0.05,
	/** Where the random numbers start, so a fill gives the same bytes every time. */
	seed: 0x2f6b_4c1d,
} as const;

/** The band around `hole` that sources are drawn from: its box grown on every side, inside the picture. */
export const bandAround = (hole: Box, width: number, height: number): Box => {
	const reach = Math.max(
		INPAINT_TUNING.bandMinimum,
		Math.ceil(INPAINT_TUNING.bandReach * Math.max(hole.width, hole.height))
	);
	const x = Math.max(0, hole.x - reach);
	const y = Math.max(0, hole.y - reach);
	return {
		x,
		y,
		width: Math.min(width, hole.x + hole.width + reach) - x,
		height: Math.min(height, hole.y + hole.height + reach) - y,
	};
};

/** Whether a level above `picture` is worth making: its hole is still wide, and it is not yet small. */
const worthHalving = (picture: Picture): boolean => {
	const box = boxOf(picture.hole, picture.width, picture.height);
	const widest = box === undefined ? 0 : Math.max(box.width, box.height);
	return (
		widest > INPAINT_TUNING.coarsestHole &&
		Math.min(picture.width, picture.height) >= 2 * INPAINT_TUNING.smallestSide
	);
};

/**
 * The pyramid over `picture`, finest first: each level half the one below,
 * for as long as the hole is wide and the level above still has a source.
 */
const pyramidOf = (picture: Picture, radius: number): readonly Level[] => {
	const level = levelOf(picture, radius);
	if (!worthHalving(picture)) return [level];
	const above = halved(picture);
	if (!hasSource(above, radius)) return [level];
	return [level, ...pyramidOf(above, radius)];
};

/** A step of the work: it takes the generator's state and gives back the next. */
type Step = (state: number) => number;

/** One round at a level: every match measured again, PatchMatch's passes, and the vote. */
const round = (level: Level): readonly Step[] => [
	(state) => {
		measureMatches(level);
		return state;
	},
	...Array.from(
		{ length: INPAINT_TUNING.passes },
		(_, pass): Step =>
			(state) =>
				matchPass(level, pass % 2 === 1, state)
	),
	(state) => {
		vote(level);
		return state;
	},
];

/** How many rounds a level gets: the most where it is smallest and cheapest. */
const roundsAt = (index: number, count: number): number => {
	if (index === count - 1) return INPAINT_TUNING.rounds.coarsest;
	return index === 0 ? INPAINT_TUNING.rounds.finest : INPAINT_TUNING.rounds.between;
};

/**
 * The steps at level `index` of `pyramid`: how it starts, from its edge at the
 * coarsest, or from the level below and, short of the finest, from its edge
 * again with that as the guide; and then its rounds.
 */
const stepsAt = (pyramid: readonly Level[], index: number): readonly Step[] => {
	const level = pyramid[index];
	if (level === undefined) return [];
	const coarser = pyramid[index + 1];
	const start: readonly Step[] =
		coarser === undefined
			? [(state) => matchAtRandom(level, fillFromEdge(level, state))]
			: [
					(state) => matchFromCoarser(coarser, level, state),
					(state) => {
						measureMatches(level);
						vote(level);
						// Not at the finest level, where it is dearest and adds least: the
						// level below it has already carried the thin lines in.
						return index === 0
							? state
							: fillFromEdge(level, state, INPAINT_TUNING.guide);
					},
				];
	const rounds = Array.from({ length: roundsAt(index, pyramid.length) }, () => round(level));
	return [...start, ...rounds.flat()];
};

/** Whether the mask makes any pixel again, and keeps any to make it from. */
const fillable = (mask: Uint8Array): boolean =>
	mask.includes(0) && mask.some((value) => value !== 0);

/**
 * The picture with the pixels under `mask` (not 0) made again from the rest;
 * `inpaint` in `./index.ts` says the rest. `checkpoint` is awaited between
 * steps: a page yields there, and gives up by rejecting, and a worker passes
 * one that does nothing.
 */
export const inpaintPixels = async (
	image: Pixels,
	mask: Uint8Array,
	checkpoint: () => Promise<void>
): Promise<Uint8ClampedArray<ArrayBuffer>> => {
	const out = new Uint8ClampedArray(image.data);
	const hole = fillable(mask) ? boxOf(mask, image.width, image.height) : undefined;
	if (hole === undefined) return out;
	const band = bandAround(hole, image.width, image.height);
	const finest = cropOf(image, mask, band);
	const pyramid = pyramidOf(finest, radiusFor(finest, INPAINT_TUNING.patchRadius));
	const steps = pyramid.flatMap((_, index) => stepsAt(pyramid, pyramid.length - 1 - index));
	await steps.reduce(
		(done, step) => done.then((state) => checkpoint().then(() => step(state))),
		Promise.resolve<number>(INPAINT_TUNING.seed)
	);
	const level = pyramid[0];
	if (level !== undefined) writeHole(out, image.width, level, band);
	return out;
};

/** What the page posts to the worker: the picture and the mask, their buffers transferred. */
export interface InpaintRequest {
	readonly width: number;
	readonly height: number;
	readonly data: ArrayBuffer;
	readonly mask: ArrayBuffer;
}

/** What the worker posts back: the whole picture filled, its buffer transferred, or why it could not be. */
export type InpaintReply = Readonly<{ data: ArrayBuffer }> | Readonly<{ error: string }>;

/** The worker's answer to a request: the fill run straight through, with nothing to yield to. */
export const answer = (request: InpaintRequest): Promise<InpaintReply> =>
	inpaintPixels(
		{
			width: request.width,
			height: request.height,
			data: new Uint8ClampedArray(request.data),
		},
		new Uint8Array(request.mask),
		() => Promise.resolve()
	).then(
		(data): InpaintReply => ({ data: data.buffer }),
		(error: unknown): InpaintReply => ({
			error: error instanceof Error ? error.message : String(error),
		})
	);
