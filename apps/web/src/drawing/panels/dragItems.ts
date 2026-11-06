import { canMoveElements } from '../document/elements.js';
import {
	itemDropAt,
	type ItemDropTarget,
	type MeasuredItemRow,
	sameItemTarget,
} from './itemDrop.js';
import type { Dragged } from './useLayerDrag.js';

/**
 * A vector layer's items dragged in the layers panel to another place among
 * its elements, or into another vector layer (docs/ARCHITECTURE.md §7, "The
 * interface"), by the panel's one drag (`useLayerDrag`). Where they would
 * land is `itemDropAt` over the rows as they are drawn, each row saying what
 * the drop reads of it on itself (`LayerRow`, `LayerItemRow`); a place
 * `canMoveElements` refuses, a no-op among them, shows nothing and drops
 * nothing.
 */

/** The drag the panel draws: the items dragged, and where they would land. */
export type ItemsDrag = Readonly<{
	kind: 'items';
	layerId: string;
	/** Their positions among the layer's elements, ascending. */
	positions: readonly number[];
	/** The position of the item pressed, among them: the one whose row the focus follows. */
	pressed: number;
	target: ItemDropTarget | undefined;
}>;

/**
 * A row of the list as the drop reads it, from what it carries, or none for a
 * row that is neither a layer's nor an item's, and none for the space that
 * stands for items' rows not drawn (`ItemRows`), where nothing is aimed at.
 */
const measureItemRow = (row: Element): readonly MeasuredItemRow[] => {
	if (!(row instanceof HTMLElement) || row.dataset.gap !== undefined) return [];
	const { itemOf, layerId, position, itemCount, takesItems } = row.dataset;
	const id = itemOf ?? layerId;
	if (id === undefined) return [];
	const box = row.getBoundingClientRect();
	const measured = {
		layerId: id,
		takesItems: takesItems !== undefined,
		top: box.top,
		bottom: box.bottom,
	};
	return itemOf === undefined
		? [{ ...measured, kind: 'layer', count: Number(itemCount ?? 0) }]
		: [{ ...measured, kind: 'item', position: Number(position) }];
};

/** The items' drag as it shows `shown`, aimed anew from the rows as drawn. */
export const itemsDragged = (root: SVGSVGElement, shown: ItemsDrag): Dragged<ItemsDrag> => {
	const dragged: Dragged<ItemsDrag> = {
		shown,
		aim: (list, point) => {
			const found = itemDropAt([...list.children].flatMap(measureItemRow), point.y);
			const target =
				found !== undefined &&
				canMoveElements(root, shown.layerId, shown.positions, found.place)
					? found
					: undefined;
			return sameItemTarget(target, shown.target)
				? dragged
				: itemsDragged(root, { ...shown, target });
		},
	};
	return dragged;
};
