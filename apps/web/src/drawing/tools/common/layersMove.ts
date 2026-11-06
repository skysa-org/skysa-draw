import { cell } from '@skysa/draw-core';

import { t } from '../../../i18n/t.js';
import { attributeCommand, compound } from '../../document/commands.js';
import type { Command, LayerInfo } from '../../document/model.js';
import { layerDisplayName } from '../../layerName.js';
import { moveInParent } from '../raster/space.js';
import type { PointerSample, ToolBehavior, ToolContext } from '../types.js';
import { hideSelection } from '../vector/region.js';

/**
 * The move tool on layers whole (docs/ARCHITECTURE.md §7, "The editor"): the
 * layers chosen in the panel, where more than one is, or a group active
 * alone, moved together by the same distance on the screen, each by its own
 * `transform`, as Photoshop's move tool moves the layers selected in its
 * panel. A layer's move is a translation in front of the transform it had,
 * `translate(dx dy) <original>`, in the units of its parent (`moveInParent`),
 * so a layer in a scaled or turned group goes where the pointer goes, and a
 * layer chosen inside a group chosen too goes with the group and is not
 * moved twice: the viewport gives the outermost (`ToolContext.layers`). A
 * loose element at the root is moved by its own `transform`, which is the
 * layer's, as hiding it writes its own `display`, so nothing is wrapped.
 *
 * The drag sets the attributes live; at its end they are put back and one
 * command sets them all, labeled as the one-layer move is, so one undo puts
 * every layer back; a cancel puts them back and runs nothing. The arrows
 * nudge the same layers by one command each (`nudgeLayers`).
 *
 * A move with a layer that may not move is refused whole, as Photoshop
 * refuses it, and the first such layer, top first, is named in the words a
 * tool's guard uses: one hidden or locked itself, or a locked layer inside a
 * group that moves, which the group would carry along with it.
 *
 * Nothing stays selected among a layer's elements once the layers move: what
 * was is let go of, with its box or its outlines, which the move would leave
 * behind. The area stays, as the canvas's; a raster layer's float ends, as it
 * does whenever the layer's `transform` changes (`raster/move.ts`).
 */

/** Enough places that a move survives a round trip through the file, and no float noise. */
const round = (value: number): number => Number(value.toFixed(3));

/**
 * The original transform with a translation in front of it, in SVG's own
 * words: `translate(dx dy) <original>` applies the original first and the
 * move second. None for no transform at all.
 */
export const translated = (original: string | null, dx: number, dy: number): string | undefined => {
	const kept = original?.trim() ?? '';
	if (dx === 0 && dy === 0) return kept === '' ? undefined : kept;
	const translate = `translate(${round(dx)} ${round(dy)})`;
	return kept === '' ? translate : `${translate} ${kept}`;
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

/** The layers a press or a key moves: the chosen, where there are several, else the active one. */
const movedIds = (context: ToolContext): readonly string[] => {
	const { layers, layer } = context;
	if (layers !== undefined && layers.length > 1) return layers;
	return layer === undefined ? [] : [layer.id];
};

/**
 * Why `ids` may not move, as a tool's guard words it, for the first layer
 * that keeps them, top first: hidden or locked itself, or a locked layer
 * inside one of them; none where every one may.
 */
const refusal = (layers: readonly LayerInfo[], ids: readonly string[]): string | undefined => {
	const byId = new Map(layers.map((layer) => [layer.id, layer]));
	const fromTop = [...layers].reverse();
	const [first] = [...ids].reverse().flatMap((id) => {
		const layer = byId.get(id);
		if (layer === undefined) return [];
		if (layer.locked || layer.hidden) return [layer];
		return fromTop.filter((each) => each.locked && isWithin(byId, each, id));
	});
	if (first === undefined) return undefined;
	const name = layerDisplayName(first, layers.indexOf(first));
	return first.locked ? t('layers.locked', { name }) : t('layers.hidden', { name });
};

/** One layer moved, and its `transform` before the move, or `null` for none. */
type Moved = Readonly<{ id: string; original: string | null }>;

type Moving = Readonly<{ start: Readonly<{ x: number; y: number }>; layers: readonly Moved[] }>;

/**
 * The layers of `ids`, each with its `transform` as it is, where every one
 * may move; otherwise the user is told why, and none.
 */
const takeUp = (context: ToolContext, ids: readonly string[]): readonly Moved[] | undefined => {
	const refused = refusal(context.document.snapshot().layers, ids);
	if (refused !== undefined) {
		context.notify(refused);
		return undefined;
	}
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

/** Each layer's `transform` once moved by `dx` and `dy` in the root's units; one it would not move is left out. */
const finalsOf = (
	context: ToolContext,
	layers: readonly Moved[],
	dx: number,
	dy: number
): readonly Final[] =>
	layers.flatMap(({ id, original }) => {
		const element = context.document.layer(id);
		if (element === undefined) return [];
		const value = movedTransform(element, context.document.root, original, dx, dy);
		return value === translated(original, 0, 0) ? [] : [{ id, value }];
	});

/** Every layer given its `transform` by one command, one step of the history. */
const moveCommand = (finals: readonly Final[]): Command =>
	compound(
		'tools.select',
		finals.map(({ id, value }) =>
			attributeCommand(id, 'tools.select', (_root, layer) => setTransform(layer, value))
		)
	);

// One move tool, so one drag of layers under way, which the arrows' nudge waits for.
const active = cell<Moving | undefined>(undefined);

/** The attributes as they were before the drag, back on the live layers. */
const putBack = (context: ToolContext, moving: Moving): void => {
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

const offsetOf = (moving: Moving, sample: PointerSample): readonly [number, number] => [
	sample.x - moving.start.x,
	sample.y - moving.start.y,
];

export const layersMove: ToolBehavior = {
	begin: (context, sample) => {
		abandon(context);
		const ids = movedIds(context);
		if (ids.length === 0) {
			context.notify(t('layers.noneActive'));
			return;
		}
		const layers = takeUp(context, ids);
		if (layers === undefined) return;
		letGo(context);
		active.current = { start: { x: sample.x, y: sample.y }, layers };
	},
	move: (context, sample) => {
		const moving = active.current;
		if (moving === undefined) return;
		const [dx, dy] = offsetOf(moving, sample);
		const { root } = context.document;
		moving.layers.forEach(({ id, original }) => {
			const element = context.document.layer(id);
			if (element === undefined) return;
			setTransform(element, movedTransform(element, root, original, dx, dy));
		});
	},
	end: (context, sample) => {
		const moving = active.current;
		if (moving === undefined) return;
		active.current = undefined;
		// Back to the originals before the command runs: it keeps each layer's
		// attributes as it finds them, and the live drag was not a change.
		putBack(context, moving);
		const [dx, dy] = offsetOf(moving, sample);
		const finals = finalsOf(context, moving.layers, dx, dy);
		// A click, or a drag back to where it began, moved nothing.
		if (finals.length > 0) context.document.execute(moveCommand(finals));
	},
	cancel: abandon,
};

/**
 * An arrow key with the move tool, where it moves layers whole, which the
 * viewport decides (`viewport/chosenLayers.ts`): the layers `layersMove`
 * moves, each by `dx` and `dy` in the drawing's user units, 1 or 10 with
 * Shift as the caller says, so every one goes the same distance on the
 * screen whatever its own scale, by one command, as a drag does. Whether
 * there was a layer to nudge: a layer that may not move, or a drag under
 * way, takes the key and moves nothing, the first said.
 */
export const nudgeLayers = (context: ToolContext, dx: number, dy: number): boolean => {
	const ids = movedIds(context);
	if (ids.length === 0) return false;
	if (active.current !== undefined) return true;
	const layers = takeUp(context, ids);
	if (layers === undefined) return true;
	const finals = finalsOf(context, layers, dx, dy);
	if (finals.length === 0) return true;
	letGo(context);
	context.document.execute(moveCommand(finals));
	return true;
};
