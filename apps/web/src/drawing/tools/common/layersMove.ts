import { cell } from '@skysa/storage';

import { t } from '../../../i18n/t.js';
import { type ClipPreview, keepingClips, previewClips } from '../../document/clip.js';
import { attributeCommand, compound } from '../../document/commands.js';
import type { Command, LayerInfo } from '../../document/model.js';
import { layerDisplayName } from '../../layerName.js';
import { moveInParent } from '../raster/space.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import { hideSelection } from '../vector/region.js';
import type { Offset } from './align.js';
import { heldBy } from './held.js';
import { createDragSnap, type ExtentOf } from './snap.js';

/**
 * The move tool on layers whole (docs/ARCHITECTURE.md §7, "The editor"): the
 * layers chosen in the panel, where more than one is, or a group active
 * alone, moved together by the same distance on the screen, each by its own
 * `transform`, as Photoshop's move tool moves the layers selected in its
 * panel. A layer's move is a translation in front of the transform it had,
 * `translate(dx dy) <original>`, in the units of its parent (`moveInParent`),
 * folded into the translation that transform begins with where it begins
 * with one (`translated`), so a layer in a scaled or turned group goes where
 * the pointer goes, moves made one after another stay one translation, and a
 * layer chosen inside a group chosen too goes with the group and is not
 * moved twice: the viewport gives the outermost (`ToolContext.layers`). A
 * loose element at the root is moved by its own `transform`, which is the
 * layer's, as hiding it writes its own `display`, so nothing is wrapped.
 *
 * The drag sets the attributes live; at its end they are put back and one
 * command sets them all, labeled as the one-layer move is, so one undo puts
 * every layer back; a cancel puts them back and runs nothing. The arrows
 * nudge the same layers by one command each (`nudgeLayers`), as they nudge
 * the active layer alone where nothing is selected on it; the options bar's
 * alignment (`align.ts`) moves them too, each by a distance of its own, by
 * one command (`moveLayersBy`). The drag snaps what the layers
 * paint to the canvas and to the other layers (`snap.ts`); the nudge does
 * not, as Photoshop's does not.
 *
 * A clipped layer moves over the layer below and its clip stays where that
 * layer is, as Photoshop's does: the command keeps the clip's `<use>` the
 * inverse of the layer's new `transform` (`keepingClips`, `document/clip.ts`),
 * and the drag keeps it so as it goes (`previewClips`).
 *
 * A move with a layer that may not move is refused whole, as Photoshop
 * refuses it, and the first such layer, top first, is named in the words a
 * tool's guard uses: one hidden or locked, itself or by a group around it,
 * which is named, or a locked layer inside a group that moves, which the
 * group would carry along with it.
 *
 * Nothing stays selected among a layer's elements once the layers move: what
 * was is let go of, with its box or its outlines, which the move would leave
 * behind. The area stays, as the canvas's; a raster layer's float ends, as it
 * does whenever the layer's `transform` changes (`raster/move.ts`).
 */

/** Enough places that a move survives a round trip through the file, and no float noise. */
const round = (value: number): number => Number(value.toFixed(3));

/** A number as a transform list writes one. */
const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?`;

/**
 * A transform list that begins with a translation: its x, its y where it
 * gives one, and the comma or the spaces after it, which part it from the
 * rest.
 */
const LEADING_TRANSLATE = new RegExp(
	String.raw`^translate\s*\(\s*(${NUMBER})(?:\s*,?\s*(${NUMBER}))?\s*\)\s*,?\s*`
);

/** The translation a transform list begins with, a y of 0 where it gives none, and what follows it; none where it begins with another. */
const leadingTranslate = (
	kept: string
): Readonly<{ x: number; y: number; rest: string }> | undefined => {
	const match = LEADING_TRANSLATE.exec(kept);
	if (match === null) return undefined;
	return { x: Number(match[1]), y: Number(match[2] ?? 0), rest: kept.slice(match[0].length) };
};

/**
 * The original transform with a translation in front of it, in SVG's own
 * words: `translate(dx dy) <original>` applies the original first and the
 * move second. Where the original begins with a translation already, the
 * move is folded into it, `translate(a+dx b+dy) <rest>`, which is the same
 * transform, since both are in the parent's units and come before the rest,
 * so moves made one after another do not pile up. A translation that folds
 * to nothing is left out. None for no transform at all.
 */
export const translated = (original: string | null, dx: number, dy: number): string | undefined => {
	const kept = original?.trim() ?? '';
	if (dx === 0 && dy === 0) return kept === '' ? undefined : kept;
	const leading = leadingTranslate(kept);
	const x = round((leading?.x ?? 0) + dx);
	const y = round((leading?.y ?? 0) + dy);
	const rest = leading?.rest ?? kept;
	if (x === 0 && y === 0) return rest === '' ? undefined : rest;
	const translate = `translate(${x} ${y})`;
	return rest === '' ? translate : `${translate} ${rest}`;
};

/** A layer's `transform` set, or taken off for none. */
export const setTransform = (element: Element, value: string | null | undefined): void => {
	if (value === undefined || value === null) element.removeAttribute('transform');
	else element.setAttribute('transform', value);
};

/**
 * The `transform` that moves the layer `element` by `dx` and `dy` in the
 * root's user units from where `original` put it: the move in its parent's
 * units, rounded, in front of the original.
 */
export const movedTransform = (
	element: SVGGraphicsElement,
	root: SVGSVGElement,
	original: string | null,
	dx: number,
	dy: number
): string | undefined => {
	const [x, y] = moveInParent(element, root, dx, dy);
	return translated(original, round(x), round(y));
};

/** Whether `layer` is inside the group `id`, at any depth. */
const isWithin = (byId: ReadonlyMap<string, LayerInfo>, layer: LayerInfo, id: string): boolean => {
	if (layer.parentId === undefined) return false;
	const parent = byId.get(layer.parentId);
	return layer.parentId === id || (parent !== undefined && isWithin(byId, parent, id));
};

/**
 * Whether the layer `id` moves with the layers `chosen`: it is one of them,
 * or it is inside a group that is. Auto-select's press on such a layer keeps
 * the choice, where there are several, and moves them all.
 */
export const movesWith = (
	layers: readonly LayerInfo[],
	chosen: readonly string[],
	id: string
): boolean => {
	const byId = new Map(layers.map((layer) => [layer.id, layer]));
	const layer = byId.get(id);
	return (
		chosen.includes(id) ||
		(layer !== undefined && chosen.some((each) => isWithin(byId, layer, each)))
	);
};

/**
 * The layers a press, a key or an alignment moves: the chosen, where there
 * are several, else the active one.
 */
export const movedIds = (context: ToolContext): readonly string[] => {
	const { layers, layer } = context;
	if (layers !== undefined && layers.length > 1) return layers;
	return layer === undefined ? [] : [layer.id];
};

/**
 * Why `ids` may not move, as a tool's guard words it, for the first layer
 * that keeps them, top first: hidden or locked, itself or by a group around
 * it (`heldBy`), or a locked layer inside one of them; none where every one
 * may.
 */
const refusal = (layers: readonly LayerInfo[], ids: readonly string[]): string | undefined => {
	const byId = new Map(layers.map((layer) => [layer.id, layer]));
	const fromTop = [...layers].reverse();
	const [first] = [...ids].reverse().flatMap((id) => {
		const layer = byId.get(id);
		if (layer === undefined) return [];
		const held = heldBy(layers, layer);
		if (held !== undefined) return [held];
		return fromTop
			.filter((each) => each.locked && isWithin(byId, each, id))
			.map((each) =>
				t('layers.locked', { name: layerDisplayName(each, layers.indexOf(each)) })
			);
	});
	return first;
};

/** One layer moved, and its `transform` before the move, or `null` for none. */
type Moved = Readonly<{ id: string; original: string | null }>;

type Moving = Readonly<{
	start: Readonly<{ x: number; y: number }>;
	layers: readonly Moved[];
	/** The clips of the layers moved, kept as the drag goes (`previewClips`). */
	clips: ClipPreview;
}>;

/** Whether every layer of `ids` may move; where one may not, the user is told why. */
export const mayMove = (context: ToolContext, ids: readonly string[]): boolean => {
	const refused = refusal(context.document.snapshot().layers, ids);
	if (refused !== undefined) context.notify(refused);
	return refused === undefined;
};

/**
 * The layers of `ids`, each with its `transform` as it is, where every one
 * may move; otherwise the user is told why, and none.
 */
const takeUp = (context: ToolContext, ids: readonly string[]): readonly Moved[] | undefined => {
	if (!mayMove(context, ids)) return undefined;
	return ids.flatMap((id) => {
		const element = context.document.layer(id);
		return element === undefined ? [] : [{ id, original: element.getAttribute('transform') }];
	});
};

/** What is selected among the elements let go of, with what shows it, which the move would leave behind. */
const letGo = (context: ToolContext): void => {
	context.selection.clear();
	hideSelection(context.overlay);
};

type Final = Readonly<{ id: string; value: string | undefined }>;

/**
 * The layer `id`'s `transform` once moved by `dx` and `dy` in the root's
 * units from `original`; none for a layer that is not there, or that it
 * would not move.
 */
const finalOf = (
	context: ToolContext,
	id: string,
	original: string | null,
	dx: number,
	dy: number
): readonly Final[] => {
	const element = context.document.layer(id);
	if (element === undefined) return [];
	const value = movedTransform(element, context.document.root, original, dx, dy);
	return value === translated(original, 0, 0) ? [] : [{ id, value }];
};

/** Each layer's `transform` once moved by `dx` and `dy` in the root's units; one it would not move is left out. */
const finalsOf = (
	context: ToolContext,
	layers: readonly Moved[],
	dx: number,
	dy: number
): readonly Final[] => layers.flatMap(({ id, original }) => finalOf(context, id, original, dx, dy));

/**
 * Every layer given its `transform` by one command labeled `label`, one step
 * of the history, each clip of a layer moved kept with it (`keepingClips`),
 * so the clip's shape stays where the layer below is.
 */
const moveCommand = (finals: readonly Final[], label = 'tools.select'): Command =>
	keepingClips(
		compound(
			label,
			finals.map(({ id, value }) =>
				attributeCommand(id, label, (_root, layer) => setTransform(layer, value))
			)
		)
	);

// One move tool, so one drag of layers under way, which the arrows' nudge waits for.
const active = cell<Moving | undefined>(undefined);

/** Whether a drag of layers is under way, which a nudge and an alignment wait for. */
export const draggingLayers = (): boolean => active.current !== undefined;

/** One layer's own move, by `dx` and `dy` in the root's user units. */
export type LayerMove = Readonly<{ id: string; dx: number; dy: number }>;

/**
 * Each layer of `moves` moved by its own distance from where it is now, in
 * front of its own `transform` as a drag moves it, by one command labeled
 * `label`, so one undo puts every one back; what was selected among the
 * elements is let go of first. A layer that is not there, or that its move
 * would not move, is left out, and with none left nothing runs. Whether
 * anything moved. Whether the layers may move at all is the caller's to ask
 * (`mayMove`).
 */
export const moveLayersBy = (
	context: ToolContext,
	moves: readonly LayerMove[],
	label: string
): boolean => {
	const finals = moves.flatMap(({ id, dx, dy }) =>
		finalOf(context, id, context.document.layer(id)?.getAttribute('transform') ?? null, dx, dy)
	);
	if (finals.length === 0) return false;
	letGo(context);
	context.document.execute(moveCommand(finals, label));
	return true;
};

/** The attributes as they were before the drag, back on the live layers and their clips. */
const putBack = (context: ToolContext, moving: Moving): void => {
	moving.clips.putBack();
	moving.layers.forEach(({ id, original }) => {
		const element = context.document.layer(id);
		if (element !== undefined) setTransform(element, original);
	});
};

/** The drag under way, if any, abandoned: its layers put back. */
const abandon = (context: ToolContext): void => {
	const moving = active.current;
	active.current = undefined;
	if (moving !== undefined) putBack(context, moving);
};

const offsetOf = (moving: Moving, sample: PointerSample): Offset => [
	sample.x - moving.start.x,
	sample.y - moving.start.y,
];

/**
 * The move of layers whole, snapping as it drags (`snap.ts`): what moves is
 * what the layers paint together, measured by `extentOf`, the browser's
 * where none is given, and the end's command moves them by the offset
 * snapped as the last step was.
 */
export const createLayersMove = (extentOf?: ExtentOf): ToolBehavior => {
	const snap = createDragSnap(extentOf);
	const abandonDrag = (context: ToolContext): void => {
		snap.cancel(context);
		abandon(context);
	};
	return {
		begin: (context, sample) => {
			abandonDrag(context);
			const ids = movedIds(context);
			if (ids.length === 0) {
				context.notify(t('layers.noneActive'));
				return;
			}
			const layers = takeUp(context, ids);
			if (layers === undefined) return;
			letGo(context);
			active.current = {
				start: { x: sample.x, y: sample.y },
				layers,
				clips: previewClips(context.document.root),
			};
			snap.beginLayers(
				context,
				layers.map(({ id }) => id)
			);
		},
		move: (context, sample) => {
			const moving = active.current;
			if (moving === undefined) return;
			const [dx, dy] = snap.move(context, sample, offsetOf(moving, sample));
			const { root } = context.document;
			moving.layers.forEach(({ id, original }) => {
				const element = context.document.layer(id);
				if (element === undefined) return;
				setTransform(element, movedTransform(element, root, original, dx, dy));
			});
			moving.clips.follow();
		},
		end: (context, sample) => {
			const moving = active.current;
			if (moving === undefined) return;
			active.current = undefined;
			const [dx, dy] = snap.end(context, sample, offsetOf(moving, sample));
			// Back to the originals before the command runs: it keeps each layer's
			// attributes as it finds them, and the live drag was not a change.
			putBack(context, moving);
			const finals = finalsOf(context, moving.layers, dx, dy);
			// A click, or a drag back to where it began, moved nothing.
			if (finals.length > 0) context.document.execute(moveCommand(finals));
		},
		cancel: abandonDrag,
	};
};

export const layersMove: ToolBehavior = createLayersMove();

/**
 * An arrow key with the move tool, where it moves layers whole, which the
 * viewport decides (`viewport/chosenLayers.ts`): the layers `layersMove`
 * moves, or the active layer alone where nothing is selected on it, as
 * Photoshop's move tool moves the layer, each by `dx` and `dy` in the
 * drawing's user units, 1 or 10 with Shift as the caller says, so every one
 * goes the same distance on the screen whatever its own scale, by one
 * command, as a drag does. Whether there was a layer to nudge: a layer that
 * may not move, or a drag under way, takes the key and moves nothing, the
 * first said.
 */
export const nudgeLayers = (context: ToolContext, dx: number, dy: number): boolean => {
	const ids = movedIds(context);
	if (ids.length === 0) return false;
	if (draggingLayers() || !mayMove(context, ids)) return true;
	moveLayersBy(
		context,
		ids.map((id) => ({ id, dx, dy })),
		'tools.select'
	);
	return true;
};
