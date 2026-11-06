import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setLayerHidden } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { LayerSelection } from '../../src/drawing/layerSelection.js';
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
	/** The layers chosen in the panel, outermost, as the viewport gives them. */
	chosen?: readonly string[];
	options?: ToolOptions;
	scale?: number;
	selected?: readonly Element[];
}>;

/** The viewport's own context, for a document and an active layer. */
const contextFor = (editor: EditorDocument, setup: ContextSetup = {}): ToolContext =>
	createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === (setup.active ?? 'layer-1')),
		...(setup.chosen === undefined ? {} : { layers: setup.chosen }),
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

	it('passes over a locked layer, and a locked group’s layers, to what lies under them', () => {
		const lockedOnTop = (below: string) =>
			open(
				[
					below,
					`<g id="layer-2" draw:kind="raster" draw:locked="true">${image(leftHalf())}</g>`,
				].join('\n')
			);
		const ground =
			'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>';
		expect(pickedAt(lockedOnTop(ground), 20, 20)).toBe('layer-1');
		// Nothing under it but the locked layer: nothing is picked, and the active layer is kept.
		expect(
			pickedAt(lockedOnTop('<g id="layer-1" draw:kind="vector"/>'), 20, 20)
		).toBeUndefined();
		const inGroup = (group: string) =>
			open(
				[
					ground,
					`<g id="layer-2" draw:kind="group"${group}>`,
					'<g id="layer-3" draw:kind="vector"><rect x="10" y="10" width="20" height="20"/></g>',
					'</g>',
				].join('\n')
			);
		expect(pickedAt(inGroup(''), 20, 20)).toBe('layer-3');
		expect(pickedAt(inGroup(' draw:locked="true"'), 20, 20)).toBe('layer-1');
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

/** Auto-select on, in Photoshop's Group mode. */
const GROUP_ON: ToolOptions = { ...ON, autoSelectMode: 'group' };

describe('Auto-Select’s pick in Group mode', () => {
	/**
	 * A ground at the root, a group in a group over it, the inner one holding
	 * a square, and a card at the root on top; `outer` and `inner` are the
	 * groups' attributes, and `more` and `moreInner` what else each holds.
	 */
	const nested = (
		setup: Readonly<{ outer?: string; inner?: string; more?: string; moreInner?: string }> = {}
	) =>
		open(
			[
				'<g id="layer-1" draw:kind="vector"><rect x="0" y="0" width="100" height="100"/></g>',
				`<g id="layer-2" draw:kind="group"${setup.outer ?? ''}>`,
				`<g id="layer-3" draw:kind="group"${setup.inner ?? ''}>`,
				'<g id="layer-4" draw:kind="vector"><rect x="10" y="10" width="20" height="20"/></g>',
				setup.moreInner ?? '',
				'</g>',
				setup.more ?? '',
				'</g>',
				'<g id="layer-5" draw:kind="vector"><rect x="60" y="60" width="20" height="20"/></g>',
			].join('\n')
		);

	const group = { options: GROUP_ON };

	it('is Layer mode by default, and in Group mode picks the outermost group of the layer it finds', () => {
		const editor = nested();
		expect(DEFAULT_TOOL_OPTIONS.autoSelectMode).toBe('layer');
		expect(pickedAt(editor, 20, 20)).toBe('layer-4');
		expect(pickedAt(editor, 20, 20, group)).toBe('layer-2');
		// The group active already is picked too, and the viewport keeps it.
		expect(pickedAt(editor, 20, 20, { ...group, active: 'layer-2' })).toBe('layer-2');
		expect(pickedAt(editor, 20, 20, { ...group, active: 'layer-4' })).toBe('layer-2');
	});

	it('picks a layer in no group itself, and none over nothing', () => {
		const editor = nested();
		expect(pickedAt(editor, 70, 70, group)).toBe('layer-5');
		expect(pickedAt(editor, 90, 90, group)).toBe('layer-1');
		const bare = open(
			'<g id="layer-1" draw:kind="group"><g id="layer-2" draw:kind="vector"/></g>'
		);
		expect(pickedAt(bare, 20, 20, group)).toBeUndefined();
	});

	it('does the other with Ctrl or ⌘, which pick in Group mode with Auto-select off', () => {
		const editor = nested();
		const off = { options: { ...DEFAULT_TOOL_OPTIONS, autoSelectMode: 'group' as const } };
		expect(pickedAt(editor, 20, 20, off)).toBeUndefined();
		expect(pickedAt(editor, 20, 20, off, { primaryKey: true })).toBe('layer-2');
		expect(pickedAt(editor, 20, 20, group, { primaryKey: true })).toBeUndefined();
	});

	it('passes over the layers of a hidden or a locked group, at any depth, to what lies under them', () => {
		expect(pickedAt(nested({ outer: ' display="none"' }), 20, 20, group)).toBe('layer-1');
		expect(pickedAt(nested({ inner: ' style="display:none"' }), 20, 20, group)).toBe('layer-1');
		expect(pickedAt(nested({ outer: ' draw:locked="true"' }), 20, 20, group)).toBe('layer-1');
		expect(pickedAt(nested({ inner: ' draw:locked="true"' }), 20, 20, group)).toBe('layer-1');
	});

	it('picks the outermost group that may move whole where a locked layer keeps the one round it, else the layer', () => {
		const locked = '<g id="layer-6" draw:kind="vector" draw:locked="true"/>';
		expect(pickedAt(nested({ more: locked }), 20, 20, group)).toBe('layer-3');
		expect(pickedAt(nested({ moreInner: locked }), 20, 20, group)).toBe('layer-4');
		// A hidden layer moves with its group, and does not keep it.
		const hidden = '<g id="layer-6" draw:kind="vector" display="none"/>';
		expect(pickedAt(nested({ more: hidden }), 20, 20, group)).toBe('layer-2');
	});

	it('picks the layer it finds where that moves with the layers chosen, so the choice is kept', () => {
		const editor = nested();
		const chosen = (ids: readonly string[]) => ({ ...group, active: ids[0], chosen: ids });
		expect(pickedAt(editor, 20, 20, chosen(['layer-4', 'layer-5']))).toBe('layer-4');
		expect(pickedAt(editor, 20, 20, chosen(['layer-3', 'layer-5']))).toBe('layer-4');
		expect(pickedAt(editor, 20, 20, chosen(['layer-2', 'layer-5']))).toBe('layer-4');
		// Chosen without it, or chosen alone, which is no choice to keep: the group.
		expect(pickedAt(editor, 20, 20, chosen(['layer-1', 'layer-5']))).toBe('layer-2');
		expect(pickedAt(editor, 20, 20, chosen(['layer-4']))).toBe('layer-2');
	});

	it('leaves a press on a handle of the box around what is selected to resize it, and picks the group inside it', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="group">',
				'<g id="layer-2" draw:kind="vector"><rect id="small" x="10" y="10" width="20" height="20"/></g>',
				'</g>',
				'<g id="layer-3" draw:kind="vector"><rect x="25" y="25" width="30" height="30"/></g>',
			].join('\n')
		);
		const small = editor.root.querySelector('#small');
		if (small === null) throw new Error('the drawing has its rect');
		const selected = { ...group, active: 'layer-2', selected: [small] };
		// The south-east corner of the selection's box.
		expect(pickedAt(editor, 30, 30, selected)).toBeUndefined();
		expect(pickedAt(editor, 30, 30, group)).toBe('layer-3');
		// Inside the box, on what is selected: its group, which moves whole.
		expect(pickedAt(editor, 20, 20, selected)).toBe('layer-1');
	});
});

/**
 * The viewport in a frame of its own, which makes active the layer it is
 * asked to and puts in hand the tool. The layers chosen are `chosen`, top
 * first, or the active one alone, until the viewport makes a layer active,
 * which chooses it alone, as the frame's reducer does.
 */
const Frame = ({
	editor,
	options,
	initial,
	chosen,
	selection,
	onActivate,
	onSelect,
	onNotify,
}: Readonly<{
	editor: EditorDocument;
	options: ToolOptions;
	initial: string;
	chosen?: readonly string[];
	selection: ViewportSelection;
	onActivate: (id: string) => void;
	onSelect?: (choice: LayerSelection) => void;
	onNotify: (message: string) => void;
}>) => {
	const [layerId, setLayerId] = useState(initial);
	const [alone, setAlone] = useState<string | undefined>(undefined);
	const [toolId, setToolId] = useState<ToolId>('select');
	return (
		<Viewport
			document={editor}
			tool={toolById(toolId) as Tool}
			options={options}
			layerId={layerId}
			selectedLayerIds={alone === undefined ? (chosen ?? [layerId]) : [alone]}
			selection={selection}
			onColor={noop}
			onNotify={onNotify}
			onActivateLayer={(id) => {
				onActivate(id);
				setLayerId(id);
				setAlone(id);
			}}
			{...(onSelect === undefined ? {} : { onSelectLayers: onSelect })}
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
		expect(toolById('select')?.options).toEqual(['autoSelect', 'autoSelectMode', 'snap']);
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

	it('presses through a locked layer, and the same press moves what lies under it', () => {
		const { onActivate, onNotify, region, element } = setup({
			raster: ' draw:locked="true"',
			initial: 'layer-3',
		});
		drag(region, [20, 50], [26, 47]);
		expect(onActivate.mock.calls).toEqual([['layer-1']]);
		expect(element('ground').getAttribute('transform')).toBe('matrix(1 0 0 1 6 -3)');
		expect(element('layer-2').hasAttribute('transform')).toBe(false);
		expect(onNotify).not.toHaveBeenCalledWith(t('layers.locked', { name: 'Photo' }));
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

	it('acts on a group’s layers while the group is active, and moves the group whole over nothing', () => {
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
		expect(onNotify).not.toHaveBeenCalled();
		expect(onActivate).not.toHaveBeenCalled();
		expect(editor.root.querySelector('#layer-1')?.getAttribute('transform')).toBe(
			'translate(2 0)'
		);
		// The rectangle, two units over with its group.
		drag(region, [21, 20], [24, 20], { at: 1000 });
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

	it('gives back the whole choice when a press that picked another layer is canceled', () => {
		const editor = open(SCENE(leftHalf()));
		const onActivate = vi.fn<(id: string) => void>();
		const onSelect = vi.fn<(choice: LayerSelection) => void>();
		const utils = render(
			<Frame
				editor={editor}
				options={ON}
				initial="layer-1"
				chosen={['layer-2', 'layer-1']}
				selection={createViewportSelection()}
				onActivate={onActivate}
				onSelect={onSelect}
				onNotify={vi.fn()}
			/>
		);
		const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
		fire(region, pointer('pointerdown', 70, 70));
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		fire(window, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		expect(onSelect.mock.calls).toEqual([
			[{ active: 'layer-1', selected: ['layer-2', 'layer-1'], anchor: 'layer-1' }],
		]);
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

/**
 * Two groups, one in the other, the inner holding a square and the outer a
 * second one beside it, over a ground, and a card at the root on top.
 */
const NESTED = (more = '') =>
	[
		'<g id="layer-1" draw:kind="vector"><rect id="ground" x="0" y="0" width="100" height="90"/></g>',
		'<g id="layer-2" draw:kind="group">',
		'<g id="layer-3" draw:kind="group">',
		'<g id="layer-4" draw:kind="vector"><rect id="inner" x="10" y="10" width="20" height="20"/></g>',
		'</g>',
		'<g id="layer-5" draw:kind="vector"><rect id="beside" x="40" y="10" width="10" height="10"/></g>',
		more,
		'</g>',
		'<g id="layer-6" draw:kind="vector"><rect id="card" x="60" y="60" width="20" height="20"/></g>',
	].join('\n');

describe('Auto-Select in Group mode in the viewport', () => {
	type Grouped = Readonly<{
		options?: ToolOptions;
		initial?: string;
		chosen?: readonly string[];
		more?: string;
	}>;

	const grouped = (setupOptions: Grouped = {}) => {
		const editor = open(NESTED(setupOptions.more));
		const original = editor.text();
		const selection = createViewportSelection();
		const onActivate = vi.fn<(id: string) => void>();
		const onNotify = vi.fn<(message: string) => void>();
		const utils = render(
			<Frame
				editor={editor}
				options={setupOptions.options ?? GROUP_ON}
				initial={setupOptions.initial ?? 'layer-1'}
				{...(setupOptions.chosen === undefined ? {} : { chosen: setupOptions.chosen })}
				selection={selection}
				onActivate={onActivate}
				onNotify={onNotify}
			/>
		);
		const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
		const transformOf = (id: string): string | null =>
			editor.root.querySelector(`[id="${id}"]`)?.getAttribute('transform') ?? null;
		return { ...utils, editor, original, selection, onActivate, onNotify, region, transformOf };
	};

	it('makes the outermost group of the layer under the press active, and the same press moves it whole', () => {
		const { editor, original, onActivate, onNotify, region, transformOf } = grouped();
		drag(region, [20, 20], [24, 23]);
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(transformOf('layer-2')).toBe('translate(4 3)');
		expect(['layer-3', 'layer-4', 'inner', 'ground'].map(transformOf)).toEqual([
			null,
			null,
			null,
			null,
		]);
		expect(onNotify).not.toHaveBeenCalled();
		// One step of the history, which undoes to the bytes.
		act(() => {
			editor.undo();
		});
		expect(editor.snapshot().canUndo).toBe(false);
		expect(editor.text()).toBe(original);
		// The group active now: a press on its other layer moves it again, and makes nothing else active.
		drag(region, [45, 15], [47, 15], { at: 1000 });
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(transformOf('layer-2')).toBe('translate(2 0)');
	});

	it('moves a layer in no group as Layer mode does', () => {
		const { onActivate, region, transformOf } = grouped();
		drag(region, [70, 70], [75, 72]);
		expect(onActivate.mock.calls).toEqual([['layer-6']]);
		expect(transformOf('card')).toBe('matrix(1 0 0 1 5 2)');
		expect(transformOf('layer-2')).toBeNull();
	});

	it('picks the group with Ctrl or ⌘ held where Auto-select is off', () => {
		const { onActivate, region, transformOf } = grouped({
			options: { ...DEFAULT_TOOL_OPTIONS, autoSelectMode: 'group' },
		});
		drag(region, [20, 20], [22, 20], { primary: true });
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(transformOf('layer-2')).toBe('translate(2 0)');
	});

	it('keeps the layers chosen where the press is on one of them inside a group, and moves them all', () => {
		// The card's layer active, and the square's chosen with it.
		const { onActivate, region, transformOf } = grouped({
			initial: 'layer-6',
			chosen: ['layer-6', 'layer-4'],
		});
		drag(region, [20, 20], [24, 20]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(transformOf('layer-4')).toBe('translate(4 0)');
		expect(transformOf('layer-6')).toBe('translate(4 0)');
		expect(transformOf('layer-2')).toBeNull();
	});

	it('moves the group under it that may move where a locked layer keeps the outer one, and says nothing', () => {
		const { onActivate, onNotify, region, transformOf } = grouped({
			more: '<g id="layer-7" draw:kind="vector" draw:name="Sketch" draw:locked="true"/>',
		});
		drag(region, [20, 20], [24, 20]);
		expect(onActivate.mock.calls).toEqual([['layer-3']]);
		expect(transformOf('layer-3')).toBe('translate(4 0)');
		expect(transformOf('layer-2')).toBeNull();
		expect(onNotify).not.toHaveBeenCalled();
	});

	it('resizes what is selected from a handle of its box, and keeps the active layer', () => {
		const { editor, selection, onActivate, region, transformOf } = grouped({
			initial: 'layer-4',
		});
		const inner = editor.root.querySelector('#inner');
		if (inner === null) throw new Error('the drawing has its rect');
		act(() => {
			selection.elements.set([inner]);
		});
		// From the south-east corner of the box, outward.
		drag(region, [30, 30], [40, 40]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(transformOf('layer-2')).toBeNull();
		expect(transformOf('inner')).not.toBeNull();
		expect(selection.elements.get()).toEqual([inner]);
	});
});

/** The selection's boxes on the overlay, each as `x y width height`. */
const boxesIn = (container: HTMLElement): readonly string[] =>
	[
		...container.querySelectorAll(
			'.viewport-overlay [data-draw-selection] > rect:not([data-handle])'
		),
	].map((rect) => ['x', 'y', 'width', 'height'].map((name) => rect.getAttribute(name)).join(' '));

/** A mouse moving over the canvas with no button down. */
const hoverAt = (target: EventTarget, clientX: number, clientY: number): void => {
	fire(
		target,
		new PointerEvent('pointermove', {
			bubbles: true,
			pointerId: 1,
			pointerType: 'mouse',
			isPrimary: true,
			button: -1,
			buttons: 0,
			clientX,
			clientY,
		})
	);
};

/** An area, which is the canvas's: a change of layer leaves it as it is. */
const AREA: Region = { path: 'M 90 0 L 100 0 L 100 10 L 90 10 Z', inverted: false, feather: 0 };

describe('A selection on a layer no longer active', () => {
	it('moves to what an Auto-select press on another vector layer is on, which the same drag moves', () => {
		const { selection, onActivate, region, element, container } = setup({ initial: 'layer-3' });
		// The ground, through the raster layer's clear half.
		fire(region, pointer('pointerdown', 90, 40, { at: 0 }));
		fire(region, pointer('pointerup', 90, 40, { at: 50 }));
		expect(selection.elements.get()).toEqual([element('ground')]);
		expect(boxesIn(container)).toEqual(['0 0 100 90']);
		drag(region, [70, 70], [75, 72], { at: 1000 });
		expect(onActivate.mock.calls).toEqual([['layer-1'], ['layer-3']]);
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(element('card').getAttribute('transform')).toBe('matrix(1 0 0 1 5 2)');
		expect(element('ground').hasAttribute('transform')).toBe(false);
		expect(boxesIn(container)).toEqual(['65 62 20 20']);
	});

	it('lets go of the element and its box when an Auto-select press picks a raster layer, and keeps the area', () => {
		const { selection, onActivate, region, element, container } = setup({ initial: 'layer-3' });
		fire(region, pointer('pointerdown', 70, 70, { at: 0 }));
		fire(region, pointer('pointerup', 70, 70, { at: 50 }));
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
		act(() => {
			selection.region.set(AREA);
		});
		// The picture's opaque half.
		fire(region, pointer('pointerdown', 20, 50, { at: 1000 }));
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		// Gone as the press begins, not only once it ends; the area is the canvas's, and stays.
		expect(selection.elements.get()).toEqual([]);
		expect(boxesIn(container)).toEqual([]);
		expect(selection.region.get()).toBe(AREA);
		fire(region, pointer('pointermove', 26, 47, { at: 1010 }));
		fire(region, pointer('pointerup', 26, 47, { at: 1020 }));
		hoverAt(region, 70, 70);
		expect(boxesIn(container)).toEqual([]);
		expect(element('card').hasAttribute('transform')).toBe(false);
	});
});

/**
 * The viewport with the move tool and Auto-select off, on the scene, for a
 * frame that makes `layerId` active and may make another so (`activate`), as
 * a press on a row of the layers panel does.
 */
const mount = (layerId: string, scene: string = SCENE(leftHalf())) => {
	const editor = open(scene);
	const selection = createViewportSelection();
	const viewport = (id: string) => (
		<Viewport
			document={editor}
			tool={toolById('select') as Tool}
			options={DEFAULT_TOOL_OPTIONS}
			layerId={id}
			selection={selection}
			onColor={noop}
			onNotify={noop}
			onActivateLayer={noop}
		/>
	);
	const utils = render(viewport(layerId));
	const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
	const element = (id: string): Element => {
		const found = editor.root.querySelector(`[id="${id}"]`);
		if (found === null) throw new Error(`the drawing has #${id}`);
		return found;
	};
	return {
		...utils,
		editor,
		selection,
		region,
		element,
		activate: (id: string) => {
			utils.rerender(viewport(id));
		},
	};
};

describe('A selection when the frame makes another layer active', () => {
	it('lets go of the element and its box on a press on another layer’s row, and keeps the area', () => {
		const { selection, region, element, container, activate } = mount('layer-3');
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointerup', 70, 70));
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
		act(() => {
			selection.region.set(AREA);
		});
		activate('layer-1');
		expect(selection.elements.get()).toEqual([]);
		expect(boxesIn(container)).toEqual([]);
		hoverAt(region, 70, 70);
		expect(boxesIn(container)).toEqual([]);
		expect(selection.region.get()).toBe(AREA);
		// Its own layer made active again does not bring it back.
		activate('layer-3');
		hoverAt(region, 72, 72);
		expect(selection.elements.get()).toEqual([]);
		expect(boxesIn(container)).toEqual([]);
	});
});

/** Ctrl and ⌘ A, read as select-all whichever the platform's primary key is. */
const selectAllKey = (): KeyboardEvent =>
	new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, metaKey: true, bubbles: true });

describe('A selection on a hidden layer', () => {
	const hide = (editor: EditorDocument, id: string, hidden: boolean): void => {
		act(() => {
			editor.execute(setLayerHidden(id, hidden));
		});
	};

	it('stays selected with no box while its layer is hidden, and shows its box again with the layer', () => {
		const { editor, selection, region, element, container } = mount('layer-3');
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointerup', 70, 70));
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
		hide(editor, 'layer-3', true);
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(boxesIn(container)).toEqual([]);
		hoverAt(region, 70, 70);
		expect(boxesIn(container)).toEqual([]);
		hide(editor, 'layer-3', false);
		hoverAt(region, 72, 72);
		expect(selection.elements.get()).toEqual([element('card')]);
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
		// An undo hides it again, and a redo shows it.
		act(() => {
			editor.undo();
		});
		expect(boxesIn(container)).toEqual([]);
		act(() => {
			editor.redo();
		});
		hoverAt(region, 70, 70);
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
	});

	it('draws no box for everything selected on a hidden layer, or on a layer in a hidden group', () => {
		const hidden = mount(
			'layer-3',
			SCENE(leftHalf()).replace('id="layer-3"', 'id="layer-3" display="none"')
		);
		fire(window, selectAllKey());
		expect(hidden.selection.elements.get()).toEqual([
			hidden.element('card'),
			hidden.element('word'),
		]);
		hoverAt(hidden.region, 70, 70);
		expect(boxesIn(hidden.container)).toEqual([]);
		hidden.unmount();
		const grouped = mount(
			'layer-2',
			[
				'<g id="layer-1" draw:kind="group" display="none">',
				'<g id="layer-2" draw:kind="vector"><rect id="inside" x="10" y="10" width="20" height="20"/></g>',
				'</g>',
			].join('\n')
		);
		fire(window, selectAllKey());
		expect(grouped.selection.elements.get()).toEqual([grouped.element('inside')]);
		hoverAt(grouped.region, 20, 20);
		expect(boxesIn(grouped.container)).toEqual([]);
		hide(grouped.editor, 'layer-1', false);
		hoverAt(grouped.region, 22, 22);
		expect(boxesIn(grouped.container)).toEqual(['10 10 20 20']);
	});

	it('keeps no handle out of sight from Auto-select, which picks the layer under it', () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector" display="none"><rect id="small" x="10" y="10" width="20" height="20"/></g>',
				'<g id="layer-2" draw:kind="vector"><rect x="25" y="25" width="30" height="30"/></g>',
			].join('\n')
		);
		const small = editor.root.querySelector('#small');
		if (small === null) throw new Error('the drawing has its rect');
		// The south-east corner of the box the hidden selection would have.
		expect(pickedAt(editor, 30, 30, { selected: [small] })).toBe('layer-2');
	});
});

/** The selected elements' outlines on the overlay, which mark them with no handles. */
const outlinesIn = (container: HTMLElement): number =>
	container.querySelectorAll('.viewport-overlay [data-draw-region-outline] > *').length;

const arrow = (key: string, shiftKey = false): KeyboardEvent =>
	new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true });

describe('The move tool with several layers chosen', () => {
	type Chosen = Readonly<{
		initial: string;
		chosen: readonly string[];
		options?: ToolOptions;
		scene?: string;
	}>;

	/** The scene in the viewport, `chosen` chosen, `initial` active among them. */
	const choose = ({ initial, chosen, options, scene }: Chosen) => {
		const editor = open(scene ?? SCENE(leftHalf()));
		const original = editor.text();
		const selection = createViewportSelection();
		const onActivate = vi.fn<(id: string) => void>();
		const onNotify = vi.fn<(message: string) => void>();
		const frame = (now: readonly string[]) => (
			<Frame
				editor={editor}
				options={options ?? DEFAULT_TOOL_OPTIONS}
				initial={initial}
				chosen={now}
				selection={selection}
				onActivate={onActivate}
				onNotify={onNotify}
			/>
		);
		const utils = render(frame(chosen));
		const region = utils.getByRole('region', { name: t('editor.panes.canvas') });
		const transformOf = (id: string): string | null =>
			editor.root.querySelector(`[id="${id}"]`)?.getAttribute('transform') ?? null;
		const rechoose = (now: readonly string[]): void => {
			utils.rerender(frame(now));
		};
		return {
			...utils,
			editor,
			original,
			selection,
			onActivate,
			onNotify,
			region,
			transformOf,
			rechoose,
		};
	};

	it('moves every one whole by one command, whatever the active layer’s kind, and leaves the area be', () => {
		const { editor, original, selection, onActivate, region, transformOf } = choose({
			initial: 'layer-2',
			chosen: ['layer-3', 'layer-2'],
		});
		act(() => {
			selection.region.set(AREA);
		});
		expect(region.style.cursor).toBe('default');
		// On the raster layer's picture, where its area does not reach.
		drag(region, [20, 50], [26, 47]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(transformOf('layer-2')).toBe('translate(6 -3)');
		expect(transformOf('layer-3')).toBe('translate(6 -3)');
		expect(transformOf('layer-1')).toBeNull();
		expect(selection.region.get()).toBe(AREA);
		act(() => {
			editor.undo();
		});
		expect(editor.snapshot().canUndo).toBe(false);
		expect(editor.text()).toBe(original);
	});

	it('keeps the choice where Auto-select picks one of them, and chooses another layer alone', () => {
		const { onActivate, region, transformOf } = choose({
			initial: 'layer-1',
			chosen: ['layer-3', 'layer-1'],
			options: ON,
		});
		// The card, on the chosen layer that is not the active one.
		drag(region, [70, 70], [75, 72]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(transformOf('layer-1')).toBe('translate(5 2)');
		expect(transformOf('layer-3')).toBe('translate(5 2)');
		expect(transformOf('card')).toBeNull();
		// The picture, on a layer not chosen: it is made active, chosen alone, and moved alone.
		drag(region, [20, 50], [26, 47], { at: 1000 });
		expect(onActivate.mock.calls).toEqual([['layer-2']]);
		expect(transformOf('layer-2')).toBe('translate(6 -3)');
		expect(transformOf('layer-1')).toBe('translate(5 2)');
	});

	it('keeps the choice where Auto-select picks a layer inside a chosen group, and moves the group', () => {
		const { onActivate, region, transformOf } = choose({
			initial: 'layer-3',
			chosen: ['layer-3', 'layer-1'],
			options: ON,
			scene: [
				'<g id="layer-1" draw:kind="group">',
				'<g id="layer-2" draw:kind="vector"><rect id="inside" x="10" y="10" width="20" height="20"/></g>',
				'</g>',
				'<g id="layer-3" draw:kind="vector"><rect x="60" y="60" width="20" height="20"/></g>',
			].join('\n'),
		});
		drag(region, [20, 20], [24, 20]);
		expect(onActivate).not.toHaveBeenCalled();
		expect(transformOf('layer-1')).toBe('translate(4 0)');
		expect(transformOf('layer-2')).toBeNull();
		expect(transformOf('layer-3')).toBe('translate(4 0)');
	});

	it('refuses the move for a locked one, and says so', () => {
		const { editor, onNotify, region, transformOf } = choose({
			initial: 'layer-3',
			chosen: ['layer-3', 'layer-2'],
			scene: SCENE(leftHalf(), ' draw:locked="true"'),
		});
		drag(region, [70, 70], [75, 72]);
		expect(onNotify).toHaveBeenCalledWith(t('layers.locked', { name: 'Photo' }));
		expect(transformOf('layer-3')).toBeNull();
		expect(editor.snapshot().canUndo).toBe(false);
	});

	it('nudges every one with the arrows, a unit or ten with Shift, each by one command', () => {
		const { editor, region, transformOf } = choose({
			initial: 'layer-3',
			chosen: ['layer-3', 'layer-1'],
		});
		const right = arrow('ArrowRight');
		fire(window, right);
		expect(right.defaultPrevented).toBe(true);
		fire(window, arrow('ArrowDown', true));
		expect(transformOf('layer-1')).toBe('translate(1 10)');
		expect(transformOf('layer-3')).toBe('translate(1 10)');
		expect(transformOf('layer-2')).toBeNull();
		act(() => {
			editor.undo();
		});
		expect(transformOf('layer-3')).toBe('translate(1 0)');
		expect(region.style.cursor).toBe('default');
	});

	it('nudges a group active alone whole, and a vector layer alone whole with nothing selected on it', () => {
		const grouped = choose({
			initial: 'layer-1',
			chosen: ['layer-1'],
			scene: [
				'<g id="layer-1" draw:kind="group">',
				'<g id="layer-2" draw:kind="vector"><rect x="10" y="10" width="20" height="20"/></g>',
				'</g>',
			].join('\n'),
		});
		fire(window, arrow('ArrowLeft'));
		expect(grouped.transformOf('layer-1')).toBe('translate(-1 0)');
		grouped.unmount();
		const single = choose({ initial: 'layer-3', chosen: ['layer-3'] });
		const left = arrow('ArrowLeft');
		fire(window, left);
		expect(left.defaultPrevented).toBe(true);
		expect(single.transformOf('layer-3')).toBe('translate(-1 0)');
	});

	it('lets go of the elements selected, and their box, as the choice grows past one layer', () => {
		const { selection, region, container, rechoose } = choose({
			initial: 'layer-3',
			chosen: ['layer-3'],
		});
		fire(region, pointer('pointerdown', 70, 70));
		fire(region, pointer('pointerup', 70, 70));
		expect(selection.elements.get()).toHaveLength(1);
		expect(boxesIn(container)).toEqual(['60 60 20 20']);
		rechoose(['layer-3', 'layer-1']);
		expect(selection.elements.get()).toEqual([]);
		expect(boxesIn(container)).toEqual([]);
		hoverAt(region, 70, 70);
		expect(boxesIn(container)).toEqual([]);
	});

	it('outlines what select all selects, with no handles, and lets go of it as the layers move', () => {
		const { selection, region, container, transformOf } = choose({
			initial: 'layer-3',
			chosen: ['layer-3', 'layer-1'],
		});
		fire(window, selectAllKey());
		expect(selection.elements.get()).toHaveLength(2);
		expect(boxesIn(container)).toEqual([]);
		expect(outlinesIn(container)).toBe(2);
		// Where the box's corner handle would be.
		drag(region, [80, 80], [83, 80]);
		expect(transformOf('layer-3')).toBe('translate(3 0)');
		expect(selection.elements.get()).toEqual([]);
		expect(outlinesIn(container)).toBe(0);
	});
});
