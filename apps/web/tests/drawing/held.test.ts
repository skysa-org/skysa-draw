import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { asReached } from '../../src/drawing/tools/common/held.js';
import { nudgeLayers } from '../../src/drawing/tools/common/layersMove.js';
import { behaviorFor, toolById } from '../../src/drawing/tools/index.js';
import { guardedLayer } from '../../src/drawing/tools/raster/guard.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type Tool,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { guardLayer } from '../../src/drawing/tools/vector/guard.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';

/**
 * A layer held by a group (docs/ARCHITECTURE.md §7, "The editor"): what a
 * locked or a hidden group holds shares its lock and its visibility, so every
 * tool's guard refuses a layer inside one, as it refuses one locked or hidden
 * itself, and names the nearest layer or group that holds it, in the words it
 * always used. A lock still lets a tool read the pixels; hiding does not.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

/** A group named Outer holding a group named Inner, which holds a vector layer and a raster one; a vector layer beside them. */
const nested = (outer = '', inner = '', vector = '') =>
	[
		`<g id="layer-1" draw:kind="group" draw:name="Outer"${outer}>`,
		`<g id="layer-2" draw:kind="group" draw:name="Inner"${inner}>`,
		`<g id="layer-3" draw:kind="vector"${vector}><rect x="10" y="10" width="20" height="20"/></g>`,
		`<g id="layer-4" draw:kind="raster"><image href="${PICTURE}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/></g>`,
		'</g>',
		'</g>',
		'<g id="layer-5" draw:kind="vector"><rect x="50" y="50" width="20" height="20"/></g>',
	].join('\n');

const open = (layers: string): EditorDocument => {
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

const contextFor = (editor: EditorDocument, active: string, chosen?: readonly string[]) => {
	const notify = vi.fn<(message: string) => void>();
	const context: ToolContext = createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === active),
		...(chosen === undefined ? {} : { layers: chosen }),
		options: DEFAULT_TOOL_OPTIONS,
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		canvas: document.createElement('canvas'),
		pixelRatio: () => 1,
		view: observable(IDENTITY_VIEW),
		selection: observable<readonly Element[]>([]),
		region: observable<Region | undefined>(undefined),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify,
	});
	return { context, notify };
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

const LOCKED = ' draw:locked="true"';
const HIDDEN = ' display="none"';

describe('a vector tool’s guard', () => {
	it('refuses a layer in a locked or a hidden group, naming the nearest that holds it', () => {
		const outer = contextFor(open(nested(LOCKED)), 'layer-3');
		expect(guardLayer(outer.context)).toBeUndefined();
		expect(outer.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Outer' })]]);
		const both = contextFor(open(nested(LOCKED, HIDDEN)), 'layer-3');
		expect(guardLayer(both.context)).toBeUndefined();
		expect(both.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Inner' })]]);
		const itself = contextFor(open(nested(LOCKED, '', HIDDEN)), 'layer-3');
		expect(guardLayer(itself.context)).toBeUndefined();
		expect(itself.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Layer 3' })]]);
	});

	it('lets a layer through that nothing holds, beside a locked group', () => {
		const { context, notify } = contextFor(open(nested(LOCKED)), 'layer-5');
		expect(guardLayer(context)?.id).toBe('layer-5');
		expect(notify).not.toHaveBeenCalled();
	});

	it('keeps the rectangle tool from drawing on a layer in a locked group', () => {
		const editor = open(nested(LOCKED));
		const original = editor.text();
		const { context, notify } = contextFor(editor, 'layer-3');
		const rectangle = behaviorFor(toolById('rectangle') as Tool, 'vector');
		rectangle?.begin(context, at(60, 10));
		rectangle?.move(context, at(80, 30));
		rectangle?.end(context, at(80, 30));
		expect(editor.text()).toBe(original);
		expect(notify.mock.calls[0]).toEqual([t('layers.locked', { name: 'Outer' })]);
	});
});

describe('a raster tool’s guard', () => {
	it('refuses a change to a layer in a locked group, and lets the pixels be read', () => {
		const editor = open(nested('', LOCKED));
		const change = contextFor(editor, 'layer-4');
		expect(guardedLayer(change.context)).toBeUndefined();
		expect(change.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Inner' })]]);
		const read = contextFor(editor, 'layer-4');
		expect(guardedLayer(read.context, 'read')?.id).toBe('layer-4');
		expect(read.notify).not.toHaveBeenCalled();
	});

	it('refuses even a read of a layer in a hidden group', () => {
		const { context, notify } = contextFor(open(nested(HIDDEN)), 'layer-4');
		expect(guardedLayer(context, 'read')).toBeUndefined();
		expect(notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Outer' })]]);
	});

	it('keeps the move tool from moving a raster layer in a locked group whole', () => {
		const editor = open(nested(LOCKED));
		const { context, notify } = contextFor(editor, 'layer-4');
		const move = behaviorFor(toolById('select') as Tool, 'raster');
		move?.begin(context, at(5, 5));
		move?.move(context, at(15, 5));
		move?.end(context, at(15, 5));
		expect(editor.root.querySelector('[id="layer-4"]')?.hasAttribute('transform')).toBe(false);
		expect(notify.mock.calls).toEqual([[t('layers.locked', { name: 'Outer' })]]);
	});
});

describe('the move of layers chosen', () => {
	it('is refused whole where one of them is in a locked group, which is named', () => {
		const editor = open(nested('', LOCKED));
		const { context, notify } = contextFor(editor, 'layer-5', ['layer-3', 'layer-5']);
		expect(nudgeLayers(context, 1, 0)).toBe(true);
		expect(editor.snapshot().canUndo).toBe(false);
		expect(notify.mock.calls).toEqual([[t('layers.locked', { name: 'Inner' })]]);
	});
});

describe('asReached', () => {
	const reached = (document: EditorDocument, id: string) => {
		const { layers } = document.snapshot();
		const layer = layers.find((each) => each.id === id);
		if (layer === undefined) throw new Error(`no ${id}`);
		return asReached(layers, layer);
	};

	it('is the layer locked where a group around it is, and hidden where one is', () => {
		const locked = open(nested(LOCKED));
		expect(reached(locked, 'layer-3')).toMatchObject({ locked: true, hidden: false });
		const hidden = open(nested('', HIDDEN));
		expect(reached(hidden, 'layer-4')).toMatchObject({ locked: false, hidden: true });
	});

	it('is the layer as it is where nothing around it holds it', () => {
		const document = open(nested('', '', LOCKED));
		expect(reached(document, 'layer-3')).toMatchObject({ locked: true, hidden: false });
		expect(reached(document, 'layer-4')).toMatchObject({ locked: false, hidden: false });
		expect(reached(document, 'layer-5')).toMatchObject({ locked: false, hidden: false });
	});
});
