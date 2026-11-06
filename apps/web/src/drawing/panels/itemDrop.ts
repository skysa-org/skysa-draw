import type { ElementPlace } from '../document/elements.js';
import type { RowDrop } from './LayerRow.js';

/**
 * Where a vector layer's items dragged in the layers panel would land
 * (docs/ARCHITECTURE.md §7, "The interface"), as a place among a vector
 * layer's elements (`ElementPlace`, `document/elements.ts`). Pure, over the
 * panel's rows top first; the panel measures the rows and draws what this
 * says, as `layerDrop.ts` is for layers.
 *
 * Items land among the items of a layer that takes them, a vector layer that
 * is a `<g>` and is not held, locked or hidden, itself or by a group
 * (`isLayerHeld`): their own layer, or another. Over one of its items' rows
 * the upper half is the gap over that row, which in paint order is above that
 * element, and the lower half the gap under it, below the element. Over the
 * layer's own row is on top of its elements, the row lit as a group's is for
 * into it: the way to a layer shown collapsed, or to one of a single element,
 * which has no items' rows. Anywhere else is no place: a raster layer's row,
 * a group's, a held or a loose layer's, and past the rows, since a gap
 * between layers is a place for layers, not elements. Whether a place can be
 * had at all, and would move anything, is `canMoveElements`'s to say.
 */

/** A row as the drop reads it: a layer's, with how many elements it holds, or an item's, with its position among them. */
export type ItemDropRow = Readonly<{
	layerId: string;
	/** Whether its layer takes items: a vector `<g>` not held. */
	takesItems: boolean;
}> &
	(Readonly<{ kind: 'layer'; count: number }> | Readonly<{ kind: 'item'; position: number }>);

/** A row as it is drawn: its top and bottom edges, in CSS px from the top of the page. */
export type MeasuredItemRow = ItemDropRow & Readonly<{ top: number; bottom: number }>;

/**
 * What the panel shows for a drop of items: a line over or under the row of
 * the item at `position` in the layer the place is in; or the layer's own row
 * lit, for on top of its elements.
 */
export type ItemDropTarget =
	| Readonly<{ kind: 'gap'; position: number; edge: 'before' | 'after'; place: ElementPlace }>
	| Readonly<{ kind: 'into'; place: ElementPlace }>;

/** Where a drag of items over the rows, at `y` on the page, would drop; nowhere off the rows that take them. */
export const itemDropAt = (
	rows: readonly MeasuredItemRow[],
	y: number
): ItemDropTarget | undefined => {
	const row = rows.find((each) => y >= each.top && y < each.bottom);
	if (row === undefined || !row.takesItems) return undefined;
	const { layerId } = row;
	if (row.kind === 'layer') return { kind: 'into', place: { layerId, index: row.count } };
	// Over the row is above its element in paint order, directly below the next one up.
	const over = y < (row.top + row.bottom) / 2;
	return {
		kind: 'gap',
		position: row.position,
		edge: over ? 'before' : 'after',
		place: { layerId, index: over ? row.position + 1 : row.position },
	};
};

/** Whether two drops show the same, so a move between them draws nothing again. */
export const sameItemTarget = (
	one: ItemDropTarget | undefined,
	other: ItemDropTarget | undefined
): boolean =>
	one === other ||
	(one !== undefined &&
		other !== undefined &&
		one.kind === other.kind &&
		one.place.layerId === other.place.layerId &&
		one.place.index === other.place.index &&
		(one.kind === 'into' ||
			(other.kind === 'gap' && one.position === other.position && one.edge === other.edge)));

/** What the layer `layerId`'s row shows of a drop of items: itself lit, where they go on top of its elements. */
export const itemDropOnLayer = (
	target: ItemDropTarget | undefined,
	layerId: string
): RowDrop | undefined =>
	target?.kind === 'into' && target.place.layerId === layerId ? { at: 'into' } : undefined;

/** What the row of the item at `position` in the layer `layerId` shows of a drop of items: a line over or under it, at `depth`. */
export const itemDropOnItem = (
	target: ItemDropTarget | undefined,
	layerId: string,
	position: number,
	depth: number
): Readonly<{ at: 'before' | 'after'; depth: number; item: true }> | undefined =>
	target?.kind === 'gap' && target.place.layerId === layerId && target.position === position
		? { at: target.edge, depth, item: true }
		: undefined;
