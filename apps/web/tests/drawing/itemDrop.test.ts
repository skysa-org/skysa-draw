import { describe, expect, it } from 'vitest';

import {
	itemDropAt,
	itemDropOnItem,
	itemDropOnLayer,
	type ItemDropRow,
	type ItemDropTarget,
	type MeasuredItemRow,
	sameItemTarget,
} from '../../src/drawing/panels/itemDrop.js';

/**
 * Where a drag of a vector layer's items in the layers panel drops
 * (docs/ARCHITECTURE.md §7, "The interface"), over rows top first: a layer's,
 * and an expanded vector layer's items' under it.
 */

/** Each row 44 px tall, from the top of the page down. */
const measured = (rows: readonly ItemDropRow[]): MeasuredItemRow[] =>
	rows.map((row, at) => ({ ...row, top: at * 44, bottom: at * 44 + 44 }));

/**
 * A vector layer `a` of three elements, expanded, top first; a raster layer;
 * a vector layer `b` of one, collapsed; a group; a locked vector layer `c`,
 * expanded.
 */
const ROWS = measured([
	{ kind: 'layer', layerId: 'a', takesItems: true, count: 3 },
	{ kind: 'item', layerId: 'a', takesItems: true, position: 2 },
	{ kind: 'item', layerId: 'a', takesItems: true, position: 1 },
	{ kind: 'item', layerId: 'a', takesItems: true, position: 0 },
	{ kind: 'layer', layerId: 'raster', takesItems: false, count: 0 },
	{ kind: 'layer', layerId: 'b', takesItems: true, count: 1 },
	{ kind: 'layer', layerId: 'group', takesItems: false, count: 0 },
	{ kind: 'layer', layerId: 'c', takesItems: false, count: 2 },
	{ kind: 'item', layerId: 'c', takesItems: false, position: 1 },
	{ kind: 'item', layerId: 'c', takesItems: false, position: 0 },
]);

/** The drop at `share` of the height of the row at `at`. */
const over = (at: number, share: number) => itemDropAt(ROWS, at * 44 + share * 44);

describe('itemDropAt', () => {
	it('drops above an item’s element from the upper half of its row, below it from the lower', () => {
		expect(over(1, 0.2)).toEqual({
			kind: 'gap',
			position: 2,
			edge: 'before',
			place: { layerId: 'a', index: 3 },
		});
		expect(over(1, 0.7)).toEqual({
			kind: 'gap',
			position: 2,
			edge: 'after',
			place: { layerId: 'a', index: 2 },
		});
		expect(over(3, 0.3)?.place).toEqual({ layerId: 'a', index: 1 });
		// Under the bottom item is the bottom of the layer.
		expect(over(3, 0.9)?.place).toEqual({ layerId: 'a', index: 0 });
	});

	it('makes the lower half of one item’s row and the upper half of the next one place', () => {
		expect(over(1, 0.8)?.place).toEqual(over(2, 0.2)?.place);
		expect(over(2, 0.8)?.place).toEqual(over(3, 0.2)?.place);
	});

	it('drops on top of a vector layer’s elements from its own row, all of it, collapsed or not', () => {
		expect(over(5, 0.1)).toEqual({ kind: 'into', place: { layerId: 'b', index: 1 } });
		expect(over(5, 0.9)).toEqual({ kind: 'into', place: { layerId: 'b', index: 1 } });
		expect(over(0, 0.5)).toEqual({ kind: 'into', place: { layerId: 'a', index: 3 } });
	});

	it('drops nowhere on a raster layer, a group, a held layer or its items, or past the rows', () => {
		expect(over(4, 0.5)).toBeUndefined();
		expect(over(6, 0.5)).toBeUndefined();
		expect(over(7, 0.5)).toBeUndefined();
		expect(over(8, 0.2)).toBeUndefined();
		expect(over(9, 0.8)).toBeUndefined();
		expect(itemDropAt(ROWS, -1)).toBeUndefined();
		expect(itemDropAt(ROWS, ROWS.length * 44 + 1)).toBeUndefined();
		expect(itemDropAt([], 10)).toBeUndefined();
	});
});

describe('what the rows show of a drop of items', () => {
	const gap = over(2, 0.2);
	const into = over(5, 0.5);

	it('draws the line on the item’s row the pointer is over, on its edge, at the depth given', () => {
		expect(itemDropOnItem(gap, 'a', 1, 2)).toEqual({ at: 'before', depth: 2, item: true });
		expect(itemDropOnItem(gap, 'a', 2, 2)).toBeUndefined();
		expect(itemDropOnItem(gap, 'c', 1, 2)).toBeUndefined();
		expect(itemDropOnItem(into, 'b', 0, 1)).toBeUndefined();
		expect(itemDropOnItem(undefined, 'a', 1, 2)).toBeUndefined();
	});

	it('lights the row of the layer they go on top of, and no other', () => {
		expect(itemDropOnLayer(into, 'b')).toEqual({ at: 'into' });
		expect(itemDropOnLayer(into, 'a')).toBeUndefined();
		expect(itemDropOnLayer(gap, 'a')).toBeUndefined();
		expect(itemDropOnLayer(undefined, 'b')).toBeUndefined();
	});
});

describe('sameItemTarget', () => {
	const at = (place: ItemDropTarget['place']): ItemDropTarget => ({
		kind: 'gap',
		position: place.index,
		edge: 'after',
		place,
	});

	it('is the same drop for the same place shown the same way, and another for any change', () => {
		expect(sameItemTarget(undefined, undefined)).toBe(true);
		expect(sameItemTarget(over(1, 0.2), over(1, 0.3))).toBe(true);
		expect(sameItemTarget(over(5, 0.2), over(5, 0.8))).toBe(true);
		expect(sameItemTarget(over(1, 0.2), undefined)).toBe(false);
		// One place, shown on the edge of another row: drawn again.
		expect(sameItemTarget(over(1, 0.8), over(2, 0.2))).toBe(false);
		expect(sameItemTarget(over(0, 0.5), over(1, 0.2))).toBe(false);
		expect(sameItemTarget(at({ layerId: 'a', index: 1 }), at({ layerId: 'b', index: 1 }))).toBe(
			false
		);
	});
});
