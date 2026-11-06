import { layerBelow } from '../../document/clip.js';
import type { LayerInfo } from '../../document/model.js';
import { coverageAt } from '../raster/probe.js';
import type { PointerSample, Tool, ToolContext } from '../types.js';
import type { Measure } from '../vector/measure.js';
import { elementAt, onSelectionHandle } from '../vector/select.js';

/**
 * The move tool's Auto-Select (docs/decisions/0004-the-interface.md), as
 * Photoshop's in its Layer mode: with it on, a press picks the topmost layer
 * that has something under the pointer, the viewport makes it the active
 * layer, and the press goes on as the move tool's on that layer
 * (`Tool.pick`). Ctrl or ⌘ held as the press begins does the other, so with
 * it off they pick for that press, and with it on they keep the active
 * layer, as Photoshop's Ctrl and ⌘ do.
 *
 * The walk is the paint order from the top down, into every group, a group
 * itself never picked, since Layer mode picks the layer; a group is moved
 * whole by choosing it in the panel (`layersMove.ts`). A hidden layer is passed over, and so is every
 * layer of a hidden group. A layer has something under the pointer where it
 * is more than half opaque there, as seen: Photoshop's line, under which its
 * move tool sees through a pixel to the layer below. A vector layer has it
 * where the select tool's own hit finds an element (`elementAt`), a raster
 * layer by the alpha of its pixel there (`coverageAt`); either is times the
 * layer's opacity and its groups', and a layer clipped to the one below
 * (`LayerInfo.clipped`), or in a group clipped so, has paint only where that
 * one has. A mask or a filter of the file's own is not read: a blur that
 * spreads a layer's paint does not spread where it is found.
 *
 * A locked layer is passed over, and so is every layer of a locked group, as
 * a click goes through a locked object in Illustrator and Figma: the press
 * finds what lies under it, which it may move. Photoshop picks a locked layer
 * and then refuses the move, so a locked layer took every press meant for
 * what lay on it or under it. A press over nothing keeps the active layer,
 * and the tool does with it what it does; so does a press on a handle of the
 * box around what is selected, which resizes or rotates that, but for one
 * with several layers chosen, where no box is shown and the press moves the
 * layers (`layersMove.ts`). The viewport keeps the choice where the layer
 * picked is one of them or inside one (`viewport/chosenLayers.ts`).
 */

/** How opaque a layer must be under the pointer, above which it is picked: half, as in Photoshop. */
const SEEN = 0.5;

/**
 * The layer a press with the move tool acts on, where Auto-Select picks one:
 * on with no Ctrl or ⌘, or off with one. `measure` is the select tool's.
 */
export const autoSelect =
	(measure: Measure): NonNullable<Tool['pick']> =>
	(context: ToolContext, sample: PointerSample): LayerInfo | undefined => {
		const point = { x: sample.x, y: sample.y };
		if (context.options.autoSelect === sample.primaryKey) return undefined;
		const several = (context.layers?.length ?? 0) > 1;
		if (!several && onSelectionHandle(measure, context, point)) return undefined;
		const { document } = context;
		const { layers } = document.snapshot();
		const byId = new Map(layers.map((layer) => [layer.id, layer]));

		const parentOf = (layer: LayerInfo): LayerInfo | undefined =>
			layer.parentId === undefined ? undefined : byId.get(layer.parentId);

		/** The layer's own paint here, before its opacity: an element hit, or a pixel's alpha. */
		const ownPaint = (layer: LayerInfo): number => {
			if (layer.kind === 'raster') return coverageAt(document, layer.id, point.x, point.y);
			const element = document.layer(layer.id);
			return element !== undefined &&
				elementAt(measure, element, point, context.viewport.scale) !== undefined
				? 1
				: 0;
		};

		/** How far a clip lets a layer show here: as far as the layer below it has paint. */
		const clipOf = (layer: LayerInfo): number => {
			if (layer.clipped !== true) return 1;
			const below = byId.get(layerBelow(document.root, layer.id)?.getAttribute('id') ?? '');
			return below === undefined ? 0 : paintOf(below);
		};

		/** How opaque a layer is here within its parent: a group as its most opaque layer. */
		const paintOf = (layer: LayerInfo): number => {
			if (layer.hidden) return 0;
			const own =
				layer.kind === 'group'
					? Math.max(
							0,
							...layers.filter((each) => each.parentId === layer.id).map(paintOf)
						)
					: ownPaint(layer);
			return own === 0 ? 0 : own * layer.opacity * clipOf(layer);
		};

		/** What the groups a layer is in let through of it by their opacity: none for a hidden one. */
		const opacityAbove = (layer: LayerInfo): number => {
			const parent = parentOf(layer);
			if (parent === undefined) return 1;
			return parent.hidden ? 0 : parent.opacity * opacityAbove(parent);
		};

		/** Whether a layer is locked, or is in a group that is: passed over, never picked. */
		const isLocked = (layer: LayerInfo): boolean => {
			const parent = parentOf(layer);
			return layer.locked || (parent !== undefined && isLocked(parent));
		};

		/** How far the clips of the groups a layer is in let it show here. */
		const clipsAbove = (layer: LayerInfo): number => {
			const parent = parentOf(layer);
			return parent === undefined ? 1 : clipOf(parent) * clipsAbove(parent);
		};

		/**
		 * How opaque a layer is here as seen, as far as it need be known: no
		 * pixel is read of one too faint to pass at its most opaque, and no clip
		 * above it once its own paint does not pass.
		 */
		const seen = (layer: LayerInfo): number => {
			const above = opacityAbove(layer);
			if (layer.opacity * above <= SEEN) return 0;
			const paint = paintOf(layer) * above;
			return paint <= SEEN ? paint : paint * clipsAbove(layer);
		};

		return [...layers]
			.reverse()
			.find(
				(layer) =>
					layer.kind !== 'group' &&
					!layer.hidden &&
					!isLocked(layer) &&
					seen(layer) > SEEN
			);
	};
