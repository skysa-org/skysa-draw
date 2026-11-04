import {
	DEFAULT_DRAWING_SIZE,
	DRAWING_NAMESPACE,
	emptyDrawing,
	SVG_NAMESPACE,
} from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { areaOf, reachesArea, rectPath } from '../../src/drawing/tools/raster/area.js';
import type * as Space from '../../src/drawing/tools/raster/space.js';
import {
	type Pixels,
	WAND_MAX_CORNERS,
	wandBehavior,
	wandMask,
} from '../../src/drawing/tools/raster/wand.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import type * as Geometry from '../../src/drawing/tools/vector/geometry.js';
import { attributeBox } from '../../src/drawing/tools/vector/measure.js';
import { createWand } from '../../src/drawing/tools/vector/wand.js';
import { regionControl } from '../../src/drawing/viewport/context.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { t } from '../../src/i18n/t.js';
import { installFakeCanvas, registerPicture, uninstallFakeCanvas } from './fakeCanvas.js';

/**
 * The magic wand (docs/decisions/0004-the-interface.md): on a raster layer
 * the pixels of a color as the area selection, through the compositing fake
 * canvas (`fakeCanvas.ts`) and a real document, the area held as the
 * viewport holds it (`regionControl`); on a vector layer the elements of a
 * color, against a real SVG document. The outline itself is `trace.test.ts`.
 *
 * jsdom has no SVG transforms, so where a layer's `transform` is read here it
 * is read from the attribute, as a browser reads one on a layer at the root.
 */

vi.mock('../../src/drawing/tools/raster/space.js', async (importOriginal) => {
	const geometry = await vi.importActual<typeof Geometry>(
		'../../src/drawing/tools/vector/geometry.js'
	);
	return {
		...(await importOriginal<typeof Space>()),
		toLocal: (
			layer: Element,
			_root: Element,
			x: number,
			y: number
		): readonly [number, number] => {
			const local = geometry.apply(
				geometry.invert(geometry.parseTransform(layer.getAttribute('transform'))),
				{ x, y }
			);
			return [local.x, local.y];
		},
	};
});

const noop = (): undefined => undefined;

const sample = (x: number, y: number, overrides: Partial<PointerSample> = {}): PointerSample => ({
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
	...overrides,
});

/** A click: pressed and lifted at the same point. */
const click = (tool: ToolBehavior, context: ToolContext, at: PointerSample): void => {
	tool.begin(context, at);
	tool.end(context, at);
};

/** Every promise the click began, settled. */
const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const RED = [255, 0, 0, 255] as const;
const NEAR_RED = [250, 0, 0, 255] as const;
const BLUE = [0, 0, 255, 255] as const;
const CLEAR = [0, 0, 0, 0] as const;

const pixelsOf = (
	width: number,
	height: number,
	paint: (x: number, y: number) => readonly number[]
): Pixels => {
	const data = new Uint8ClampedArray(width * height * 4);
	Array.from({ length: width * height }).forEach((_, i) => {
		data.set(paint(i % width, Math.floor(i / width)), i * 4);
	});
	return { data, width, height };
};

const selectedOf = (mask: { selected: Uint8Array } | undefined): number[] => [
	...(mask?.selected ?? []),
];

describe('wandMask', () => {
	// Two red runs, the second a shade off, apart; a clear pixel between them.
	const row = pixelsOf(7, 1, (x) => [RED, RED, CLEAR, NEAR_RED, NEAR_RED, BLUE, RED][x] ?? CLEAR);

	it('selects the pixels joined to the one clicked by their sides, within the tolerance', () => {
		expect(selectedOf(wandMask(row, 0.5, 0.5, 0.1, true))).toEqual([1, 1, 0, 0, 0, 0, 0]);
	});

	it('selects every pixel of the layer within the tolerance with contiguous off', () => {
		expect(selectedOf(wandMask(row, 0.5, 0.5, 0.1, false))).toEqual([1, 1, 0, 1, 1, 0, 1]);
		expect(selectedOf(wandMask(row, 0.5, 0.5, 0, false))).toEqual([1, 1, 0, 0, 0, 0, 1]);
	});

	it('measures color as the fill does, alpha with the rest, so a clear pixel selects the clear ones', () => {
		const faint = [0, 0, 0, 30];
		const strip = pixelsOf(4, 1, (x) => [CLEAR, faint, RED, CLEAR][x] ?? CLEAR);
		expect(selectedOf(wandMask(strip, 0, 0, 0.1, false))).toEqual([1, 1, 0, 1]);
		expect(selectedOf(wandMask(strip, 0, 0, 0.01, false))).toEqual([1, 0, 0, 1]);
		// 30 of 510 is just under 0.06.
		expect(selectedOf(wandMask(strip, 0, 0, 0.058, false))).toEqual([1, 0, 0, 1]);
		expect(selectedOf(wandMask(strip, 0, 0, 0.059, false))).toEqual([1, 1, 0, 1]);
	});

	it('does not join pixels that touch only at a corner', () => {
		const diagonal = pixelsOf(2, 2, (x, y) => (x === y ? RED : BLUE));
		expect(selectedOf(wandMask(diagonal, 0, 0, 0.1, true))).toEqual([1, 0, 0, 0]);
		expect(selectedOf(wandMask(diagonal, 0, 0, 0.1, false))).toEqual([1, 0, 0, 1]);
	});

	it('always selects the pixel clicked, and nothing for a point outside the pixels', () => {
		expect(selectedOf(wandMask(row, 5.9, 0.2, 0, true))).toEqual([0, 0, 0, 0, 0, 1, 0]);
		// A tolerance under 0 is 0: the same color only.
		expect(selectedOf(wandMask(row, 0, 0, -1, true))).toEqual([1, 1, 0, 0, 0, 0, 0]);
		[
			[-0.1, 0],
			[7, 0],
			[0, 1],
			[0, -0.5],
		].forEach(([x = 0, y = 0]) => {
			expect(wandMask(row, x, y, 0.1, true)).toBeUndefined();
		});
	});

	it('floods a picture as large as a photo without recursing', () => {
		const size = 1500;
		const spiral = pixelsOf(size, size, (x, y) =>
			x % 2 === 0 || (y === 0 && x % 4 === 1) || (y === size - 1 && x % 4 === 3) ? RED : BLUE
		);
		const mask = wandMask(spiral, 0, 0, 0.1, true);
		expect(mask?.selected.reduce((sum, on) => sum + on, 0)).toBeGreaterThan((size * size) / 2);
	});
});

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/**
 * 40 × 30 pixels at (5, 7): a red square at pixels 10 to 19 by 5 to 14, a
 * near-red one at 25 to 34 by the same, a blue strip across rows 20 to 24,
 * and nothing anywhere else.
 */
const picture = (): string =>
	registerPicture(40, 30, (x, y) => {
		if (y >= 20 && y < 25) return [...BLUE];
		if (y >= 5 && y < 15 && x >= 10 && x < 20) return [...RED];
		if (y >= 5 && y < 15 && x >= 25 && x < 35) return [...NEAR_RED];
		return [...CLEAR];
	});

/** The red square, as the area selection: its pixels' edges in user units. */
const RED_SQUARE = 'M 15 12 L 25 12 L 25 22 L 15 22 Z';
const NEAR_RED_SQUARE = 'M 30 12 L 40 12 L 40 22 L 30 22 Z';

/** A point on a pixel of the layer, in user units. */
const onPixel = (x: number, y: number, overrides: Partial<PointerSample> = {}): PointerSample =>
	sample(5 + x + 0.5, 7 + y + 0.5, overrides);

type RasterFake = Readonly<{
	context: ToolContext;
	region: () => Region | undefined;
	notices: string[];
}>;

type RasterSetup = Readonly<{
	layerAttributes?: string;
	href?: string;
	size?: Readonly<{ width: number; height: number }>;
	region?: Region;
	options?: Partial<ToolOptions>;
}>;

const rasterFake = (setup: RasterSetup = {}): RasterFake => {
	const { width, height } = setup.size ?? { width: 40, height: 30 };
	const text = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 60 50" width="60" height="50">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster"${setup.layerAttributes ?? ''}><image href="${setup.href ?? picture()}" x="5" y="7" width="${width}" height="${height}" preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');
	const opened = openDocument(text);
	if (opened === undefined) throw new Error('the drawing opens');
	const held = observable<Region | undefined>(setup.region);
	const notices: string[] = [];
	const context: ToolContext = {
		document: opened,
		layer: opened.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: regionControl(held),
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	return { context, region: held.get, notices };
};

const plain = (path: string): Region => ({ path, inverted: false, feather: 0 });

describe('the magic wand on a raster layer', () => {
	beforeEach(() => installFakeCanvas());
	afterEach(uninstallFakeCanvas);

	it('selects the pixels of the color clicked, joined to it, as the area, in user units', async () => {
		const fake = rasterFake();
		click(wandBehavior(), fake.context, onPixel(12, 8));
		await settled();
		expect(fake.region()).toEqual(plain(RED_SQUARE));
		expect(fake.notices).toEqual([]);
	});

	it('selects every pixel of the color in the layer with contiguous off, within the tolerance', async () => {
		const loose = rasterFake({ options: { contiguous: false } });
		click(wandBehavior(), loose.context, onPixel(12, 8));
		await settled();
		expect(loose.region()).toEqual(plain(`${RED_SQUARE} ${NEAR_RED_SQUARE}`));
		const exact = rasterFake({ options: { contiguous: false, tolerance: 0 } });
		click(wandBehavior(), exact.context, onPixel(12, 8));
		await settled();
		expect(exact.region()).toEqual(plain(RED_SQUARE));
	});

	it('selects the clear pixels from a clear one, with the colored ones as holes', async () => {
		const fake = rasterFake();
		click(wandBehavior(), fake.context, onPixel(1, 1));
		await settled();
		// The clear pixels above the blue strip, clockwise, and the two squares in them the other way.
		expect(fake.region()?.path).toBe(
			'M 5 7 L 45 7 L 45 27 L 5 27 Z M 15 12 L 15 22 L 25 22 L 25 12 Z M 30 12 L 30 22 L 40 22 L 40 12 Z'
		);
	});

	it('replaces the area with a new plain one without Shift, an inverted or feathered one too', async () => {
		const fake = rasterFake({
			region: { path: 'M 0 0 L 1 0 L 1 1 Z', inverted: true, feather: 4 },
		});
		click(wandBehavior(), fake.context, onPixel(12, 8));
		await settled();
		expect(fake.region()).toEqual(plain(RED_SQUARE));
	});

	it('adds to the area with Shift, as the marquee adds, keeping its feather', async () => {
		const there = rectPath({ x: 0, y: 0, width: 4, height: 4 }) ?? '';
		const fake = rasterFake({ region: { path: there, inverted: false, feather: 2 } });
		click(wandBehavior(), fake.context, onPixel(12, 8, { shiftKey: true }));
		await settled();
		expect(fake.region()).toEqual({
			path: `${there} ${RED_SQUARE}`,
			inverted: false,
			feather: 2,
		});
	});

	it('starts a new area with Shift over an inverted one, as the marquee does', async () => {
		const fake = rasterFake({
			region: { path: 'M 0 0 L 4 0 L 4 4 L 0 4 Z', inverted: true, feather: 0 },
		});
		click(wandBehavior(), fake.context, onPixel(12, 8, { shiftKey: true }));
		await settled();
		expect(fake.region()).toEqual(plain(RED_SQUARE));
	});

	it('deselects on a click outside the layer’s pixels, and keeps the area there with Shift', async () => {
		const there = plain('M 0 0 L 4 0 L 4 4 L 0 4 Z');
		const fake = rasterFake({ region: there });
		click(wandBehavior(), fake.context, sample(55, 45, { shiftKey: true }));
		await settled();
		expect(fake.region()).toEqual(there);
		click(wandBehavior(), fake.context, sample(55, 45));
		await settled();
		expect(fake.region()).toBeUndefined();
	});

	it('takes the pixels where the pointer was pressed, and nothing for a press canceled', async () => {
		const fake = rasterFake();
		const tool = wandBehavior();
		tool.begin(fake.context, onPixel(12, 8));
		tool.move(fake.context, onPixel(1, 1));
		tool.end(fake.context, onPixel(1, 1));
		await settled();
		expect(fake.region()).toEqual(plain(RED_SQUARE));
		const other = rasterFake();
		tool.begin(other.context, onPixel(12, 8));
		tool.cancel(other.context);
		tool.end(other.context, onPixel(12, 8));
		await settled();
		expect(other.region()).toBeUndefined();
	});

	it('selects from a locked layer, which it only reads, and not from a hidden one', async () => {
		const locked = rasterFake({ layerAttributes: ' draw:locked="true"' });
		click(wandBehavior(), locked.context, onPixel(12, 8));
		await settled();
		expect(locked.region()).toEqual(plain(RED_SQUARE));
		expect(locked.notices).toEqual([]);
		const there = plain('M 0 0 L 4 0 L 4 4 L 0 4 Z');
		const hidden = rasterFake({ layerAttributes: ' display="none"', region: there });
		click(wandBehavior(), hidden.context, onPixel(12, 8));
		await settled();
		expect(hidden.region()).toEqual(there);
		expect(hidden.notices).toEqual([t('layers.hidden', { name: 'Layer 2' })]);
	});

	it('puts the outline under a layer the select tool moved, scaled or flipped', async () => {
		const moved = rasterFake({ layerAttributes: ' transform="translate(3 4) scale(2)"' });
		click(wandBehavior(), moved.context, sample(37, 34));
		await settled();
		expect(moved.region()?.path).toBe('M 33 28 L 53 28 L 53 48 L 33 48 Z');
		const flipped = rasterFake({ layerAttributes: ' transform="scale(-1 1)"' });
		click(wandBehavior(), flipped.context, sample(-17.5, 15.5));
		await settled();
		// Written backward, so the outline is still clockwise in the drawing’s units.
		expect(flipped.region()?.path).toBe('M -15 22 L -25 22 L -25 12 L -15 12 Z');
	});

	it('says so for a picture that would not decode, and keeps the area', async () => {
		const there = plain('M 0 0 L 4 0 L 4 4 L 0 4 Z');
		const fake = rasterFake({ href: 'data:image/png;base64,bm90aGluZw==', region: there });
		click(wandBehavior(), fake.context, onPixel(12, 8));
		await settled();
		expect(fake.region()).toEqual(there);
		expect(fake.notices).toEqual([t('tools.wandUnreadable')]);
	});

	it('refuses an outline of more corners than an area can bear, and keeps the area', async () => {
		const size = 710;
		const href = registerPicture(size, size, (x, y) =>
			(x + y) % 2 === 0 ? [...RED] : [...BLUE]
		);
		expect((size * size * 4) / 2).toBeGreaterThan(WAND_MAX_CORNERS);
		const there = plain('M 0 0 L 4 0 L 4 4 L 0 4 Z');
		const scattered = rasterFake({
			href,
			size: { width: size, height: size },
			region: there,
			options: { contiguous: false },
		});
		click(wandBehavior(), scattered.context, onPixel(0, 0));
		await settled();
		expect(scattered.region()).toEqual(there);
		expect(scattered.notices).toEqual([t('tools.wandTooDetailed')]);
		const joined = rasterFake({ href, size: { width: size, height: size } });
		click(wandBehavior(), joined.context, onPixel(0, 0));
		await settled();
		expect(joined.region()).toEqual(plain('M 5 7 L 6 7 L 6 8 L 5 8 Z'));
	});
});

describe('the area a wand makes, as the raster tools read it', () => {
	beforeEach(() => installFakeCanvas());
	afterEach(uninstallFakeCanvas);

	it('paints in the hole of an inverted ring, which is selected, and not on the ring', async () => {
		const fake = rasterFake();
		click(wandBehavior(), fake.context, onPixel(1, 1));
		await settled();
		fake.context.region.update({ inverted: true });
		const area = areaOf(fake.context);
		if (area === undefined) throw new Error('there is an area');
		// Inside the red square, a hole in the clear pixels' outline: outside the outline, so selected.
		expect(reachesArea(area, { x: 18, y: 15, width: 2, height: 2 })).toBe(true);
		// On the clear pixels, inside the outline: not selected.
		expect(reachesArea(area, { x: 6, y: 8, width: 2, height: 2 })).toBe(false);
	});

	it('reads an outline of more than a hundred thousand corners', async () => {
		const size = 300;
		const href = registerPicture(size, size, (x, y) =>
			(x + y) % 2 === 0 ? [...RED] : [...BLUE]
		);
		const fake = rasterFake({
			href,
			size: { width: size, height: size },
			options: { contiguous: false },
		});
		click(wandBehavior(), fake.context, onPixel(0, 0));
		await settled();
		expect(fake.notices).toEqual([]);
		expect(() => areaOf(fake.context)).not.toThrow();
		expect(areaOf(fake.context)?.bounds).toEqual({ x: 5, y: 7, width: size, height: size });
	});
});

const layerInfo = (overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id: 'layer-1',
	kind: 'vector',
	name: undefined,
	hidden: false,
	locked: false,
	opacity: 1,
	blend: 'normal',
	depth: 0,
	parentId: undefined,
	loose: false,
	...overrides,
});

type VectorFake = Readonly<{
	context: ToolContext;
	selected: () => readonly string[];
	region: () => Region | undefined;
	notices: string[];
	layer: Element;
}>;

/**
 * `layer-1` holds, left to right: three filled squares, red, near red and
 * blue; two unfilled lines, red and near red, and a `<line>`, red; a square
 * whose `style` makes it red over a blue attribute; a picture; a square with
 * no fill of its own; and a square filled by a gradient with a green stroke.
 */
const SHAPES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	red: { tag: 'rect', x: '0', y: '0', width: '10', height: '10', fill: '#ff0000' },
	nearRed: { tag: 'rect', x: '20', y: '0', width: '10', height: '10', fill: 'rgb(248, 0, 0)' },
	blue: { tag: 'rect', x: '40', y: '0', width: '10', height: '10', fill: '#00f' },
	redLine: { tag: 'path', d: 'M 0 20 L 10 30', fill: 'none', stroke: '#ff0000' },
	nearRedLine: { tag: 'path', d: 'M 20 20 L 30 30', fill: 'none', stroke: '#fe0000' },
	line: { tag: 'line', x1: '40', y1: '20', x2: '50', y2: '30', stroke: '#ff0000' },
	styled: {
		tag: 'rect',
		x: '60',
		y: '0',
		width: '10',
		height: '10',
		fill: '#0000ff',
		style: 'fill: #ff0000',
	},
	picture: { tag: 'image', x: '60', y: '20', width: '10', height: '10' },
	unfilled: { tag: 'rect', x: '80', y: '0', width: '10', height: '10' },
	gradient: {
		tag: 'rect',
		x: '80',
		y: '20',
		width: '10',
		height: '10',
		fill: 'url(#g)',
		stroke: '#00ff00',
	},
};

const vectorFake = (
	setup: Readonly<{
		layer?: Partial<LayerInfo>;
		selected?: readonly string[];
		options?: Partial<ToolOptions>;
		layerFill?: string;
	}> = {}
): VectorFake => {
	const parsed = new DOMParser().parseFromString(emptyDrawing({ id: 'd-1' }), 'image/svg+xml');
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.getElementById('layer-1');
	if (layer === null) throw new Error('an empty drawing starts with layer-1');
	if (setup.layerFill !== undefined) layer.setAttribute('fill', setup.layerFill);
	Object.entries(SHAPES).forEach(([id, { tag = 'rect', ...attributes }]) => {
		const element = parsed.createElementNS(SVG_NAMESPACE, tag);
		element.setAttribute('id', id);
		Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
		layer.appendChild(element);
	});
	const info = layerInfo(setup.layer);
	const notices: string[] = [];
	const held = observable<Region | undefined>(plain('M 0 0 L 4 0 L 4 4 L 0 4 Z'));
	let selected: readonly Element[] = (setup.selected ?? []).map(
		(id) => parsed.getElementById(id) as Element
	);
	const editor: EditorDocument = {
		root,
		prolog: '',
		size: DEFAULT_DRAWING_SIZE,
		snapshot: () => ({
			layers: [info],
			size: DEFAULT_DRAWING_SIZE,
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		}),
		text: () => '',
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: noop,
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: noop,
		settle: () => Promise.resolve(),
	};
	const context: ToolContext = {
		document: editor,
		layer: info,
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: {
			get elements() {
				return selected;
			},
			set: (elements) => {
				selected = elements;
			},
			clear: () => {
				selected = [];
			},
		},
		region: regionControl(held),
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	return {
		context,
		selected: () => selected.map((element) => element.id),
		region: held.get,
		notices,
		layer,
	};
};

/** The middle of a shape of the table, by the box the tool measures it by. */
const on = (id: string, overrides: Partial<PointerSample> = {}): PointerSample => {
	const { tag = 'rect', ...attributes } = SHAPES[id] ?? {};
	const element = document.createElementNS(SVG_NAMESPACE, tag);
	Object.entries(attributes).forEach(([name, value]) => element.setAttribute(name, value));
	const box = attributeBox(element);
	return sample(box.x + box.width / 2, box.y + box.height / 2, overrides);
};

describe('the magic wand on a vector layer', () => {
	const tool = createWand(attributeBox);

	it('selects every element filled within the tolerance of the one clicked, in paint order', () => {
		const fake = vectorFake();
		click(tool, fake.context, on('red'));
		expect(fake.selected()).toEqual(['red', 'nearRed', 'styled']);
		const exact = vectorFake({ options: { tolerance: 0 } });
		click(tool, exact.context, on('red'));
		expect(exact.selected()).toEqual(['red', 'styled']);
		const all = vectorFake({ options: { tolerance: 1 } });
		click(tool, all.context, on('blue'));
		expect(all.selected()).toEqual(['red', 'nearRed', 'blue', 'styled', 'unfilled']);
	});

	it('matches an element with no fill by its stroke, against the others with none', () => {
		const fake = vectorFake();
		click(tool, fake.context, on('redLine'));
		expect(fake.selected()).toEqual(['redLine', 'nearRedLine', 'line']);
		const gradient = vectorFake();
		click(tool, gradient.context, on('gradient'));
		expect(gradient.selected()).toEqual(['gradient']);
	});

	it('reads a fill the element inherits, black where nothing sets one', () => {
		const black = vectorFake({ options: { tolerance: 0 } });
		click(tool, black.context, on('unfilled'));
		expect(black.selected()).toEqual(['unfilled']);
		const red = vectorFake({ layerFill: '#ff0000' });
		click(tool, red.context, on('red'));
		expect(red.selected()).toEqual(['red', 'nearRed', 'styled', 'unfilled']);
	});

	it('selects a picture alone, which is painted with no color', () => {
		const fake = vectorFake();
		click(tool, fake.context, on('picture'));
		expect(fake.selected()).toEqual(['picture']);
	});

	it('adds to the selection with Shift, and deselects on a click on nothing unless Shift is held', () => {
		const fake = vectorFake({ selected: ['blue'] });
		click(tool, fake.context, on('red', { shiftKey: true }));
		expect(fake.selected()).toEqual(['red', 'nearRed', 'blue', 'styled']);
		click(tool, fake.context, sample(150, 150, { shiftKey: true }));
		expect(fake.selected()).toEqual(['red', 'nearRed', 'blue', 'styled']);
		click(tool, fake.context, sample(150, 150));
		expect(fake.selected()).toEqual([]);
		const replaced = vectorFake({ selected: ['blue'] });
		click(tool, replaced.context, on('redLine'));
		expect(replaced.selected()).toEqual(['redLine', 'nearRedLine', 'line']);
	});

	it('drops the area and outlines what it selected on the overlay', () => {
		const fake = vectorFake();
		click(tool, fake.context, on('red'));
		expect(fake.region()).toBeUndefined();
		expect(
			fake.context.overlay.querySelectorAll('[data-draw-region-outline] rect')
		).toHaveLength(3);
		click(tool, fake.context, sample(150, 150));
		expect(
			fake.context.overlay.querySelectorAll('[data-draw-region-outline] rect')
		).toHaveLength(0);
	});

	it('takes the element where the pointer was pressed, and nothing for a press canceled', () => {
		const fake = vectorFake();
		tool.begin(fake.context, on('redLine'));
		tool.end(fake.context, on('blue'));
		expect(fake.selected()).toEqual(['redLine', 'nearRedLine', 'line']);
		const canceled = vectorFake({ selected: ['blue'] });
		tool.begin(canceled.context, on('red'));
		tool.cancel(canceled.context);
		tool.end(canceled.context, on('red'));
		expect(canceled.selected()).toEqual(['blue']);
	});

	it('says so on a locked or a hidden layer, as the marquee does, and selects nothing', () => {
		const locked = vectorFake({ layer: { locked: true }, selected: ['blue'] });
		click(tool, locked.context, on('red'));
		expect(locked.selected()).toEqual(['blue']);
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 1' })]);
		const hidden = vectorFake({ layer: { hidden: true } });
		click(tool, hidden.context, on('red'));
		expect(hidden.selected()).toEqual([]);
		expect(hidden.notices).toEqual([t('layers.hidden', { name: 'Layer 1' })]);
	});
});
