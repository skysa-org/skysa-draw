import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import type { EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { LayerExtent, Offset } from '../../src/drawing/tools/common/align.js';
import {
	clearGuides,
	createDragSnap,
	drawGuides,
	type ExtentOf,
	type Guide,
	raiseGuides,
	SNAP_PX,
	snapOffset,
	snapTargetIds,
	STILL_PX,
} from '../../src/drawing/tools/common/snap.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import type { Box } from '../../src/drawing/tools/vector/geometry.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';

/**
 * Snapping, as Photoshop's View › Snap (docs/ARCHITECTURE.md §7, "The
 * editor"): the pure math of the offset and its guides, the layers a drag may
 * snap to, the guides on the overlay, and one drag's snapping against a
 * measure given in the browser's place, since jsdom measures nothing.
 */

const MOVING: Box = { x: 0, y: 0, width: 10, height: 10 };

/** Lines 50 apart, ten times the moving box's, so only one pair is ever in reach. */
const TARGET: Box = { x: 100, y: 300, width: 100, height: 100 };

const LINES = [
	['near edge', 0],
	['center', 0.5],
	['far edge', 1],
] as const;

const PAIRS = LINES.flatMap(([own, ownAt]) =>
	LINES.map(([target, targetAt]) => [own, target, ownAt, targetAt] as const)
);

/** A box as wide as a point, whose three lines are one. */
const point = (x: number, y: number): Box => ({ x, y, width: 0, height: 0 });

describe('the snapped offset', () => {
	it.each(PAIRS)(
		'pulls the box’s %s across onto a target’s %s, from either side',
		(_own, _target, ownAt, targetAt) => {
			const line = TARGET.x + TARGET.width * targetAt;
			const exact = line - MOVING.width * ownAt;
			[-2, 2].forEach((miss) => {
				const { offset, guides } = snapOffset(MOVING, [exact + miss, 0], [TARGET], 6);
				expect(offset).toEqual([exact, 0]);
				expect(guides).toEqual([{ axis: 'x', at: line, from: 0, to: 400 }]);
			});
		}
	);

	it.each(PAIRS)(
		'pulls the box’s %s down onto a target’s %s, from either side',
		(_own, _target, ownAt, targetAt) => {
			const line = TARGET.y + TARGET.height * targetAt;
			const exact = line - MOVING.height * ownAt;
			[-2, 2].forEach((miss) => {
				const { offset, guides } = snapOffset(MOVING, [0, exact + miss], [TARGET], 6);
				expect(offset).toEqual([0, exact]);
				expect(guides).toEqual([{ axis: 'y', at: line, from: 0, to: 200 }]);
			});
		}
	);

	it('snaps each axis on its own, each to a target of its own', () => {
		const across = { x: 50, y: 500, width: 40, height: 40 };
		const down = { x: 500, y: 80, width: 40, height: 40 };
		const { offset, guides } = snapOffset(MOVING, [48, 83], [across, down], 6);
		expect(offset).toEqual([50, 80]);
		expect(guides).toEqual([
			{ axis: 'x', at: 50, from: 80, to: 540 },
			{ axis: 'y', at: 80, from: 50, to: 540 },
		]);
	});

	it('leaves the axis with nothing in reach as the pointer has it', () => {
		const across = { x: 50, y: 500, width: 40, height: 40 };
		const { offset, guides } = snapOffset(MOVING, [48, 200], [across], 6);
		expect(offset).toEqual([50, 200]);
		expect(guides.map((guide) => guide.axis)).toEqual(['x']);
	});

	it('pulls from as far as the reach and no farther, and draws no guide out of it', () => {
		const wide = { x: 0, y: 0, width: 30, height: 30 };
		expect(snapOffset(wide, [64, 0], [TARGET], 6).offset).toEqual([70, 0]);
		expect(snapOffset(wide, [63.9, 0], [TARGET], 6)).toEqual({ offset: [63.9, 0], guides: [] });
		expect(snapOffset(MOVING, [80, 0], [TARGET], 6)).toEqual({ offset: [80, 0], guides: [] });
		expect(snapOffset(MOVING, [80, 0], [], 6)).toEqual({ offset: [80, 0], guides: [] });
	});

	it('takes the smallest pull of every pair in reach', () => {
		const wide = { x: 0, y: 0, width: 30, height: 30 };
		// Own lines at 96, 111 and 126: the one at 100 pulls by 4, the one at 93 by -3.
		const { offset, guides } = snapOffset(wide, [96, 0], [point(100, 300), point(93, 300)], 6);
		expect(offset).toEqual([93, 0]);
		expect(guides).toEqual([{ axis: 'x', at: 93, from: 0, to: 300 }]);
	});

	it('takes the first found of two pulls as small, in the order the targets are given', () => {
		const wide = { x: 0, y: 0, width: 30, height: 30 };
		const right = point(99, 300);
		const left = point(93, 300);
		expect(snapOffset(wide, [96, 0], [right, left], 6).offset).toEqual([99, 0]);
		expect(snapOffset(wide, [96, 0], [left, right], 6).offset).toEqual([93, 0]);
	});

	it('shows a guide for each line of the box that meets one where it snapped', () => {
		// Its left edge pulled onto one box's left puts its right edge on the other's.
		const left = { x: 50, y: 100, width: 100, height: 10 };
		const right = { x: 30, y: -50, width: 30, height: 10 };
		const { offset, guides } = snapOffset(MOVING, [48, 0], [left, right], 6);
		expect(offset).toEqual([50, 0]);
		expect(guides).toEqual([
			{ axis: 'x', at: 50, from: 0, to: 110 },
			{ axis: 'x', at: 60, from: -50, to: 10 },
		]);
	});

	it('draws one guide for a line two targets share, spanning the box and both', () => {
		const above = { x: 50, y: -100, width: 40, height: 10 };
		const below = { x: 30, y: 100, width: 20, height: 10 };
		const { guides } = snapOffset(MOVING, [48, 0], [above, below], 6);
		expect(guides).toEqual([{ axis: 'x', at: 50, from: -100, to: 110 }]);
	});

	it('draws a guide to the canvas along its whole side, and on to the box past it', () => {
		const canvas = { x: 0, y: 0, width: 200, height: 100 };
		const inside = { x: 20, y: 20, width: 10, height: 10 };
		expect(snapOffset(inside, [73, 0], [canvas], 6)).toEqual({
			offset: [75, 0],
			guides: [{ axis: 'x', at: 100, from: 0, to: 100 }],
		});
		const below = { x: 20, y: 150, width: 10, height: 10 };
		expect(snapOffset(below, [73, 0], [canvas], 6).guides).toEqual([
			{ axis: 'x', at: 100, from: 0, to: 160 },
		]);
	});

	it('draws one guide for a box with no size, whose three lines are one', () => {
		expect(snapOffset(point(0, 0), [98, 0], [TARGET], 6)).toEqual({
			offset: [100, 0],
			guides: [{ axis: 'x', at: 100, from: 0, to: 400 }],
		});
	});

	it('keeps a box already on a line where it is, with its guide', () => {
		expect(snapOffset(MOVING, [100, 0], [TARGET], 6)).toEqual({
			offset: [100, 0],
			guides: [{ axis: 'x', at: 100, from: 0, to: 400 }],
		});
	});
});

const layerInfo = (id: string, overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id,
	kind: 'vector',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: overrides.parentId === undefined ? 0 : 1,
	parentId: undefined,
	loose: false,
	...overrides,
});

describe('the layers a drag may snap to', () => {
	const LAYERS: readonly LayerInfo[] = [
		layerInfo('layer-1'),
		layerInfo('layer-2', { kind: 'raster' }),
		layerInfo('holds', { kind: 'group' }),
		layerInfo('layer-4', { parentId: 'holds' }),
		layerInfo('layer-5', { parentId: 'holds' }),
		layerInfo('moves', { kind: 'group' }),
		layerInfo('inner', { kind: 'group', parentId: 'moves' }),
		layerInfo('layer-8', { parentId: 'inner', depth: 2 }),
		layerInfo('hidden-group', { kind: 'group', hidden: true }),
		layerInfo('layer-10', { parentId: 'hidden-group' }),
		layerInfo('layer-11', { hidden: true }),
		layerInfo('group', { kind: 'group' }),
		layerInfo('layer-13', { parentId: 'group' }),
	];

	it('are every other layer in sight, in paint order, past what moves, what is in it, and what holds it', () => {
		expect(snapTargetIds(LAYERS, ['layer-1', 'layer-4', 'moves'])).toEqual([
			'layer-2',
			'layer-5',
			'group',
			'layer-13',
		]);
	});

	it('are every layer in sight where nothing named moves', () => {
		expect(snapTargetIds(LAYERS, [])).toEqual([
			'layer-1',
			'layer-2',
			'holds',
			'layer-4',
			'layer-5',
			'moves',
			'inner',
			'layer-8',
			'group',
			'layer-13',
		]);
	});
});

const newOverlay = (): SVGSVGElement => document.createElementNS(SVG_NAMESPACE, 'svg');

/** The guides on the overlay, as lines. */
const linesOn = (overlay: SVGSVGElement): Record<string, string | null>[] =>
	[...overlay.querySelectorAll('.snap-guide')].map((line) => ({
		x1: line.getAttribute('x1'),
		y1: line.getAttribute('y1'),
		x2: line.getAttribute('x2'),
		y2: line.getAttribute('y2'),
	}));

describe('the guides on the overlay', () => {
	const GUIDES: readonly Guide[] = [
		{ axis: 'x', at: 100, from: 0, to: 400 },
		{ axis: 'y', at: 50.5, from: -10, to: 20 },
	];

	it('draws each as a hairline, upright for a line across and level for one down, in a group of their own', () => {
		const overlay = newOverlay();
		drawGuides(overlay, GUIDES);
		expect(linesOn(overlay)).toEqual([
			{ x1: '100', y1: '0', x2: '100', y2: '400' },
			{ x1: '-10', y1: '50.5', x2: '20', y2: '50.5' },
		]);
		const group = overlay.querySelector('[data-snap-guides]');
		expect(group?.getAttribute('class')).toBe('snap-guides');
		expect(
			[...overlay.querySelectorAll('.snap-guide')].map((line) =>
				line.getAttribute('vector-effect')
			)
		).toEqual(['non-scaling-stroke', 'non-scaling-stroke']);
	});

	it('draws them afresh each time, takes them away for none, and leaves the rest of the overlay', () => {
		const overlay = newOverlay();
		const box = overlay.appendChild(document.createElementNS(SVG_NAMESPACE, 'rect'));
		drawGuides(overlay, GUIDES);
		drawGuides(overlay, GUIDES.slice(1));
		expect(overlay.querySelectorAll('[data-snap-guides]')).toHaveLength(1);
		expect(linesOn(overlay)).toHaveLength(1);
		drawGuides(overlay, []);
		expect(overlay.querySelector('[data-snap-guides]')).toBeNull();
		drawGuides(overlay, GUIDES);
		clearGuides(overlay);
		expect([...overlay.children]).toEqual([box]);
	});

	it('are put back over what was drawn after them', () => {
		const overlay = newOverlay();
		drawGuides(overlay, GUIDES);
		const box = overlay.appendChild(document.createElementNS(SVG_NAMESPACE, 'g'));
		raiseGuides(overlay);
		expect(overlay.lastElementChild?.hasAttribute('data-snap-guides')).toBe(true);
		expect(overlay.firstElementChild).toBe(box);
		clearGuides(overlay);
		raiseGuides(overlay);
		expect([...overlay.children]).toEqual([box]);
	});
});

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** Bottom to top: what moves, a layer to snap to, and a hidden one that would pull nearer. */
const LAYERS = [
	'<g id="layer-1" draw:kind="vector"><rect x="20" y="20" width="10" height="10"/></g>',
	'<g id="layer-2" draw:kind="vector"><rect x="120" y="60" width="40" height="20"/></g>',
	'<g id="layer-3" draw:kind="vector" display="none"><rect x="119" y="0" width="1" height="1"/></g>',
].join('\n');

/** What each layer paints, as a measure would say it as the drag began. */
const BOXES: Readonly<Record<string, Box>> = {
	'layer-1': { x: 20, y: 20, width: 10, height: 10 },
	'layer-2': { x: 120, y: 60, width: 40, height: 20 },
	'layer-3': { x: 119, y: 0, width: 1, height: 1 },
};

const open = (): EditorDocument => {
	const opened = openDocument(
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 200 100" width="200" height="100">`,
			LAYERS,
			'</svg>',
			'',
		].join('\n')
	);
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

const noop = (): undefined => undefined;

const at = (extra: Partial<PointerSample> = {}): PointerSample => ({
	x: 0,
	y: 0,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType: 'mouse',
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
	...extra,
});

const contextFor = (
	editor: EditorDocument,
	setup: Readonly<{ options?: Partial<ToolOptions>; scale?: number }> = {}
): ToolContext =>
	createToolContext({
		document: editor,
		layer: editor.snapshot().layers.find((layer) => layer.id === 'layer-1'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: newOverlay(),
		canvas: document.createElement('canvas'),
		pixelRatio: () => 1,
		view: observable({ scale: setup.scale ?? 1, tx: 0, ty: 0 }),
		selection: observable<readonly Element[]>([]),
		region: observable<Region | undefined>(undefined),
		host: document.createElement('div'),
		fit: noop,
		actualSize: noop,
		setColor: noop,
		notify: noop,
	});

/** A macrotask, past every measure that has resolved. */
const settle = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

/** `box` moved by `offset`. */
const shifted = (box: Box | undefined, [dx, dy]: Offset): Box | undefined =>
	box === undefined ? undefined : { ...box, x: box.x + dx, y: box.y + dy };

/**
 * A measure that answers from `boxes` as it is asked, with layer 1 where
 * `live()` has it then, as the browser's reads a layer the drag moved live;
 * each asked for is kept in `asked`.
 */
const measured = (
	boxes: Readonly<Record<string, Box>> = BOXES,
	live: () => Offset = () => [0, 0]
) => {
	const asked: string[] = [];
	const extentOf: ExtentOf = () => (id) => {
		asked.push(id);
		return Promise.resolve(shifted(boxes[id], id === 'layer-1' ? live() : [0, 0]));
	};
	return { asked, extentOf };
};

/**
 * A measure that answers when `release` is called, with layer 1 where
 * `offset()` has it then, as a measure of a layer moved live does, and the
 * others where they are.
 */
const held = (offset: () => Offset) => {
	const gate: { open?: () => void } = {};
	const opened = new Promise<void>((resolve) => {
		gate.open = resolve;
	});
	const extent: LayerExtent = async (id) => {
		await opened;
		return shifted(BOXES[id], id === 'layer-1' ? offset() : [0, 0]);
	};
	const extentOf: ExtentOf = () => extent;
	return { extentOf, release: () => gate.open?.() };
};

describe('one drag’s snapping', () => {
	// Layer 1's right edge, at 118 after a move of 88, is 2 short of layer 2's left.
	const NEAR: Offset = [88, 0];
	const SNAPPED: Offset = [90, 0];

	it('snaps once what moves is measured, and not before', async () => {
		const applied = { current: [0, 0] as Offset };
		const { asked, extentOf } = measured(BOXES, () => applied.current);
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		applied.current = snap.move(context, at(), NEAR);
		expect(applied.current).toEqual(NEAR);
		expect(linesOn(context.overlay)).toEqual([]);
		await settle();
		// Asked again, since the drag moved before the first answer.
		expect(asked).toEqual(['layer-1', 'layer-2', 'layer-1']);
		expect(snap.move(context, at(), NEAR)).toEqual(SNAPPED);
		expect(linesOn(context.overlay)).toEqual([{ x1: '120', y1: '20', x2: '120', y2: '80' }]);
	});

	it('asks for what moves first, then each layer it may snap to, never a hidden one', () => {
		const { asked, extentOf } = measured();
		const snap = createDragSnap(extentOf);
		snap.beginLayers(contextFor(open()), ['layer-1']);
		expect(asked).toEqual(['layer-1', 'layer-2']);
	});

	it('takes the canvas on a tie with a layer', async () => {
		const { extentOf } = measured({
			...BOXES,
			'layer-2': { x: 104, y: 60, width: 40, height: 20 },
		});
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		await settle();
		// Its center, at 102, between the canvas's at 100 and layer 2's left edge at 104.
		expect(snap.move(context, at(), [77, 0])).toEqual([75, 0]);
	});

	it('measures nothing and snaps nothing with Snap off', async () => {
		const { asked, extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open(), { options: { snap: false } });
		snap.beginLayers(context, ['layer-1']);
		await settle();
		expect(asked).toEqual([]);
		expect(snap.move(context, at(), NEAR)).toEqual(NEAR);
	});

	it('does not snap while Control is held, and snaps again once it is let go', async () => {
		const { extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		await settle();
		expect(snap.move(context, at(), NEAR)).toEqual(SNAPPED);
		expect(snap.move(context, at({ controlKey: true }), NEAR)).toEqual(NEAR);
		expect(linesOn(context.overlay)).toEqual([]);
		expect(snap.move(context, at({ controlKey: false }), NEAR)).toEqual(SNAPPED);
		expect(snap.end(context, at({ controlKey: true }), NEAR)).toEqual(NEAR);
	});

	it('does not snap a click, or a tremor, until the pointer has gone a few pixels on the screen', async () => {
		const { extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open(), { scale: 2 });
		// Its center 1 short of the canvas's, well in reach.
		const box = { x: 94, y: 20, width: 10, height: 10 };
		snap.beginBox(context, box, 'layer-1', []);
		await settle();
		expect(STILL_PX).toBe(3);
		expect(snap.end(context, at(), [0, 0])).toEqual([0, 0]);
		snap.beginBox(context, box, 'layer-1', []);
		await settle();
		expect(snap.move(context, at(), [1, 0])).toEqual([1, 0]);
		expect(snap.move(context, at(), [0, 1.4])).toEqual([0, 1.4]);
		expect(snap.end(context, at(), [1, 1])).toEqual([1, 1]);
		snap.beginBox(context, box, 'layer-1', []);
		await settle();
		// 1.5 user units at twice the size: 3 pixels away, and snapping from then on.
		expect(snap.move(context, at(), [1.5, 0])).toEqual([1, 0]);
		expect(snap.move(context, at(), [0.5, 0])).toEqual([1, 0]);
		expect(snap.end(context, at(), [0, 0])).toEqual([1, 0]);
	});

	it('reaches as far on the screen at any zoom', async () => {
		expect(SNAP_PX).toBe(6);
		const { extentOf } = measured();
		const zoomed = contextFor(open(), { scale: 2 });
		const snap = createDragSnap(extentOf);
		snap.beginLayers(zoomed, ['layer-1']);
		await settle();
		expect(snap.move(zoomed, at(), [87, 0])).toEqual(SNAPPED);
		expect(snap.move(zoomed, at(), [86.5, 0])).toEqual([86.5, 0]);
		const out = contextFor(open(), { scale: 0.5 });
		snap.beginLayers(out, ['layer-1']);
		await settle();
		// Its bottom edge, at 40, 10 short of the canvas's middle.
		expect(snap.move(out, at(), [-100, 10])).toEqual([-100, 20]);
	});

	it('ends with the offset snapped as a move would snap it, its guides gone, as a cancel leaves none', async () => {
		const { extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		await settle();
		snap.move(context, at(), NEAR);
		expect(snap.end(context, at(), [89, 1])).toEqual([90, 1]);
		expect(context.overlay.childElementCount).toBe(0);
		expect(snap.move(context, at(), NEAR)).toEqual(NEAR);
		snap.beginLayers(context, ['layer-1']);
		await settle();
		snap.move(context, at(), NEAR);
		snap.cancel(context);
		expect(context.overlay.childElementCount).toBe(0);
	});

	it('lets go of measures that come in after their drag ended', async () => {
		const late = held(() => [0, 0]);
		const snap = createDragSnap(late.extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		snap.cancel(context);
		late.release();
		await settle();
		expect(snap.move(context, at(), NEAR)).toEqual(NEAR);
	});

	it('goes on without snapping where the drag keeps moving before what moves is measured', async () => {
		const applied = { current: [0, 0] as Offset };
		const asked: string[] = [];
		// Each answer a macrotask after it is asked, and a step of the drag before it.
		const extentOf: ExtentOf = () => (id) => {
			asked.push(id);
			return new Promise((resolve) => {
				setTimeout(() =>
					resolve(shifted(BOXES[id], id === 'layer-1' ? applied.current : [0, 0]))
				);
			});
		};
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		await [1, 2, 3, 4].reduce(async (before, step) => {
			await before;
			applied.current = snap.move(context, at(), [step, 0]);
			await settle();
		}, Promise.resolve());
		expect(asked.filter((id) => id === 'layer-1')).toHaveLength(3);
		expect(snap.move(context, at(), NEAR)).toEqual(NEAR);
	});

	it('measures several layers that move together by the box around them, past one that paints nothing', async () => {
		const { asked, extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1', 'nothing', 'layer-2']);
		expect(asked).toEqual(['layer-1', 'nothing', 'layer-2']);
		await settle();
		// The box around both, 20 to 160 across, its center at 102, 2 past the
		// canvas's; and 20 to 80 down, its middle on the canvas's already.
		expect(snap.move(context, at(), [12, 0])).toEqual([10, 0]);
		expect(linesOn(context.overlay)).toEqual([
			{ x1: '100', y1: '0', x2: '100', y2: '100' },
			{ x1: '0', y1: '50', x2: '200', y2: '50' },
		]);
	});

	it('takes what moves where it was as the drag began, though measured after the drag moved it', async () => {
		// The measure reads the layer where the drag last put it, live.
		const applied = { current: [0, 0] as Offset };
		const slow = held(() => applied.current);
		const snap = createDragSnap(slow.extentOf);
		const context = contextFor(open());
		snap.beginLayers(context, ['layer-1']);
		applied.current = snap.move(context, at(), [13, 0]);
		slow.release();
		await settle();
		expect(snap.move(context, at(), NEAR)).toEqual(SNAPPED);
	});

	it('snaps a box given on a layer to the canvas, to the other layers, and to what is beside it', async () => {
		const { asked, extentOf } = measured();
		const snap = createDragSnap(extentOf);
		const context = contextFor(open());
		const beside = { x: 40, y: 0, width: 50, height: 10 };
		snap.beginBox(context, { x: 0, y: 30, width: 10, height: 10 }, 'layer-1', [beside]);
		expect(asked).toEqual(['layer-2']);
		expect(snap.move(context, at(), [38, 0])).toEqual([38, 0]);
		await settle();
		// Its left edge, at 38, 2 short of the box beside it.
		expect(snap.move(context, at(), [38, 0])).toEqual([40, 0]);
		expect(linesOn(context.overlay)).toEqual([{ x1: '40', y1: '0', x2: '40', y2: '40' }]);
		// Its right edge, at 118, 2 short of layer 2's left.
		expect(snap.move(context, at(), [108, 0])).toEqual([110, 0]);
	});
});
