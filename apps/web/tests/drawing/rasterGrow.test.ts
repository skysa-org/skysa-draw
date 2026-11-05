import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { Pixels } from '../../src/drawing/inpaint/index.js';
import { fillAreaWith } from '../../src/drawing/tools/raster/areaFill.js';
import {
	boundsAt,
	heldTo,
	inkExtent,
	keepsGrid,
	mostPixels,
	outside,
	wholePixels,
} from '../../src/drawing/tools/raster/grow.js';
import { fillArea, layerViaArea, rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import { pixelGrid, type Rgba } from '../../src/drawing/tools/raster/pixels.js';
import { surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
	type ToolContext,
	type ToolId,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import {
	fakeOf,
	installFakeCanvas,
	pictureAt,
	pictureSize,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * A raster layer's pixels grow to hold what is written past them
 * (docs/ARCHITECTURE.md §3, "Layers"; §7, "The editor"), as a Photoshop
 * layer has no edge of its own: a layer moved, or smaller than the canvas,
 * takes paint wherever the canvas is, and the `<image>` grows in its own
 * pixels, at the same pixels per unit, by whole pixels, the pixels already
 * there kept where they are, to the byte, and the layer's `transform` left
 * alone; one command, undone to the bytes. Against a real document and its
 * real commands, and the compositing fake canvas (`fakeCanvas.ts`), which
 * samples each pixel at its center, so a hard dab is the pixels whose
 * centers it covers. The layer's `transform` is read through the SVG DOM,
 * which jsdom has not, so `space.ts` is a double here that places the layer
 * by `space.matrix`, its own units to the root's; and the content-aware
 * engine is a double that makes its hole green.
 */

const engine = vi.hoisted(() => ({
	inpaint:
		vi.fn<
			(image: Pixels, mask: Uint8Array, signal?: AbortSignal) => Promise<Uint8ClampedArray>
		>(),
}));
vi.mock('../../src/drawing/inpaint/index.js', () => ({ inpaint: engine.inpaint }));

/** The layer's own units to the root's, `[a, b, c, d, e, f]`, read by the double of `space.ts`. */
const space = vi.hoisted(() => ({ matrix: [1, 0, 0, 1, 0, 0] as readonly number[] }));
vi.mock('../../src/drawing/tools/raster/space.js', () => ({
	toLocal: (_layer: unknown, _root: unknown, x: number, y: number) => {
		const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = space.matrix;
		const det = a * d - b * c;
		const [dx, dy] = [x - e, y - f];
		return [(d * dx - c * dy) / det, (a * dy - b * dx) / det];
	},
	moveInParent: (_layer: unknown, _root: unknown, dx: number, dy: number) => [dx, dy],
}));

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** A picture whose every pixel is its own, so a pixel moved by one is seen. */
const varied = (width: number, height: number): string =>
	registerPicture(width, height, (x, y) => [x * 5, y * 7, 100, 255]);

const filled = (rgba: Rgba, width: number, height: number): string =>
	registerPicture(width, height, () => rgba);

/** The canvas is 40 × 30; `layer-2` is a raster layer whose `<image>` is `image`. */
const drawingText = (picture: string, image: string, transform: string): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster" draw:name="Paint"${transform === '' ? '' : ` transform="${transform}"`}><image href="${picture}" ${image} preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

/** The left half of the canvas. */
const LEFT_HALF = 'x="0" y="0" width="20" height="30"';

const noop = (): undefined => undefined;

type Box = Readonly<{ x: number; y: number; width: number; height: number }>;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	setRegion: (region: Region | undefined) => void;
	/** The `<image>`'s box on `id`, as the file has it. */
	box: (id?: string) => Box;
	href: (id?: string) => string | null | undefined;
	/** A pixel of the picture as written, `[r, g, b, a]`, at the layer's own units, one pixel a unit. */
	at: (x: number, y: number, id?: string) => number[];
	markup: () => string;
}>;

type Setup = Readonly<{
	picture: string;
	image?: string;
	transform?: string;
	options?: Partial<ToolOptions>;
}>;

const createFake = (setup: Setup): Fake => {
	const opened = openDocument(
		drawingText(setup.picture, setup.image ?? LEFT_HALF, setup.transform ?? '')
	);
	if (opened === undefined) throw new Error('the drawing opens');
	const labels: string[] = [];
	const notices: string[] = [];
	const editor: EditorDocument = {
		...opened,
		get size() {
			return opened.size;
		},
		execute: (command) => {
			labels.push(command.label);
			opened.execute(command);
		},
	};
	let region: Region | undefined;
	const screen = document.createElement('canvas');
	screen.width = 40;
	screen.height = 30;
	const context: ToolContext = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: {
			get path() {
				return region?.path;
			},
			get region() {
				return region;
			},
			set: (path) => {
				region = path === undefined ? undefined : { path, inverted: false, feather: 0 };
			},
			update: (change) => {
				if (region !== undefined) region = { ...region, ...change };
			},
		},
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	const image = (id: string) =>
		Array.from(editor.layer(id)?.children ?? []).find((child) => child.localName === 'image');
	const box = (id = 'layer-2'): Box => {
		const found = image(id);
		const read = (name: string) => Number(found?.getAttribute(name));
		return { x: read('x'), y: read('y'), width: read('width'), height: read('height') };
	};
	const href = (id = 'layer-2') => image(id)?.getAttribute('href');
	return {
		context,
		document: editor,
		labels,
		notices,
		setRegion: (next) => {
			region = next;
		},
		box,
		href,
		at: (x, y, id = 'layer-2') => {
			const placed = box(id);
			return pictureAt(href(id), x - placed.x, y - placed.y);
		},
		markup: () => new XMLSerializer().serializeToString(editor.root),
	};
};

const sampleAt = (x: number, y: number): PointerSample => ({
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

const tool = (id: ToolId): ToolBehavior => {
	const behavior = rasterBehaviors[id];
	if (behavior === undefined) throw new Error(`no raster ${id}`);
	return behavior;
};

/** A stroke through `points` in the root's units, begun at the first and ended at the last; one is a click. */
const stroke = (
	behavior: ToolBehavior,
	context: ToolContext,
	points: readonly (readonly [number, number])[]
): void => {
	const [first = [0, 0], ...rest] = points;
	behavior.begin(context, sampleAt(...first));
	rest.forEach((point) => behavior.move(context, sampleAt(...point)));
	behavior.end(context, sampleAt(...(rest.at(-1) ?? first)));
};

/** A stroke on a decoded layer, landed. */
const painted = async (
	fake: Fake,
	id: ToolId,
	points: readonly (readonly [number, number])[]
): Promise<void> => {
	await surfaceFor(fake.context)?.ready;
	stroke(tool(id), fake.context, points);
	await fake.document.settle();
};

/** A hard round brush four units across, in blue, that follows no pressure. */
const HARD = {
	size: 4,
	hardness: 1,
	opacity: 1,
	pressure: false,
	fill: '#0000ff',
	stroke: '#0000ff',
} as const;

/** A rectangle's outline as the marquee writes it. */
const rectangle = (x: number, y: number, width: number, height: number): Region => ({
	path: `M ${x} ${y} L ${x + width} ${y} L ${x + width} ${y + height} L ${x} ${y + height} Z`,
	inverted: false,
	feather: 0,
});

/** An engine that makes its hole `rgba` and keeps the rest. */
const makesHole =
	(rgba: Rgba) =>
	(image: Pixels, mask: Uint8Array): Promise<Uint8ClampedArray> =>
		Promise.resolve(
			new Uint8ClampedArray(image.data).map((value, i) =>
				mask[Math.floor(i / 4)] === 1 ? (rgba[i % 4] ?? 0) : value
			)
		);

/** Every pixel of a `width` × `height` picture where `fake` has it at the layer's units `(x, y)` on. */
const everyPixel = (width: number, height: number): readonly (readonly [number, number])[] =>
	Array.from({ length: width * height }, (_, i) => [i % width, Math.floor(i / width)] as const);

/** The engine's pixels as an `ImageData` would hold them, which jsdom has not. */
class FakeImageData {
	constructor(
		readonly data: Uint8ClampedArray,
		readonly width: number,
		readonly height: number
	) {}
}

beforeEach(() => {
	installFakeCanvas();
	vi.stubGlobal('ImageData', FakeImageData);
	space.matrix = [1, 0, 0, 1, 0, 0];
	engine.inpaint.mockReset();
	engine.inpaint.mockImplementation(makesHole(GREEN));
});
afterEach(uninstallFakeCanvas);

describe('a stroke past a raster layer’s pixels', () => {
	it('lands on a layer moved right, left of its old box, the old pixels kept to the byte, in one command undone to the bytes', async () => {
		const picture = varied(40, 30);
		space.matrix = [1, 0, 0, 1, 20, 0];
		const fake = createFake({
			picture,
			image: 'x="0" y="0" width="40" height="30"',
			transform: 'translate(20 0)',
			options: HARD,
		});
		const before = fake.markup();
		// The root's (5, 15) to (15, 15): the layer's (-15, 15) to (-5, 15), past its left edge.
		await painted(fake, 'pencil', [
			[5, 15],
			[10, 15],
			[15, 15],
		]);
		expect(fake.labels).toEqual(['tools.pencil']);
		// A disk of radius 2 about (-15, 15) covers the centers of pixels -17 to -14.
		expect(fake.box()).toEqual({ x: -17, y: 0, width: 57, height: 30 });
		expect(pictureSize(fake.href())).toEqual({ width: 57, height: 30 });
		expect(fake.at(-15, 15)).toEqual([...BLUE]);
		expect(fake.at(-6, 15)).toEqual([...BLUE]);
		expect(fake.at(-15, 5)).toEqual(CLEAR);
		everyPixel(40, 30).forEach(([x, y]) => {
			expect(fake.at(x, y)).toEqual([x * 5, y * 7, 100, 255]);
		});
		expect(fake.document.layer('layer-2')?.getAttribute('transform')).toBe('translate(20 0)');
		const after = fake.markup();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		expect(fake.href()).toBe(picture);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('grows the box right on a layer that covers part of the canvas, to the canvas’s edge and no further', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { ...HARD, size: 8 } });
		// A disk of radius 4 about (38, 15) reaches pixel 41, past the canvas at 40.
		await painted(fake, 'pencil', [[38, 15]]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 40, height: 30 });
		expect(fake.at(39, 15)).toEqual([...BLUE]);
		expect(fake.at(34, 15)).toEqual([...BLUE]);
		expect(fake.at(25, 15)).toEqual(CLEAR);
		expect(fake.at(19, 15)).toEqual([...RED]);
	});

	it('keeps the pixels a layer already has off the canvas', async () => {
		const fake = createFake({
			picture: varied(30, 30),
			image: 'x="-10" y="0" width="30" height="30"',
			options: HARD,
		});
		await painted(fake, 'pencil', [[30, 15]]);
		expect(fake.box()).toEqual({ x: -10, y: 0, width: 42, height: 30 });
		expect(fake.at(30, 15)).toEqual([...BLUE]);
		everyPixel(30, 30).forEach(([x, y]) => {
			expect(fake.at(x - 10, y)).toEqual([x * 5, y * 7, 100, 255]);
		});
	});

	it('shows the stroke on the screen as it lands', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: HARD });
		await surfaceFor(fake.context)?.ready;
		tool('brush').begin(fake.context, sampleAt(30, 15));
		const screen = fakeOf(fake.context.screen.canvas);
		expect(screen.at(30, 15)).toEqual([...BLUE]);
		tool('brush').end(fake.context, sampleAt(30, 15));
		await fake.document.settle();
		expect(fake.at(30, 15)).toEqual([...BLUE]);
		expect(fake.box().width).toBe(32);
	});

	it('grows a layer turned a quarter in its own pixels, along its own axes', async () => {
		// The layer's (x, y) at the root's (30 - y, x): its top edge is the root's right.
		space.matrix = [0, 1, -1, 0, 30, 0];
		const fake = createFake({
			picture: varied(20, 20),
			image: 'x="0" y="0" width="20" height="20"',
			transform: 'translate(30 0) rotate(90)',
			options: HARD,
		});
		// The root's (35, 10) is the layer's (10, -5), above its top edge.
		await painted(fake, 'pencil', [[35, 10]]);
		expect(fake.box()).toEqual({ x: 0, y: -7, width: 20, height: 27 });
		expect(fake.at(10, -5)).toEqual([...BLUE]);
		expect(fake.at(2, -5)).toEqual(CLEAR);
		everyPixel(20, 20).forEach(([x, y]) => {
			expect(fake.at(x, y)).toEqual([x * 5, y * 7, 100, 255]);
		});
	});

	it('writes nothing for a stroke off the canvas and the pixels', async () => {
		const picture = filled(RED, 20, 30);
		const fake = createFake({ picture, options: HARD });
		await painted(fake, 'pencil', [
			[50, 15],
			[60, 15],
		]);
		expect(fake.labels).toEqual([]);
		expect(fake.href()).toBe(picture);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 20, height: 30 });
	});

	it('makes no canvas of its own for a stroke on a layer that covers the canvas', async () => {
		const fake = createFake({
			picture: filled(RED, 40, 30),
			image: 'x="0" y="0" width="40" height="30"',
			options: HARD,
		});
		const surface = surfaceFor(fake.context);
		await surface?.ready;
		const [canvas, strokeCanvas] = [surface?.canvas, surface?.stroke];
		await painted(fake, 'brush', [
			[-5, 15],
			[20, 15],
			[45, 15],
		]);
		expect(fake.labels).toEqual(['tools.brush']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 40, height: 30 });
		expect(surface?.canvas).toBe(canvas);
		expect(surface?.stroke).toBe(strokeCanvas);
	});
});

describe('the eraser past a raster layer’s pixels', () => {
	it('never grows them', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: HARD });
		await painted(fake, 'eraser', [
			[15, 15],
			[30, 15],
		]);
		expect(fake.labels).toEqual(['tools.eraser']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 20, height: 30 });
		expect(fake.at(16, 15)).toEqual(CLEAR);
		expect(fake.at(16, 5)).toEqual([...RED]);
	});

	it('writes nothing wholly past them', async () => {
		const picture = filled(RED, 20, 30);
		const fake = createFake({ picture, options: HARD });
		await painted(fake, 'eraser', [
			[25, 15],
			[35, 15],
		]);
		expect(fake.labels).toEqual([]);
		expect(fake.href()).toBe(picture);
	});
});

describe('a raster shape past a layer’s pixels', () => {
	it('lands whole, and the pixels grow to hold it', async () => {
		const fake = createFake({
			picture: filled(RED, 20, 30),
			options: { fill: '#00ff00', stroke: 'none' },
		});
		await surfaceFor(fake.context)?.ready;
		const rectangleTool = tool('rectangle');
		rectangleTool.begin(fake.context, sampleAt(15, 5));
		rectangleTool.move(fake.context, sampleAt(30, 12));
		rectangleTool.end(fake.context, sampleAt(30, 12));
		await fake.document.settle();
		expect(fake.labels).toEqual(['tools.rectangle']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 30, height: 30 });
		expect(fake.at(29, 11)).toEqual([...GREEN]);
		expect(fake.at(22, 8)).toEqual([...GREEN]);
		expect(fake.at(16, 8)).toEqual([...GREEN]);
		expect(fake.at(22, 12)).toEqual(CLEAR);
		expect(fake.at(10, 20)).toEqual([...RED]);
	});
});

describe('the paint bucket past a raster layer’s pixels, as Photoshop’s', () => {
	it('floods the canvas past them, as transparent pixels of the layer, and the pixels grow to the canvas', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { fill: '#0000ff' } });
		await painted(fake, 'fill', [[30, 15]]);
		expect(fake.labels).toEqual(['tools.fill']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 40, height: 30 });
		expect(fake.at(20, 15)).toEqual([...BLUE]);
		expect(fake.at(39, 29)).toEqual([...BLUE]);
		expect(fake.at(19, 15)).toEqual([...RED]);
	});

	it('floods past them from a transparent pixel joined to the canvas beyond', async () => {
		const fake = createFake({
			picture: registerPicture(20, 30, (x) => (x < 10 ? RED : [0, 0, 0, 0])),
			options: { fill: '#0000ff' },
		});
		await painted(fake, 'fill', [[15, 15]]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 40, height: 30 });
		expect(fake.at(10, 15)).toEqual([...BLUE]);
		expect(fake.at(35, 2)).toEqual([...BLUE]);
		expect(fake.at(9, 15)).toEqual([...RED]);
	});

	it('grows nothing for a fill that stays on the pixels', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { fill: '#0000ff' } });
		await painted(fake, 'fill', [[5, 5]]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 20, height: 30 });
		expect(pictureSize(fake.href())).toEqual({ width: 20, height: 30 });
		expect(fake.at(19, 29)).toEqual([...BLUE]);
	});

	it('fills nothing from a press off the canvas and the pixels, or one that changes no pixel', async () => {
		const picture = filled(RED, 20, 30);
		const fake = createFake({ picture, options: { fill: '#ff0000' } });
		await painted(fake, 'fill', [[50, 15]]);
		await painted(fake, 'fill', [[5, 5]]);
		expect(fake.labels).toEqual([]);
		expect(fake.href()).toBe(picture);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 20, height: 30 });
	});

	it('stops at the area past the pixels too', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { fill: '#0000ff' } });
		fake.setRegion(rectangle(15, 5, 10, 10));
		await painted(fake, 'fill', [[22, 10]]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 25, height: 30 });
		expect(fake.at(24, 14)).toEqual([...BLUE]);
		expect(fake.at(22, 20)).toEqual(CLEAR);
	});
});

describe('Fill… past a raster layer’s pixels', () => {
	it('fills the area with a color where it reaches past them, and they grow to hold it', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { fill: '#00ff00' } });
		fake.setRegion(rectangle(15, 5, 10, 10));
		await surfaceFor(fake.context)?.ready;
		expect(fillArea(fake.context)).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.fill']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 25, height: 30 });
		expect(fake.at(24, 14)).toEqual([...GREEN]);
		expect(fake.at(16, 10)).toEqual([...GREEN]);
		expect(fake.at(10, 10)).toEqual([...RED]);
		expect(fake.at(22, 20)).toEqual(CLEAR);
	});

	it('makes the area again past them with Content-Aware, from a frame that reaches there', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30) });
		fake.setRegion(rectangle(15, 5, 10, 10));
		await surfaceFor(fake.context)?.ready;
		fillAreaWith(fake.context, {
			contents: 'contentAware',
			mode: 'normal',
			opacity: 1,
			preserveTransparency: false,
		});
		await fake.document.settle();
		const [image] = engine.inpaint.mock.calls[0] ?? [];
		expect(fake.notices).toEqual([]);
		expect(image?.width).toBe(25);
		expect(fake.labels).toEqual(['regions.fill']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 25, height: 30 });
		expect(fake.at(24, 10)).toEqual([...GREEN]);
		expect(fake.at(16, 10)).toEqual([...GREEN]);
		expect(fake.at(10, 10)).toEqual([...RED]);
	});

	it('writes nothing for a color that changes no pixel', async () => {
		const picture = filled(RED, 20, 30);
		const fake = createFake({ picture, options: { fill: '#ff0000' } });
		fake.setRegion(rectangle(2, 2, 10, 10));
		await surfaceFor(fake.context)?.ready;
		fillArea(fake.context);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.href()).toBe(picture);
	});
});

describe('Remove past a raster layer’s pixels', () => {
	it('makes its stroke again where it reaches past them, and they grow to hold what was made', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: { size: 4 } });
		await painted(fake, 'remove', [
			[18, 15],
			[24, 15],
		]);
		const [image] = engine.inpaint.mock.calls[0] ?? [];
		expect(image?.width).toBeGreaterThanOrEqual(26);
		expect(fake.labels).toEqual(['remove.command']);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 26, height: 30 });
		expect(fake.at(25, 15)).toEqual([...GREEN]);
		expect(fake.at(17, 15)).toEqual([...GREEN]);
		expect(fake.at(10, 15)).toEqual([...RED]);
	});
});

describe('the smudge past a raster layer’s pixels', () => {
	it('grows them where it pushes color past them', async () => {
		const fake = createFake({
			picture: filled(RED, 20, 30),
			options: { size: 6, hardness: 1, strength: 0.8, pressure: false },
		});
		await painted(fake, 'smudge', [
			[12, 15],
			[16, 15],
			[20, 15],
			[24, 15],
			[28, 15],
		]);
		expect(fake.labels).toEqual(['tools.smudge']);
		const { width, x, y, height } = fake.box();
		expect({ x, y, height }).toEqual({ x: 0, y: 0, height: 30 });
		expect(width).toBeGreaterThan(20);
		expect(width).toBeLessThanOrEqual(32);
		expect(fake.at(21, 15)[3]).toBeGreaterThan(0);
		expect(fake.at(5, 2)).toEqual([...RED]);
	});

	it('writes nothing where it moves only transparency', async () => {
		const picture = filled(RED, 20, 30);
		const fake = createFake({
			picture,
			options: { size: 6, hardness: 1, strength: 0.8, pressure: false },
		});
		await painted(fake, 'smudge', [
			[26, 15],
			[30, 15],
			[34, 15],
		]);
		expect(fake.labels).toEqual([]);
		expect(fake.href()).toBe(picture);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 20, height: 30 });
	});
});

describe('the move tool past a raster layer’s pixels', () => {
	it('moves an area’s pixels off the canvas too, the pixels grown to keep them, and a later drag brings them back whole', async () => {
		const fake = createFake({ picture: varied(20, 30) });
		fake.setRegion(rectangle(5, 5, 10, 10));
		const before = fake.markup();
		await painted(fake, 'select', [
			[10, 10],
			[40, 10],
		]);
		expect(fake.labels).toEqual(['regions.move']);
		// Moved by 30, from 5 to 15 to 35 to 45: past the canvas at 40.
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 45, height: 30 });
		expect(fake.at(35, 5)).toEqual([25, 35, 100, 255]);
		expect(fake.at(44, 14)).toEqual([70, 98, 100, 255]);
		expect(fake.at(10, 10)).toEqual(CLEAR);
		expect(fake.at(2, 2)).toEqual([10, 14, 100, 255]);
		await painted(fake, 'select', [
			[40, 10],
			[10, 10],
		]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 45, height: 30 });
		everyPixel(20, 30).forEach(([x, y]) => {
			expect(fake.at(x, y)).toEqual([x * 5, y * 7, 100, 255]);
		});
		expect(fake.at(40, 10)).toEqual(CLEAR);
		fake.document.undo();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
	});

	it('grows them left, and keeps the rest where it was', async () => {
		const fake = createFake({ picture: varied(20, 30) });
		fake.setRegion(rectangle(5, 5, 10, 10));
		await painted(fake, 'select', [
			[10, 10],
			[0, 10],
		]);
		expect(fake.box()).toEqual({ x: -5, y: 0, width: 25, height: 30 });
		expect(fake.at(-5, 5)).toEqual([25, 35, 100, 255]);
		expect(fake.at(4, 14)).toEqual([70, 98, 100, 255]);
		expect(fake.at(7, 10)).toEqual(CLEAR);
		expect(fake.at(17, 10)).toEqual([85, 70, 100, 255]);
		expect(fake.at(10, 20)).toEqual([50, 140, 100, 255]);
	});
});

describe('layer via copy after the pixels grew', () => {
	it('makes the copy at the box the pixels have now', async () => {
		const fake = createFake({ picture: filled(RED, 20, 30), options: HARD });
		await painted(fake, 'pencil', [[30, 15]]);
		expect(fake.box()).toEqual({ x: 0, y: 0, width: 32, height: 30 });
		fake.setRegion(rectangle(26, 11, 8, 8));
		const made = await layerViaArea(fake.context, 'copy');
		expect(made).toBeDefined();
		expect(fake.box(made)).toEqual({ x: 0, y: 0, width: 32, height: 30 });
		expect(pictureSize(fake.href(made))).toEqual({ width: 32, height: 30 });
		expect(fake.at(30, 15, made)).toEqual([...BLUE]);
		expect(fake.at(5, 5, made)).toEqual(CLEAR);
	});
});

describe('the grid a layer’s pixels grow in', () => {
	it('takes the whole pixels a box touches', () => {
		expect(wholePixels({ x: -0.5, y: 1.2, width: 2, height: 1 })).toEqual({
			x: -1,
			y: 1,
			width: 3,
			height: 2,
		});
		expect(wholePixels({ x: 2, y: 3, width: 4, height: 5 })).toEqual({
			x: 2,
			y: 3,
			width: 4,
			height: 5,
		});
	});

	it('grows a layer of a pixel a unit to the largest side the file allows, and one of fewer only as far as its longer side', () => {
		const small = { x: 0, y: 0, width: 100, height: 50 };
		expect(mostPixels(small, pixelGrid(small), 4096)).toEqual({ width: 4096, height: 4096 });
		const large = { x: 0, y: 0, width: 8192, height: 4096 };
		const grid = pixelGrid(large);
		expect(grid).toEqual({ width: 4096, height: 2048, ppu: 0.5 });
		expect(mostPixels(large, grid, 4096)).toEqual({ width: 4096, height: 4096 });
		expect(keepsGrid(large, grid, { x: 0, y: -2048, width: 4096, height: 4096 })).toBe(true);
		expect(keepsGrid(large, grid, { x: -1, y: 0, width: 4097, height: 2048 })).toBe(false);
	});

	it('places the grown box from the first bounds, so growing twice is growing once', () => {
		const bounds = { x: 0.25, y: 10, width: 20, height: 30 };
		const grid = pixelGrid(bounds);
		expect(boundsAt(bounds, grid, { x: -3, y: 0, width: 23, height: 32 })).toEqual({
			x: -2.75,
			y: 10,
			width: 23,
			height: 32,
		});
	});

	it('holds the pixels it has, and as much of what is wanted as fits, the part preferred first', () => {
		const kept = { x: 0, y: 0, width: 10, height: 10 };
		const wanted = { x: -20, y: 0, width: 40, height: 10 };
		expect(heldTo(kept, wanted, { width: 100, height: 100 })).toEqual(wanted);
		expect(heldTo(kept, wanted, { width: 25, height: 25 })).toEqual({
			x: -15,
			y: 0,
			width: 25,
			height: 10,
		});
		expect(
			heldTo(kept, wanted, { width: 25, height: 25 }, { x: 12, y: 0, width: 6, height: 10 })
		).toEqual({ x: -7, y: 0, width: 25, height: 10 });
		expect(heldTo(kept, wanted, { width: 5, height: 5 })).toEqual(kept);
	});

	it('reads what of a region is outside the pixels, in up to four bands', () => {
		const bands = outside(
			{ x: 0, y: 0, width: 10, height: 10 },
			{ x: 2, y: 2, width: 4, height: 4 }
		);
		expect(bands).toHaveLength(4);
		expect(bands.reduce((sum, band) => sum + band.width * band.height, 0)).toBe(84);
		expect(
			outside({ x: 0, y: 0, width: 4, height: 4 }, { x: 0, y: 0, width: 10, height: 10 })
		).toEqual([]);
	});

	it('finds the box around any alpha, and none where there is none', () => {
		const box = { x: 5, y: 7, width: 4, height: 3 };
		const data = new Uint8ClampedArray(4 * 3 * 4);
		expect(inkExtent(data, box)).toBeUndefined();
		data[(1 * 4 + 1) * 4 + 3] = 1;
		data[(2 * 4 + 2) * 4 + 3] = 255;
		expect(inkExtent(data, box)).toEqual({ x: 6, y: 8, width: 2, height: 2 });
		// Color with no alpha is no ink.
		data[(0 * 4 + 3) * 4] = 255;
		expect(inkExtent(data, box)).toEqual({ x: 6, y: 8, width: 2, height: 2 });
	});
});
