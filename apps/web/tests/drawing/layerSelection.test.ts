import { describe, expect, it } from 'vitest';

import {
	choiceKeysOf,
	clickSelection,
	everyLayer,
	type LayerSelection,
	stepSelection,
} from '../../src/drawing/layerSelection.js';

/**
 * The layers chosen in the panel, with the keys users know from Photoshop and
 * every file manager (docs/ARCHITECTURE.md §7, "The interface"). The rows are
 * five layers, top first.
 */

const ORDER = ['e', 'd', 'c', 'b', 'a'];

const PLAIN = { toggle: false, range: false };
const TOGGLE = { toggle: true, range: false };
const RANGE = { toggle: false, range: true };
const BOTH = { toggle: true, range: true };

const one = (id: string): LayerSelection => ({ active: id, selected: [id], anchor: id });

describe('choiceKeysOf', () => {
	it('reads ⌘ on a Mac and Ctrl elsewhere as the toggle, and Shift as the range', () => {
		const command = { ctrlKey: false, metaKey: true, shiftKey: true };
		expect(choiceKeysOf(command, true)).toEqual({ toggle: true, range: true });
		expect(choiceKeysOf(command, false)).toEqual({ toggle: false, range: true });
		expect(choiceKeysOf({ ctrlKey: true, metaKey: false, shiftKey: false }, false)).toEqual(
			TOGGLE
		);
	});
});

describe('clickSelection', () => {
	it('chooses the layer clicked alone, and makes it the anchor', () => {
		const chosen = { active: 'd', selected: ['d', 'c'], anchor: 'c' };
		expect(clickSelection(chosen, ORDER, 'a', PLAIN)).toEqual(one('a'));
	});

	it('adds a layer with the toggle, kept top first, and makes it active and the anchor', () => {
		const chosen = clickSelection(one('b'), ORDER, 'd', TOGGLE);
		expect(chosen).toEqual({ active: 'd', selected: ['d', 'b'], anchor: 'd' });
		expect(clickSelection(chosen, ORDER, 'c', TOGGLE).selected).toEqual(['d', 'c', 'b']);
	});

	it('takes a layer out with the toggle, keeping the active one where it is left', () => {
		const chosen = { active: 'd', selected: ['d', 'c', 'b'], anchor: 'd' };
		expect(clickSelection(chosen, ORDER, 'b', TOGGLE)).toEqual({
			active: 'd',
			selected: ['d', 'c'],
			anchor: 'b',
		});
	});

	it('makes the topmost left active where the active one is taken out', () => {
		const chosen = { active: 'c', selected: ['d', 'c', 'b'], anchor: 'c' };
		expect(clickSelection(chosen, ORDER, 'c', TOGGLE)).toEqual({
			active: 'd',
			selected: ['d', 'b'],
			anchor: 'c',
		});
	});

	it('never leaves nothing chosen: the toggle on the only layer chosen keeps it', () => {
		expect(clickSelection(one('c'), ORDER, 'c', TOGGLE)).toEqual(one('c'));
	});

	it('chooses the range from the anchor to the layer clicked, either way, and keeps the anchor', () => {
		const down = clickSelection(one('d'), ORDER, 'b', RANGE);
		expect(down).toEqual({ active: 'b', selected: ['d', 'c', 'b'], anchor: 'd' });
		// A second Shift-click ranges from the same anchor, so the range shrinks or flips.
		expect(clickSelection(down, ORDER, 'e', RANGE)).toEqual({
			active: 'e',
			selected: ['e', 'd'],
			anchor: 'd',
		});
	});

	it('adds the range to the choice with both keys', () => {
		const chosen = { active: 'a', selected: ['e', 'a'], anchor: 'a' };
		expect(clickSelection(chosen, ORDER, 'c', BOTH)).toEqual({
			active: 'c',
			selected: ['e', 'c', 'b', 'a'],
			anchor: 'a',
		});
	});

	it('ranges from the active layer where the anchor is gone, and drops layers gone', () => {
		const chosen = { active: 'c', selected: ['gone', 'c'], anchor: 'gone' };
		expect(clickSelection(chosen, ORDER, 'a', RANGE)).toEqual({
			active: 'a',
			selected: ['c', 'b', 'a'],
			anchor: 'c',
		});
		expect(clickSelection(chosen, ORDER, 'e', TOGGLE).selected).toEqual(['e', 'c']);
	});

	it('changes nothing for a layer not in the rows', () => {
		const chosen = one('c');
		expect(clickSelection(chosen, ORDER, 'gone', PLAIN)).toBe(chosen);
	});
});

describe('stepSelection', () => {
	it('chooses the next row up or down alone, and nothing past either end', () => {
		expect(stepSelection(one('c'), ORDER, 1, false)).toEqual(one('b'));
		expect(stepSelection(one('c'), ORDER, -1, false)).toEqual(one('d'));
		const top = one('e');
		expect(stepSelection(top, ORDER, -1, false)).toBe(top);
		const bottom = one('a');
		expect(stepSelection(bottom, ORDER, 1, true)).toBe(bottom);
	});

	it('grows the range from the anchor with Shift, and shrinks it back toward the anchor', () => {
		const grown = stepSelection(stepSelection(one('d'), ORDER, 1, true), ORDER, 1, true);
		expect(grown).toEqual({ active: 'b', selected: ['d', 'c', 'b'], anchor: 'd' });
		expect(stepSelection(grown, ORDER, -1, true)).toEqual({
			active: 'c',
			selected: ['d', 'c'],
			anchor: 'd',
		});
		// Past the anchor the range turns round it.
		const turned = stepSelection(
			stepSelection(stepSelection(grown, ORDER, -1, true), ORDER, -1, true),
			ORDER,
			-1,
			true
		);
		expect(turned).toEqual({ active: 'e', selected: ['e', 'd'], anchor: 'd' });
	});

	it('changes nothing with no layer active', () => {
		const none = { active: undefined, selected: [], anchor: undefined };
		expect(stepSelection(none, ORDER, 1, false)).toBe(none);
	});
});

describe('everyLayer', () => {
	it('chooses every row and keeps the active one active', () => {
		expect(everyLayer(ORDER, 'c')).toEqual({ active: 'c', selected: ORDER, anchor: 'c' });
	});

	it('makes the top one active where none is, and chooses nothing in an empty drawing', () => {
		expect(everyLayer(ORDER, undefined).active).toBe('e');
		expect(everyLayer([], undefined)).toEqual({
			active: undefined,
			selected: [],
			anchor: undefined,
		});
	});
});
