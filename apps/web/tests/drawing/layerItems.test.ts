import { emptyDrawing } from '@skysa/draw-core';
import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { editLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	cutWords,
	heldNotice,
	itemName,
	itemsOf,
	pressedSelection,
	TEXT_NAME_MOST,
	useLayerItems,
} from '../../src/drawing/panels/layerItems.js';
import { entriesOf, rowsUnder } from '../../src/drawing/panels/LayerTree.js';

/**
 * A vector layer's items in the layers panel (docs/ARCHITECTURE.md §7, "The
 * interface"): what each is called, which are shown, and what a press on one
 * leaves selected.
 */

const SVG = 'http://www.w3.org/2000/svg';
const INKSCAPE = 'http://www.inkscape.org/namespaces/inkscape';
const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

/** An element made from markup, inside an `<svg>` that knows Inkscape's prefix. */
const element = (markup: string): Element => {
	const parsed = new DOMParser().parseFromString(
		`<svg xmlns="${SVG}" xmlns:inkscape="${INKSCAPE}">${markup}</svg>`,
		'image/svg+xml'
	);
	const found = parsed.documentElement.firstElementChild;
	if (found === null) throw new Error(`an element from ${markup}`);
	return found;
};

const open = (layers: string): EditorDocument => {
	const document = openDocument(
		emptyDrawing({ id: DRAWING_ID }).replace(/<g id="layer-1"[^>]*\/>/, layers)
	);
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

describe('itemName', () => {
	it('names an element by what it is, a circle an ellipse and a <use> a clone', () => {
		expect(
			[
				'<rect/>',
				'<circle/>',
				'<ellipse/>',
				'<line/>',
				'<polyline/>',
				'<polygon/>',
				'<path/>',
				'<g/>',
				'<image/>',
				'<use/>',
				'<svg/>',
				'<switch/>',
			].map((markup) => itemName(element(markup)))
		).toEqual([
			'Rectangle',
			'Ellipse',
			'Ellipse',
			'Line',
			'Polyline',
			'Polygon',
			'Path',
			'Group',
			'Image',
			'Clone',
			'Embedded drawing',
			'Group',
		]);
	});

	it('names a text by its words, each run of space one, and a text of none as a text', () => {
		expect(itemName(element('<text>\n  Harbor   <tspan>at</tspan>  dusk </text>'))).toBe(
			'Harbor at dusk'
		);
		expect(itemName(element('<text>   </text>'))).toBe('Text');
	});

	it(`cuts a text's words past ${String(TEXT_NAME_MOST)} characters, never inside a letter`, () => {
		expect(itemName(element('<text>The quick brown fox jumps over the lazy dog</text>'))).toBe(
			'The quick brown fox jump…'
		);
		expect(cutWords('a'.repeat(TEXT_NAME_MOST))).toBe('a'.repeat(TEXT_NAME_MOST));
		// No space is left before the ellipsis.
		expect(cutWords(`${'a'.repeat(TEXT_NAME_MOST - 1)} bcd`)).toBe(
			`${'a'.repeat(TEXT_NAME_MOST - 1)}…`
		);
		// An emoji is one character, not two halves.
		expect(cutWords('🐙'.repeat(TEXT_NAME_MOST + 1))).toBe(`${'🐙'.repeat(TEXT_NAME_MOST)}…`);
	});

	it('names an element by the name it was given before anything else: its label, then its title', () => {
		expect(itemName(element('<rect inkscape:label="Sky"><title>Blue</title></rect>'))).toBe(
			'Sky'
		);
		expect(itemName(element('<path><title>  Coast\n line </title></path>'))).toBe('Coast line');
		expect(itemName(element('<text><title>Caption</title>Long words here</text>'))).toBe(
			'Caption'
		);
		// An empty label or title is none.
		expect(itemName(element('<rect inkscape:label=" "><title></title></rect>'))).toBe(
			'Rectangle'
		);
	});
});

describe('itemsOf', () => {
	it('lists a layer’s graphics elements bottom first, by position, and nothing else', () => {
		const layer = element('<g><title>Not an item</title><rect/><defs/><circle/></g>');
		expect(itemsOf(layer).map(({ position, name }) => [position, name])).toEqual([
			[0, 'Rectangle'],
			[1, 'Ellipse'],
		]);
		expect(itemsOf(undefined)).toEqual([]);
	});

	it('takes a loose layer, one element at the root, as its one item', () => {
		const loose = element('<rect/>');
		expect(itemsOf(loose).map(({ element: each }) => each)).toEqual([loose]);
	});
});

describe('pressedSelection', () => {
	const [a, b, c] = ['<rect/>', '<circle/>', '<line/>'].map(element);
	const layer = [a, b, c].flatMap((each) => each ?? []);

	it('selects the item alone, whatever was selected, without a key held', () => {
		if (b === undefined) throw new Error('three elements');
		expect(pressedSelection(layer, layer, b, false)).toEqual([b]);
	});

	it('adds the item with a key held, or takes it out, in paint order, of the layer’s own alone', () => {
		if (a === undefined || b === undefined || c === undefined)
			throw new Error('three elements');
		const other = element('<path/>');
		expect(pressedSelection(layer, [c, other], a, true)).toEqual([a, c]);
		expect(pressedSelection(layer, [a, c], c, true)).toEqual([a]);
		expect(pressedSelection(layer, [a], a, true)).toEqual([]);
	});
});

const TWO = '<g id="layer-1" draw:kind="vector"><rect/><circle/></g>';
const ONE = '<g id="layer-2" draw:kind="vector"><path d="M0 0"/></g>';
const RASTER = '<g id="layer-3" draw:kind="raster"/>';

describe('useLayerItems', () => {
	it('counts every vector layer’s items, and names those of the layers expanded alone, top first', () => {
		const document = open(TWO + ONE + RASTER);
		const { result } = renderHook(() =>
			useLayerItems(document, document.snapshot(), ['layer-1', 'layer-2'])
		);
		expect(result.current.countOf('layer-1')).toBe(2);
		expect(result.current.countOf('layer-2')).toBe(1);
		expect(result.current.countOf('layer-3')).toBe(0);
		expect(result.current.shownOf('layer-1').map(({ name }) => name)).toEqual([
			'Ellipse',
			'Rectangle',
		]);
		// One item is the layer itself, as seen: nothing to show under it.
		expect(result.current.shownOf('layer-2')).toEqual([]);
	});

	it('reads the layer again with each snapshot, as an edit or an undo replaced its markup', () => {
		const document = open(TWO);
		const { result, rerender } = renderHook(
			({ snapshot }) => useLayerItems(document, snapshot, ['layer-1']),
			{ initialProps: { snapshot: document.snapshot() } }
		);
		const before = result.current.shownOf('layer-1').map(({ element: each }) => each);
		document.execute(
			editLayer('layer-1', 'tools.select', (layer) => {
				layer.appendChild(layer.ownerDocument.createElementNS(SVG, 'line'));
			})
		);
		document.undo();
		rerender({ snapshot: document.snapshot() });
		const after = result.current.shownOf('layer-1').map(({ element: each }) => each);
		expect(after).toHaveLength(2);
		expect(after.some((each) => before.includes(each))).toBe(false);
	});
});

describe('heldNotice', () => {
	/** Layer 1 and Layer 2 in Group 3, and Group 3 in Group 4, each with what `attributes` gives it. */
	const nested = (attributes: Readonly<Record<string, string>>) => {
		const of = (id: string) => attributes[id] ?? '';
		const document = open(
			`<g id="layer-4" draw:kind="group"${of('layer-4')}><g id="layer-3" draw:kind="group"${of('layer-3')}>` +
				`<g id="layer-1" draw:kind="vector"${of('layer-1')}/><g id="layer-2" draw:kind="vector"${of('layer-2')}/></g></g>`
		);
		return document.snapshot().layers;
	};
	const LOCKED = ' draw:locked="true"';
	const HIDDEN = ' display="none"';

	it('says nothing of a layer nothing holds, nor of one it does not have', () => {
		expect(heldNotice(nested({}), 'layer-1')).toBeUndefined();
		expect(heldNotice(nested({}), 'layer-9')).toBeUndefined();
	});

	it('says the layer is locked, or hidden, by its name, as a tool does, its lock first', () => {
		expect(heldNotice(nested({ 'layer-1': LOCKED }), 'layer-1')).toBe('“Layer 1” is locked.');
		expect(heldNotice(nested({ 'layer-1': HIDDEN }), 'layer-1')).toBe('“Layer 1” is hidden.');
		expect(heldNotice(nested({ 'layer-1': LOCKED + HIDDEN }), 'layer-1')).toBe(
			'“Layer 1” is locked.'
		);
		expect(heldNotice(nested({ 'layer-2': ' draw:name="Sky"' + HIDDEN }), 'layer-2')).toBe(
			'“Sky” is hidden.'
		);
	});

	it('says which group holds it where the layer itself is free, the nearest first', () => {
		expect(heldNotice(nested({ 'layer-3': HIDDEN }), 'layer-1')).toBe('“Group 3” is hidden.');
		expect(heldNotice(nested({ 'layer-4': LOCKED }), 'layer-2')).toBe('“Group 4” is locked.');
		expect(heldNotice(nested({ 'layer-3': HIDDEN, 'layer-4': LOCKED }), 'layer-1')).toBe(
			'“Group 3” is hidden.'
		);
		// The layer's own state before any group's.
		expect(heldNotice(nested({ 'layer-1': HIDDEN, 'layer-3': LOCKED }), 'layer-1')).toBe(
			'“Layer 1” is hidden.'
		);
	});
});

describe('entriesOf', () => {
	it('walks every row shown, each layer’s followed by its items’, top first', () => {
		const document = open(TWO + ONE);
		const rows = rowsUnder(document.snapshot().layers, undefined);
		const shown = (id: string) => (id === 'layer-1' ? [{ position: 1 }, { position: 0 }] : []);
		expect(entriesOf(rows, shown)).toEqual([
			{ layerId: 'layer-2' },
			{ layerId: 'layer-1' },
			{ layerId: 'layer-1', position: 1 },
			{ layerId: 'layer-1', position: 0 },
		]);
	});
});
