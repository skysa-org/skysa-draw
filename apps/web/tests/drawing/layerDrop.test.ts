import { describe, expect, it } from 'vitest';

import type { LayerPlace } from '../../src/drawing/document/arrange.js';
import {
	type DropRow,
	dropTargetAt,
	type MeasuredRow,
	nextPlace,
	scrollStep,
} from '../../src/drawing/panels/layerDrop.js';

/**
 * Where a drag in the layers panel drops, and where Alt with an arrow moves
 * the layers chosen (docs/ARCHITECTURE.md §7, "The interface"), over rows
 * built from a tree, top first, a group's layers under it.
 */

type Tree = { id: string; holds?: Tree[] };

const rowsOf = (trees: readonly Tree[], depth = 0, parentId?: string): DropRow[] =>
	trees.flatMap((tree) => [
		{ id: tree.id, depth, parentId, group: tree.holds !== undefined },
		...rowsOf(tree.holds ?? [], depth + 1, tree.id),
	]);

/** Each row 44 px tall, from the top of the page down. */
const measured = (rows: readonly DropRow[]): MeasuredRow[] =>
	rows.map((row, at) => ({ ...row, top: at * 44, bottom: at * 44 + 44 }));

const INDENT = { left: 0, step: 16 };

/** A layer, a group holding a group, an empty group, and a layer under them. */
const TREE: Tree[] = [
	{ id: 'a' },
	{ id: 'g', holds: [{ id: 'h', holds: [{ id: 'h1' }, { id: 'h2' }] }, { id: 'g1' }] },
	{ id: 'e', holds: [] },
	{ id: 'b' },
];
const ROWS = measured(rowsOf(TREE));

/** The row's index in `ROWS`, and a point at `share` of its height, `x` across. */
const over = (id: string, share: number, x = 200) => {
	const at = ROWS.findIndex((row) => row.id === id);
	return dropTargetAt(ROWS, { x, y: at * 44 + share * 44 }, INDENT);
};

const place = (parentId: string | undefined, aboveId: string | undefined): LayerPlace => ({
	parentId,
	aboveId,
});

describe('dropTargetAt', () => {
	it('drops above a row from its upper half, as its sibling', () => {
		expect(over('a', 0.2)).toEqual({
			kind: 'gap',
			before: 0,
			depth: 0,
			place: place(undefined, 'a'),
		});
		expect(over('h1', 0.4)).toEqual({
			kind: 'gap',
			before: 3,
			depth: 2,
			place: place('h', 'h1'),
		});
		// Above the first row is above it too.
		expect(dropTargetAt(ROWS, { x: 0, y: -10 }, INDENT)).toEqual(over('a', 0.2));
	});

	it('drops below a row from its lower half, as its sibling', () => {
		expect(over('a', 0.7)).toEqual({
			kind: 'gap',
			before: 1,
			depth: 0,
			place: place(undefined, 'g'),
		});
		expect(over('h1', 0.7)).toEqual({
			kind: 'gap',
			before: 4,
			depth: 2,
			place: place('h', 'h2'),
		});
	});

	it('drops into a group from the middle of its row, at its top, an empty one too', () => {
		expect(over('g', 0.5)).toEqual({ kind: 'into', id: 'g', place: place('g', 'h') });
		expect(over('h', 0.3)).toEqual({ kind: 'into', id: 'h', place: place('h', 'h1') });
		expect(over('e', 0.7)).toEqual({ kind: 'into', id: 'e', place: place('e', undefined) });
	});

	it("drops at a group's top from just under its row, and beside it from its edges", () => {
		expect(over('g', 0.9)).toEqual({
			kind: 'gap',
			before: 2,
			depth: 1,
			place: place('g', 'h'),
		});
		expect(over('g', 0.1)).toEqual({
			kind: 'gap',
			before: 1,
			depth: 0,
			place: place(undefined, 'g'),
		});
		expect(over('e', 0.9)).toEqual({
			kind: 'gap',
			before: 7,
			depth: 0,
			place: place(undefined, 'b'),
		});
	});

	it("chooses with x how far out of a group the foot of it drops, from the row's own depth to the next row's", () => {
		// Under h2, the last of h, whose group g goes on with g1.
		expect(over('h2', 0.8, 200)).toEqual({
			kind: 'gap',
			before: 5,
			depth: 2,
			place: place('h', undefined),
		});
		expect(over('h2', 0.8, 20)).toEqual({
			kind: 'gap',
			before: 5,
			depth: 1,
			place: place('g', 'g1'),
		});
		// No further out than g1, the row under the gap.
		expect(over('h2', 0.8, 2)).toEqual(over('h2', 0.8, 20));
		// Under g1, the last of g: the foot of g, or below g at the root.
		expect(over('g1', 0.8, 40)).toEqual({
			kind: 'gap',
			before: 6,
			depth: 1,
			place: place('g', undefined),
		});
		expect(over('g1', 0.8, 8)).toEqual({
			kind: 'gap',
			before: 6,
			depth: 0,
			place: place(undefined, 'e'),
		});
	});

	it('drops at the bottom of the drawing under the last row, and as deep as it goes with no indent', () => {
		expect(over('b', 0.8)).toEqual({
			kind: 'gap',
			before: 8,
			depth: 0,
			place: place(undefined, undefined),
		});
		expect(dropTargetAt(ROWS, { x: 0, y: 1000 }, INDENT)).toEqual({
			kind: 'gap',
			before: 8,
			depth: 0,
			place: place(undefined, undefined),
		});
		const flat = ROWS.findIndex((row) => row.id === 'h2');
		expect(dropTargetAt(ROWS, { x: -50, y: flat * 44 + 40 }, { left: 0, step: 0 })).toEqual(
			over('h2', 0.9, 200)
		);
	});

	it('drops nowhere with no rows', () => {
		expect(dropTargetAt([], { x: 0, y: 0 }, INDENT)).toBeUndefined();
	});
});

describe('nextPlace', () => {
	const takeOut = (trees: Tree[], id: string): [Tree[], Tree | undefined] => {
		const found = trees.find((tree) => tree.id === id);
		if (found !== undefined) return [trees.filter((tree) => tree !== found), found];
		let taken: Tree | undefined;
		const kept = trees.map((tree) => {
			if (tree.holds === undefined) return tree;
			const [holds, inside] = takeOut(tree.holds, id);
			taken = taken ?? inside;
			return { ...tree, holds };
		});
		return [kept, taken];
	};

	const putIn = (trees: Tree[], moved: Tree, where: LayerPlace, parentId?: string): Tree[] => {
		if (where.parentId === parentId) {
			const at =
				where.aboveId === undefined
					? trees.length
					: trees.findIndex((tree) => tree.id === where.aboveId);
			return [...trees.slice(0, at), moved, ...trees.slice(at)];
		}
		return trees.map((tree) =>
			tree.holds === undefined
				? tree
				: { ...tree, holds: putIn(tree.holds, moved, where, tree.id) }
		);
	};

	/** Where the layer is, as `nextPlace` names a place: its group, and the layer under it. */
	const placeOf = (trees: Tree[], id: string): LayerPlace => {
		const rows = rowsOf(trees);
		const row = rows.find((each) => each.id === id);
		const under = rows
			.slice(rows.indexOf(row as DropRow) + 1)
			.find((each) => each.parentId === row?.parentId);
		return place(row?.parentId, under?.id);
	};

	/** Every place Alt with the arrow takes `id` to, one press at a time, until it goes no further. */
	const walk = (start: Tree[], id: string, direction: 'up' | 'down'): LayerPlace[] => {
		const places: LayerPlace[] = [];
		let trees = start;
		for (;;) {
			const next = nextPlace(rowsOf(trees), [id], direction, () => true);
			if (next === undefined) return places;
			places.push(next);
			const [kept, moved] = takeOut(trees, id);
			trees = putIn(kept, moved as Tree, next);
			expect(placeOf(trees, id)).toEqual(next);
		}
	};

	const WALKED: Tree[] = [
		{ id: 'l' },
		{ id: 'a' },
		{ id: 'g', holds: [{ id: 'h', holds: [{ id: 'h1' }] }, { id: 'g1' }] },
		{ id: 'e', holds: [] },
		{ id: 'b' },
	];

	const DOWN = [
		place(undefined, 'g'),
		place('g', 'h'),
		place('h', 'h1'),
		place('h', undefined),
		place('g', 'g1'),
		place('g', undefined),
		place(undefined, 'e'),
		place('e', undefined),
		place(undefined, 'b'),
		place(undefined, undefined),
	];

	it('moves a layer down a row at a time, into each group at its top and out of it a level at a time', () => {
		expect(walk(WALKED, 'l', 'down')).toEqual(DOWN);
	});

	it('moves it up again the same way back', () => {
		const [kept, moved] = takeOut(WALKED, 'l');
		const atBottom = putIn(kept, moved as Tree, place(undefined, undefined));
		expect(walk(atBottom, 'l', 'up')).toEqual([
			...DOWN.slice(0, -1).reverse(),
			place(undefined, 'a'),
		]);
	});

	it('passes over a place that is not taken', () => {
		const rows = rowsOf(WALKED);
		const notInto = (where: LayerPlace) => !['g', 'h'].includes(where.parentId ?? '');
		expect(nextPlace(rows, ['a'], 'down', notInto)).toEqual(place(undefined, 'e'));
	});

	it('moves a group with what it holds, and a layer chosen inside it goes with it', () => {
		const rows = rowsOf([{ id: 'a' }, { id: 'g', holds: [{ id: 'g1' }] }, { id: 'b' }]);
		expect(nextPlace(rows, ['g', 'g1'], 'down', () => true)).toEqual(
			place(undefined, undefined)
		);
		expect(nextPlace(rows, ['g'], 'up', () => true)).toEqual(place(undefined, 'a'));
	});

	it('moves layers apart from the bottommost of them going down, and stops at the top going up', () => {
		const rows = rowsOf([{ id: 'a' }, { id: 'x' }, { id: 'b' }, { id: 'y' }]);
		expect(nextPlace(rows, ['a', 'b'], 'down', () => true)).toEqual(
			place(undefined, undefined)
		);
		expect(nextPlace(rows, ['a', 'b'], 'up', () => true)).toBeUndefined();
		expect(nextPlace(rows, [], 'up', () => true)).toBeUndefined();
	});
});

describe('scrollStep', () => {
	const BOX = { top: 100, bottom: 500 };

	it('scrolls up near the top and down near the bottom, faster nearer the edge', () => {
		expect(scrollStep(BOX, 300)).toBe(0);
		expect(scrollStep(BOX, 140)).toBeLessThan(0);
		expect(scrollStep(BOX, 105)).toBeLessThan(scrollStep(BOX, 140));
		expect(scrollStep(BOX, 460)).toBeGreaterThan(0);
		expect(scrollStep(BOX, 495)).toBeGreaterThan(scrollStep(BOX, 460));
	});

	it('scrolls fastest past an edge, and never in the middle third of a short box', () => {
		expect(scrollStep(BOX, 20)).toBe(-12);
		expect(scrollStep(BOX, 900)).toBe(12);
		expect(scrollStep({ top: 0, bottom: 60 }, 30)).toBe(0);
		expect(scrollStep({ top: 0, bottom: 0 }, 0)).toBe(0);
	});
});

describe('over a collapsed group', () => {
	/** The group g collapsed: its row alone, which knows its top layer. */
	const SHUT = measured([
		{ id: 'a', depth: 0, parentId: undefined, group: false },
		{ id: 'g', depth: 0, parentId: undefined, group: true, collapsed: true, topLayer: 'g2' },
		{ id: 'b', depth: 0, parentId: undefined, group: false },
	]);

	it('drops into it at its top, above the layer no row shows', () => {
		expect(dropTargetAt(SHUT, { x: 200, y: 44 + 22 }, INDENT)).toEqual({
			kind: 'into',
			id: 'g',
			place: place('g', 'g2'),
		});
	});

	it('drops under its row beside it, not among its layers', () => {
		expect(dropTargetAt(SHUT, { x: 200, y: 44 + 40 }, INDENT)).toEqual({
			kind: 'gap',
			before: 2,
			depth: 0,
			place: place(undefined, 'b'),
		});
	});

	it('is passed over whole by Alt and an arrow', () => {
		expect(nextPlace(SHUT, ['a'], 'down', () => true)).toEqual(place(undefined, 'b'));
		expect(nextPlace(SHUT, ['b'], 'up', () => true)).toEqual(place(undefined, 'g'));
	});
});
