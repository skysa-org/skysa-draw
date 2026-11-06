import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	layersMove,
	movesWith,
	nudgeLayers,
	translated,
} from '../../src/drawing/tools/common/layersMove.js';
import { behaviorFor, toolById } from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type Tool,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { drawSelectionBox, hasSelectionBox } from '../../src/drawing/tools/vector/selection.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';

/**
 * The move tool on layers whole (docs/ARCHITECTURE.md §7, "The editor"): the
 * layers chosen, or a group active alone, moved together by their own
 * `transform`s, live during the drag and as one command at its end, and
 * nudged by the arrows the same way. Against a real document; jsdom has no
 * SVG geometry, so every layer's parent is read as in the root's units.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A picture's bytes, never decoded: the move writes the layer's `<g>`, not its pixels. */
const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

/**
 * Bottom to top: a vector layer, a raster one moved already, and a group of
 * two vector layers, every one of them with something in it.
 */
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

type Setup = Readonly<{
	active: string;
	layers?: readonly string[];
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
		region: observable<Region | undefined>(undefined),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify,
	});
	return { context, notify, selection };
};

const transformOf = (editor: EditorDocument, id: string): string | null =>
	editor.root.querySelector(`[id="${id}"]`)?.getAttribute('transform') ?? null;

const drag = (
	context: ToolContext,
	from: readonly [number, number],
	to: readonly [number, number]
): void => {
	layersMove.begin(context, at(...from));
	layersMove.move(context, at(...to));
	layersMove.end(context, at(...to));
};

describe('moving the layers chosen', () => {
	it('moves every one by the same distance while the drag lasts, each before its own transform', () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(14, 7));
		expect(transformOf(editor, 'layer-1')).toBe('translate(4 -3)');
		expect(transformOf(editor, 'layer-2')).toBe('translate(4 -3) translate(5 0) rotate(10)');
		expect(transformOf(editor, 'layer-3')).toBeNull();
		expect(editor.snapshot().canUndo).toBe(false);
	});

	it('runs one command at the end, labeled as the one-layer move, which one undo takes back to the bytes', () => {
		const editor = open();
		const original = editor.text();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-2',
			layers: ['layer-1', 'layer-2', 'layer-3'],
		});
		drag(context, [10, 10], [12.5, 10]);
		expect(execute).toHaveBeenCalledTimes(1);
		expect(execute.mock.calls[0]?.[0].label).toBe('tools.select');
		expect(transformOf(editor, 'layer-1')).toBe('translate(2.5 0)');
		expect(transformOf(editor, 'layer-2')).toBe('translate(2.5 0) translate(5 0) rotate(10)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(2.5 0)');
		// The group's layers are drawn where it puts them, and keep their own.
		expect(transformOf(editor, 'layer-4')).toBeNull();
		editor.undo();
		expect(editor.snapshot().canUndo).toBe(false);
		expect(editor.text()).toBe(original);
		editor.redo();
		expect(transformOf(editor, 'layer-3')).toBe('translate(2.5 0)');
	});

	it('runs nothing for a click, or a drag back to where it began', () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		drag(context, [10, 10], [10, 10]);
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(30, 10));
		layersMove.end(context, at(10, 10));
		expect(execute).not.toHaveBeenCalled();
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
	});

	it('puts every layer back on a cancel, and runs nothing', () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(20, 20));
		layersMove.cancel(context);
		layersMove.end(context, at(20, 20));
		expect(execute).not.toHaveBeenCalled();
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
	});

	it('moves a group active alone whole, as the move tool’s behavior for a group', () => {
		const editor = open();
		const { context } = contextFor(editor, { active: 'layer-3' });
		const select = toolById('select') as Tool;
		expect(behaviorFor(select, 'group')).toBe(layersMove);
		drag(context, [0, 0], [3, 4]);
		expect(transformOf(editor, 'layer-3')).toBe('translate(3 4)');
		expect(transformOf(editor, 'layer-4')).toBeNull();
	});

	it('refuses the whole move for a chosen layer that is locked or hidden, and names the topmost such', () => {
		const editor = open(
			LAYERS.replace('id="layer-1"', 'id="layer-1" display="none"').replace(
				'id="layer-5" draw:kind="vector"',
				'id="layer-5" draw:kind="vector" draw:locked="true"'
			)
		);
		const execute = vi.spyOn(editor, 'execute');
		const hidden = contextFor(editor, { active: 'layer-1', layers: ['layer-1', 'layer-2'] });
		drag(hidden.context, [0, 0], [5, 5]);
		expect(hidden.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Layer 1' })]]);
		const locked = contextFor(editor, { active: 'layer-2', layers: ['layer-1', 'layer-5'] });
		drag(locked.context, [0, 0], [5, 5]);
		expect(locked.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Lid' })]]);
		expect(execute).not.toHaveBeenCalled();
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
	});

	it('refuses to move a group that holds a locked layer, which would go with it', () => {
		const editor = open(
			LAYERS.replace(
				'id="layer-4" draw:kind="vector"',
				'id="layer-4" draw:kind="vector" draw:locked="true"'
			)
		);
		const alone = contextFor(editor, { active: 'layer-3' });
		drag(alone.context, [0, 0], [5, 5]);
		expect(alone.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Layer 4' })]]);
		const chosen = contextFor(editor, { active: 'layer-2', layers: ['layer-2', 'layer-3'] });
		drag(chosen.context, [0, 0], [5, 5]);
		expect(chosen.notify).toHaveBeenCalledTimes(1);
		expect(transformOf(editor, 'layer-3')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
	});

	it('lets go of the elements selected and their box as the layers begin to move', () => {
		const editor = open();
		const card = editor.root.querySelector('#card') as Element;
		const { context, selection } = contextFor(editor, {
			active: 'layer-4',
			layers: ['layer-1', 'layer-4'],
			selected: [card],
		});
		drawSelectionBox(context.overlay, { x: 60, y: 60, width: 20, height: 20 }, 1);
		layersMove.begin(context, at(0, 0));
		expect(selection.get()).toEqual([]);
		expect(hasSelectionBox(context.overlay)).toBe(false);
		layersMove.cancel(context);
	});

	it('writes a move as a translation in front of the transform there was, and nothing for none', () => {
		expect(translated(null, 1, 2)).toBe('translate(1 2)');
		expect(translated(' scale(2) ', 0.1234, -3)).toBe('translate(0.123 -3) scale(2)');
		expect(translated(null, 0, 0)).toBeUndefined();
		expect(translated('scale(2)', 0, 0)).toBe('scale(2)');
	});
});

describe('the arrows’ nudge of the layers chosen', () => {
	it('moves every one by the amount, in the drawing’s units, as one command', () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-3'],
		});
		expect(nudgeLayers(context, 10, 0)).toBe(true);
		expect(nudgeLayers(context, 0, -1)).toBe(true);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 -1) translate(10 0)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(0 -1) translate(10 0)');
		editor.undo();
		expect(transformOf(editor, 'layer-1')).toBe('translate(10 0)');
	});

	it('takes the key and moves nothing during a drag, or for a layer that may not move', () => {
		const editor = open(LAYERS.replace('id="layer-1"', 'id="layer-1" draw:locked="true"'));
		const execute = vi.spyOn(editor, 'execute');
		const free = contextFor(editor, { active: 'layer-2', layers: ['layer-2', 'layer-3'] });
		layersMove.begin(free.context, at(0, 0));
		expect(nudgeLayers(free.context, 1, 0)).toBe(true);
		layersMove.cancel(free.context);
		const locked = contextFor(editor, { active: 'layer-2', layers: ['layer-1', 'layer-2'] });
		expect(nudgeLayers(locked.context, 1, 0)).toBe(true);
		expect(locked.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Layer 1' })]]);
		expect(execute).not.toHaveBeenCalled();
	});

	it('leaves the key with no layer to nudge', () => {
		const { context } = contextFor(open(), { active: 'layer-9' });
		expect(nudgeLayers(context, 1, 0)).toBe(false);
	});
});

describe('the layers that move with the chosen', () => {
	it('are the chosen and the layers inside a chosen group, at any depth', () => {
		const layers = open(
			LAYERS.replace(
				'<g id="layer-5" draw:kind="vector" draw:name="Lid"><rect x="0" y="0" width="5" height="5"/></g>',
				'<g id="layer-5" draw:kind="group"><g id="layer-6" draw:kind="vector"><rect width="1" height="1"/></g></g>'
			)
		).snapshot().layers;
		expect(movesWith(layers, ['layer-1', 'layer-3'], 'layer-1')).toBe(true);
		expect(movesWith(layers, ['layer-1', 'layer-3'], 'layer-4')).toBe(true);
		expect(movesWith(layers, ['layer-1', 'layer-3'], 'layer-6')).toBe(true);
		expect(movesWith(layers, ['layer-1', 'layer-3'], 'layer-2')).toBe(false);
		expect(movesWith(layers, ['layer-1', 'layer-4'], 'layer-3')).toBe(false);
	});
});
