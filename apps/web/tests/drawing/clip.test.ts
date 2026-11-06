import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import { placeLayers } from '../../src/drawing/document/arrange.js';
import { turnCanvas } from '../../src/drawing/document/canvasOps.js';
import { clipToBelow, releaseClip } from '../../src/drawing/document/clip.js';
import { duplicateLayer, removeLayer, renameLayer } from '../../src/drawing/document/commands.js';
import { ungroupLayer } from '../../src/drawing/document/groups.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { arrangeLayers, type LayerExtent } from '../../src/drawing/tools/common/align.js';
import { layersMove, nudgeLayers } from '../../src/drawing/tools/common/layersMove.js';
import { createSelect } from '../../src/drawing/tools/raster/select.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import {
	type Box,
	IDENTITY,
	invert,
	type Mat,
	multiply,
	parseTransform,
	translate,
} from '../../src/drawing/tools/vector/geometry.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';

/**
 * A clip to the layer below (`document/clip.ts`) draws that layer inside the
 * mask where it is drawn on the canvas, whatever moved: the clip's `<use>`
 * carries the inverse of the clipped layer's own `transform`, written when
 * the clip is made and kept in the same step by every command that changes
 * that `transform`, and live while a drag moves it. Checked by where things
 * are drawn, through the transforms written, and by the bytes an undo gives
 * back. jsdom has no SVG geometry, so nothing here renders.
 */

const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

/** A shape, a layer turned a quarter over it, a raster picture, and a moved group of two layers. */
const LAYERS = `  <title>Clip</title>
  <g id="layer-1" draw:kind="vector" transform="translate(20 10)"><rect width="100" height="100"/></g>
  <g id="layer-2" draw:kind="vector" transform="matrix(0 1 -1 0 300 0)"><circle cx="50" cy="50" r="60"/></g>
  <g id="layer-3" draw:kind="raster" transform="translate(4 6)"><image href="${PICTURE}" x="0" y="0" width="50" height="50" preserveAspectRatio="none"/></g>
  <g id="layer-4" draw:kind="group" transform="rotate(30 50 50)">
    <g id="layer-5" draw:kind="vector" transform="translate(5 5)"><rect width="20" height="20"/></g>
    <g id="layer-6" draw:kind="vector"><rect width="40" height="40"/></g>
  </g>`;

const drawing = (body = LAYERS): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="d1" viewBox="0 0 400 300" width="400" height="300">`,
		body,
		'</svg>',
		'',
	].join('\n');

const open = (body?: string): EditorDocument => {
	const opened = openDocument(drawing(body));
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

const byId = (editor: EditorDocument, id: string): Element => {
	const found = editor.root.querySelector(`[id="${id}"]`);
	if (found === null) throw new Error(`no element ${id}`);
	return found;
};

const transformOf = (editor: EditorDocument, id: string): string | null =>
	byId(editor, id).getAttribute('transform');

/** Where an element's user units are in the root's, from the transforms written down to it. */
const placeIn = (root: Element, element: Element | null): Mat =>
	element === null || element === root
		? IDENTITY
		: multiply(
				placeIn(root, element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

const maskIdOf = (editor: EditorDocument, id: string): string =>
	/#([^)]+)\)/.exec(byId(editor, id).getAttribute('mask') ?? '')?.[1] ?? '';

const clipUseOf = (editor: EditorDocument, id: string): Element => {
	const use = byId(editor, maskIdOf(editor, id)).querySelector('use');
	if (use === null) throw new Error('the clip has a use');
	return use;
};

/**
 * Where the clip of the layer `id` draws the layer it names: the clipped
 * layer's user units, then the `<use>`'s `transform` and its `x` and `y`,
 * then the named layer's own `transform`, as SVG draws a `<use>` in a mask.
 */
const clipPlace = (editor: EditorDocument, id: string): Mat => {
	const use = clipUseOf(editor, id);
	const named = byId(editor, (use.getAttribute('href') ?? '').slice(1));
	const at = translate(Number(use.getAttribute('x') ?? 0), Number(use.getAttribute('y') ?? 0));
	return multiply(
		multiply(
			multiply(
				placeIn(editor.root, byId(editor, id)),
				parseTransform(use.getAttribute('transform'))
			),
			at
		),
		parseTransform(named.getAttribute('transform'))
	);
};

/** Where the layer the clip of `id` names is drawn on the canvas. */
const belowPlace = (editor: EditorDocument, id: string): Mat => {
	const named = byId(editor, (clipUseOf(editor, id).getAttribute('href') ?? '').slice(1));
	return placeIn(editor.root, named);
};

const expectMatrix = (actual: Mat, expected: Mat): void => {
	actual.forEach((value, index) => {
		expect(value).toBeCloseTo(expected[index] ?? Number.NaN, 6);
	});
};

/** The clip of `id` shows the layer below just where that layer is drawn. */
const expectClipTrue = (editor: EditorDocument, id: string): void => {
	expectMatrix(clipPlace(editor, id), belowPlace(editor, id));
};

/** The `<use>`'s `transform` is the inverse of the clipped layer's own. */
const expectInverse = (editor: EditorDocument, id: string): void => {
	expectMatrix(
		parseTransform(clipUseOf(editor, id).getAttribute('transform')),
		invert(parseTransform(transformOf(editor, id)))
	);
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

/** The viewport's context for an active layer and the layers chosen. */
const contextFor = (
	editor: EditorDocument,
	active: string,
	layers?: readonly string[]
): ToolContext =>
	createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === active),
		...(layers === undefined ? {} : { layers }),
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
		notify: vi.fn<(message: string) => void>(),
	});

/** The drawing with `layer-2` clipped to `layer-1`, the clip one step of the history. */
const clipped = (body?: string): EditorDocument => {
	const editor = open(body);
	editor.execute(clipToBelow(editor.root, 'layer-2'));
	return editor;
};

describe('a clip made', () => {
	it('carries the inverse of a turned layer’s transform, so the layer below shows where it is', () => {
		const editor = open();
		const before = editor.text();
		editor.execute(clipToBelow(editor.root, 'layer-2'));
		expect(clipUseOf(editor, 'layer-2').getAttribute('transform')).toBe(
			'matrix(0 -1 1 0 0 300)'
		);
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('writes a move’s inverse as a translation, and nothing for a layer with no transform', () => {
		const moved = open();
		moved.execute(clipToBelow(moved.root, 'layer-3'));
		expect(moved.text()).toContain(
			'<mask id="clip-layer-3" style="mask-type:alpha"><use href="#layer-2" transform="translate(-4 -6)"/></mask>'
		);
		expectClipTrue(moved, 'layer-3');
		const plain = open();
		plain.execute(clipToBelow(plain.root, 'layer-6'));
		expect(clipUseOf(plain, 'layer-6').hasAttribute('transform')).toBe(false);
		expectClipTrue(plain, 'layer-6');
	});

	it('leaves the use as it is for a transform it cannot read as one matrix', () => {
		const editor = open(LAYERS.replace('matrix(0 1 -1 0 300 0)', 'rotate(45deg)'));
		editor.execute(clipToBelow(editor.root, 'layer-2'));
		expect(clipUseOf(editor, 'layer-2').hasAttribute('transform')).toBe(false);
	});
});

describe('a clipped layer moved', () => {
	it('keeps the clip where the layer below is while it drags, and in the one command at its end', () => {
		const editor = clipped();
		const before = editor.text();
		const context = contextFor(editor, 'layer-2');
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(50, 30));
		expect(transformOf(editor, 'layer-2')).toBe('translate(40 20) matrix(0 1 -1 0 300 0)');
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		layersMove.end(context, at(50, 30));
		const after = editor.text();
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(before);
		editor.redo();
		expect(editor.text()).toBe(after);
	});

	it('puts the clip back with the layer on a cancel, and for a drag back to where it began', () => {
		const editor = clipped();
		const before = editor.text();
		const { version } = editor.snapshot();
		const context = contextFor(editor, 'layer-2');
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(50, 30));
		layersMove.cancel(context);
		expect(editor.text()).toBe(before);
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(50, 30));
		layersMove.end(context, at(10, 10));
		expect(editor.text()).toBe(before);
		expect(editor.snapshot().version).toBe(version);
	});

	it('keeps it through a nudge, one undo taking back the move and the clip', () => {
		const editor = clipped();
		const before = editor.text();
		const context = contextFor(editor, 'layer-2');
		expect(nudgeLayers(context, 10, 0)).toBe(true);
		expect(transformOf(editor, 'layer-2')).toBe('translate(10 0) matrix(0 1 -1 0 300 0)');
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('keeps it through an alignment', async () => {
		const editor = clipped();
		const before = editor.text();
		const extent: LayerExtent = (id) =>
			Promise.resolve<Box | undefined>(
				id === 'layer-2' ? { x: 200, y: 40, width: 120, height: 120 } : undefined
			);
		const context = contextFor(editor, 'layer-2');
		expect(
			await arrangeLayers(context, { kind: 'align', edge: 'left' }, 'canvas', extent)
		).toBe(true);
		expect(transformOf(editor, 'layer-2')).toBe('translate(-200 0) matrix(0 1 -1 0 300 0)');
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('keeps the clip of a raster layer moved whole by the select tool', () => {
		const editor = open();
		editor.execute(clipToBelow(editor.root, 'layer-3'));
		const before = editor.text();
		const select = createSelect();
		const context = contextFor(editor, 'layer-3');
		select.begin(context, at(0, 0));
		select.move(context, at(7, 9));
		expect(clipUseOf(editor, 'layer-3').getAttribute('transform')).toBe('translate(-11 -15)');
		select.end(context, at(7, 9));
		expect(transformOf(editor, 'layer-3')).toBe('translate(11 15)');
		expect(clipUseOf(editor, 'layer-3').getAttribute('transform')).toBe('translate(-11 -15)');
		expectClipTrue(editor, 'layer-3');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('leaves the clip of a layer whose own transform does not change: the layer below moved', () => {
		const editor = clipped();
		const use = clipUseOf(editor, 'layer-2').getAttribute('transform');
		nudgeLayers(contextFor(editor, 'layer-1'), 5, 5);
		expect(clipUseOf(editor, 'layer-2').getAttribute('transform')).toBe(use);
		expectClipTrue(editor, 'layer-2');
	});
});

describe('a clip in a group', () => {
	/** The group's two layers, the upper clipped to the lower. */
	const grouped = (): EditorDocument => {
		const editor = open();
		editor.execute(clipToBelow(editor.root, 'layer-6'));
		return editor;
	};

	it('needs nothing when the group moves, since the group’s transform is common to both', () => {
		const editor = grouped();
		const mask = byId(editor, 'clip-layer-6').outerHTML;
		nudgeLayers(contextFor(editor, 'layer-4'), 30, -10);
		expect(transformOf(editor, 'layer-4')).toBe('translate(30 -10) rotate(30 50 50)');
		expect(byId(editor, 'clip-layer-6').outerHTML).toBe(mask);
		expectClipTrue(editor, 'layer-6');
	});

	it('is kept as an ungroup gives each layer the group’s transform', () => {
		const editor = grouped();
		const before = editor.text();
		editor.execute(ungroupLayer(editor.root, 'layer-4'));
		expect(transformOf(editor, 'layer-6')).toBe('rotate(30 50 50)');
		expectInverse(editor, 'layer-6');
		expectClipTrue(editor, 'layer-6');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('is kept as the two are carried out of the group together, each drawn where it was', () => {
		const editor = grouped();
		const before = editor.text();
		editor.execute(
			placeLayers(editor.root, ['layer-5', 'layer-6'], {
				parentId: undefined,
				aboveId: 'layer-3',
			})
		);
		expect(byId(editor, 'layer-6').parentElement).toBe(editor.root);
		expectInverse(editor, 'layer-6');
		expectClipTrue(editor, 'layer-6');
		editor.undo();
		expect(editor.text()).toBe(before);
	});
});

describe('a duplicate of a clipped layer', () => {
	it('shares the mask until one of the two moves, which then gets a mask of its own', () => {
		const editor = clipped();
		const copy = duplicateLayer(editor.root, 'layer-2');
		editor.execute(copy);
		expect(maskIdOf(editor, copy.id)).toBe('clip-layer-2');
		const shared = byId(editor, 'clip-layer-2').outerHTML;
		const before = editor.text();
		nudgeLayers(contextFor(editor, copy.id), 0, 25);
		expect(maskIdOf(editor, copy.id)).toBe(`clip-${copy.id}`);
		expect(maskIdOf(editor, 'layer-2')).toBe('clip-layer-2');
		expect(byId(editor, 'clip-layer-2').outerHTML).toBe(shared);
		expectInverse(editor, copy.id);
		expectClipTrue(editor, copy.id);
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(before);
	});

	it('keeps sharing it when both move together', () => {
		const editor = clipped();
		const copy = duplicateLayer(editor.root, 'layer-2');
		editor.execute(copy);
		nudgeLayers(contextFor(editor, 'layer-2', ['layer-2', copy.id]), -3, 0);
		expect(maskIdOf(editor, copy.id)).toBe('clip-layer-2');
		expect(editor.root.querySelectorAll('mask')).toHaveLength(1);
		expectClipTrue(editor, copy.id);
		expectClipTrue(editor, 'layer-2');
	});

	it('shows a mask of its own while it drags, and leaves the document as it was on a cancel', () => {
		const editor = clipped();
		const copy = duplicateLayer(editor.root, 'layer-2');
		editor.execute(copy);
		const before = editor.text();
		const context = contextFor(editor, copy.id);
		layersMove.begin(context, at(0, 0));
		layersMove.move(context, at(12, 0));
		expect(maskIdOf(editor, copy.id)).toBe(`clip-${copy.id}`);
		expectClipTrue(editor, copy.id);
		expectClipTrue(editor, 'layer-2');
		layersMove.cancel(context);
		expect(editor.text()).toBe(before);
	});

	it('lets its own mask go with a release of its clip, and keeps the original’s', () => {
		const editor = clipped();
		const copy = duplicateLayer(editor.root, 'layer-2');
		editor.execute(copy);
		nudgeLayers(contextFor(editor, copy.id), 0, 25);
		editor.execute(releaseClip(editor.root, copy.id));
		expect(editor.root.querySelector(`[id="clip-${copy.id}"]`)).toBeNull();
		expect(maskIdOf(editor, 'layer-2')).toBe('clip-layer-2');
	});
});

describe('a file whose clip does not carry the inverse', () => {
	/** Made before the clip kept itself, or by hand: `layer-2` turned, its `<use>` with no transform. */
	const OLD = LAYERS.replace(
		'  <title>Clip</title>',
		'  <title>Clip</title>\n  <defs><mask id="clip-layer-2" style="mask-type:alpha"><use href="#layer-1"/></mask></defs>'
	).replace(
		'transform="matrix(0 1 -1 0 300 0)"',
		'transform="matrix(0 1 -1 0 300 0)" mask="url(#clip-layer-2)"'
	);

	it('is not rewritten on open, nor by an edit that leaves the clipped layer’s transform alone', () => {
		const editor = open(OLD);
		expect(editor.text()).toBe(drawing(OLD));
		expect(editor.snapshot().dirty).toBe(false);
		editor.execute(renameLayer('layer-2', 'Sun'));
		nudgeLayers(contextFor(editor, 'layer-1'), 5, 0);
		expect(clipUseOf(editor, 'layer-2').hasAttribute('transform')).toBe(false);
	});

	it('is made true by the first change to that transform, one undo taking both back', () => {
		const editor = open(OLD);
		nudgeLayers(contextFor(editor, 'layer-2'), 5, 0);
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(drawing(OLD));
	});

	it('is made true by a turn of the canvas', () => {
		const editor = open(OLD);
		editor.execute(turnCanvas(editor.root, editor.size, 'rotate90ccw'));
		expectInverse(editor, 'layer-2');
		expectClipTrue(editor, 'layer-2');
		editor.undo();
		expect(editor.text()).toBe(drawing(OLD));
	});
});

describe('deleting the layer a clip names', () => {
	it('leaves the clip, which a move of the clipped layer still keeps', () => {
		const editor = clipped();
		editor.execute(removeLayer('layer-1'));
		expect(maskIdOf(editor, 'layer-2')).toBe('clip-layer-2');
		nudgeLayers(contextFor(editor, 'layer-2'), 1, 1);
		expectInverse(editor, 'layer-2');
	});
});
