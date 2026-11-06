import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editLayer } from '../../src/drawing/document/commands.js';
import { transformElements } from '../../src/drawing/document/elements.js';
import type { Command, EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { toolById } from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type Tool,
	type ToolContext,
} from '../../src/drawing/tools/types.js';
import { arrangeElements } from '../../src/drawing/tools/vector/alignElements.js';
import {
	apply,
	multiply,
	parseTransform,
	type Point,
} from '../../src/drawing/tools/vector/geometry.js';
import { layerSpace } from '../../src/drawing/tools/vector/guard.js';
import { attributeBox } from '../../src/drawing/tools/vector/measure.js';
import { Viewport } from '../../src/drawing/Viewport.js';
import { nudgeWith } from '../../src/drawing/viewport/chosenLayers.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { createViewportSelection } from '../../src/drawing/viewport/selectionState.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';
import { installFakeCanvas, uninstallFakeCanvas } from './fakeCanvas.js';

/**
 * The arrows with the move tool on one layer (docs/ARCHITECTURE.md §7, "The
 * editor"), past an area's pixels, which `moveArea.test.ts` nudges, and the
 * layers chosen, which `layersMove.test.ts` does: the elements selected on a
 * vector layer moved by their own `transform`s, along the drawing's axes
 * whatever the layer's placement, and with nothing selected the layer whole,
 * as Photoshop's move tool moves it. Against a real document; jsdom lays
 * nothing out and has no SVG geometry, so the view is the identity and an
 * element's box is read from its attributes.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A picture's bytes, never decoded: the nudge writes the layer's `<g>`, not its pixels. */
const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

/** Bottom to top: a raster layer, a vector one of two rectangles, and a vector one turned 30°. */
const LAYERS = [
	`<g id="layer-1" draw:kind="raster"><image href="${PICTURE}" x="0" y="0" width="10" height="10" preserveAspectRatio="none"/></g>`,
	'<g id="layer-2" draw:kind="vector"><rect id="card" x="60" y="60" width="20" height="20"/><rect id="chip" x="10" y="10" width="5" height="5"/></g>',
	'<g id="layer-3" draw:kind="vector" transform="rotate(30 50 50)"><rect id="tilted" x="40" y="40" width="10" height="10"/></g>',
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

const elementOf = (editor: EditorDocument, id: string): Element => {
	const found = editor.root.querySelector(`[id="${id}"]`);
	if (found === null) throw new Error(`the drawing has #${id}`);
	return found;
};

const transformOf = (editor: EditorDocument, id: string): string | null =>
	elementOf(editor, id).getAttribute('transform');

/** The viewport's context for an active layer, the elements selected and an area, with what it tells the user kept. */
const contextFor = (
	editor: EditorDocument,
	active: string,
	setup: Readonly<{ selected?: readonly string[]; region?: Region }> = {}
) => {
	const notify = vi.fn<(message: string) => void>();
	const selection = observable<readonly Element[]>(
		(setup.selected ?? []).map((id) => elementOf(editor, id))
	);
	const context: ToolContext = createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === active),
		layers: [active],
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

/** Where a point of an element is drawn in the drawing: its own `transform`, then its layer's. */
const drawnAt = (editor: EditorDocument, id: string, point: Point): Point => {
	const element = elementOf(editor, id);
	const { outOf } = layerSpace(element.parentElement ?? undefined);
	return apply(multiply(outOf, parseTransform(element.getAttribute('transform'))), point);
};

describe('the arrows on the elements selected on a vector layer', () => {
	it('moves them by their own transforms, each key one command labeled as the drag’s, and keeps them selected', () => {
		const editor = open();
		const original = editor.text();
		const execute = vi.spyOn(editor, 'execute');
		const { context, selection } = contextFor(editor, 'layer-2', {
			selected: ['card', 'chip'],
		});
		expect(nudgeWith(context, [1, 0], false)).toBe(true);
		expect(nudgeWith(context, [0, 10], false)).toBe(true);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(execute.mock.calls.map(([command]) => command.label)).toEqual([
			'tools.select',
			'tools.select',
		]);
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 1 10)');
		expect(transformOf(editor, 'chip')).toBe('matrix(1 0 0 1 1 10)');
		expect(transformOf(editor, 'layer-2')).toBeNull();
		expect(selection.get()).toEqual([elementOf(editor, 'card'), elementOf(editor, 'chip')]);
		const [card, chip] = selection.get();
		editor.undo();
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 1 0)');
		editor.undo();
		expect(editor.text()).toBe(original);
		editor.redo();
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 1 0)');
		// The same nodes through the undos and the redo: what was selected still is, and the next key moves it again.
		expect([elementOf(editor, 'card'), elementOf(editor, 'chip')]).toEqual([card, chip]);
		expect(elementOf(editor, 'card')).toBe(card);
		expect(nudgeWith(context, [1, 0], false)).toBe(true);
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 2 0)');
		expect(transformOf(editor, 'layer-2')).toBeNull();
	});

	it('moves only what is selected on the active layer, and draws its box again where it went', () => {
		const editor = open();
		const { context } = contextFor(editor, 'layer-2', { selected: ['chip', 'tilted'] });
		expect(nudgeWith(context, [-1, 0], false)).toBe(true);
		expect(transformOf(editor, 'chip')).toBe('matrix(1 0 0 1 -1 0)');
		expect(transformOf(editor, 'card')).toBeNull();
		expect(transformOf(editor, 'tilted')).toBeNull();
		const box = context.overlay.querySelector(
			'[data-draw-selection] > rect:not([data-handle])'
		);
		expect(['x', 'y', 'width', 'height'].map((name) => box?.getAttribute(name))).toEqual([
			'9',
			'10',
			'5',
			'5',
		]);
	});

	it('moves them along the drawing’s axes on a turned layer, as far as on any other', () => {
		const editor = open();
		const { context } = contextFor(editor, 'layer-3', { selected: ['tilted'] });
		const corner = { x: 40, y: 40 };
		const before = drawnAt(editor, 'tilted', corner);
		const movedBy = (): Point => {
			const now = drawnAt(editor, 'tilted', corner);
			return { x: now.x - before.x, y: now.y - before.y };
		};
		expect(nudgeWith(context, [10, 0], false)).toBe(true);
		expect(movedBy().x).toBeCloseTo(10, 2);
		expect(movedBy().y).toBeCloseTo(0, 2);
		expect(nudgeWith(context, [0, -1], false)).toBe(true);
		expect(movedBy().x).toBeCloseTo(10, 2);
		expect(movedBy().y).toBeCloseTo(-1, 2);
		expect(transformOf(editor, 'layer-3')).toBe('rotate(30 50 50)');
	});
});

describe('the arrows on a loose element selected', () => {
	it('wrap its layer first, as a drag does, and move it inside', () => {
		const editor = open('<rect id="layer-1" x="10" y="10" width="5" height="5"/>');
		const { context, selection } = contextFor(editor, 'layer-1', { selected: ['layer-1'] });
		expect(nudgeWith(context, [1, 0], false)).toBe(true);
		const rect = editor.root.querySelector('rect');
		expect(rect?.parentElement?.id).toBe('layer-1');
		expect(rect?.getAttribute('transform')).toBe('matrix(1 0 0 1 1 0)');
		expect(selection.get()).toEqual([rect]);
	});
});

describe('the arrows on the active layer with nothing selected on it', () => {
	it('move a vector layer whole, by one command, letting go of what was selected elsewhere', () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const { context, selection } = contextFor(editor, 'layer-2', { selected: ['tilted'] });
		expect(nudgeWith(context, [1, 0], false)).toBe(true);
		expect(nudgeWith(context, [0, 10], false)).toBe(true);
		expect(execute).toHaveBeenCalledTimes(2);
		expect(transformOf(editor, 'layer-2')).toBe('translate(1 10)');
		expect(transformOf(editor, 'card')).toBeNull();
		expect(transformOf(editor, 'tilted')).toBeNull();
		expect(selection.get()).toEqual([]);
		editor.undo();
		expect(transformOf(editor, 'layer-2')).toBe('translate(1 0)');
	});

	it('move a loose element at the root by its own transform, which is the layer’s, wrapping nothing', () => {
		const editor = open('<rect id="layer-1" x="10" y="10" width="5" height="5"/>');
		const { context } = contextFor(editor, 'layer-1');
		expect(nudgeWith(context, [0, 1], false)).toBe(true);
		expect(editor.root.querySelector('g')).toBeNull();
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 1)');
	});

	it('move a turned layer along the drawing’s axes, in front of its own transform', () => {
		const editor = open();
		const { context } = contextFor(editor, 'layer-3');
		expect(nudgeWith(context, [-10, 0], false)).toBe(true);
		expect(transformOf(editor, 'layer-3')).toBe('translate(-10 0) rotate(30 50 50)');
	});

	it('move a raster layer whole with no area, and where its area does not reach its pixels, as a drag does', () => {
		const editor = open();
		const none = contextFor(editor, 'layer-1');
		expect(nudgeWith(none.context, [0, 1], false)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(0 1)');
		const away = contextFor(editor, 'layer-1', {
			region: { path: 'M 80 80 L 90 80 L 90 90 L 80 90 Z', inverted: false, feather: 0 },
		});
		expect(nudgeWith(away.context, [1, 0], false)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(1 1)');
		expect(away.context.region.region).toBeDefined();
	});
});

describe('the arrows on a layer that may not change', () => {
	it('take the key and move nothing on a locked or a hidden layer, and say so', () => {
		const editor = open(
			LAYERS.replace('id="layer-2"', 'id="layer-2" draw:locked="true"').replace(
				'id="layer-1"',
				'id="layer-1" display="none"'
			)
		);
		const execute = vi.spyOn(editor, 'execute');
		const selected = contextFor(editor, 'layer-2', { selected: ['card'] });
		expect(nudgeWith(selected.context, [1, 0], false)).toBe(true);
		const whole = contextFor(editor, 'layer-2');
		expect(nudgeWith(whole.context, [1, 0], false)).toBe(true);
		const hidden = contextFor(editor, 'layer-1');
		expect(nudgeWith(hidden.context, [1, 0], false)).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(selected.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Layer 2' })]]);
		expect(whole.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Layer 2' })]]);
		expect(hidden.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Layer 1' })]]);
	});

	it('take the key and move nothing on a layer in a locked or a hidden group, which is named', () => {
		const grouped = (attributes: string) =>
			open(
				[
					`<g id="layer-1" draw:kind="group" draw:name="Folder"${attributes}>`,
					'<g id="layer-2" draw:kind="vector"><rect id="card" x="60" y="60" width="20" height="20"/></g>',
					'</g>',
				].join('\n')
			);
		const locked = grouped(' draw:locked="true"');
		const execute = vi.spyOn(locked, 'execute');
		const selected = contextFor(locked, 'layer-2', { selected: ['card'] });
		expect(nudgeWith(selected.context, [1, 0], false)).toBe(true);
		const whole = contextFor(locked, 'layer-2');
		expect(nudgeWith(whole.context, [1, 0], false)).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(selected.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Folder' })]]);
		expect(whole.notify.mock.calls).toEqual([[t('layers.locked', { name: 'Folder' })]]);
		const hidden = contextFor(grouped(' display="none"'), 'layer-2');
		expect(nudgeWith(hidden.context, [1, 0], false)).toBe(true);
		expect(hidden.notify.mock.calls).toEqual([[t('layers.hidden', { name: 'Folder' })]]);
		expect(transformOf(locked, 'card')).toBeNull();
		expect(transformOf(locked, 'layer-2')).toBeNull();
	});

	it('take the key and move nothing while a stroke is under way, and say nothing', () => {
		const editor = open();
		const execute = vi.spyOn(editor, 'execute');
		const selected = contextFor(editor, 'layer-2', { selected: ['card'] });
		expect(nudgeWith(selected.context, [1, 0], true)).toBe(true);
		const whole = contextFor(editor, 'layer-1');
		expect(nudgeWith(whole.context, [1, 0], true)).toBe(true);
		expect(execute).not.toHaveBeenCalled();
		expect(selected.notify).not.toHaveBeenCalled();
	});

	it('leave the key with no active layer', () => {
		const { context } = contextFor(open(), 'layer-9');
		expect(nudgeWith(context, [1, 0], false)).toBe(false);
	});
});

describe('the move of elements by their transforms', () => {
	it('undoes to the very text, an attribute taken off put back where it was among the others', () => {
		const editor = open(
			'<g id="layer-1" draw:kind="vector"><rect id="card" transform="matrix(1 0 0 1 1 0)" x="60" y="60" width="20" height="20"/></g>'
		);
		const original = editor.text();
		const card = elementOf(editor, 'card');
		editor.execute(transformElements('layer-1', 'tools.select', [{ position: 0, value: '' }]));
		expect(card.hasAttribute('transform')).toBe(false);
		editor.undo();
		expect(editor.text()).toBe(original);
		expect(elementOf(editor, 'card')).toBe(card);
		editor.redo();
		expect(card.hasAttribute('transform')).toBe(false);
		editor.undo();
		expect(editor.text()).toBe(original);
	});

	it('finds the elements by their positions after a layer edit put the layer back', () => {
		const editor = open();
		editor.execute(
			transformElements('layer-2', 'tools.select', [
				{ position: 1, value: 'matrix(1 0 0 1 5 0)' },
			])
		);
		editor.execute(
			editLayer('layer-2', 'tools.pen', (layer) => layer.setAttribute('opacity', '0.5'))
		);
		editor.undo();
		editor.undo();
		expect(transformOf(editor, 'chip')).toBeNull();
		editor.redo();
		expect(transformOf(editor, 'chip')).toBe('matrix(1 0 0 1 5 0)');
	});

	it('records nothing where it finds nothing', () => {
		const editor = open();
		const command = transformElements('layer-9', 'tools.select', [{ position: 0, value: 'x' }]);
		command.apply(editor.root);
		expect(command.bytes).toBe(0);
	});

	it('costs the history the attribute it changed, on a layer of hundreds of strokes', () => {
		const stroke = (n: number) =>
			`<path d="M ${n} 0 ${Array.from({ length: 80 }, (_, i) => `L ${n + i} ${i * 2}`).join(' ')} Z"/>`;
		const editor = open(
			`<g id="layer-1" draw:kind="vector">${Array.from({ length: 300 }, (_, n) => stroke(n)).join('')}</g>`
		);
		const execute = vi.spyOn(editor, 'execute');
		const path = editor.root.querySelector('path');
		if (path === null) throw new Error('the layer has strokes');
		const { context } = contextFor(editor, 'layer-1');
		context.selection.set([path]);
		expect(nudgeWith(context, [1, 0], false)).toBe(true);
		const nudge = execute.mock.calls[0]?.[0] as Command;
		const layerEdit = editLayer('layer-1', 'tools.select', () => undefined);
		layerEdit.apply(editor.root);
		expect(nudge.bytes).toBeLessThan(100);
		// The layer edit a nudge was before: the layer copied twice, some 440 kB of the history's 256 MB a key.
		expect(layerEdit.bytes).toBeGreaterThan(400_000);
	});

	it('keeps what Align moved selected through an undo, on the same nodes', () => {
		const editor = open();
		const { context, selection } = contextFor(editor, 'layer-2', {
			selected: ['card', 'chip'],
		});
		const [card, chip] = selection.get();
		expect(
			arrangeElements(context, { kind: 'align', edge: 'left' }, 'selection', attributeBox)
		).toBe(true);
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 -50 0)');
		editor.undo();
		expect(transformOf(editor, 'card')).toBeNull();
		expect([elementOf(editor, 'card'), elementOf(editor, 'chip')]).toEqual([card, chip]);
		editor.redo();
		expect(elementOf(editor, 'card')).toBe(card);
	});
});

const arrow = (key: string, init: KeyboardEventInit = {}): KeyboardEvent =>
	new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });

const fire = (target: EventTarget, event: Event): void => {
	act(() => {
		target.dispatchEvent(event);
	});
};

const pointer = (
	type: 'pointerdown' | 'pointermove' | 'pointerup',
	clientX: number,
	clientY: number
) =>
	new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: 0,
		buttons: type === 'pointerup' ? 0 : 1,
		clientX,
		clientY,
	});

describe('the arrows in the viewport, with the move tool', () => {
	beforeEach(() => {
		installFakeCanvas();
	});

	afterEach(() => {
		uninstallFakeCanvas();
	});

	/** The drawing in the viewport, the move tool in hand on `layerId`. */
	const mount = (layerId: string) => {
		const editor = open();
		const selection = createViewportSelection();
		const onNotify = vi.fn<(message: string) => void>();
		const utils = render(
			<Viewport
				document={editor}
				tool={toolById('select') as Tool}
				options={DEFAULT_TOOL_OPTIONS}
				layerId={layerId}
				selectedLayerIds={[layerId]}
				selection={selection}
				onColor={noop}
				onNotify={onNotify}
			/>
		);
		const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
		const boxes = () =>
			[
				...utils.container.querySelectorAll(
					'.viewport-overlay [data-draw-selection] > rect:not([data-handle])'
				),
			].map((rect) =>
				['x', 'y', 'width', 'height'].map((name) => rect.getAttribute(name)).join(' ')
			);
		return { ...utils, editor, selection, onNotify, region, boxes };
	};

	it('nudges the element a click selected, a unit or ten with Shift, its box following', () => {
		const { editor, selection, region, boxes } = mount('layer-2');
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointerup', 70, 70));
		expect(selection.elements.get()).toEqual([elementOf(editor, 'card')]);
		const right = arrow('ArrowRight');
		fire(window, right);
		expect(right.defaultPrevented).toBe(true);
		fire(window, arrow('ArrowUp', { shiftKey: true }));
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 1 -10)');
		expect(selection.elements.get()).toEqual([elementOf(editor, 'card')]);
		expect(boxes()).toEqual(['61 50 20 20']);
		act(() => {
			editor.undo();
		});
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 1 0)');
		// Still selected, its box where it went back to; the redo and the next key move it.
		expect(selection.elements.get()).toEqual([elementOf(editor, 'card')]);
		expect(boxes()).toEqual(['61 60 20 20']);
		act(() => {
			editor.redo();
		});
		expect(boxes()).toEqual(['61 50 20 20']);
		act(() => {
			editor.undo();
		});
		fire(window, arrow('ArrowRight'));
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 2 0)');
		expect(transformOf(editor, 'layer-2')).toBeNull();
		expect(boxes()).toEqual(['62 60 20 20']);
	});

	it('keeps what a drag moved selected through its undo, and the arrows move it next', () => {
		const { editor, selection, region, boxes } = mount('layer-2');
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointermove', 75, 72));
		fire(region, pointer('pointerup', 75, 72));
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 5 2)');
		act(() => {
			editor.undo();
		});
		expect(transformOf(editor, 'card')).toBeNull();
		expect(selection.elements.get()).toEqual([elementOf(editor, 'card')]);
		expect(boxes()).toEqual(['60 60 20 20']);
		fire(window, arrow('ArrowDown'));
		expect(transformOf(editor, 'card')).toBe('matrix(1 0 0 1 0 1)');
		expect(transformOf(editor, 'layer-2')).toBeNull();
	});

	it('nudges the layer whole with nothing selected on it', () => {
		const { editor, region } = mount('layer-2');
		// A click on nothing: nothing is selected.
		fire(region, pointer('pointerdown', 40, 40));
		fire(region, pointer('pointerup', 40, 40));
		fire(window, arrow('ArrowLeft'));
		expect(transformOf(editor, 'layer-2')).toBe('translate(-1 0)');
		expect(transformOf(editor, 'card')).toBeNull();
	});

	it('leaves a key some control took, a key with a modifier, and a key in a field', () => {
		const { editor, container } = mount('layer-2');
		const taken = arrow('ArrowRight');
		taken.preventDefault();
		fire(window, taken);
		fire(window, arrow('ArrowRight', { altKey: true }));
		const field = document.createElement('input');
		container.append(field);
		fire(field, arrow('ArrowRight'));
		expect(transformOf(editor, 'layer-2')).toBeNull();
		expect(editor.snapshot().canUndo).toBe(false);
	});
});
