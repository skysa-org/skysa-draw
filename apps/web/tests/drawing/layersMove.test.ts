import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import {
	createLayersMove,
	layersMove,
	movesWith,
	nudgeLayers,
	translated,
} from '../../src/drawing/tools/common/layersMove.js';
import type { ExtentOf } from '../../src/drawing/tools/common/snap.js';
import { behaviorFor, toolById } from '../../src/drawing/tools/index.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type Tool,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import {
	type Box,
	IDENTITY,
	type Mat,
	multiply,
	parseTransform,
	transformBox,
	unionBox,
} from '../../src/drawing/tools/vector/geometry.js';
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
	options?: Partial<ToolOptions>;
}>;

/** The viewport's context for an active layer and the layers chosen, with what it tells the user kept. */
const contextFor = (editor: EditorDocument, setup: Setup) => {
	const notify = vi.fn<(message: string) => void>();
	const selection = observable<readonly Element[]>(setup.selected ?? []);
	const context: ToolContext = createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === setup.active),
		...(setup.layers === undefined ? {} : { layers: setup.layers }),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
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
	it('moves every one by the same distance while the drag lasts, each before its own transform, folded into its translation', () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		layersMove.begin(context, at(10, 10));
		layersMove.move(context, at(14, 7));
		expect(transformOf(editor, 'layer-1')).toBe('translate(4 -3)');
		expect(transformOf(editor, 'layer-2')).toBe('translate(9 -3) rotate(10)');
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
		expect(transformOf(editor, 'layer-2')).toBe('translate(7.5 0) rotate(10)');
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
		expect(translated(null, 0.0001, -0.0004)).toBeUndefined();
	});

	it('folds a move into the translation the transform begins with', () => {
		expect(translated('translate(10 20)', 1.5, -2)).toBe('translate(11.5 18)');
		expect(translated('translate(0 36.8)', -448.59, 0)).toBe('translate(-448.59 36.8)');
		// One number is an x, with a y of 0.
		expect(translated('translate(7)', 1, 2)).toBe('translate(8 2)');
		expect(translated('translate(0.1 0.2)', 0.2, 0.1)).toBe('translate(0.3 0.3)');
		// Only the first is folded: a translation after another transform is in other units.
		expect(translated('translate(1 2) translate(3 4)', 1, 1)).toBe(
			'translate(2 3) translate(3 4)'
		);
		expect(translated('scale(2) translate(5 5)', 1, 1)).toBe(
			'translate(1 1) scale(2) translate(5 5)'
		);
		// Not a translation: a name that only begins like one is left behind its move.
		expect(translated('translateX(1)', 1, 0)).toBe('translate(1 0) translateX(1)');
	});

	it('folds a move back to no transform, or to the rest of it alone', () => {
		expect(translated('translate(4 -3)', -4, 3)).toBeUndefined();
		expect(translated(' translate(1e1, -2.5) ', -10, 2.5)).toBeUndefined();
		expect(translated('translate(5 0) rotate(10)', -5, 0)).toBe('rotate(10)');
		expect(translated('translate(5,0),rotate(10)', -5, 0)).toBe('rotate(10)');
	});

	it('folds a translation followed by more, keeping the rest as it was written', () => {
		expect(translated('translate(5 0) rotate(10)', 4, -3)).toBe('translate(9 -3) rotate(10)');
		expect(translated('translate(5 0)rotate(10) scale(2,3)', 1, 0)).toBe(
			'translate(6 0) rotate(10) scale(2,3)'
		);
		expect(translated('translate( 5 , 6 ) , matrix(1 0 0 1 2 3)', 1, 1)).toBe(
			'translate(6 7) matrix(1 0 0 1 2 3)'
		);
	});

	it('folds a translation written with a comma, or with a sign for a separator', () => {
		expect(translated('translate(10,20)', 1, 1)).toBe('translate(11 21)');
		expect(translated('translate(10, 20) scale(2)', -10, 0)).toBe('translate(0 20) scale(2)');
		expect(translated('translate(10-20)', 0, 20)).toBe('translate(10 0)');
		expect(translated('translate(.5.5)', 0.5, 0.5)).toBe('translate(1 1)');
	});

	it('folds repeated moves into one translation, through the drag and the arrows alike', () => {
		const editor = open();
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-2'],
		});
		drag(context, [10, 10], [12, 10]);
		drag(context, [10, 10], [10, 13]);
		expect(nudgeLayers(context, -1, 0)).toBe(true);
		expect(transformOf(editor, 'layer-1')).toBe('translate(1 3)');
		expect(transformOf(editor, 'layer-2')).toBe('translate(6 3) rotate(10)');
		drag(context, [0, 0], [-1, -3]);
		expect(transformOf(editor, 'layer-1')).toBeNull();
		expect(transformOf(editor, 'layer-2')).toBe('translate(5 0) rotate(10)');
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
		expect(transformOf(editor, 'layer-1')).toBe('translate(10 -1)');
		expect(transformOf(editor, 'layer-3')).toBe('translate(10 -1)');
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

/**
 * Bottom to top: a square, a hidden speck that would pull nearer than
 * anything, and a group of a vector square and a raster one, which paint
 * 50 to 80 each way together.
 */
const SNAP_SCENE = [
	'<g id="layer-1" draw:kind="vector"><rect x="10" y="10" width="20" height="20"/></g>',
	'<g id="layer-2" draw:kind="vector" display="none"><rect x="97" y="40" width="1" height="1"/></g>',
	'<g id="layer-3" draw:kind="group">',
	'<g id="layer-4" draw:kind="vector"><rect x="50" y="50" width="10" height="10"/></g>',
	`<g id="layer-5" draw:kind="raster"><image href="${PICTURE}" x="70" y="70" width="10" height="10" preserveAspectRatio="none"/></g>`,
	'</g>',
].join('\n');

/** What each layer that is not a group paints, in its own units. */
const PAINTED: Readonly<Record<string, Box>> = {
	'layer-1': { x: 10, y: 10, width: 20, height: 20 },
	'layer-2': { x: 97, y: 40, width: 1, height: 1 },
	'layer-4': { x: 50, y: 50, width: 10, height: 10 },
	'layer-5': { x: 70, y: 70, width: 10, height: 10 },
};

/** Where the user units of `element` are in the root's: its `transform` after every one above it. */
const placementOf = (element: Element | null): Mat =>
	element === null || element.localName === 'svg'
		? IDENTITY
		: multiply(
				placementOf(element.parentElement),
				parseTransform(element.getAttribute('transform'))
			);

/**
 * A measure in the browser's place: what each layer paints, placed where its
 * `transform` and its groups' put it when the measure answers, once `gate`
 * opens, and a group by the layers in it; each asked for is kept in `asked`.
 */
const liveExtent =
	(asked: string[] = [], gate: Promise<void> = Promise.resolve()): ExtentOf =>
	(editor) => {
		const extentOf = (id: string): Box | undefined => {
			const element = editor.layer(id);
			if (element === undefined) return undefined;
			const own = PAINTED[id];
			if (own !== undefined) return transformBox(placementOf(element), own);
			return unionBox([...element.children].flatMap((child) => extentOf(child.id) ?? []));
		};
		return async (id) => {
			asked.push(id);
			await gate;
			return extentOf(id);
		};
	};

/** A macrotask, past every measure that has answered. */
const settle = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

const guidesOn = (context: ToolContext): Record<string, string | null>[] =>
	[...context.overlay.querySelectorAll('.snap-guide')].map((line) => ({
		x1: line.getAttribute('x1'),
		y1: line.getAttribute('y1'),
		x2: line.getAttribute('x2'),
		y2: line.getAttribute('y2'),
	}));

describe('snapping the layers as they drag', () => {
	// The group's right edge at 98, 2 short of the canvas's; its top at 53, 3 past the canvas's middle.
	const NEAR = [18, 3] as const;

	it('snaps what they paint to the canvas and to the other layers, and the command moves them by as much', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, { active: 'layer-3' });
		const asked: string[] = [];
		const move = createLayersMove(liveExtent(asked));
		move.begin(context, at(0, 0));
		// What moves, then what it may snap to: not the hidden layer, nor the group's own.
		expect(asked).toEqual(['layer-3', 'layer-1']);
		await settle();
		move.move(context, at(...NEAR));
		expect(transformOf(editor, 'layer-3')).toBe('translate(20 0)');
		expect(guidesOn(context)).toEqual([
			{ x1: '100', y1: '0', x2: '100', y2: '100' },
			{ x1: '0', y1: '50', x2: '100', y2: '50' },
		]);
		move.end(context, at(...NEAR));
		expect(transformOf(editor, 'layer-3')).toBe('translate(20 0)');
		expect(guidesOn(context)).toEqual([]);
		editor.undo();
		expect(transformOf(editor, 'layer-3')).toBeNull();
	});

	it('does not snap before what moves is measured, while Control is held, or with Snap off', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, { active: 'layer-3' });
		const move = createLayersMove(liveExtent());
		move.begin(context, at(0, 0));
		move.move(context, at(...NEAR));
		expect(transformOf(editor, 'layer-3')).toBe('translate(18 3)');
		await settle();
		move.move(context, { ...at(...NEAR), controlKey: true });
		expect(transformOf(editor, 'layer-3')).toBe('translate(18 3)');
		expect(guidesOn(context)).toEqual([]);
		move.move(context, at(...NEAR));
		expect(transformOf(editor, 'layer-3')).toBe('translate(20 0)');
		move.end(context, { ...at(...NEAR), controlKey: true });
		expect(transformOf(editor, 'layer-3')).toBe('translate(18 3)');

		const off = contextFor(open(SNAP_SCENE), { active: 'layer-3', options: { snap: false } });
		const asked: string[] = [];
		const still = createLayersMove(liveExtent(asked));
		still.begin(off.context, at(0, 0));
		await settle();
		still.move(off.context, at(...NEAR));
		still.end(off.context, at(...NEAR));
		expect(asked).toEqual([]);
		expect(transformOf(off.context.document, 'layer-3')).toBe('translate(18 3)');
	});

	it('takes what moves where it was as the drag began, though its measure came in after the drag moved it', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, { active: 'layer-3' });
		const gate: { open?: () => void } = {};
		const opened = new Promise<void>((resolve) => {
			gate.open = resolve;
		});
		const move = createLayersMove(liveExtent([], opened));
		move.begin(context, at(0, 0));
		move.move(context, at(13, 0));
		expect(transformOf(editor, 'layer-3')).toBe('translate(13 0)');
		gate.open?.();
		await settle();
		move.move(context, at(...NEAR));
		expect(transformOf(editor, 'layer-3')).toBe('translate(20 0)');
		move.cancel(context);
		expect(transformOf(editor, 'layer-3')).toBeNull();
		expect(guidesOn(context)).toEqual([]);
	});

	it('snaps the layers chosen to one beside them in a group, not to the group that holds one of them', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, {
			active: 'layer-1',
			layers: ['layer-1', 'layer-4'],
		});
		const asked: string[] = [];
		const move = createLayersMove(liveExtent(asked));
		move.begin(context, at(0, 0));
		expect(asked).toEqual(['layer-1', 'layer-4', 'layer-5']);
		await settle();
		// The two paint 10 to 60 across: their right edge at 68, 2 short of layer 5's left.
		move.move(context, at(8, 0));
		move.end(context, at(8, 0));
		expect(transformOf(editor, 'layer-1')).toBe('translate(10 0)');
		expect(transformOf(editor, 'layer-4')).toBe('translate(10 0)');
	});

	it('moves the layers as far as a click’s tremor took them, unsnapped', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, { active: 'layer-3' });
		const move = createLayersMove(liveExtent());
		move.begin(context, at(0, 0));
		await settle();
		// The group's left edge at 51, a unit past the canvas's middle.
		move.move(context, at(1, 0));
		move.end(context, at(1, 0));
		expect(transformOf(editor, 'layer-3')).toBe('translate(1 0)');
	});

	it('leaves the arrows’ nudge unsnapped, a unit from the canvas’s middle a unit from it', async () => {
		const editor = open(SNAP_SCENE);
		const { context } = contextFor(editor, { active: 'layer-3' });
		const move = createLayersMove(liveExtent());
		move.begin(context, at(0, 0));
		await settle();
		move.end(context, at(0, 0));
		expect(nudgeLayers(context, 0, 1)).toBe(true);
		expect(transformOf(editor, 'layer-3')).toBe('translate(0 1)');
	});
});
