import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import type { PointerSample, Region, ToolContext } from '../types.js';
import { apply, type Box, invert, type Mat, transformBox, unionBox } from '../vector/geometry.js';
import {
	affineOf,
	type Area,
	areaMask,
	areaOf,
	areaPixelBox,
	eraseCovered,
	holdsColor,
	keepCovered,
	pixelsToScreen,
	reachesSurface,
	releaseCanvas,
	translatePath,
} from './area.js';
import {
	activeLayerName,
	claimScreen,
	clearScreen,
	guardedLayer,
	releaseScreen,
	reportFailure,
} from './guard.js';
import { type Hole, NO_HOLE, showHole } from './hole.js';
import { heldMove, type Point } from './pixels.js';
import { type RasterSurface, surfaceFor } from './surface.js';

/**
 * The move tool over an area on a raster layer (docs/ARCHITECTURE.md §7,
 * "Tools"), as Photoshop's: wherever the drag begins, it moves the area's
 * pixels, each by as much as the area covers it, so a feathered edge takes
 * its share and leaves the rest, and the place they came from is left
 * transparent; Alt held as it begins moves a copy and leaves them; Shift
 * holds the move to a multiple of 45°. The move is in the layer's whole
 * pixels, so nothing is resampled, and the marching ants go with it, the
 * outline's numbers moved by as much in user units (`translatePath`): an
 * inverse moves everything outside its outline, and stays an inverse, so the
 * strip the move leaves at the canvas's edge is selected, and empty.
 *
 * One command a drag (`regions.move`), written through the surface as any
 * pixel edit is, and refused where the file's picture moved while it was
 * encoded (`RasterSurface.rewrite`), since an undo meanwhile put other pixels
 * there. The pixels go wherever the drag takes them, past the layer's pixels
 * and off the drawing's canvas too, which grow to hold them in the same
 * command (`RasterSurface`), so a later drag brings them back whole. The
 * pixels float, as in Photoshop and GIMP: the tool keeps, in
 * memory, what lay beneath them and the pixels themselves, and every drag
 * after the first is drawn from those at the whole way moved, so moving them
 * on gives back what they covered. The file holds the result after every
 * drag; the float is only a memory of what is under it, and it lasts while
 * nothing else has changed the layer or the area. It ends, and the next drag
 * takes up the layer's pixels as they are, when the area is not the one this
 * tool last left (`Region` is replaced, never changed, so a marquee, a
 * feather, a deselect each make another); when the layer's surface is not
 * the one the float was written through, which it is not after an undo or a
 * redo moved the picture under it (`surfaceFor`), or another write was asked
 * of it since (`RasterSurface.writes`), a stroke or a fill; when another
 * layer is active, or the layer's `transform` changed.
 *
 * While the drag lasts, the screen canvas shows the pixels where they are
 * going, and, for a float, what lay beneath where they were; the layer shows
 * the hole they leave through a mask beside the drawing (`hole.ts`), never in
 * it. The screen canvas is over every layer, as a brush stroke's is, so a
 * layer above the one moved is covered where the pixels pass, until they land.
 */

/** A move in the layer's whole pixels. */
type Offset = readonly [number, number];

const NONE: Offset = [0, 0];

const plus = (a: Offset, b: Offset): Offset => [a[0] + b[0], a[1] + b[1]];

const isNone = (offset: Offset): boolean => offset[0] === 0 && offset[1] === 0;

const sameOffset = (a: Offset, b: Offset): boolean => a[0] === b[0] && a[1] === b[1];

const shifted = (box: Box, by: Offset): Box => ({ ...box, x: box.x + by[0], y: box.y + by[1] });

/**
 * The pixels a move took up, and what they leave, placed in the frame of the
 * layer's pixels (`RasterSurface.origin`), which pixels grown left or up do
 * not move.
 */
interface Lift {
	/** Where they were. */
	readonly box: Box;
	/** The area's pixels, by its coverage, the size of `box`. */
	readonly pixels: HTMLCanvasElement;
	/** The area's coverage, the size of `box`. */
	readonly cover: HTMLCanvasElement;
	/** The layer's pixels under them, the whole layer: the rest of each, or, for a copy, all of it. */
	readonly beneath: HTMLCanvasElement;
	/** Where `beneath` is. */
	readonly beneathAt: Box;
	readonly copy: boolean;
}

/** Pixels afloat: what the last drag wrote, and what it was drawn from. */
interface Float {
	readonly surface: RasterSurface;
	readonly layerId: string;
	readonly transform: string | null;
	/** The area as this tool left it: the same object, or the float is over. */
	readonly region: Region;
	/** The surface's writes once this float's was asked: another since, and the float is over. */
	readonly writes: number;
	/** The outline where the pixels were lifted. */
	readonly outline: string;
	readonly lift: Lift;
	/** How far the pixels are from where they were lifted. */
	readonly offset: Offset;
}

interface Drag {
	/** Which stroke this is on the screen canvas; none for a nudge, which shows nothing until it lands. */
	readonly serial: number | undefined;
	readonly surface: RasterSurface;
	readonly layerId: string;
	readonly transform: string | null;
	readonly start: Point;
	/** The area as the drag found it, to put back. */
	readonly region: Region;
	/** What a lift not yet made takes up. */
	readonly area: Area;
	readonly copy: boolean;
	/** The outline where the pixels were lifted, and how far they were from it as the drag began. */
	readonly outline: string;
	readonly from: Offset;
	/** The pixels; none until the layer's picture is decoded. */
	readonly lift: Lift | undefined;
	/** Whether `lift` is the float's, which outlives the drag. */
	readonly floating: boolean;
	/** This drag's own move so far. */
	readonly by: Offset;
	/** For a float, what lay beneath where its pixels were, as far as they cover it. */
	readonly under: HTMLCanvasElement | undefined;
	readonly hole: Hole;
	/** What the screen canvas showed last, in its pixels, to clear. */
	readonly shown: Box | undefined;
}

/** A canvas of `box`'s size holding `source`'s pixels there; none where `box` leaves it. */
const cropOf = (source: HTMLCanvasElement, box: Box): HTMLCanvasElement => {
	const canvas = document.createElement('canvas');
	canvas.width = box.width;
	canvas.height = box.height;
	canvas
		.getContext('2d')
		?.drawImage(source, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);
	return canvas;
};

const releaseLift = (lift: Lift): void => {
	releaseCanvas(lift.pixels);
	releaseCanvas(lift.cover);
	releaseCanvas(lift.beneath);
};

/**
 * The area's pixels taken up from the layer's, by its coverage, and the rest
 * of each pixel left beneath, or all of it for a copy; none where the area
 * holds no color, or the browser cannot draw its mask.
 */
const liftOf = (surface: RasterSurface, area: Area, copy: boolean): Lift | undefined => {
	const box = areaPixelBox(surface, area);
	const mask = box === undefined ? undefined : areaMask(surface, area);
	if (box === undefined || mask === undefined) {
		if (mask !== undefined) releaseCanvas(mask);
		return undefined;
	}
	const { width, height } = surface.canvas;
	const cover = cropOf(mask, box);
	const pixels = cropOf(surface.canvas, box);
	keepCovered(pixels, cover);
	const beneath = cropOf(surface.canvas, { x: 0, y: 0, width, height });
	const ctx = beneath.getContext('2d');
	if (!copy && ctx !== null) eraseCovered(ctx, mask);
	releaseCanvas(mask);
	const [ox, oy] = surface.origin();
	const lift: Lift = {
		box: shifted(box, [0 - ox, 0 - oy]),
		pixels,
		cover,
		beneath,
		beneathAt: { x: 0 - ox, y: 0 - oy, width, height },
		copy,
	};
	const held = pixels.getContext('2d');
	const whole = { x: 0, y: 0, width: box.width, height: box.height };
	if (held !== null && holdsColor(held, whole)) return lift;
	releaseLift(lift);
	return undefined;
};

/** What a move by `offset` writes, in the frame: what lies beneath, and where the pixels go. */
const movedBox = (lift: Lift, offset: Offset): Box =>
	unionBox([lift.beneathAt, shifted(lift.box, offset)]) ?? lift.beneathAt;

/** A box in the frame, in the pixels of the surface's canvas as it is now. */
const onCanvas = (surface: RasterSurface, box: Box): Box => shifted(box, surface.origin());

/**
 * The layer's pixels as the move leaves them, drawn onto `ctx` whole, whose
 * canvas has the frame's first pixel at `origin`: what lies beneath, and the
 * pixels over it at `offset`. Back where they were lifted, a move's pixels
 * and the rest of each it left add up to the pixels as they were
 * (`lighter`), so a feathered edge taken away and put back is whole again;
 * and a copy put back on itself is no copy.
 */
const composite = (
	ctx: CanvasRenderingContext2D,
	lift: Lift,
	offset: Offset,
	origin: Offset
): void => {
	const home = isNone(offset);
	const under = shifted(lift.beneathAt, origin);
	const at = shifted(lift.box, plus(offset, origin));
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.globalAlpha = 1;
	ctx.globalCompositeOperation = 'source-over';
	ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
	ctx.drawImage(lift.beneath, under.x, under.y);
	if (!(home && lift.copy)) {
		ctx.globalCompositeOperation = home ? 'lighter' : 'source-over';
		ctx.drawImage(lift.pixels, at.x, at.y);
	}
	ctx.restore();
};

/**
 * The drag so far as a move in the layer's whole pixels, through the layer's
 * place in the root; Shift holds it to a multiple of 45°.
 */
const stepOf = (surface: RasterSurface, start: Point, sample: PointerSample): Offset => {
	const [dx, dy] = [sample.x - start.x, sample.y - start.y];
	const along = sample.shiftKey ? heldMove(dx, dy) : { x: dx, y: dy };
	const [a, b, c, d] = affineOf(surface.toPixel);
	return [Math.round(a * along.x + c * along.y) || 0, Math.round(b * along.x + d * along.y) || 0];
};

/** The outline where the pixels are at `offset` from where they were lifted. */
const outlineAt = (drag: Pick<Drag, 'surface' | 'outline'>, offset: Offset): string => {
	if (isNone(offset)) return drag.outline;
	const [a, b, c, d] = affineOf(drag.surface.toPixel);
	const units = apply(invert([a, b, c, d, 0, 0]), { x: offset[0], y: offset[1] });
	return translatePath(drag.outline, units.x, units.y);
};

/** The marching ants on `path`, where they are not already. */
const placeOutline = (context: ToolContext, path: string): void => {
	if (context.region.path !== path) context.region.update({ path });
};

/** A box in a canvas's pixels after `matrix`, in whole pixels and one more each way for the edge. */
const screenBox = (matrix: Mat, box: Box): Box => {
	const placed = transformBox(matrix, box);
	const x = Math.floor(placed.x) - 1;
	const y = Math.floor(placed.y) - 1;
	return {
		x,
		y,
		width: Math.ceil(placed.x + placed.width) + 1 - x,
		height: Math.ceil(placed.y + placed.height) + 1 - y,
	};
};

/**
 * The pixels on the screen canvas where the drag has them, through the
 * layer's place in the view, kept to what the layer's pixels can grow to
 * hold, as the write keeps them (`RasterSurface.room`), off the drawing's
 * canvas too; for a float, over what lay beneath where they were. What the
 * last showing covered is cleared, and nothing more, so a stroke still
 * landing keeps its own.
 */
const show = (context: ToolContext, drag: Drag): Drag => {
	const { lift, surface, under } = drag;
	const ctx = context.screen.canvas.getContext('2d');
	if (lift === undefined || ctx === null) return drag;
	const matrix = pixelsToScreen(surface.toPixel, context.screen.toScreen);
	const at = onCanvas(surface, shifted(lift.box, plus(drag.from, drag.by)));
	const was = onCanvas(surface, shifted(lift.box, drag.from));
	const covers = unionBox(under === undefined ? [at] : [at, was]) ?? at;
	const room = surface.room(at, true);
	const [a, b, c, d, e, f] = matrix;
	ctx.save();
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	if (drag.shown !== undefined) {
		ctx.clearRect(drag.shown.x, drag.shown.y, drag.shown.width, drag.shown.height);
	}
	ctx.setTransform(a, b, c, d, e, f);
	ctx.beginPath();
	ctx.rect(room.x, room.y, room.width, room.height);
	ctx.clip();
	if (under !== undefined) ctx.drawImage(under, was.x, was.y);
	ctx.drawImage(lift.pixels, at.x, at.y);
	ctx.restore();
	return { ...drag, shown: screenBox(matrix, covers) };
};

/**
 * What lay beneath a float's pixels at `at`, in the frame, as far as they
 * cover it, for the screen while they move.
 */
const underOf = (lift: Lift, at: Box): HTMLCanvasElement => {
	const canvas = cropOf(lift.beneath, shifted(at, [0 - lift.beneathAt.x, 0 - lift.beneathAt.y]));
	keepCovered(canvas, lift.cover);
	return canvas;
};

/** The live preview carries the layer's opacity, as the pixels will once they land. */
const fadeScreen = (context: ToolContext): void => {
	const opacity = context.layer?.opacity ?? 1;
	if (opacity >= 1) context.screen.canvas.style.removeProperty('opacity');
	else context.screen.canvas.style.setProperty('opacity', String(opacity));
};

/** The move tool's behavior over an area: `begin` says whether the drag is the area's. */
export type AreaMove = Readonly<{
	begin: (context: ToolContext, sample: PointerSample) => boolean;
	move: (context: ToolContext, sample: PointerSample) => void;
	end: (context: ToolContext, sample: PointerSample) => void;
	cancel: (context: ToolContext) => void;
}>;

// One move tool, so one drag under way and one float, which its drags and
// the arrow keys' nudges share.
const active = cell<Drag | undefined>(undefined);
const floating = cell<Float | undefined>(undefined);
// What the last drag left on the screen canvas while its pixels land: the
// next drag clears it as it first shows its own, since the screen is
// cleared whole only when the stroke begun last lands.
const trail = cell<Box | undefined>(undefined);

/** The float replaced, its pixels let go of unless the next one keeps them. */
const setFloat = (next: Float | undefined): void => {
	const old = floating.current;
	floating.current = next;
	if (old !== undefined && old.lift !== next?.lift) releaseLift(old.lift);
};

/** The float there is, where it is still the layer's; any other is over. */
const floatFor = (
	context: ToolContext,
	surface: RasterSurface,
	transform: string | null
): Float | undefined => {
	const float = floating.current;
	if (float === undefined) return undefined;
	const holds =
		float.surface === surface &&
		float.writes === surface.writes() &&
		float.layerId === context.layer?.id &&
		float.region === context.region.region &&
		float.transform === transform;
	if (holds) return float;
	setFloat(undefined);
	return undefined;
};

/**
 * After a drag that wrote nothing: a float's pixels stay afloat, under the
 * area as it now is, and a drag's own are let go of.
 */
const keepOrRelease = (context: ToolContext, drag: Drag): void => {
	if (drag.lift === undefined) return;
	const float = floating.current;
	const region = context.region.region;
	if (drag.floating && float?.lift === drag.lift && region !== undefined) {
		floating.current = { ...float, region };
		return;
	}
	releaseLift(drag.lift);
};

/** The preview taken away, and the ants put back where the drag found them. */
const withdraw = (context: ToolContext, drag: Drag): void => {
	if (drag.serial !== undefined) releaseScreen(context.screen, drag.serial);
	drag.hole.remove();
	if (drag.under !== undefined) releaseCanvas(drag.under);
	placeOutline(context, drag.region.path);
};

/** The pixels taken up once they can be read; said to the user where there are none. */
const lifted = (context: ToolContext, drag: Drag): void => {
	if (!drag.surface.readable()) {
		active.current = undefined;
		withdraw(context, drag);
		context.notify(t('raster.unreadable'));
		return;
	}
	const lift = liftOf(drag.surface, drag.area, drag.copy);
	if (lift === undefined) {
		active.current = undefined;
		withdraw(context, drag);
		context.notify(t('regions.empty', { name: activeLayerName(context) }));
		return;
	}
	const hole = drag.copy
		? NO_HOLE
		: showHole(
				context.document.root,
				drag.layerId,
				drag.surface,
				lift.cover,
				onCanvas(drag.surface, lift.box)
			);
	active.current = show(context, { ...drag, lift, hole });
};

/**
 * The move written: the pixels drawn from what lay beneath them and
 * themselves at the whole way moved, by one command, in the surface's turn;
 * the ants where the pixels are now, and the float kept for the next move.
 * Where it was not written the float is over and the ants go back, unless
 * something moved them since. A drag's preview stays until the pixels land.
 */
const finish = (context: ToolContext, drag: Drag, by: Offset): void => {
	const last = drag.serial === undefined ? { ...drag, by } : show(context, { ...drag, by });
	const total = plus(drag.from, by);
	placeOutline(context, outlineAt(last, total));
	const region = context.region.region;
	const { surface } = drag;
	// Lifted in the surface's turn where the picture was still decoding when
	// the move was made, before the pixels grow to hold where they go.
	const lifting = cell<Lift | undefined>(last.lift);
	const reach = (): Box | undefined => {
		lifting.current = last.lift ?? liftOf(surface, drag.area, drag.copy);
		return lifting.current === undefined
			? undefined
			: onCanvas(surface, movedBox(lifting.current, total));
	};
	const work = surface.rewrite(
		'regions.move',
		(ctx) => {
			const lift = lifting.current;
			if (lift === undefined) {
				context.notify(t('regions.empty', { name: activeLayerName(context) }));
				return false;
			}
			composite(ctx, lift, total, surface.origin());
			if (last.lift === undefined) releaseLift(lift);
			return onCanvas(surface, movedBox(lift, total));
		},
		{ reach, offCanvas: true }
	);
	const float: Float | undefined =
		last.lift === undefined || region === undefined
			? undefined
			: {
					surface,
					layerId: drag.layerId,
					transform: drag.transform,
					region,
					writes: surface.writes(),
					outline: drag.outline,
					lift: last.lift,
					offset: total,
				};
	setFloat(float);
	if (last.shown !== undefined) trail.current = last.shown;
	const landed = (written: boolean): void => {
		if (last.shown !== undefined && trail.current === last.shown) trail.current = undefined;
		if (drag.serial !== undefined) releaseScreen(context.screen, drag.serial);
		last.hole.remove();
		if (last.under !== undefined) releaseCanvas(last.under);
		if (written) return;
		if (float !== undefined && floating.current === float) {
			floating.current = undefined;
			if (active.current?.lift !== float.lift) releaseLift(float.lift);
		}
		if (region !== undefined && context.region.region === region) {
			placeOutline(context, drag.region.path);
		}
	};
	context.document.pending(
		work.then(landed, (error: unknown) => {
			landed(false);
			reportFailure(context, surface, error);
		})
	);
};

/** What a move over the area works on: the layer, its surface and the area; none where it is not the area's. */
type Target = Readonly<{
	layerId: string;
	region: Region;
	area: Area;
	surface: RasterSurface;
	transform: string | null;
	float: Float | undefined;
}>;

/**
 * The active raster layer, the area and the float, where a move is the
 * area's: an area that reaches the layer's pixels, or pixels still afloat
 * (`copy` takes up the pixels as they are, so it needs the area to reach).
 * A layer moved whole needs none of its pixels, so with no area no surface
 * is made.
 */
const targetOf = (context: ToolContext, copy: boolean): Target | undefined => {
	const { layer } = context;
	const region = context.region.region;
	const area = layer?.kind === 'raster' && region !== undefined ? areaOf(context) : undefined;
	const element =
		layer === undefined || area === undefined ? undefined : context.document.layer(layer.id);
	const surface = element === undefined ? undefined : surfaceFor(context);
	if (
		layer === undefined ||
		region === undefined ||
		area === undefined ||
		element === undefined ||
		surface === undefined
	) {
		setFloat(undefined);
		return undefined;
	}
	const transform = element.getAttribute('transform');
	const float = floatFor(context, surface, transform);
	if ((float === undefined || copy) && !reachesSurface(surface, area)) return undefined;
	return { layerId: layer.id, region, area, surface, transform, float };
};

/** A move that has not begun to move, from the float where there is one and it is kept. */
const dragOf = (target: Target, rest: Pick<Drag, 'serial' | 'start' | 'copy' | 'shown'>): Drag => {
	const { float } = target;
	const kept = float !== undefined && !rest.copy;
	return {
		...rest,
		surface: target.surface,
		layerId: target.layerId,
		transform: target.transform,
		region: target.region,
		area: target.area,
		by: NONE,
		outline: kept ? float.outline : target.region.path,
		from: kept ? float.offset : NONE,
		lift: kept ? float.lift : undefined,
		floating: kept,
		under: undefined,
		hole: NO_HOLE,
	};
};

const begin: AreaMove['begin'] = (context, sample) => {
	const copy = sample.altKey;
	const target = targetOf(context, copy);
	if (target === undefined) return false;
	const serial = claimScreen();
	fadeScreen(context);
	const shown = trail.current;
	trail.current = undefined;
	const drag = dragOf(target, { serial, start: { x: sample.x, y: sample.y }, copy, shown });
	if (drag.lift !== undefined) {
		const at = shifted(drag.lift.box, drag.from);
		const hole = showHole(
			context.document.root,
			drag.layerId,
			drag.surface,
			drag.lift.cover,
			onCanvas(drag.surface, at)
		);
		active.current = show(context, { ...drag, under: underOf(drag.lift, at), hole });
		return true;
	}
	// A copy takes up the pixels as they are, the float's among them.
	setFloat(undefined);
	if (target.surface.decoded()) {
		lifted(context, drag);
		return true;
	}
	active.current = drag;
	// Never rejects: a picture that would not decode is said once it is known.
	void target.surface.ready.then(() => {
		const now = active.current;
		if (now?.serial === serial) lifted(context, now);
	});
	return true;
};

const move: AreaMove['move'] = (context, sample) => {
	const drag = active.current;
	if (drag === undefined) return;
	const by = stepOf(drag.surface, drag.start, sample);
	if (sameOffset(by, drag.by)) return;
	const next = { ...drag, by };
	placeOutline(context, outlineAt(next, plus(next.from, by)));
	active.current = show(context, next);
};

const end: AreaMove['end'] = (context, sample) => {
	const drag = active.current;
	if (drag === undefined) return;
	active.current = undefined;
	const by = stepOf(drag.surface, drag.start, sample);
	// A click, or a drag back to where it began, moved nothing.
	if (isNone(by)) {
		withdraw(context, drag);
		keepOrRelease(context, drag);
		return;
	}
	finish(context, drag, by);
};

const cancel: AreaMove['cancel'] = (context) => {
	const drag = active.current;
	active.current = undefined;
	if (drag === undefined) return;
	withdraw(context, drag);
	clearScreen(context.screen);
	keepOrRelease(context, drag);
};

/** The move tool over an area; every one made shares the drag under way and the float. */
export const createAreaMove = (): AreaMove => ({ begin, move, end, cancel });

/**
 * A nudge's move in the layer's whole pixels: `dx` and `dy` are pixels of the
 * layer, whatever the zoom, in the direction they name in the root, so an
 * arrow moves by one of the layer's pixels however large it is drawn.
 */
const nudgeStep = (surface: RasterSurface, dx: number, dy: number): Offset => {
	const [a, b, c, d] = affineOf(surface.toPixel);
	const [px, py] = [a * dx + c * dy, b * dx + d * dy];
	const scale = Math.hypot(dx, dy) / (Math.hypot(px, py) || 1);
	return [Math.round(px * scale) || 0, Math.round(py * scale) || 0];
};

/**
 * An arrow key with the move tool, as Photoshop's: the area's pixels moved by
 * `dx` and `dy` of the layer's pixels (1, or 10 with Shift, as the caller
 * says), from the float where there is one, by one command (`regions.move`),
 * with the ants. For the viewport to call with the move tool active. Whether
 * it was the area's to do: a raster layer with an area that reaches it, or
 * pixels afloat; otherwise the key is the caller's to pass on. A locked or a
 * hidden layer, an area that holds no color, or a drag under way, is the
 * area's and moves nothing; the first two are said. Nudges in a burst land
 * in the order they were made: each is drawn on the layer's pixels in turn
 * as it is asked for, and the surface writes each after the one before,
 * whatever order their encodings finish in.
 */
export const nudgeArea = (context: ToolContext, dx: number, dy: number): boolean => {
	const target = targetOf(context, false);
	if (target === undefined) return false;
	if (active.current !== undefined || guardedLayer(context) === undefined) return true;
	const by = nudgeStep(target.surface, dx, dy);
	if (isNone(by)) return true;
	const drag = dragOf(target, {
		serial: undefined,
		start: { x: 0, y: 0 },
		copy: false,
		shown: undefined,
	});
	if (drag.lift !== undefined || !target.surface.decoded()) {
		finish(context, drag, by);
		return true;
	}
	if (!target.surface.readable()) {
		context.notify(t('raster.unreadable'));
		return true;
	}
	const lift = liftOf(target.surface, target.area, false);
	if (lift === undefined) {
		context.notify(t('regions.empty', { name: activeLayerName(context) }));
		return true;
	}
	setFloat(undefined);
	finish(context, { ...drag, lift }, by);
	return true;
};
