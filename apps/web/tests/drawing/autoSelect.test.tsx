import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { autoSelect } from '../../src/drawing/tools/common/autoSelect.js';
import { toolById } from '../../src/drawing/tools/index.js';
import { cachedSurface, surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type Tool,
	type ToolContext,
	type ToolId,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { attributeBox } from '../../src/drawing/tools/vector/measure.js';
import { Viewport } from '../../src/drawing/Viewport.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import {
	createViewportSelection,
	type ViewportSelection,
} from '../../src/drawing/viewport/selectionState.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { t } from '../../src/i18n/t.js';
import {
	fakeOf,
	installFakeCanvas,
	pictureAt,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * The move tool's Auto-Select (docs/decisions/0004-the-interface.md), as
 * Photoshop's in its Layer mode: a press picks the topmost layer with
 * something under it, more than half opaque as seen, the viewport makes it
 * the active one, and the press goes on as the move tool's on that layer.
 * Against a real document, the real select tool and the compositing fake
 * canvas (`fakeCanvas.ts`), which draws an `<image>` by its `href`. jsdom
 * lays nothing out and has no SVG geometry, so the view is the identity, a
 * screen point is a user point, every layer is in the root's units, one
 * pixel to a unit, and an element's box is read from its attributes.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

type Rgba = readonly [number, number, number, number];

const RED: Rgba = [255, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** A picture the size of the canvas, opaque red where x < 50 and clear elsewhere. */
const leftHalf = (): string => registerPicture(100, 100, (x) => (x < 50 ? RED : CLEAR));

/** A picture the size of the canvas, every pixel black at `alpha`. */
const atAlpha = (alpha: number): string => registerPicture(100, 100, () => [0, 0, 0, alpha]);

/** An `<image>` filling `width` × `height` from the origin, as the app writes a raster layer's. */
const image = (href: string, width = 100, height = 100): string =>
	`<image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="none"/>`;

/** A drawing of these layers, bottom to top, on a canvas of 100 × 100. */
const drawingText = (layers: string): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 100 100" width="100" height="100">`,
		layers,
		'</svg>',
		'',
	].join('\n');

const open = (layers: string): EditorDocument => {
	const opened = openDocument(drawingText(layers));
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

const noop = (): undefined => undefined;

const pressAt = (x: number, y: number, init: Partial<PointerSample> = {}): PointerSample => ({
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
	...init,
});

const ON: ToolOptions = { ...DEFAULT_TOOL_OPTIONS, autoSelect: true };

type ContextSetup = Readonly<{
	active?: string;
	options?: ToolOptions;
	scale?: number;
	selected?: readonly Element[];
}>;

/** The viewport's own context, for a document and an active layer. */
const contextFor = (editor: EditorDocument, setup: ContextSetup = {}): ToolContext =>
	createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === (setup.active ?? 'layer-1')),
		options: setup.options ?? ON,
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		canvas: document.createElement('canvas'),
		pixelRatio: () => 1,
		view: observable({ ...IDENTITY_VIEW, scale: setup.scale ?? 1 }),
		selection: observable(setup.selected ?? []),
		region: observable<Region | undefined>(undefined),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify: noop,
	});

/** Auto-Select's pick, with the boxes read from the attributes. */
const pick = autoSelect(attributeBox);

const pickedAt = (
	editor: EditorDocument,
	x: number,
	y: number,
	setup: ContextSetup = {},
	init: Partial<PointerSample> = {}
): string | undefined => pick(contextFor(editor, setup), pressAt(x, y, init))?.id;

/** The fake canvas's spy on `getContext`: spied again, the spy there already. */
const getContext = () => vi.spyOn(HTMLCanvasElement.prototype, 'getContext');

/** Every canvas a 2D context was asked of since `from`, by its size. */
const canvasesSince = (from: number): readonly string[] =>
	getContext()
		.mock.contexts.slice(from)
		.map((canvas) => {
			const { width, height } = canvas as HTMLCanvasElement;
			return `${width}x${height}`;
		});

const contextsAsked = (): number => getContext().mock.contexts.length;

beforeEach(() => {
	installFakeCanvas();
});

afterEach(() => {
	uninstallFakeCanvas();
});

describe('Auto-Select’s pick', () => {
	const twoRects = () =>
		open(
			[
				'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="50" height="50"/></g>',
				'<g id="layer-2" draw:kind="vector"><rect x="40" y="40" width="20" height="20"/></g>',
			].join('\n')
		);

	it('is off by default, picks with it on, and Ctrl or ⌘ does the other for the press', () => {
		const editor = twoRects();
		const off = { options: DEFAULT_TOOL_OPTIONS };
		expect(DEFAULT_TOOL_OPTIONS.autoSelect).toBe(false);
		expect(pickedAt(editor, 45, 45, off)).toBeUndefined();
		expect(pickedAt(editor, 45, 45, off, { primaryKey: true })).toBe('layer-2');
		expect(pickedAt(editor, 45, 45)).toBe('layer-2');
		expect(pickedAt(editor, 45, 45, {}, { primaryKey: true })).toBeUndefined();
	});

	it('walks the paint order from the top down to the first layer with something under the press', () => {
		const editor = twoRects();
		expect(pickedAt(editor, 45, 45)).toBe('layer-2');
		expect(pickedAt(editor, 10, 10)).toBe('layer-1');
		expect(pickedAt(editor, 55, 55, { active: 'layer-2' })).toBe('layer-2');
	});

	it('picks none over nothing, which keeps the active layer', () => {
		expect(pickedAt(twoRects(), 90, 90)).toBeUndefined();
	});

	it('hits a vector layer’s element as the select tool does, its box grown by 4 CSS px', () => {
		const editor = twoRects();
		expect(pickedAt(editor, 63, 50)).toBe('layer-2');
		expect(pickedAt(editor, 65, 50)).toBeUndefined();
		// At twice the size, 4 CSS px are 2 units.
		expect(pickedAt(editor, 63, 50, { scale: 2 })).toBeUndefined();
		expect(pickedAt(editor, 61.5, 50, { scale: 2 })).toBe('layer-2');
	});

	it('reads a raster layer by its pixel under the press, seeing through one no more than half opaque', () => {
		const layers = (picture: string) =>
			open(
				[
					'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
					`<g id="layer-2" draw:kind="raster">${image(picture)}</g>`,
				].join('\n')
			);
		const halves = layers(leftHalf());
		expect(pickedAt(halves, 20, 20)).toBe('layer-2');
		expect(pickedAt(halves, 70, 20)).toBe('layer-1');
		// Photoshop's line: more than half opaque.
		expect(pickedAt(layers(atAlpha(128)), 20, 20)).toBe('layer-2');
		expect(pickedAt(layers(atAlpha(127)), 20, 20)).toBe('layer-1');
	});

	it('reads one pixel of the picture, and makes no surface of the layer', () => {
		const editor = open(`<g id="layer-1" draw:kind="raster">${image(leftHalf())}</g>`);
		const from = contextsAsked();
		expect(pickedAt(editor, 20, 20)).toBe('layer-1');
		expect(pickedAt(editor, 70, 20)).toBeUndefined();
		expect(canvasesSince(from)).toEqual(['1x1', '1x1']);
		expect(cachedSurface(editor, 'layer-1')).toBeUndefined();
	});

	it('reads the layer’s surface where one is decoded, with what it holds that the file does not yet', async () => {
		const editor = open(`<g id="layer-1" draw:kind="raster">${image(leftHalf())}</g>`);
		const surface = surfaceFor(contextFor(editor));
		if (surface === undefined) throw new Error('a raster layer has a surface');
		await surface.ready;
		// A stroke at (70, 20), composited and not yet written.
		fakeOf(surface.canvas)
			.pixels()
			.set(RED, (20 * 100 + 70) * 4);
		const from = contextsAsked();
		expect(pickedAt(editor, 70, 20)).toBe('layer-1');
		expect(pickedAt(editor, 70, 21)).toBeUndefined();
		expect(canvasesSince(from).filter((size) => size === '1x1')).toEqual([]);
	});

	it('finds a raster layer by its picture’s box where its pixels cannot be read', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
				`<g id="layer-2" draw:kind="raster">${image(
					registerPicture(50, 50, () => CLEAR),
					50,
					50
				)}</g>`,
			].join('\n')
		);
		getContext().mockImplementation(() => null);
		expect(pickedAt(editor, 20, 20)).toBe('layer-2');
		expect(pickedAt(editor, 70, 20)).toBe('layer-1');
	});

	it('counts the layer’s opacity and its groups’, so a faint layer is seen through', () => {
		const layers = (layerOpacity: number, groupOpacity: number) =>
			open(
				[
					'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
					`<g id="layer-2" draw:kind="group" opacity="${groupOpacity}">`,
					`<g id="layer-3" draw:kind="raster" opacity="${layerOpacity}">${image(atAlpha(255))}</g>`,
					'</g>',
				].join('\n')
			);
		expect(pickedAt(layers(0.6, 1), 20, 20)).toBe('layer-3');
		expect(pickedAt(layers(0.5, 1), 20, 20)).toBe('layer-1');
		expect(pickedAt(layers(0.6, 0.9), 20, 20)).toBe('layer-3');
		expect(pickedAt(layers(0.6, 0.8), 20, 20)).toBe('layer-1');
	});

	it('picks the layer inside a group, never the group, and passes over hidden layers and hidden groups', () => {
		const layers = (group: string, inner: string) =>
			open(
				[
					'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
					`<g id="layer-2" draw:kind="group"${group}>`,
					`<g id="layer-3" draw:kind="vector"${inner}><rect x="10" y="10" width="20" height="20"/></g>`,
					'</g>',
				].join('\n')
			);
		expect(pickedAt(layers('', ''), 20, 20)).toBe('layer-3');
		expect(pickedAt(layers('', ''), 20, 20, { active: 'layer-2' })).toBe('layer-3');
		expect(pickedAt(layers('', ' display="none"'), 20, 20)).toBe('layer-1');
		expect(pickedAt(layers(' style="display:none"', ''), 20, 20)).toBe('layer-1');
	});

	it('picks a locked layer, as Photoshop does', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
				`<g id="layer-2" draw:kind="raster" draw:locked="true">${image(leftHalf())}</g>`,
			].join('\n')
		);
		expect(pickedAt(editor, 20, 20)).toBe('layer-2');
	});

	it('finds a layer clipped to the one below only where that one has paint', () => {
		const editor = open(
			[
				'<defs><mask id="clip-layer-2" style="mask-type:alpha"><use href="#layer-1"/></mask></defs>',
				`<g id="layer-1" draw:kind="raster">${image(leftHalf())}</g>`,
				'<g id="layer-2" draw:kind="vector" mask="url(#clip-layer-2)"><rect x="0" y="0" width="100" height="100"/></g>',
			].join('\n')
		);
		expect(editor.snapshot().layers.find((layer) => layer.id === 'layer-2')?.clipped).toBe(
			true
		);
		expect(pickedAt(editor, 20, 20)).toBe('layer-2');
		expect(pickedAt(editor, 70, 20)).toBeUndefined();
	});

	it('leaves a press on a handle of the box around what is selected to resize it', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector"><rect id="small" x="10" y="10" width="20" height="20"/></g>',
				'<g id="layer-2" draw:kind="vector"><rect x="25" y="25" width="30" height="30"/></g>',
			].join('\n')
		);
		const small = editor.root.querySelector('#small');
		if (small === null) throw new Error('the drawing has its rect');
		// The south-east corner of the selection's box.
		expect(pickedAt(editor, 30, 30, { selected: [small] })).toBeUndefined();
		expect(pickedAt(editor, 30, 30)).toBe('layer-2');
	});
});

/** The viewport in a frame of its own, which makes active the layer it is asked to and puts in hand the tool. */
const Frame = ({
	editor,
	options,
	initial,
	selection,
	onActivate,
	onNotify,
}: Readonly<{
	editor: EditorDocument;
	options: ToolOptions;
	initial: string;
	selection: ViewportSelection;
	onActivate: (id: string) => void;
	onNotify: (message: string) => void;
}>) => {
	const [layerId, setLayerId] = useState(initial);
	const [toolId, setToolId] = useState<ToolId>('select');
	return (
		<Viewport
			document={editor}
			tool={toolById(toolId) as Tool}
			options={options}
			layerId={layerId}
			selection={selection}
			onColor={noop}
			onNotify={onNotify}
			onActivateLayer={(id) => {
				onActivate(id);
				setLayerId(id);
			}}
			onTool={setToolId}
		/>
	);
};

type PointerType = 'pointerdown' | 'pointermove' | 'pointerup';

/** A mouse's event at a point, at a time; `primary` holds Ctrl and ⌘ both, so it reads the same anywhere. */
const pointer = (
	type: PointerType,
	clientX: number,
	clientY: number,
	init: Readonly<{ at?: number; primary?: boolean }> = {}
): PointerEvent => {
	const event = new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		pointerType: 'mouse',
		isPrimary: true,
		button: type === 'pointermove' ? -1 : 0,
		buttons: type === 'pointerup' ? 0 : 1,
		clientX,
		clientY,
		ctrlKey: init.primary === true,
		metaKey: init.primary === true,
	});
	Object.defineProperty(event, 'timeStamp', { value: init.at ?? 0 });
	return event;
};

const fire = (target: EventTarget, event: Event): void => {
	act(() => {
		target.dispatchEvent(event);
	});
};

/**
 * A drag from one point to another, in user units, the view being the
 * identity. The select tool writes an element's move as a `matrix()`, and a
 * raster layer's as a `translate()`.
 */
const drag = (
	target: EventTarget,
	from: readonly [number, number],
	to: readonly [number, number],
	init: Readonly<{ at?: number; primary?: boolean }> = {}
): void => {
	fire(target, pointer('pointerdown', ...from, init));
	fire(target, pointer('pointermove', ...to, init));
	fire(target, pointer('pointerup', ...to, init));
};

/**
 * Three layers, bottom to top: a vector ground that leaves a strip clear at
 * the foot, a raster picture opaque in its left half, and a vector card with
 * a word above it.
 */
const SCENE = (picture: string, rasterAttributes = '') =>
	[
		'<g id="layer-1" draw:kind="vector"><rect id="ground" x="0" y="0" width="100" height="90"/></g>',
		`<g id="layer-2" draw:kind="raster" draw:name="Photo"${rasterAttributes}>${image(picture)}</g>`,
		'<g id="layer-3" draw:kind="vector"><rect id="card" x="60" y="60" width="20" height="20"/><text id="word" x="70" y="20">Hi</text></g>',
	].join('\n');

const setup = (
	setupOptions: Readonly<{ options?: ToolOptions; initial?: string; raster?: string }> = {}
) => {
	const editor = open(SCENE(leftHalf(), setupOptions.raster ?? ''));
	const original = editor.text();
	const selection = createViewportSelection();
	const onActivate = vi.fn<(id: string) => void>();
	const onNotify = vi.fn<(message: string) => void>();
	const utils = render(
		<Frame
			editor={editor}
			options={setupOptions.options ?? ON}
			initial={setupOptions.initial ?? 'layer-1'}
			selection={selection}
			onActivate={onActivate}
			onNotify={onNotify}
		/>
	);
	const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
	const element = (id: string): Element => {
		const found = editor.root.querySelector(`[id="${id}"]`);
		if (found === null) throw new Error(`the drawing has #${id}`);
		return found;
	};
	return { ...utils, editor, original, selection, onActivate, onNotify, region, element };
};

describe('Auto-Select in the viewport', () => {
	it('shows the option in the move tool’s strip, and nowhere else', () => {
		expect(toolById('select')?.options).toEqual(['autoSelect']);
		expect(toolById('select')?.pick).toBeDefined();
		expect(toolById('node')?.pick).toBeUndefined();
		expect(t('tools.options.autoSelect')).toBe('Auto-select');
	});

	it('makes the vector layer under the press active, and the same press selects and drags its element', () => {
		const { editor, original, selection, onActivate, region, element } = setup();
		drag(region, [70, 70], [75, 72]);
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		expect(element('card').getAttribute('transform')).toBe('matrix(1 0 0 1 5 2)');
		expect(element('ground').hasAttribute('transform')).toBe(false);
		expect(selection.elements.get()).toEqual([element('card')]);
		// Activating is not a step of the history; the move is one, and undoes to the bytes.
		act(() => {
			editor.undo();
		});
		expect(editor.snapshot().canUndo).toBe(false);
		expect(editor.text()).toBe(original);
	});

	it('keeps the element a click on another layer selected, once the frame shows that layer', () => {
		const { selection, onActivate, region, element, container } = setup();
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointerup', 70, 70));
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(element('card').hasAttribute('transform')).toBe(false);
		expect(container.querySelector('.viewport-overlay')?.childElementCount).toBeGreaterThan(0);
	});

	it('moves a raster layer it picks whole, as the move tool does there', () => {
		const { onActivate, region, element } = setup();
		drag(region, [20, 50], [26, 47]);
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(element('layer-2').getAttribute('transform')).toBe('translate(6 -3)');
		expect(element('ground').hasAttribute('transform')).toBe(false);
	});

	it('moves the area’s pixels of a raster layer it picks, where the area reaches them', async () => {
		const { editor, selection, onActivate, region, element } = setup();
		const href = () => element('layer-2').querySelector('image')?.getAttribute('href');
		const before = href();
		act(() => {
			selection.region.set({
				path: 'M 40 10 L 60 10 L 60 30 L 40 30 Z',
				inverted: false,
				feather: 0,
			});
		});
		drag(region, [45, 20], [50, 20]);
		await act(() => editor.settle());
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(element('layer-2').hasAttribute('transform')).toBe(false);
		expect(href()).not.toBe(before);
		// The red half of the area moved 5 across, leaving clear where it was.
		expect(pictureAt(href(), 52, 20)).toEqual([...RED]);
		expect(pictureAt(href(), 42, 20)).toEqual([...CLEAR]);
		expect(pictureAt(href(), 20, 20)).toEqual([...RED]);
	});

	it('sees through a raster layer’s clear pixels to the layer below', () => {
		const { onActivate, region, element } = setup({ initial: 'layer-3' });
		drag(region, [90, 40], [92, 40]);
		expect(onActivate.mock.calls).toEqual([['layer-1']]);
		expect(element('ground').getAttribute('transform')).toBe('matrix(1 0 0 1 2 0)');
	});

	it('makes a locked layer active and moves nothing, saying it is locked', () => {
		const { onActivate, onNotify, region, element } = setup({
			raster: ' draw:locked="true"',
		});
		drag(region, [20, 50], [26, 47]);
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(onNotify).toHaveBeenCalledWith(t('layers.locked', { name: 'Photo' }));
		expect(element('layer-2').hasAttribute('transform')).toBe(false);
	});

	it('keeps the active layer over nothing, and does what the tool does there', () => {
		const { onActivate, region, element, editor } = setup({ initial: 'layer-2' });
		drag(region, [90, 97], [95, 99]);
		expect(onActivate).not.toHaveBeenCalled();
		// The move tool on the raster layer still active moves it whole.
		expect(element('layer-2').getAttribute('transform')).toBe('translate(5 2)');
		expect(editor.snapshot().canUndo).toBe(true);
	});

	it('picks nothing with it off, and picks with Ctrl or ⌘ held for that press', () => {
		const { onActivate, region, element } = setup({ options: DEFAULT_TOOL_OPTIONS });
		drag(region, [70, 70], [75, 70]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(element('ground').getAttribute('transform')).toBe('matrix(1 0 0 1 5 0)');
		drag(region, [70, 70], [72, 70], { primary: true, at: 1000 });
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		expect(element('card').getAttribute('transform')).toBe('matrix(1 0 0 1 2 0)');
	});

	it('keeps the active layer with Ctrl or ⌘ held while it is on', () => {
		const { onActivate, region, element } = setup();
		drag(region, [70, 70], [74, 70], { primary: true });
		expect(onActivate).not.toHaveBeenCalled();
		expect(element('ground').getAttribute('transform')).toBe('matrix(1 0 0 1 4 0)');
	});

	it('acts on a group’s layers while the group is active, and says so over nothing', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="group">',
				'<g id="layer-2" draw:kind="vector"><rect id="inside" x="10" y="10" width="20" height="20"/></g>',
				'</g>',
			].join('\n')
		);
		const onActivate = vi.fn<(id: string) => void>();
		const onNotify = vi.fn<(message: string) => void>();
		const utils = render(
			<Frame
				editor={editor}
				options={ON}
				initial="layer-1"
				selection={createViewportSelection()}
				onActivate={onActivate}
				onNotify={onNotify}
			/>
		);
		const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
		expect(region.style.cursor).toBe('default');
		drag(region, [90, 90], [92, 90]);
		expect(onNotify).toHaveBeenCalledWith(t('tools.notOnGroup', { tool: t('tools.select') }));
		drag(region, [20, 20], [23, 20], { at: 1000 });
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(editor.root.querySelector('#inside')?.getAttribute('transform')).toBe(
			'matrix(1 0 0 1 3 0)'
		);
	});

	it('gives the layer back when the press is canceled, and leaves what it moved as it was', () => {
		const { onActivate, region, element } = setup();
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointermove', 78, 70));
		expect(element('card').getAttribute('transform')).toBe('matrix(1 0 0 1 8 0)');
		fire(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onActivate.mock.calls).toEqual([['layer-3'], ['layer-1']]);
		expect(element('card').hasAttribute('transform')).toBe(false);
	});

	it('opens a text in the text tool on a double press, the first of which picked its layer', () => {
		const { onActivate, region, container } = setup();
		fire(region, pointer('pointerdown', 70, 20, { at: 0 }));
		fire(region, pointer('pointerup', 70, 20, { at: 50 }));
		fire(region, pointer('pointerdown', 70, 20, { at: 200 }));
		fire(region, pointer('pointerup', 70, 20, { at: 250 }));
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		const field = container.querySelector('textarea');
		expect(field?.value).toBe('Hi');
	});
});
