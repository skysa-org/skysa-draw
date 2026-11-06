import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { Arrangement, LayerExtent } from '../../src/drawing/tools/common/align.js';
import { arrange, arrangedCount } from '../../src/drawing/tools/common/arrange.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { arrangeElements } from '../../src/drawing/tools/vector/alignElements.js';
import type { Box } from '../../src/drawing/tools/vector/geometry.js';
import { layerSpace } from '../../src/drawing/tools/vector/guard.js';
import { placedBox } from '../../src/drawing/tools/vector/hit.js';
import { attributeBox, type Measure } from '../../src/drawing/tools/vector/measure.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';

/**
 * The move tool's alignment of the elements selected on a vector layer
 * (`tools/vector/alignElements.ts`), as Photoshop's path selection tool
 * aligns paths: a text, a shape and a line lined up with each other, each by
 * its own `transform`, in one command, and what decides whether a press
 * arranges the elements or the layers (`tools/common/arrange.ts`). jsdom has
 * no SVG geometry, so the elements are measured from their attributes, a
 * text by a box given for it.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A shape, a line and a text on one vector layer, and a layer over it. */
const LAYERS = [
	'<g id="layer-1" draw:kind="vector">',
	'<rect id="shape" x="10" y="10" width="40" height="20"/>',
	'<line id="line" x1="0" y1="60" x2="30" y2="60" stroke="#000"/>',
	'<text id="words" x="50" y="90">Hello</text>',
	'</g>',
	'<g id="layer-2" draw:kind="vector"><rect id="lid" x="150" y="150" width="10" height="10"/></g>',
].join('\n');

const open = (layers = LAYERS): EditorDocument => {
	const opened = openDocument(
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 200 200" width="200" height="200">`,
			layers,
			'</svg>',
			'',
		].join('\n')
	);
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

/** The browser's measure, as the attributes give it, and a text as 60 by 24 above its baseline. */
const measure: Measure = (element) =>
	element.localName === 'text'
		? {
				x: Number(element.getAttribute('x')),
				y: Number(element.getAttribute('y')) - 20,
				width: 60,
				height: 24,
			}
		: attributeBox(element);

const noop = (): undefined => undefined;

const contextFor = (
	editor: EditorDocument,
	setup: Readonly<{ active: string; layers?: readonly string[]; selected: readonly string[] }>
) => {
	const notify = vi.fn<(message: string) => void>();
	const selected = setup.selected.flatMap((id) => {
		const element = editor.root.querySelector(`[id="${id}"]`);
		return element === null ? [] : [element];
	});
	const selection = observable<readonly Element[]>(selected);
	const context: ToolContext = createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === setup.active),
		...(setup.layers === undefined ? {} : { layers: setup.layers }),
		options: DEFAULT_TOOL_OPTIONS,
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		canvas: document.createElement('canvas'),
		pixelRatio: () => 1,
		view: observable(IDENTITY_VIEW),
		selection,
		region: observable<Region | undefined>(undefined),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify,
	});
	return { context, notify, selection };
};

/** Where an element is seen on the canvas: its box, after its own `transform` and its layer's. */
const seen = (editor: EditorDocument, id: string): Box => {
	const element = editor.root.querySelector(`[id="${id}"]`);
	if (element === null) throw new Error(`${id} is in the drawing`);
	const layer = element.parentElement ?? undefined;
	return placedBox(measure, element, layerSpace(layer).outOf);
};

const centerX = (box: Box): number => box.x + box.width / 2;
const centerY = (box: Box): number => box.y + box.height / 2;

const ALL = ['shape', 'line', 'words'] as const;

const align = (edge: Extract<Arrangement, { kind: 'align' }>['edge']): Arrangement => ({
	kind: 'align',
	edge,
});

describe('aligning the elements selected on a vector layer', () => {
	it('lines a text, a shape and a line up by their centers, by one command one undo takes back', () => {
		const editor = open();
		const original = editor.text();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ALL });
		const execute = vi.spyOn(editor, 'execute');
		expect(arrangeElements(context, align('centerX'), 'selection', measure)).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0].label).toBe('tools.align.aligned');
		// The box around them all runs from the line's left, 0, to the text's right, 110.
		ALL.forEach((id) => expect(centerX(seen(editor, id))).toBeCloseTo(55, 6));
		// Across the other way, nothing moved.
		expect(seen(editor, 'shape').y).toBe(10);
		expect(seen(editor, 'line').y).toBe(60);
		expect(editor.root.querySelector('#layer-1')?.hasAttribute('transform')).toBe(false);
		editor.undo();
		expect(editor.text()).toBe(original);
	});

	it('keeps them selected, as they are after the edit, with their box drawn again', () => {
		const editor = open();
		const { context, selection } = contextFor(editor, { active: 'layer-1', selected: ALL });
		arrangeElements(context, align('top'), 'selection', measure);
		const ids = selection.get().map((element) => element.id);
		expect(ids).toEqual([...ALL]);
		selection.get().forEach((element) => expect(element.isConnected).toBe(true));
		expect(context.overlay.querySelector('[data-draw-selection]')).not.toBeNull();
		ALL.forEach((id) => expect(seen(editor, id).y).toBeCloseTo(10, 6));
	});

	it('lines them up where they are seen on a turned layer', () => {
		const turned = LAYERS.replace(
			'<g id="layer-1" draw:kind="vector">',
			'<g id="layer-1" draw:kind="vector" transform="matrix(0 1 -1 0 200 0)">'
		);
		const editor = open(turned);
		const { context } = contextFor(editor, { active: 'layer-1', selected: ALL });
		arrangeElements(context, align('centerY'), 'selection', measure);
		const middles = ALL.map((id) => centerY(seen(editor, id)));
		middles.forEach((middle) => expect(middle).toBeCloseTo(middles[0] ?? 0, 6));
		expect(editor.root.querySelector('#layer-1')?.getAttribute('transform')).toBe(
			'matrix(0 1 -1 0 200 0)'
		);
	});

	it('lines one alone up with the canvas', () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ['shape'] });
		arrangeElements(context, align('centerX'), 'selection', measure);
		expect(centerX(seen(editor, 'shape'))).toBeCloseTo(100, 6);
	});

	it('lines them up with the canvas where that is what they align to', () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ALL });
		arrangeElements(context, align('right'), 'canvas', measure);
		ALL.forEach((id) => {
			const box = seen(editor, id);
			expect(box.x + box.width).toBeCloseTo(200, 6);
		});
	});

	it('spaces three evenly between the outermost, which stay', () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ALL });
		const execute = vi.spyOn(editor, 'execute');
		arrangeElements(context, { kind: 'distribute', how: 'spaceX' }, 'selection', measure);
		const [line, shape, words] = (['line', 'shape', 'words'] as const).map((id) =>
			seen(editor, id)
		);
		if (line === undefined || shape === undefined || words === undefined)
			throw new Error('measured');
		expect(line.x).toBe(0);
		expect(words.x).toBe(50);
		expect(shape.x - (line.x + line.width)).toBeCloseTo(words.x - (shape.x + shape.width), 6);
		expect(execute.mock.calls[0]?.[0].label).toBe('tools.align.distributed');
	});

	it('runs nothing where they are lined up already', () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ['shape', 'line'] });
		arrangeElements(context, align('left'), 'canvas', measure);
		const version = editor.snapshot().version;
		expect(arrangeElements(context, align('left'), 'canvas', measure)).toBe(false);
		expect(editor.snapshot().version).toBe(version);
	});

	it('leaves a locked layer as it is, and says why', () => {
		const editor = open(
			LAYERS.replace('draw:kind="vector">', 'draw:kind="vector" draw:locked="true">')
		);
		const original = editor.text();
		const { context, notify } = contextFor(editor, { active: 'layer-1', selected: ALL });
		expect(arrangeElements(context, align('left'), 'selection', measure)).toBe(false);
		expect(editor.text()).toBe(original);
		expect(notify).toHaveBeenCalled();
	});
});

describe('what a press of the alignment arranges', () => {
	const extent = vi.fn<LayerExtent>((id) =>
		Promise.resolve(id === 'layer-1' ? { x: 0, y: 10, width: 110, height: 80 } : undefined)
	);

	it('arranges the elements selected, where the move tool would move their layer alone', async () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: ALL });
		await arrange(context, align('left'), 'selection', { extent, measure });
		ALL.forEach((id) => expect(seen(editor, id).x).toBeCloseTo(0, 6));
		expect(editor.root.querySelector('#layer-1')?.hasAttribute('transform')).toBe(false);
	});

	it('arranges the layer whole with nothing of it selected', async () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-1', selected: [] });
		await arrange(context, align('centerX'), 'selection', { extent, measure });
		expect(editor.root.querySelector('#layer-1')?.getAttribute('transform')).not.toBeNull();
	});

	it('counts the elements selected, else the layers', () => {
		expect(arrangedCount(['layer-1'], 3)).toBe(3);
		expect(arrangedCount(['layer-1'], 0)).toBe(1);
		expect(arrangedCount(['layer-1', 'layer-2'], 3)).toBe(2);
		expect(arrangedCount([], 0)).toBe(0);
	});
});
