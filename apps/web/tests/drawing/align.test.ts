import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	type AlignEdge,
	alignOffsets,
	arrangedIds,
	arrangeLayers,
	arrangementsFor,
	distributeOffsets,
	type Distribution,
	type LayerExtent,
	type Offset,
} from '../../src/drawing/tools/common/align.js';
import { layersMove } from '../../src/drawing/tools/common/layersMove.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import type { Box } from '../../src/drawing/tools/vector/geometry.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';

/**
 * The move tool's alignment (`tools/common/align.ts`): the arithmetic of
 * every alignment and distribution, pure, and the arrangement done to a real
 * document's layers by one command, with the layers' measures given in place
 * of the browser's. jsdom has no SVG geometry, so every layer's parent is
 * read as in the root's units, except where a test gives a group a scale.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A picture's bytes, never decoded: the measures are given, and the move writes the layer's `<g>`. */
const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

/** Bottom to top: a vector layer, a raster one moved already, and a group of two vector layers. */
const LAYERS = [
	'<g id="layer-1" draw:kind="vector"><rect id="ground" x="0" y="0" width="100" height="90"/></g>',
	`<g id="layer-2" draw:kind="raster" transform="translate(5 0) rotate(10)"><image href="${PICTURE}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/></g>`,
	'<g id="layer-3" draw:kind="group">',
	'<g id="layer-4" draw:kind="vector"><rect id="card" x="60" y="60" width="20" height="20"/></g>',
	'<g id="layer-5" draw:kind="vector" draw:name="Lid"><rect x="0" y="0" width="5" height="5"/></g>',
	'</g>',
].join('\n');

const open = (layers = LAYERS): EditorDocument => {
	const opened = openDocument(
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 100 100" width="100" height="100">`,
			layers,
			'</svg>',
			'',
		].join('\n')
	);
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

const noop = (): undefined => undefined;

type Setup = Readonly<{
	active: string;
	layers?: readonly string[];
	region?: Region;
	selected?: readonly Element[];
}>;

/** The viewport's context for an active layer and the layers chosen, with what it tells the user kept. */
const contextFor = (editor: EditorDocument, setup: Setup) => {
	const notify = vi.fn<(message: string) => void>();
	const selection = observable<readonly Element[]>(setup.selected ?? []);
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
		region: observable<Region | undefined>(setup.region),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify,
	});
	return { context, notify, selection };
};

/** Each layer's measure, given; a layer not named paints nothing. */
const extentOf = (boxes: Readonly<Record<string, Box>>) =>
	vi.fn<LayerExtent>((id) => Promise.resolve(boxes[id]));

const transformOf = (editor: EditorDocument, id: string): string | null =>
	editor.root.querySelector(`[id="${id}"]`)?.getAttribute('transform') ?? null;

const box = (x: number, y: number, width: number, height: number): Box => ({
	x,
	y,
	width,
	height,
});

/** A box along the x axis alone, its y and its height the same for all. */
const row = (x: number, width: number): Box => box(x, 0, width, 10);

/** Offsets to nine places, and no negative zero, so arithmetic's last bits do not matter. */
const exact = (offsets: readonly Offset[]): readonly Offset[] =>
	offsets.map(([dx, dy]) => [Math.round(dx * 1e9) / 1e9 + 0, Math.round(dy * 1e9) / 1e9 + 0]);

/** A box and an offset with the axes swapped, so every case across is checked down too. */
const transposed = ({ x, y, width, height }: Box): Box => ({
	x: y,
	y: x,
	width: height,
	height: width,
});
const swapped = ([dx, dy]: Offset): Offset => [dy, dx];

const DOWN: Readonly<Record<Distribution, Distribution>> = {
	left: 'top',
	centerX: 'centerY',
	right: 'bottom',
	spaceX: 'spaceY',
	top: 'left',
	centerY: 'centerX',
	bottom: 'right',
	spaceY: 'spaceX',
};

describe('which arrangements apply', () => {
	it('aligns one layer or more, to the selection or the canvas', () => {
		expect(arrangementsFor(0, 'selection').align).toBe(false);
		expect(arrangementsFor(0, 'canvas').align).toBe(false);
		expect(arrangementsFor(1, 'selection').align).toBe(true);
		expect(arrangementsFor(1, 'canvas').align).toBe(true);
		expect(arrangementsFor(5, 'selection').align).toBe(true);
	});

	it('distributes three or more between the outermost, and two or more across the canvas', () => {
		expect(arrangementsFor(1, 'canvas').distribute).toBe(false);
		expect(arrangementsFor(2, 'selection').distribute).toBe(false);
		expect(arrangementsFor(2, 'canvas').distribute).toBe(true);
		expect(arrangementsFor(3, 'selection').distribute).toBe(true);
		expect(arrangementsFor(3, 'canvas').distribute).toBe(true);
	});
});

describe('the layers an arrangement moves', () => {
	it('are the outermost of those chosen, in paint order, bottom first, whatever order they came in', () => {
		const { root } = open();
		expect(arrangedIds(root, ['layer-2', 'layer-1'], 'layer-2')).toEqual([
			'layer-1',
			'layer-2',
		]);
		expect(arrangedIds(root, ['layer-4', 'layer-3', 'layer-1'], 'layer-1')).toEqual([
			'layer-1',
			'layer-3',
		]);
	});

	it('are the active layer alone where one is chosen, or the outermost is one', () => {
		const { root } = open();
		expect(arrangedIds(root, [], 'layer-2')).toEqual(['layer-2']);
		expect(arrangedIds(root, ['layer-2'], 'layer-2')).toEqual(['layer-2']);
		expect(arrangedIds(root, ['layer-4', 'layer-3'], 'layer-4')).toEqual(['layer-4']);
	});

	it('are none with no layer active, or one the drawing does not have', () => {
		const { root } = open();
		expect(arrangedIds(root, [], undefined)).toEqual([]);
		expect(arrangedIds(root, ['layer-9'], 'layer-9')).toEqual([]);
	});
});

describe('the alignments', () => {
	const boxes = [box(10, 20, 30, 40), box(50, 0, 10, 10)];
	const target = box(0, 0, 100, 200);

	it.each<[AlignEdge, readonly Offset[]]>([
		[
			'left',
			[
				[-10, 0],
				[-50, 0],
			],
		],
		[
			'centerX',
			[
				[25, 0],
				[-5, 0],
			],
		],
		[
			'right',
			[
				[60, 0],
				[40, 0],
			],
		],
		[
			'top',
			[
				[0, -20],
				[0, 0],
			],
		],
		[
			'centerY',
			[
				[0, 60],
				[0, 95],
			],
		],
		[
			'bottom',
			[
				[0, 140],
				[0, 190],
			],
		],
	])('moves each box along the axis alone for its %s to meet the target’s', (edge, expected) => {
		expect(exact(alignOffsets(boxes, target, edge))).toEqual(expected);
	});

	it('gives the offsets in the order the boxes came in, and none for none', () => {
		const [first, second] = boxes as [Box, Box];
		expect(exact(alignOffsets([second, first], target, 'left'))).toEqual([
			[-50, 0],
			[-10, 0],
		]);
		expect(alignOffsets([], target, 'left')).toEqual([]);
	});

	it('leaves a box already there where it is', () => {
		expect(exact(alignOffsets([box(0, 5, 10, 10)], box(0, 0, 50, 50), 'left'))).toEqual([
			[0, 0],
		]);
	});
});

/** The canvas of the cases across one, from −10 to 200. */
const WITHIN = box(-10, -50, 210, 100);

/** A distribution across, in the order the boxes came in, and what each moves. */
type Case = Readonly<{
	how: Distribution;
	boxes: readonly Box[];
	within?: Box;
	expected: readonly Offset[];
}>;

/**
 * Every distribution by an edge or a center and by the spacing, between the
 * outermost and across a box, with the boxes given out of order so the
 * offsets are seen to come back in the order given.
 */
const CASES: readonly (readonly [string, Case])[] = [
	[
		'left edges between the outermost',
		{
			how: 'left',
			boxes: [row(90, 30), row(0, 10), row(20, 20), row(50, 10)],
			expected: [
				[0, 0],
				[0, 0],
				[10, 0],
				[10, 0],
			],
		},
	],
	[
		'horizontal centers between the outermost',
		{
			how: 'centerX',
			boxes: [row(80, 30), row(0, 10), row(20, 20), row(50, 10)],
			expected: [
				[0, 0],
				[0, 0],
				[5, 0],
				[10, 0],
			],
		},
	],
	[
		'right edges between the outermost',
		{
			how: 'right',
			boxes: [row(70, 30), row(0, 10), row(20, 20), row(50, 10)],
			expected: [
				[0, 0],
				[0, 0],
				[0, 0],
				[10, 0],
			],
		},
	],
	[
		'left edges across a box: the first flush with its left, the last’s left its width from its right',
		{
			how: 'left',
			within: WITHIN,
			boxes: [row(90, 30), row(10, 10), row(20, 20), row(50, 10)],
			expected: [
				[80, 0],
				[-20, 0],
				[30, 0],
				[60, 0],
			],
		},
	],
	[
		'horizontal centers across a box: the first’s and the last’s half their widths in from its sides',
		{
			how: 'centerX',
			within: WITHIN,
			boxes: [row(90, 20), row(10, 10), row(20, 20), row(50, 10)],
			expected: [
				[90, 0],
				[-20, 0],
				[30, 0],
				[70, 0],
			],
		},
	],
	[
		'right edges across a box: the first’s right its width from its left, the last flush with its right',
		{
			how: 'right',
			within: WITHIN,
			boxes: [row(90, 20), row(0, 30), row(20, 20), row(50, 10)],
			expected: [
				[90, 0],
				[-10, 0],
				[40, 0],
				[80, 0],
			],
		},
	],
	[
		'two boxes across a box, flush with its sides',
		{
			how: 'left',
			within: box(0, 0, 100, 100),
			boxes: [row(20, 10), row(40, 20)],
			expected: [
				[-20, 0],
				[40, 0],
			],
		},
	],
	[
		'the spacing between the outermost: from the first’s left to the last’s right',
		{
			how: 'spaceX',
			boxes: [row(120, 20), row(0, 10), row(15, 30), row(60, 20)],
			expected: [
				[0, 0],
				[0, 0],
				[15, 0],
				[20, 0],
			],
		},
	],
	[
		'the spacing across a box: from its left to its right',
		{
			how: 'spaceX',
			within: WITHIN,
			boxes: [row(120, 20), row(0, 10), row(15, 30), row(60, 30)],
			expected: [
				[60, 0],
				[-10, 0],
				[25, 0],
				[50, 0],
			],
		},
	],
	[
		'the spacing of boxes in order of their centers, a wide one round a narrow one',
		{
			how: 'spaceX',
			boxes: [row(0, 100), row(10, 10), row(200, 10)],
			expected: [
				[60, 0],
				[0, 0],
				[0, 0],
			],
		},
	],
	[
		'the spacing of boxes wider than the span, which overlap',
		{
			how: 'spaceX',
			boxes: [row(0, 40), row(45, 40), row(50, 40)],
			expected: [
				[0, 0],
				[-20, 0],
				[0, 0],
			],
		},
	],
];

describe('the distributions', () => {
	it.each(CASES)('distributes the %s', (_, { how, boxes, within, expected }) => {
		expect(exact(distributeOffsets(boxes, how, within))).toEqual(expected);
	});

	it.each(CASES)('distributes the %s, down as across', (_, { how, boxes, within, expected }) => {
		const down = distributeOffsets(
			boxes.map(transposed),
			DOWN[how],
			within === undefined ? undefined : transposed(within)
		);
		expect(exact(down)).toEqual(expected.map(swapped));
	});

	it('orders boxes level with each other in the order they came in', () => {
		const [a, b, c, d, e] = [row(0, 10), row(50, 10), row(50, 20), row(50, 5), row(100, 10)];
		expect(exact(distributeOffsets([a, b, c, d, e], 'left', undefined))).toEqual([
			[0, 0],
			[-25, 0],
			[0, 0],
			[25, 0],
			[0, 0],
		]);
		expect(exact(distributeOffsets([a, d, c, b, e], 'left', undefined))).toEqual([
			[0, 0],
			[-25, 0],
			[0, 0],
			[25, 0],
			[0, 0],
		]);
	});

	it('moves nothing with too few boxes: two between the outermost, one across a box, none', () => {
		const two = [row(0, 10), row(50, 10)];
		expect(distributeOffsets(two, 'centerX', undefined)).toEqual([
			[0, 0],
			[0, 0],
		]);
		expect(distributeOffsets([row(30, 10)], 'left', WITHIN)).toEqual([[0, 0]]);
		expect(distributeOffsets([row(30, 10)], 'spaceX', WITHIN)).toEqual([[0, 0]]);
		expect(distributeOffsets([], 'spaceY', undefined)).toEqual([]);
	});

	it('leaves boxes already even where they are', () => {
		const even = [row(0, 10), row(20, 10), row(40, 10)];
		expect(exact(distributeOffsets(even, 'left', undefined))).toEqual([
			[0, 0],
			[0, 0],
			[0, 0],
		]);
		expect(exact(distributeOffsets(even, 'spaceX', undefined))).toEqual([
			[0, 0],
			[0, 0],
			[0, 0],
		]);
	});
});

/** A matrix as `DOMMatrix` has one, for the little of it the move reads: jsdom has none. */
type Matrix = Readonly<{
	a: number;
	b: number;
	c: number;
	d: number;
	e: number;
	f: number;
	multiply: (n: Matrix) => Matrix;
	inverse: () => Matrix;
}>;

const matrix = (a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): Matrix => ({
	a,
	b,
	c,
	d,
	e,
	f,
	multiply: (n) =>
		matrix(
			a * n.a + c * n.b,
			b * n.a + d * n.b,
			a * n.c + c * n.d,
			b * n.c + d * n.d,
			a * n.e + c * n.f + e,
			b * n.e + d * n.f + f
		),
	inverse: () => {
		const det = a * d - b * c;
		return matrix(
			d / det,
			-b / det,
			-c / det,
			a / det,
			(c * f - d * e) / det,
			(b * e - a * f) / det
		);
	},
});

/** `new DOMMatrix()`, the identity. */
class FakeDOMMatrix {
	constructor() {
		return matrix();
	}
}

/** The group `id` scaled by `factor`, as the SVG DOM reads its `transform`, which jsdom does not. */
const scaleGroup = (editor: EditorDocument, id: string, factor: number): void => {
	vi.stubGlobal('DOMMatrix', FakeDOMMatrix);
	const group = editor.layer(id) as SVGGraphicsElement;
	group.setAttribute('transform', `scale(${factor})`);
	Object.defineProperty(group, 'transform', {
		value: { baseVal: [{ matrix: matrix(factor, 0, 0, factor, 0, 0) }] },
	});
};

const at = (x: number, y: number): PointerSample => ({
	x,
	y,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType: 'mouse',
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
});

describe('arranging the layers', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('moves each layer by its own transform, by one command one undo takes back to the bytes', async () => {
		const editor = open();
		const original = editor.text();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2', 'layer-3'],
		});
		const extent = extentOf({
			'layer-1': box(0, 0, 20, 10),
			'layer-2': box(30, 0, 10, 10),
			'layer-3': box(50, 0, 30, 10),
		});
		const moved = await arrangeLayers(
			context,
			{ kind: 'align', edge: 'right' },
			'selection',
			extent
		);
		expect(moved).toBe(true);
		expect(extent.mock.calls.map(([id]) => id)).toEqual(['layer-1', 'layer-2', 'layer-3']);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0].label).toBe('tools.align.aligned');
		expect(transformOf(editor, 'layer-1')).toBe('translate(60 0)');
		expect(transformOf(editor, 'layer-2')).toBe('translate(45 0) rotate(10)');
		// Already at the right edge of the three, so no part of the command.
		expect(transformOf(editor, 'layer-3')).toBeNull();
		editor.undo();
		expect(editor.snapshot().canUndo).toBe(false);
		expect(editor.text()).toBe(original);
		editor.redo();
		expect(transformOf(editor, 'layer-1')).toBe('translate(60 0)');
	});

	it('distributes by one command labeled as a distribution', async () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2', 'layer-3'],
		});
		const extent = extentOf({
			'layer-1': box(0, 0, 10, 10),
			'layer-2': box(0, 10, 10, 10),
			'layer-3': box(0, 60, 10, 10),
		});
		expect(
			await arrangeLayers(context, { kind: 'distribute', how: 'top' }, 'selection', extent)
		).toBe(true);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0].label).toBe('tools.align.distributed');
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 20) rotate(10)');
		expect(transformOf(editor, 'layer-3')).toBeNull();
	});

	it('distributes two layers across the canvas, and none between themselves', async () => {
		const editor = open();
		const extent = extentOf({ 'layer-1': box(20, 0, 10, 10), 'layer-3': box(40, 0, 20, 10) });
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
		});
		const execute = vi.spyOn(editor, 'execute');
		const left = { kind: 'distribute', how: 'left' } as const;
		expect(await arrangeLayers(context, left, 'selection', extent)).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		expect(await arrangeLayers(context, left, 'canvas', extent)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(-20 0)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(40 0)');
	});

	it('moves a layer in a scaled group by the offset in the root’s units, in the group’s', async () => {
		const editor = open();
		scaleGroup(editor, 'layer-3', 2);
		const { context } = contextFor(editor, {
			active: 'layer-4',
			layers: ['layer-1', 'layer-4'],
		});
		// The card at 60 in the group, which is 120 in the root's units, to the ground's left at 10.
		const extent = extentOf({
			'layer-1': box(10, 0, 100, 90),
			'layer-4': box(120, 120, 40, 40),
		});
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'selection', extent)
		).toBe(true);
		expect(transformOf(editor, 'layer-4')).toBe('translate(-55 0)');
		expect(transformOf(editor, 'layer-1')).toBeNull();
	});

	it('aligns one layer alone to the canvas, with nothing selected or aligned to the canvas', async () => {
		const editor = open();
		const extent = extentOf({ 'layer-1': box(0, 0, 100, 90) });
		const alone = contextFor(editor, { active: 'layer-1' });
		const bottom = { kind: 'align', edge: 'bottom' } as const;
		expect(await arrangeLayers(alone.context, bottom, 'selection', extent)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 10)');
		editor.undo();
		expect(await arrangeLayers(alone.context, bottom, 'canvas', extent)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 10)');
	});

	it('aligns to the canvas when asked, not to the layers’ box together', async () => {
		const editor = open();
		const extent = extentOf({ 'layer-1': box(20, 0, 10, 10), 'layer-3': box(40, 0, 20, 10) });
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
		});
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'right' }, 'canvas', extent)
		).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(70 0)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(40 0)');
	});

	it('aligns to the area selected, over the layers’ box together; to the canvas for an inverted one', async () => {
		const editor = open();
		const path = 'M10 30 L60 30 L60 50 L10 50 Z';
		const extent = extentOf({ 'layer-1': box(0, 0, 10, 10), 'layer-3': box(40, 60, 20, 10) });
		const top = { kind: 'align', edge: 'top' } as const;
		const area = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
			region: { path, inverted: false, feather: 4 },
		});
		expect(await arrangeLayers(area.context, top, 'selection', extent)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 30)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(0 -30)');
		editor.undo();
		const inverse = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
			region: { path, inverted: true, feather: 0 },
		});
		expect(await arrangeLayers(inverse.context, top, 'selection', extent)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-3')).toBe('translate(0 -60)');
	});

	it('aligns one layer alone to the area selected', async () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-2',
			region: { path: 'M10 30 L60 30 L60 50 L10 50 Z', inverted: false, feather: 0 },
		});
		const extent = extentOf({ 'layer-2': box(0, 0, 10, 10) });
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'centerX' }, 'selection', extent)
		).toBe(true);
		expect(transformOf(editor, 'layer-2')).toBe('translate(35 0) rotate(10)');
	});

	it('refuses the whole arrangement for a layer hidden or locked, and names it, measuring nothing', async () => {
		const editor = open(
			LAYERS.replace('id="layer-1"', 'id="layer-1" display="none"').replace(
				'id="layer-5" draw:kind="vector"',
				'id="layer-5" draw:kind="vector" draw:locked="true"'
			)
		);
		const original = editor.text();
		const execute = vi.spyOn(editor, 'execute');
		const extent = extentOf({ 'layer-1': box(0, 0, 10, 10), 'layer-2': box(50, 0, 10, 10) });
		const left = { kind: 'align', edge: 'left' } as const;
		const hidden = contextFor(editor, { active: 'layer-1', layers: ['layer-1', 'layer-2'] });
		expect(await arrangeLayers(hidden.context, left, 'selection', extent)).toBe(false);
		expect(hidden.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Layer 1' })]]);
		const locked = contextFor(editor, { active: 'layer-2', layers: ['layer-2', 'layer-5'] });
		expect(await arrangeLayers(locked.context, left, 'selection', extent)).toBe(false);
		expect(locked.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Lid' })]]);
		expect(extent).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
		expect(editor.text()).toBe(original);
	});

	it('refuses to move a group that holds a locked layer, which would go with it', async () => {
		const editor = open(
			LAYERS.replace(
				'id="layer-4" draw:kind="vector"',
				'id="layer-4" draw:kind="vector" draw:locked="true"'
			)
		);
		const extent = extentOf({ 'layer-2': box(0, 0, 10, 10), 'layer-3': box(50, 0, 10, 10) });
		const { context, notify } = contextFor(editor, {
			active: 'layer-2',
			layers: ['layer-2', 'layer-3'],
		});
		expect(await arrangeLayers(context, { kind: 'align', edge: 'top' }, 'canvas', extent)).toBe(
			false
		);
		expect(notify.mock.calls).toEqual([[t('layers.locked', { name: 'Layer 4' })]]);
		expect(transformOf(editor, 'layer-3')).toBeNull();
	});

	it('says so when nothing on the layers could be measured, and runs nothing', async () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context, notify } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		const failing = vi.fn<LayerExtent>(() => Promise.reject(new Error('undecodable')));
		const left = { kind: 'align', edge: 'left' } as const;
		expect(await arrangeLayers(context, left, 'selection', extentOf({}))).toBe(false);
		expect(await arrangeLayers(context, left, 'selection', failing)).toBe(false);
		expect(notify.mock.calls).toEqual([[t('tools.align.nothing')], [t('tools.align.nothing')]]);
		expect(execute).not.toHaveBeenCalled();
	});

	it('leaves a layer that paints nothing where it is, and lines up the rest', async () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2', 'layer-3'],
		});
		const extent = extentOf({ 'layer-1': box(10, 0, 10, 10), 'layer-3': box(50, 0, 10, 10) });
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'selection', extent)
		).toBe(true);
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(-40 0)');
	});

	it('runs nothing when every layer is already in place', async () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context, notify } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
		});
		const extent = extentOf({ 'layer-1': box(10, 0, 10, 10), 'layer-3': box(10, 50, 30, 10) });
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'selection', extent)
		).toBe(false);
		expect(execute).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it('says there is no layer with none active', async () => {
		const editor = open();
		const { context, notify } = contextFor(editor, { active: 'layer-9' });
		const extent = extentOf({});
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'canvas', extent)
		).toBe(false);
		expect(notify.mock.calls).toEqual([[t('layers.noneActive')]]);
		expect(extent).not.toHaveBeenCalled();
	});

	it('lets go of the elements selected, with what shows them', async () => {
		const editor = open();
		const card = editor.root.querySelector('#card') as Element;
		const { context, selection } = contextFor(editor, { active: 'layer-4', selected: [card] });
		const extent = extentOf({ 'layer-4': box(60, 60, 20, 20) });
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'canvas', extent)
		).toBe(true);
		expect(selection.get()).toEqual([]);
		expect(transformOf(editor, 'layer-4')).toBe('translate(-60 0)');
	});

	it('does nothing while a drag of layers is under way', async () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		const extent = extentOf({ 'layer-1': box(0, 0, 10, 10), 'layer-2': box(50, 0, 10, 10) });
		layersMove.begin(context, at(0, 0));
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'canvas', extent)
		).toBe(false);
		layersMove.cancel(context);
		expect(extent).not.toHaveBeenCalled();
		expect(transformOf(editor, 'layer-1')).toBeNull();
	});

	it('does nothing where the drawing changed while the layers were measured, as a second press would', async () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
		});
		const extent = extentOf({ 'layer-1': box(0, 0, 10, 10), 'layer-3': box(50, 0, 10, 10) });
		const right = { kind: 'align', edge: 'right' } as const;
		const presses = await Promise.all([
			arrangeLayers(context, right, 'selection', extent),
			arrangeLayers(context, right, 'selection', extent),
		]);
		expect(presses).toEqual([true, false]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(transformOf(editor, 'layer-1')).toBe('translate(50 0)');
	});
});
