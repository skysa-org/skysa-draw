import { DRAWING_NAMESPACE, emptyDrawing, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import { type RasterSurface, surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehavior,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * The smudge on a raster layer (docs/decisions/0004-the-interface.md: "Push
 * pixels") against a fake editor and a fake 2D context that keeps real
 * pixels, so a stroke can be seen to read the layer's pixels, push color
 * along and write them back, and the commit be seen to be one command. What
 * this cannot show is how a dab looks on a real canvas, the decoding of a
 * real picture, or the screen's mirror in place through a real view; jsdom
 * has no canvas and no `Path2D`, and the area's test stubs one.
 */

vi.mock('../../src/drawing/document/commands.js', () => ({
	replaceRasterImage: (
		layerId: string,
		label: string,
		image: Readonly<{ href: string }>
	): Command => ({
		label,
		bytes: image.href.length,
		apply: (root) => {
			const layer = root.ownerDocument.getElementById(layerId);
			if (layer === null) return;
			const found =
				Array.from(layer.children).find((child) => child.localName === 'image') ??
				layer.appendChild(
					root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'image')
				);
			found.setAttribute('href', image.href);
		},
		revert: () => undefined,
	}),
	editLayer: () => undefined,
}));

/** `Path2D` as the area's test stubs it: the path, kept to be read back. */
class FakePath2D {
	constructor(readonly d: string) {}
}

type Call = Readonly<{ name: string; args: readonly unknown[] }>;

type Fake2D = Readonly<{
	calls: Call[];
	pixels: Uint8ClampedArray;
	named: (name: string) => Call[];
}>;

/** A context over `canvas` that keeps its pixels, reads and writes them, and records the rest. */
const fake2D = (canvas: HTMLCanvasElement): Fake2D & Record<string, unknown> => {
	const pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4);
	const calls: Call[] = [];
	const record =
		(name: string) =>
		(...args: unknown[]): void => {
			calls.push({ name, args });
		};
	let transform = [1, 0, 0, 1, 0, 0];
	return {
		calls,
		pixels,
		named: (name: string) => calls.filter((call) => call.name === name),
		fillStyle: '#000000',
		save: record('save'),
		restore: record('restore'),
		clip: record('clip'),
		clearRect: record('clearRect'),
		drawImage: record('drawImage'),
		setTransform: (...args: number[]) => {
			calls.push({ name: 'setTransform', args });
			transform = args;
		},
		// A stubbed path's numbers, as a rectangle, drawn opaque: a mask of the area.
		fill: (path: unknown) => {
			calls.push({ name: 'fill', args: [path] });
			if (!(path instanceof FakePath2D)) return;
			const numbers = (path.d.match(/-?[\d.]+/g) ?? []).map(Number);
			const xs = numbers.filter((_, i) => i % 2 === 0);
			const ys = numbers.filter((_, i) => i % 2 === 1);
			const [a = 1, , , d = 1, e = 0, f = 0] = transform;
			for (let i = 0; i < canvas.width * canvas.height; i += 1) {
				const ux = ((i % canvas.width) + 0.5 - e) / a;
				const uy = (Math.floor(i / canvas.width) + 0.5 - f) / d;
				const inside =
					ux > Math.min(...xs) &&
					ux < Math.max(...xs) &&
					uy > Math.min(...ys) &&
					uy < Math.max(...ys);
				if (inside) pixels[i * 4 + 3] = 255;
			}
		},
		getImageData: (x: number, y: number, width: number, height: number) => {
			calls.push({ name: 'getImageData', args: [x, y, width, height] });
			const data = new Uint8ClampedArray(width * height * 4);
			// A pixel off the canvas reads as transparent black, as the canvas's does.
			for (let i = 0; i < width * height; i += 1) {
				const column = x + (i % width);
				const row = y + Math.floor(i / width);
				const from = (row * canvas.width + column) * 4;
				const inside =
					column >= 0 && column < canvas.width && row >= 0 && row < canvas.height;
				if (inside) data.set(pixels.subarray(from, from + 4), i * 4);
			}
			return { data, width, height };
		},
		putImageData: (
			image: Readonly<{ data: Uint8ClampedArray; width: number; height: number }>,
			x: number,
			y: number
		) => {
			calls.push({ name: 'putImageData', args: [x, y] });
			for (let row = 0; row < image.height; row += 1) {
				const from = row * image.width * 4;
				pixels.set(
					image.data.subarray(from, from + image.width * 4),
					((y + row) * canvas.width + x) * 4
				);
			}
		},
	};
};

let contexts = new Map<HTMLCanvasElement, Fake2D>();
/** What `img.decode()` returns: settled at once, unless a test holds it. */
let decoding: Promise<void> = Promise.resolve();

const fakeOf = (canvas: HTMLCanvasElement): Fake2D => {
	const found = contexts.get(canvas);
	if (found !== undefined) return found;
	const made = fake2D(canvas);
	contexts.set(canvas, made);
	return made;
};

beforeEach(() => {
	contexts = new Map();
	decoding = Promise.resolve();
	const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
	spy.mockImplementation(() => fakeOf(spy.mock.contexts.at(-1) as HTMLCanvasElement) as never);
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
		setTimeout(() => callback(new Blob(['png'], { type: 'image/png' })), 0);
	});
	Object.defineProperty(HTMLImageElement.prototype, 'decode', {
		configurable: true,
		writable: true,
		value: () => decoding,
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

const noop = (): undefined => undefined;

const SIZE = { width: 40, height: 20 };
const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];

type Fake = Readonly<{
	context: ToolContext;
	layer: Element;
	labels: string[];
	notices: string[];
	pending: Promise<unknown>[];
	screen: HTMLCanvasElement;
}>;

type Setup = Readonly<{
	options?: Partial<ToolOptions>;
	locked?: boolean;
	area?: string;
	href?: string;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const parsed = new DOMParser().parseFromString(
		emptyDrawing({ id: 'd-1', size: SIZE }),
		'image/svg+xml'
	);
	const root = parsed.documentElement as unknown as SVGSVGElement;
	const layer = parsed.createElementNS(SVG_NAMESPACE, 'g');
	layer.setAttribute('id', 'layer-2');
	layer.setAttributeNS(DRAWING_NAMESPACE, 'draw:kind', 'raster');
	root.appendChild(layer);
	if (setup.href !== undefined) {
		const image = parsed.createElementNS(SVG_NAMESPACE, 'image');
		Object.entries({ x: '0', y: '0', width: '40', height: '20', href: setup.href }).forEach(
			([name, value]) => image.setAttribute(name, value)
		);
		layer.appendChild(image);
	}
	const info: LayerInfo = {
		id: 'layer-2',
		kind: 'raster',
		name: undefined,
		hidden: false,
		locked: setup.locked ?? false,
		opacity: 1,
		blend: 'normal',
		depth: 0,
		parentId: undefined,
		loose: false,
	};
	const labels: string[] = [];
	const notices: string[] = [];
	const pending: Promise<unknown>[] = [];
	const editor: EditorDocument = {
		root,
		prolog: '',
		size: SIZE,
		snapshot: () => ({
			layers: [info],
			size: SIZE,
			canUndo: false,
			canRedo: false,
			dirty: false,
			version: 0,
		}),
		text: () => '',
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: (command) => {
			labels.push(command.label);
			command.apply(root);
		},
		undo: noop,
		redo: noop,
		subscribe: () => noop,
		pending: (work) => {
			pending.push(work);
		},
		settle: () => Promise.all(pending).then(noop),
	};
	const screen = document.createElement('canvas');
	screen.width = 40;
	screen.height = 20;
	const context: ToolContext = {
		document: editor,
		layer: info,
		options: { ...DEFAULT_TOOL_OPTIONS, size: 8, strength: 0.8, hardness: 1, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: {
			path: setup.area,
			region:
				setup.area === undefined
					? undefined
					: { path: setup.area, inverted: false, feather: 0 },
			set: noop,
			update: noop,
		},
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	return { context, layer, labels, notices, pending, screen };
};

const at = (x: number, y: number): PointerSample => ({
	x,
	y,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType: 'pen',
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
});

const smudge = (): ToolBehavior => {
	const behavior = rasterBehaviors.smudge;
	if (behavior === undefined) throw new Error('no raster smudge');
	return behavior;
};

const surfaceOf = (fake: Fake): RasterSurface => {
	const surface = surfaceFor(fake.context);
	if (surface === undefined) throw new Error('no surface for layer-2');
	return surface;
};

/** The layer's pixels: red on the left half, blue on the right. */
const paintHalves = (surface: RasterSurface): void => {
	const { pixels } = fakeOf(surface.canvas);
	for (let i = 0; i < SIZE.width * SIZE.height; i += 1) {
		pixels.set(i % SIZE.width < 20 ? RED : BLUE, i * 4);
	}
};

const pixelOf = (surface: RasterSurface, x: number, y: number): number[] => {
	const offset = (y * SIZE.width + x) * 4;
	return Array.from(fakeOf(surface.canvas).pixels.subarray(offset, offset + 4));
};

/** From the red into the blue, along the middle row. */
const ACROSS = [14, 18, 22, 26];

const stroke = (fake: Fake, xs: readonly number[] = ACROSS): void => {
	const [first = 0, ...rest] = xs;
	smudge().begin(fake.context, at(first, 10));
	rest.forEach((x) => smudge().move(fake.context, at(x, 10)));
	smudge().end(fake.context, at(rest.at(-1) ?? first, 10));
};

const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

describe('the smudge', () => {
	it('pushes color along the stroke, reading and writing the layer’s own pixels', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		stroke(fake);
		await Promise.all(fake.pending);

		const layerCtx = fakeOf(surface.canvas);
		expect(layerCtx.named('getImageData').length).toBeGreaterThan(0);
		expect(layerCtx.named('putImageData').length).toBeGreaterThan(0);
		// Red dragged into the blue, and nothing far from the stroke touched.
		expect(pixelOf(surface, 21, 10)[0]).toBeGreaterThan(0);
		expect(pixelOf(surface, 24, 10)[0]).toBeGreaterThan(0);
		expect(pixelOf(surface, 5, 10)).toEqual(RED);
		expect(pixelOf(surface, 36, 10)).toEqual(BLUE);
		expect(pixelOf(surface, 21, 1)).toEqual(BLUE);
	});

	it('commits the stroke as one replaceRasterImage, tools.smudge, which a save waits for', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		stroke(fake);
		expect(fake.labels).toEqual([]);
		expect(fake.pending).toHaveLength(1);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.smudge']);
		const image = Array.from(fake.layer.children).find((child) => child.localName === 'image');
		expect(image?.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
	});

	it('shows each dab’s pixels on the screen canvas, and clears it once the stroke has landed', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		smudge().begin(fake.context, at(14, 10));
		smudge().move(fake.context, at(22, 10));
		const screenCtx = fakeOf(fake.screen);
		const shown = screenCtx.named('drawImage');
		expect(shown.length).toBeGreaterThan(0);
		expect(shown[0]?.args[0]).toBe(surface.canvas);

		smudge().end(fake.context, at(22, 10));
		await Promise.all(fake.pending);
		// The canvas cleared whole, with no transform: the landed stroke's own clear.
		expect(screenCtx.named('clearRect').at(-1)?.args).toEqual([0, 0, 40, 20]);
	});

	it('writes nothing for a stroke that moved no color', async () => {
		const fake = createFake({ options: { strength: 0 } });
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		stroke(fake);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual([]);
		expect(pixelOf(surface, 21, 10)).toEqual(BLUE);
	});

	it('paints the dabs queued while the picture was decoded, once it is', async () => {
		let resolve: () => void = noop;
		decoding = new Promise<void>((done) => {
			resolve = done;
		});
		const fake = createFake({ href: 'data:image/png;base64,AAAA' });
		const surface = surfaceOf(fake);
		stroke(fake);
		await tick();
		expect(fakeOf(surface.canvas).named('putImageData')).toEqual([]);

		paintHalves(surface);
		resolve();
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.smudge']);
		expect(pixelOf(surface, 21, 10)[0]).toBeGreaterThan(0);
	});

	it('changes only what is inside the area', async () => {
		vi.stubGlobal('Path2D', FakePath2D);
		const fake = createFake({ area: 'M 0 0 L 22 0 L 22 20 L 0 20 Z' });
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		stroke(fake, [14, 18, 22, 26, 30]);
		await Promise.all(fake.pending);
		expect(pixelOf(surface, 21, 10)[0]).toBeGreaterThan(0);
		expect(pixelOf(surface, 23, 10)).toEqual(BLUE);
		expect(pixelOf(surface, 27, 10)).toEqual(BLUE);
	});

	it('says so on a locked layer, and paints and commits nothing', async () => {
		const fake = createFake({ locked: true });
		stroke(fake);
		await tick();
		expect(fake.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect([fake.labels, fake.pending]).toEqual([[], []]);
	});

	it('forgets the layer’s pixels when abandoned, so the next stroke reads the file again', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		await surface.ready;
		paintHalves(surface);
		smudge().begin(fake.context, at(14, 10));
		smudge().move(fake.context, at(22, 10));
		smudge().cancel(fake.context);
		expect(surfaceOf(fake)).not.toBe(surface);
		expect(fake.pending).toEqual([]);
		expect(fakeOf(fake.screen).named('clearRect').at(-1)?.args).toEqual([0, 0, 40, 20]);
	});
});
