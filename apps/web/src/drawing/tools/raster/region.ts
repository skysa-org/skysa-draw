import { type Cell, cell, SVG_NAMESPACE } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import {
	compound,
	duplicateLayer,
	replaceRasterImage,
	setLayerLocked,
} from '../../document/commands.js';
import type { Command } from '../../document/model.js';
import type { PointerSample, ToolBehavior, ToolContext, ToolOptions } from '../types.js';
import { type Box, constrainRect, type Point, rectFrom, simplify } from '../vector/geometry.js';
import {
	addToArea,
	type Area,
	areaHolds,
	areaMask,
	areaOf,
	areaPixelBox,
	eraseCovered,
	holdsColor,
	keepCovered,
	polygonPath,
	rectPath,
	releaseCanvas,
	translatePath,
} from './area.js';
import { fillAreaWith } from './areaFill.js';
import { activeLayerName, guardedLayer, guardedSurface, reportFailure } from './guard.js';
import { heldMove } from './pixels.js';
import { type RasterSurface, surfaceFor } from './surface.js';

/**
 * The marquee and the lasso (docs/decisions/0004-the-interface.md: "Select
 * pixels in a region" on a raster layer, "Select elements in a region" on a
 * vector one), and Delete with an area selected. One drag makes the area for
 * both kinds of layer, with a preview on the overlay: the marquee a rectangle
 * from corner to corner, kept square by the constrain option and drawn from
 * its center with Alt; the lasso a freehand outline, closed where the pointer
 * lifts and simplified by Ramer–Douglas–Peucker (`simplify`). What the area
 * then is, is the layer's: on a raster layer it is set (`ToolContext.region`)
 * and outlives the tool, and the raster tools paint inside it; on a vector
 * layer it selects elements (`tools/vector/region.ts`).
 *
 * Shift held as the drag begins adds the new area to the one there, as a
 * second subpath, which under `nonzero` is the union of the two
 * (`addToArea`), and keeps its feather. Subtracting with Alt, as Photoshop
 * does, would take the difference of two arbitrary paths, which no fill rule
 * gives; it is not here, and Alt is the marquee's from-the-center at any
 * time. For the same reason Shift on an inverted area starts a new one:
 * Photoshop adds the new outline to what is selected, which for an inverse
 * is the outline there less the new one, a difference again; and making the
 * new outline part of the hole would take away what Shift was asked to add.
 * Shift pressed after the drag began keeps the marquee square, unless it
 * began the drag: that Shift is adding.
 *
 * On a raster layer a drag that begins inside the area, with neither Shift
 * nor Alt, moves its outline and nothing else, as Photoshop's selection
 * tools do: the outline's numbers moved with the pointer (`translatePath`),
 * Shift during the drag holding it to a multiple of 45°, the area still
 * inverted or feathered as it was. Inside is where the marching ants say:
 * within the outline under `nonzero`, or for an inverse on the canvas and
 * outside it (`areaHolds`). A click there drops the area, as a click
 * anywhere does; a drag that begins outside it makes a new one.
 */

type AreaKind = 'marquee' | 'lasso';

interface Drag {
	readonly start: Point;
	/** The lasso's points so far; the marquee needs only where it began. */
	readonly points: readonly Point[];
	/** Whether Shift was held as the drag began: the area made is added to the one there. */
	readonly adding: boolean;
	readonly preview: Element;
}

/** What a drag that ended does with the area it made: none for a click. */
type AreaMade = (context: ToolContext, path: string | undefined, adding: boolean) => void;

/** A drag shorter than this on screen, in CSS pixels, either way, was a click. */
const CLICK_PX = 3;

/** How far a lasso's point may stray from the line its neighbors make and be let go, in CSS pixels. */
const LASSO_SLACK_PX = 0.5;

const pointOf = (sample: PointerSample): Point => ({ x: sample.x, y: sample.y });

/** The marquee's rectangle, from where the drag began to the pointer. */
const marqueeBox = (
	start: Point,
	sample: PointerSample,
	options: ToolOptions,
	adding: boolean
): Box => {
	const square = options.constrain || (sample.shiftKey && !adding);
	const end = constrainRect(start, pointOf(sample), square);
	if (!sample.altKey) return rectFrom(start, end);
	const dx = Math.abs(end.x - start.x);
	const dy = Math.abs(end.y - start.y);
	return { x: start.x - dx, y: start.y - dy, width: 2 * dx, height: 2 * dy };
};

/** The longer side of the box around the points: how far the drag went either way. */
const extentOf = (points: readonly Point[]): number => {
	const xs = points.map((p) => p.x);
	const ys = points.map((p) => p.y);
	return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
};

/** The lasso's outline so far, open: it closes where the pointer lifts. */
const lassoPreview = (points: readonly Point[]): string => {
	const [first, ...rest] = points;
	if (first === undefined) return '';
	return `M ${first.x} ${first.y} ${rest.map((p) => `L ${p.x} ${p.y}`).join(' ')}`;
};

/** Screen pixels per user unit, never nothing. */
const scaleOf = (context: ToolContext): number =>
	context.viewport.scale > 0 ? context.viewport.scale : 1;

/** The closed path the drag made, in user units; none for a click, or an outline with no inside. */
const madeBy = (
	kind: AreaKind,
	drag: Drag,
	sample: PointerSample,
	context: ToolContext
): string | undefined => {
	const scale = scaleOf(context);
	if (kind === 'marquee') {
		const box = marqueeBox(drag.start, sample, context.options, drag.adding);
		if (Math.max(box.width, box.height) * scale < CLICK_PX) return undefined;
		return rectPath(box);
	}
	const points = [...drag.points, pointOf(sample)];
	if (extentOf(points) * scale < CLICK_PX) return undefined;
	return polygonPath(simplify(points, LASSO_SLACK_PX / scale));
};

/** The preview's outline for the drag so far. */
const previewOf = (
	kind: AreaKind,
	drag: Drag,
	sample: PointerSample,
	context: ToolContext
): string =>
	kind === 'marquee'
		? (rectPath(marqueeBox(drag.start, sample, context.options, drag.adding)) ?? '')
		: lassoPreview(drag.points);

/**
 * A drag that makes an area, for either kind of layer: `made` is told what it
 * made when it ends, and `allowed`, where given, says at its start whether
 * the layer may be worked on at all.
 */
export const areaDrag = (
	kind: AreaKind,
	made: AreaMade,
	allowed: (context: ToolContext) => boolean = () => true
): ToolBehavior => {
	const active = cell<Drag | undefined>(undefined);

	const cancel = (): void => {
		active.current?.preview.remove();
		active.current = undefined;
	};

	return {
		begin: (context, sample) => {
			cancel();
			if (!allowed(context)) return;
			const preview = context.overlay.ownerDocument.createElementNS(SVG_NAMESPACE, 'path');
			preview.setAttribute('class', 'viewport-area-drag');
			preview.setAttribute('fill-rule', 'nonzero');
			preview.setAttribute('vector-effect', 'non-scaling-stroke');
			preview.setAttribute('pointer-events', 'none');
			context.overlay.appendChild(preview);
			const start = pointOf(sample);
			active.current = { start, points: [start], adding: sample.shiftKey, preview };
		},
		move: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			const next =
				kind === 'lasso' ? { ...drag, points: [...drag.points, pointOf(sample)] } : drag;
			active.current = next;
			next.preview.setAttribute('d', previewOf(kind, next, sample, context));
		},
		end: (context, sample) => {
			const drag = active.current;
			if (drag === undefined) return;
			active.current = undefined;
			drag.preview.remove();
			made(context, madeBy(kind, drag, sample, context), drag.adding);
		},
		cancel,
	};
};

/** A drag of the area's outline: where it began, the outline then, and whether it went past a click. */
interface OutlineDrag {
	readonly start: Point;
	readonly path: string;
	readonly moved: boolean;
}

/** The outline moved as far as the pointer has, Shift holding it to a multiple of 45°. */
const outlineMoved = (drag: OutlineDrag, sample: PointerSample): string => {
	const [dx, dy] = [sample.x - drag.start.x, sample.y - drag.start.y];
	const by = sample.shiftKey ? heldMove(dx, dy) : { x: dx, y: dy };
	return translatePath(drag.path, by.x, by.y);
};

/**
 * An area a tool made, set: with `adding`, Shift held as it began, added to
 * the area there, keeping its feather; without it, or over an inverted area,
 * a new plain one. Nothing made drops the area, unless it was adding. The
 * marquee's and the lasso's, and the magic wand's (`wand.ts`).
 */
export const selectArea: AreaMade = (context, path, adding) => {
	if (path === undefined) {
		if (!adding) context.region.set(undefined);
		return;
	}
	const there = context.region.region;
	if (adding && there !== undefined && !there.inverted) {
		context.region.update({ path: addToArea(there.path, path) });
		return;
	}
	context.region.set(path);
};

/**
 * On a raster layer the area is set, and outlives the tool: a click with
 * nothing added drops it, as in every editor, and Shift adds to it, keeping
 * its feather; a new area without Shift, or with it over an inverted one, is
 * plain (`selectArea`); a drag from inside it moves its outline. Making or
 * moving an area changes no pixel, so a locked or a hidden layer may have one.
 */
export const regionBehavior = (kind: AreaKind): ToolBehavior => {
	const making = areaDrag(kind, selectArea);
	const outline = cell<OutlineDrag | undefined>(undefined);

	const place = (context: ToolContext, path: string): void => {
		if (context.region.path !== path) context.region.update({ path });
	};

	return {
		begin: (context, sample) => {
			outline.current = undefined;
			const area = sample.shiftKey || sample.altKey ? undefined : areaOf(context);
			if (area === undefined || !areaHolds(area, pointOf(sample))) {
				making.begin(context, sample);
				return;
			}
			making.cancel(context);
			outline.current = { start: pointOf(sample), path: area.path, moved: false };
		},
		move: (context, sample) => {
			const drag = outline.current;
			if (drag === undefined) {
				making.move(context, sample);
				return;
			}
			const far =
				Math.max(Math.abs(sample.x - drag.start.x), Math.abs(sample.y - drag.start.y)) *
				scaleOf(context);
			const next = drag.moved || far < CLICK_PX ? drag : { ...drag, moved: true };
			outline.current = next;
			place(context, outlineMoved(next, sample));
		},
		end: (context, sample) => {
			const drag = outline.current;
			if (drag === undefined) {
				making.end(context, sample);
				return;
			}
			outline.current = undefined;
			if (drag.moved) place(context, outlineMoved(drag, sample));
			else context.region.set(undefined);
		},
		cancel: (context) => {
			const drag = outline.current;
			outline.current = undefined;
			if (drag === undefined) making.cancel(context);
			else place(context, drag.path);
		},
	};
};

/** The active layer, where it is a raster layer, with the area there is on it; none otherwise. */
const rasterArea = (context: ToolContext): Area | undefined =>
	context.layer?.kind === 'raster' ? areaOf(context) : undefined;

/**
 * What Delete does with an area selected on a raster layer: the layer's
 * pixels taken away by as much as the area covers each, by one command
 * (`regions.clear`), so a feathered clear fades and an inverse clears all
 * but the outline's inside; none written where none it covers had any
 * color. Whether Delete was this one's: it is wherever there is an area on
 * a raster layer, though a locked or a hidden layer says so and keeps its
 * pixels.
 */
export const clearArea = (context: ToolContext): boolean => {
	const area = rasterArea(context);
	if (area === undefined) return false;
	const surface = guardedSurface(context);
	if (surface === undefined) return true;
	const work = surface
		.paint('regions.clear', (ctx) => {
			const box = areaPixelBox(surface, area);
			const mask = box === undefined ? undefined : areaMask(surface, area);
			if (box === undefined || mask === undefined) return false;
			const cleared = holdsColor(ctx, box, mask);
			if (cleared) eraseCovered(ctx, mask);
			releaseCanvas(mask);
			return cleared;
		})
		.catch((error: unknown) => reportFailure(context, surface, error));
	context.document.pending(work);
	return true;
};

/**
 * The area filled with the fill color on the active raster layer, by one
 * command (`regions.fill`): Alt+Backspace, which is Fill… with the fill
 * color in normal at full opacity (`fillAreaWith`), so the two cannot drift.
 * Laid over the layer's pixels by as much as the area covers each, so a
 * feathered fill fades at its edge and an inverse fills the canvas outside
 * the outline; the color is the one the fill tool pours, the stroke's where
 * the fill is none. A fill that changed no pixel writes nothing. Whether
 * this was the area's to do, which it is wherever there is an area on a
 * raster layer, though a locked or a hidden layer says so and keeps its
 * pixels.
 */
export const fillArea = (context: ToolContext): boolean =>
	fillAreaWith(context, {
		contents: 'fill',
		mode: 'normal',
		opacity: 1,
		preserveTransparency: false,
	});

/** The layer's pixels as far as the mask covers them, on a canvas of their own. */
const coveredCopy = (
	surface: RasterSurface,
	mask: HTMLCanvasElement
): HTMLCanvasElement | undefined => {
	const canvas = document.createElement('canvas');
	canvas.width = surface.canvas.width;
	canvas.height = surface.canvas.height;
	const ctx = canvas.getContext('2d');
	if (ctx === null) return undefined;
	ctx.drawImage(surface.canvas, 0, 0);
	keepCovered(canvas, mask);
	return canvas;
};

type Via = 'copy' | 'cut';

const VIA_LABELS: Readonly<Record<Via, string>> = {
	copy: 'regions.viaCopy',
	cut: 'regions.viaCut',
};

/**
 * Layer via copy or cut, as one step: the layer duplicated just above
 * itself (`duplicateLayer`), so the copy has its transform, its look and the
 * `<image>`'s box; the copy's picture replaced by the area's pixels, at the
 * same box and so the same pixel size; a copy of a locked layer unlocked,
 * since it is new; and for a cut the layer's own picture replaced by what
 * is left. Undo takes it all back at once, to the bytes. The copy's id is
 * chosen now, when it is executed.
 */
const viaCommand = (
	context: ToolContext,
	surface: RasterSurface,
	how: Via,
	made: Cell<string | undefined>
): ((picture: string, own: string | undefined) => Command) => {
	const label = VIA_LABELS[how];
	const sourceId = surface.layerId;
	const unlock = context.layer?.locked === true;
	return (picture, own) => {
		const duplicate = duplicateLayer(context.document.root, sourceId);
		made.current = duplicate.id;
		return compound(label, [
			duplicate,
			replaceRasterImage(duplicate.id, label, { href: picture, ...surface.bounds }),
			...(unlock ? [setLayerLocked(duplicate.id, false)] : []),
			...(own === undefined
				? []
				: [replaceRasterImage(sourceId, label, { href: own, ...surface.bounds })]),
		]);
	};
};

/**
 * Layer via copy and layer via cut, on a raster layer: the area's pixels of
 * the active layer, by as much as the area covers each, so a feathered edge
 * keeps its partial alpha and an inverse takes the canvas outside the
 * outline, made a new raster layer directly above it, in exactly its place;
 * a cut takes them from the layer by the same coverage, in the same command
 * (`regions.viaCopy`, `regions.viaCut`). A copy reads a locked layer, and a
 * cut does not change one; neither reads a hidden one.
 *
 * None where it is not the area's to do (no area, not a raster layer); else
 * the work, which the document waits on, settling on the new layer's id for
 * the caller to make active and drop the area, or on none where nothing was
 * made: a locked layer for a cut, a hidden layer, an area that holds no
 * color, each said to the user here, or a failure, said too.
 */
export const layerViaArea = (
	context: ToolContext,
	how: Via
): Promise<string | undefined> | undefined => {
	const area = rasterArea(context);
	if (area === undefined) return undefined;
	const allowed = guardedLayer(context, how === 'cut' ? 'change' : 'read');
	const surface = allowed === undefined ? undefined : surfaceFor(context);
	if (surface === undefined) return Promise.resolve(undefined);
	const made = cell<string | undefined>(undefined);
	const work = surface
		.derive((ctx) => {
			const box = areaPixelBox(surface, area);
			const mask = box === undefined ? undefined : areaMask(surface, area);
			const picture = mask === undefined ? undefined : coveredCopy(surface, mask);
			const pictureCtx = picture?.getContext('2d') ?? null;
			if (
				box === undefined ||
				mask === undefined ||
				picture === undefined ||
				pictureCtx === null ||
				!holdsColor(pictureCtx, box)
			) {
				if (mask !== undefined) releaseCanvas(mask);
				context.notify(t('regions.empty', { name: activeLayerName(context) }));
				return undefined;
			}
			if (how === 'cut') eraseCovered(ctx, mask);
			releaseCanvas(mask);
			return {
				picture,
				changed: how === 'cut',
				command: viaCommand(context, surface, how, made),
			};
		})
		.then(
			(landed) => (landed ? made.current : undefined),
			(error: unknown) => {
				reportFailure(context, surface, error);
				return undefined;
			}
		);
	context.document.pending(work);
	return work;
};
