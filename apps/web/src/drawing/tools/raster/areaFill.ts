import { type BlendMode, cell } from '@skysa/draw-core';

import type { Args, At } from '../../../i18n/catalog.js';
import { type English, type MessageKey, t } from '../../../i18n/t.js';
import { inpaint } from '../../inpaint/index.js';
import type { ToolContext } from '../types.js';
import { inkOf } from '../vector/svg.js';
import { type Area, areaMask, areaOf, areaPixelBox, keepCovered, releaseCanvas } from './area.js';
import { guardedLayer, guardedSurface, reportFailure } from './guard.js';
import { parseColor, type Rgba } from './pixels.js';
import { type RasterSurface, surfaceFor, UnreadablePictureError } from './surface.js';

/**
 * Fill… (docs/decisions/0004-the-interface.md, "The context menu"; docs/ARCHITECTURE.md
 * §7, "Tools"), Photoshop's Edit > Fill for the area selection on a raster
 * layer: the area filled with the fill color, the stroke color, a color of
 * the user's own, or the picture around it made again (content-aware), laid
 * over the layer's pixels in a blend mode at an opacity, by as much as the
 * area covers each, so a feather fades and an inverse fills outside the
 * outline. One command, `regions.fill`, whichever it is, undone to the bytes;
 * a fill that changed no pixel writes nothing.
 *
 * The mode is the canvas's `globalCompositeOperation`, which names CSS's
 * blend modes as CSS does, `normal` being its `source-over`. A color is laid
 * over the pixels; the picture made again replaces them in `normal`, its
 * transparency with it, so an object on a transparent layer goes when what is
 * around it is nothing, and is blended over them in any other mode. Preserve
 * transparency keeps each pixel's alpha: the fill is laid over a copy of the
 * pixels and the copy drawn back `source-atop`, which keeps the destination's
 * alpha.
 *
 * Making pixels again is the engine's (`inpaint`), and the work around it is
 * here once, for Fill…'s Content-Aware and for the Remove tool alike
 * (`makeAgainUnder`): the engine given the layer and a hole of every pixel a
 * coverage reaches, a status over the canvas with its Stop while it works,
 * Escape aborting it, its result dropped where the layer changed meanwhile,
 * and what it made laid over the layer by the coverage in one command.
 */

export type FillContents = 'fill' | 'stroke' | 'color' | 'contentAware';

/** What the area is filled with, and how it is laid over the layer's pixels. */
export type FillSpec = Readonly<{
	contents: FillContents;
	/** For `color`: a CSS color; one that is none or cannot be read is the fill color. */
	color?: string;
	mode: BlendMode;
	/** 0 to 1. */
	opacity: number;
	/** Photoshop's checkbox: a transparent pixel stays transparent, a part-transparent one keeps its alpha. */
	preserveTransparency: boolean;
}>;

/** How the fill is laid over the pixels, read once from the spec. */
type Way = Readonly<{
	composite: GlobalCompositeOperation;
	opacity: number;
	preserve: boolean;
}>;

const BLACK: Rgba = [0, 0, 0, 255];

/** A color as a canvas takes it, its alpha kept. */
const cssOf = (rgba: Rgba): string => `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`;

/** The mask's coverage in a color: the color drawn over it `source-in`, the whole canvas, in place. */
const tinted = (mask: HTMLCanvasElement, color: string): HTMLCanvasElement => {
	const ctx = mask.getContext('2d');
	if (ctx === null) return mask;
	ctx.globalCompositeOperation = 'source-in';
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, mask.width, mask.height);
	ctx.globalCompositeOperation = 'source-over';
	return mask;
};

/**
 * A blend mode as the 2D canvas composites it: CSS's own names, `normal`
 * being `source-over`. The compiler holds every other mode the app has to
 * being one `globalCompositeOperation` takes.
 */
const compositeOf = (mode: BlendMode): GlobalCompositeOperation =>
	mode === 'normal' ? 'source-over' : mode;

/** An opacity kept to 0 to 1; one that is not a number is full. */
const opacityOf = (opacity: number): number =>
	Number.isFinite(opacity) ? Math.min(1, Math.max(0, opacity)) : 1;

/**
 * The color a spec pours: the fill tool's for the fill color, the stroke
 * color for the stroke, each falling back to the other where it is none, as
 * `inkOf` does; the user's own for `color`, or the fill color where it is
 * none or cannot be read.
 */
const inkFor = (spec: FillSpec, context: ToolContext): string => {
	const own = spec.contents === 'color' ? spec.color : undefined;
	if (own !== undefined && parseColor(own) !== undefined) return own;
	return inkOf(context.options, spec.contents === 'stroke' ? 'stroke' : 'fill');
};

/** A canvas of `like`'s size, holding `like`'s pixels where it is given them. */
const canvasLike = (
	like: HTMLCanvasElement,
	copy: boolean
): readonly [HTMLCanvasElement, CanvasRenderingContext2D] | undefined => {
	const canvas = document.createElement('canvas');
	canvas.width = like.width;
	canvas.height = like.height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	if (copy) ctx.drawImage(like, 0, 0);
	return [canvas, ctx];
};

/** `image`, the target's size, drawn over the whole of it in `composite` at `alpha`. */
const drawWhole = (
	ctx: CanvasRenderingContext2D,
	image: HTMLCanvasElement,
	composite: GlobalCompositeOperation,
	alpha: number
): void => {
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = alpha;
	ctx.globalCompositeOperation = composite;
	ctx.drawImage(image, 0, 0);
	ctx.restore();
};

/**
 * `source`, already kept to the area's coverage, laid over `ctx`'s pixels:
 * in the mode, at the opacity. With `replacing`, the coverage, it takes the
 * pixels' place instead, in proportion: what is there is taken away by as
 * much as the coverage at the opacity says (`destination-out`) and `source`
 * added at the same opacity (`lighter`), which is the two mixed, alpha and
 * all.
 */
const layOver = (
	ctx: CanvasRenderingContext2D,
	source: HTMLCanvasElement,
	way: Way,
	replacing: HTMLCanvasElement | undefined
): void => {
	if (replacing === undefined) {
		drawWhole(ctx, source, way.composite, way.opacity);
		return;
	}
	drawWhole(ctx, replacing, 'destination-out', way.opacity);
	drawWhole(ctx, source, 'lighter', way.opacity);
};

/**
 * `source` laid over the pixels on `ctx` as `way` says. Preserving
 * transparency, it is laid over a copy, and the copy drawn back over the
 * pixels `source-atop`, which keeps each pixel's alpha and takes the copy's
 * color by as much as the copy has, so a transparent pixel stays so.
 */
const compose = (
	ctx: CanvasRenderingContext2D,
	source: HTMLCanvasElement,
	way: Way,
	replacing?: HTMLCanvasElement
): void => {
	if (!way.preserve) {
		layOver(ctx, source, way, replacing);
		return;
	}
	const made = canvasLike(ctx.canvas, true);
	if (made === undefined) return;
	const [copy, copyCtx] = made;
	layOver(copyCtx, source, way, replacing);
	drawWhole(ctx, copy, 'source-atop', 1);
	releaseCanvas(copy);
};

/** Whether any pixel in `box` on `ctx` is other than it was. */
const changedSince = (
	ctx: CanvasRenderingContext2D,
	box: Readonly<{ x: number; y: number; width: number; height: number }>,
	before: Uint8ClampedArray
): boolean =>
	ctx
		.getImageData(box.x, box.y, box.width, box.height)
		.data.some((value, index) => value !== before[index]);

/** The area filled with a color, as `surface.paint` asks: whether a pixel changed. */
const colorPainter =
	(surface: RasterSurface, area: Area, color: string, way: Way) =>
	(ctx: CanvasRenderingContext2D): boolean => {
		const box = areaPixelBox(surface, area);
		const mask = box === undefined ? undefined : areaMask(surface, area);
		if (box === undefined || mask === undefined) return false;
		const before = ctx.getImageData(box.x, box.y, box.width, box.height).data;
		compose(ctx, tinted(mask, color), way);
		releaseCanvas(mask);
		return changedSince(ctx, box, before);
	};

/**
 * The hole the engine fills: every pixel the coverage reaches at all, so a
 * feather's fading edge is made again too, and then mixed with what was
 * there by the coverage.
 */
const holeOf = (cover: HTMLCanvasElement): Uint8Array | undefined => {
	const data = cover.getContext('2d')?.getImageData(0, 0, cover.width, cover.height).data;
	if (data === undefined) return undefined;
	return new Uint8Array(cover.width * cover.height).map((_, i) =>
		(data[i * 4 + 3] ?? 0) > 0 ? 1 : 0
	);
};

/** The engine's pixels on a canvas of their own; none for pixels that are not the picture's size. */
const pictureOf = (
	data: Uint8ClampedArray,
	like: HTMLCanvasElement
): HTMLCanvasElement | undefined => {
	if (data.length !== like.width * like.height * 4) return undefined;
	const made = canvasLike(like, false);
	if (made === undefined) return undefined;
	const [canvas, ctx] = made;
	ctx.putImageData(new ImageData(new Uint8ClampedArray(data), like.width, like.height), 0, 0);
	return canvas;
};

/** Why making pixels again stopped before what was made was written. */
type Stop = 'stopped' | 'changed' | 'failed';

/** A key of the catalog whose message takes no placeholder and does not count. */
type PlainKey = {
	[K in MessageKey]: Args<At<English, K>> extends [] ? K : never;
}[MessageKey];

/**
 * What the user is told while the engine works and why it stopped, each a
 * key of the catalog that takes no placeholder: the line over the canvas,
 * its button, and one for each way it stops before it writes.
 */
export type MakeAgainWords = Readonly<Record<'working' | 'stop' | Stop, PlainKey>>;

/** Fill…'s words for its Content-Aware. */
const FILL_WORDS = {
	working: 'selection.fill.working',
	stop: 'selection.fill.stop',
	stopped: 'selection.fill.stopped',
	changed: 'selection.fill.changed',
	failed: 'selection.fill.failed',
} as const satisfies MakeAgainWords;

/** The events the progress stops, so a press on it starts no stroke and opens no menu. */
const KEPT_FROM_CANVAS = ['pointerdown', 'pointerup', 'contextmenu'] as const;

/**
 * What shows while the engine works: a line over the canvas, in the
 * viewport's own element, with a bar that does not say how far, since the
 * engine does not, and Stop, for a screen with no Escape. A status, so a
 * screen reader says it once.
 */
const showProgress = (
	host: HTMLElement,
	words: MakeAgainWords,
	onStop: () => void
): Readonly<{ remove: () => void }> => {
	const owner = host.ownerDocument;
	const box = owner.createElement('div');
	box.setAttribute('class', 'fill-progress');
	box.setAttribute('role', 'status');
	const line = owner.createElement('span');
	line.append(t(words.working));
	const bar = owner.createElement('progress');
	bar.setAttribute('aria-hidden', 'true');
	const stop = owner.createElement('button');
	stop.setAttribute('type', 'button');
	stop.append(t(words.stop));
	stop.addEventListener('click', onStop);
	KEPT_FROM_CANVAS.forEach((name) =>
		box.addEventListener(name, (event) => event.stopPropagation())
	);
	box.append(line, bar, stop);
	host.append(box);
	return { remove: () => box.remove() };
};

/** The engine at work: why it stopped, if it did, whether its pixels went stale, and its end. */
type Watch = Readonly<{
	stopped: () => Stop | undefined;
	stale: () => boolean;
	end: () => void;
}>;

/**
 * Watching the engine while it works, which may be long: Escape anywhere,
 * or Stop, aborts it, and so does any change to the layer's pixels meanwhile
 * (an undo or a redo moved the file's picture, or another write was asked of
 * the surface), since what the engine made is of the pixels as they were.
 * Escape is taken in the capture phase and its default prevented, so the
 * viewport does not also drop the area.
 */
const watchEngine = (
	context: ToolContext,
	surface: RasterSurface,
	controller: AbortController,
	words: MakeAgainWords
): Watch => {
	const why = cell<Stop | undefined>(undefined);
	const asked = surface.writes();
	const stale = (): boolean => surface.writes() !== asked || surfaceFor(context) !== surface;
	const stop = (reason: Stop): void => {
		if (why.current !== undefined) return;
		why.current = reason;
		controller.abort();
	};
	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.key !== 'Escape' || event.defaultPrevented) return;
		event.preventDefault();
		stop('stopped');
	};
	const view = context.host.ownerDocument.defaultView;
	view?.addEventListener('keydown', onKeyDown, true);
	const unsubscribe = context.document.subscribe(() => {
		if (stale()) stop('changed');
	});
	const progress = showProgress(context.host, words, () => stop('stopped'));
	const ended = cell(false);
	return {
		stopped: () => why.current,
		stale,
		end: () => {
			if (ended.current) return;
			ended.current = true;
			view?.removeEventListener('keydown', onKeyDown, true);
			unsubscribe();
			progress.remove();
		},
	};
};

/** A box of a layer's pixels, in whole pixels. */
type PixelBox = Readonly<{ x: number; y: number; width: number; height: number }>;

/**
 * What the engine makes again of a layer: how much of each of its pixels
 * goes, as the alpha of a canvas the size of the layer's pixels, and the box
 * of them outside which none does.
 */
type Coverage = Readonly<{ canvas: HTMLCanvasElement; box: PixelBox }>;

/** One making again: the command it is, the user's words for it, and what it makes again. */
export type MakeAgain = Readonly<{
	/** The command's name, as the history says it. */
	label: MessageKey;
	words: MakeAgainWords;
	/**
	 * The coverage, asked for once the layer's pixels are decoded and can be
	 * read; none where there is nothing to make again. Its canvas is the
	 * work's from then on, let go of once it is done.
	 */
	coverage: () => Coverage | undefined;
}>;

/** What the engine is given: the layer's pixels, once decoded, the coverage and the hole it makes. */
type Read = Readonly<{
	image: ImageData;
	cover: HTMLCanvasElement;
	hole: Uint8Array;
	box: PixelBox;
}>;

/**
 * The layer's pixels and the coverage of them, once they are decoded; none
 * for a surface with no 2D context, which is inert, or a coverage that
 * reaches none of them, for which the engine is not asked. A picture that
 * would not decode rejects, as a stroke on it does.
 */
const readForEngine = async (
	surface: RasterSurface,
	coverage: MakeAgain['coverage']
): Promise<Read | undefined> => {
	await surface.ready;
	const ctx = surface.canvas.getContext('2d');
	if (ctx === null) return undefined;
	if (!surface.readable()) {
		throw new UnreadablePictureError(`the picture on ${surface.layerId} could not be read`);
	}
	const covered = coverage();
	if (covered === undefined) return undefined;
	const { canvas: cover, box } = covered;
	const hole = holeOf(cover);
	if (hole === undefined || !hole.includes(1)) {
		releaseCanvas(cover);
		return undefined;
	}
	const image = ctx.getImageData(0, 0, surface.canvas.width, surface.canvas.height);
	return { image, cover, hole, box };
};

/**
 * What the engine made laid over the layer, as `surface.rewrite` asks: kept
 * to the coverage, and in `normal` taking the pixels' place in proportion
 * rather than laid over them. Whether a pixel changed.
 */
const madePainter =
	(context: ToolContext, read: Read, made: Uint8ClampedArray, way: Way, words: MakeAgainWords) =>
	(ctx: CanvasRenderingContext2D): boolean => {
		const picture = pictureOf(made, ctx.canvas);
		if (picture === undefined) {
			context.notify(t(words.failed));
			return false;
		}
		const { box, cover } = read;
		const before = ctx.getImageData(box.x, box.y, box.width, box.height).data;
		keepCovered(picture, cover);
		compose(ctx, picture, way, way.composite === 'source-over' ? cover : undefined);
		releaseCanvas(picture);
		return changedSince(ctx, box, before);
	};

/** What the engine made of what it was given; no pixels where it failed or was aborted. */
type Made = Readonly<{ read: Read; pixels: Uint8ClampedArray | undefined }>;

/** The layer read and the covered pixels made again from the rest; none where there was nothing to read. */
const makeAgain = async (
	surface: RasterSurface,
	coverage: MakeAgain['coverage'],
	signal: AbortSignal
): Promise<Made | undefined> => {
	const read = await readForEngine(surface, coverage);
	if (read === undefined) return undefined;
	const { width, height, data } = read.image;
	const pixels = await inpaint({ width, height, data }, read.hole, signal).catch(() => undefined);
	return { read, pixels };
};

/**
 * How many makings again are under way, on any layer: begun, and neither
 * written nor stopped yet.
 */
const underWay = cell(0);

/** Whether the engine is making pixels again for any layer, for a tool that would begin another. */
export const makingAgain = (): boolean => underWay.current > 0;

/**
 * The pixels the coverage reaches made again from the rest of the layer
 * (`inpaint`), and laid over it by the coverage as `way` says. An undo, a
 * redo or another write while the engine works stops it, as Escape and Stop
 * do, and the user is told why; what was made is written by `rewrite`, so an
 * undo that lands while it is encoded rejects it, as layer via copy's
 * `derive` does, and the caller says so.
 */
const makeAgainWith = async (
	context: ToolContext,
	surface: RasterSurface,
	job: MakeAgain,
	way: Way
): Promise<void> => {
	const controller = new AbortController();
	const watch = watchEngine(context, surface, controller, job.words);
	const made = await makeAgain(surface, job.coverage, controller.signal).finally(watch.end);
	if (made === undefined) return;
	const { read, pixels } = made;
	const stopped = watch.stopped() ?? (watch.stale() ? 'changed' : undefined);
	if (stopped !== undefined || pixels === undefined) {
		releaseCanvas(read.cover);
		context.notify(t(job.words[stopped ?? 'failed']));
		return;
	}
	await surface
		.rewrite(job.label, madePainter(context, read, pixels, way, job.words))
		.finally(() => releaseCanvas(read.cover));
};

/** One making again counted while it is under way (`makingAgain`). */
const counted = (work: () => Promise<void>): Promise<void> => {
	underWay.current += 1;
	return work().finally(() => {
		underWay.current -= 1;
	});
};

/** What the engine made taking the pixels' place by the coverage, at full opacity: Remove's way. */
const REPLACING: Way = { composite: 'source-over', opacity: 1, preserve: false };

/**
 * The pixels a coverage reaches on a raster layer made again from the rest of
 * it, and put in their place by the coverage at full opacity, in one command
 * (`job.label`), as Fill…'s Content-Aware does in normal mode at full
 * opacity: the Remove tool's stroke. The status, Stop, Escape and the stale
 * check are Content-Aware's, in `job.words`. Resolves once it is written or
 * has stopped, the user told why it stopped; rejects as `surface.rewrite`
 * does, for the caller to report and the document to wait for before a save.
 */
export const makeAgainUnder = (
	context: ToolContext,
	surface: RasterSurface,
	job: MakeAgain
): Promise<void> => counted(() => makeAgainWith(context, surface, job, REPLACING));

/** The area's coverage of the layer's pixels, for the engine to make again. */
const areaCoverage =
	(surface: RasterSurface, area: Area): MakeAgain['coverage'] =>
	() => {
		const box = areaPixelBox(surface, area);
		const canvas = box === undefined ? undefined : areaMask(surface, area);
		return box === undefined || canvas === undefined ? undefined : { canvas, box };
	};

/**
 * Whether the area on the active layer may be filled, for Fill… to ask
 * before its dialog opens: an area on a raster layer that is neither locked
 * nor hidden. A locked or a hidden layer says so, as the fill itself would.
 */
export const canFillArea = (context: ToolContext): boolean =>
	context.layer?.kind === 'raster' &&
	areaOf(context) !== undefined &&
	guardedLayer(context) !== undefined;

/**
 * The area filled on the active raster layer as `spec` says, by one command
 * (`regions.fill`). Whether this was the area's to do, which it is wherever
 * there is an area on a raster layer, though a locked or a hidden layer says
 * so and keeps its pixels; on a vector layer nothing is filled. The work,
 * which a content-aware fill makes long, is the document's to wait for
 * before a save.
 */
export const fillAreaWith = (context: ToolContext, spec: FillSpec): boolean => {
	if (context.layer?.kind !== 'raster') return false;
	const area = areaOf(context);
	if (area === undefined) return false;
	const surface = guardedSurface(context);
	if (surface === undefined) return true;
	const way: Way = {
		composite: compositeOf(spec.mode),
		opacity: opacityOf(spec.opacity),
		preserve: spec.preserveTransparency,
	};
	// Nothing to lay over at no opacity, and no reason to make the picture again for it.
	if (way.opacity === 0) return true;
	const work =
		spec.contents === 'contentAware'
			? counted(() =>
					makeAgainWith(
						context,
						surface,
						{
							label: 'regions.fill',
							words: FILL_WORDS,
							coverage: areaCoverage(surface, area),
						},
						way
					)
				)
			: surface.paint(
					'regions.fill',
					colorPainter(
						surface,
						area,
						cssOf(parseColor(inkFor(spec, context)) ?? BLACK),
						way
					)
				);
	context.document.pending(
		work.catch((error: unknown) => reportFailure(context, surface, error))
	);
	return true;
};
