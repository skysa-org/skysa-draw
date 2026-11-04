import {
	DEFAULT_DRAWING_SIZE,
	DRAWING_NAMESPACE,
	type DrawingSize,
	emptyDrawing,
	SVG_NAMESPACE,
} from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';

import type { Command, EditorDocument, LayerInfo } from '../../src/drawing/document/model.js';
import { rasterBehaviours } from '../../src/drawing/tools/raster/index.js';
import { type RasterSurface, surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehaviour,
	type ToolContext,
	type ToolId,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';

/**
 * The raster tools (docs/decisions/0004-the-interface.md; docs/ARCHITECTURE.md
 * §3, "Layers", and §7, "The editor") against a fake editor: a real SVG
 * document with a raster layer, `layer-2`; a document whose `execute` applies
 * a command at once and remembers it; and a 2D context that records what is
 * drawn on it and keeps pixels for `getImageData` and `putImageData`, since
 * jsdom has no canvas. The commands module is the other half of the editor
 * and is mocked to the contract the tools rely on.
 *
 * What this cannot show is the real canvas: how a stamp looks, what a PNG
 * holds, the decoding of a picture, and a layer's `transform` read through
 * the SVG DOM, which jsdom does not have (so every layer is at the root's
 * units here).
 */

vi.mock('../../src/drawing/document/commands.js', () => {
	const svg = 'http://www.w3.org/2000/svg';
	const imageIn = (root: SVGSVGElement, id: string): Element | undefined => {
		const layer = root.ownerDocument.getElementById(id);
		return layer === null
			? undefined
			: Array.from(layer.children).find((child) => child.localName === 'image');
	};
	return {
		replaceRasterImage: (
			layerId: string,
			label: string,
			image: Readonly<{ href: string; x: number; y: number; width: number; height: number }>
		) => {
			let before: string | null = null;
			return {
				label,
				bytes: image.href.length,
				apply: (root: SVGSVGElement) => {
					const layer = root.ownerDocument.getElementById(layerId);
					if (layer === null) return;
					const found = imageIn(root, layerId);
					before = found?.getAttribute('href') ?? null;
					const target =
						found ??
						layer.appendChild(root.ownerDocument.createElementNS(svg, 'image'));
					const { href, ...geometry } = image;
					Object.entries(geometry).forEach(([name, value]) =>
						target.setAttribute(name, String(value))
					);
					target.setAttribute('preserveAspectRatio', 'none');
					target.setAttribute('href', href);
				},
				revert: (root: SVGSVGElement) => {
					const found = imageIn(root, layerId);
					if (found === undefined) return;
					if (before === null) {
						found.remove();
						return;
					}
					found.setAttribute('href', before);
				},
			};
		},
		editLayer: (id: string, label: string, mutate: (layer: SVGGraphicsElement) => void) => ({
			label,
			bytes: 0,
			apply: (root: SVGSVGElement) => {
				const layer = root.ownerDocument.getElementById(id);
				if (layer !== null) mutate(layer as unknown as SVGGraphicsElement);
			},
			revert: () => undefined,
		}),
	};
});

// ---- A recording 2D context --------------------------------------------------

type Call = Readonly<{
	name: string;
	args: readonly unknown[];
	alpha: number;
	composite: string;
	fillStyle: unknown;
	strokeStyle: unknown;
}>;

type State = {
	globalAlpha: number;
	globalCompositeOperation: string;
	fillStyle: unknown;
	strokeStyle: unknown;
	lineWidth: number;
};

type FakeContext = State &
	Readonly<{
		canvas: HTMLCanvasElement;
		calls: Call[];
		/** The canvas's pixels, RGBA, made when first asked for. */
		pixels: () => Uint8ClampedArray;
		named: (name: string) => Call[];
	}>;

/** Whether `getImageData` throws, as it does on a canvas a picture from another origin tainted. */
let tainted = false;

const createFakeContext = (canvas: HTMLCanvasElement): FakeContext => {
	const state: State = {
		globalAlpha: 1,
		globalCompositeOperation: 'source-over',
		fillStyle: '#000000',
		strokeStyle: '#000000',
		lineWidth: 1,
	};
	const calls: Call[] = [];
	const saved: State[] = [];
	let store: Uint8ClampedArray | undefined;
	const pixels = (): Uint8ClampedArray => {
		store ??= new Uint8ClampedArray(canvas.width * canvas.height * 4);
		return store;
	};
	const record = (name: string, args: readonly unknown[]): void => {
		calls.push({
			name,
			args,
			alpha: state.globalAlpha,
			composite: state.globalCompositeOperation,
			fillStyle: state.fillStyle,
			strokeStyle: state.strokeStyle,
		});
	};
	const recorder =
		(name: string) =>
		(...args: unknown[]): void =>
			record(name, args);
	const methods = {
		canvas,
		calls,
		pixels,
		named: (name: string) => calls.filter((call) => call.name === name),
		save: () => {
			saved.push({ ...state });
			record('save', []);
		},
		restore: () => {
			const last = saved.pop();
			if (last !== undefined) Object.assign(state, last);
			record('restore', []);
		},
		beginPath: recorder('beginPath'),
		closePath: recorder('closePath'),
		moveTo: recorder('moveTo'),
		lineTo: recorder('lineTo'),
		arc: recorder('arc'),
		arcTo: recorder('arcTo'),
		ellipse: recorder('ellipse'),
		fill: recorder('fill'),
		stroke: recorder('stroke'),
		fillRect: recorder('fillRect'),
		strokeRect: recorder('strokeRect'),
		drawImage: recorder('drawImage'),
		clearRect: (...args: number[]) => {
			record('clearRect', args);
			store?.fill(0);
		},
		createRadialGradient: (...args: number[]) => {
			record('createRadialGradient', args);
			return { addColorStop: () => undefined };
		},
		getImageData: (x: number, y: number, width: number, height: number) => {
			record('getImageData', [x, y, width, height]);
			if (tainted) throw new DOMException('the canvas has been tainted', 'SecurityError');
			const all = pixels();
			const data = new Uint8ClampedArray(width * height * 4);
			for (let row = 0; row < height; row += 1) {
				const from = ((y + row) * canvas.width + x) * 4;
				data.set(all.subarray(from, from + width * 4), row * width * 4);
			}
			return { data, width, height, colorSpace: 'srgb' };
		},
		putImageData: (
			image: Readonly<{ data: Uint8ClampedArray; width: number; height: number }>,
			x: number,
			y: number
		) => {
			record('putImageData', [image, x, y]);
			const all = pixels();
			for (let row = 0; row < image.height; row += 1) {
				const from = row * image.width * 4;
				all.set(
					image.data.subarray(from, from + image.width * 4),
					((y + row) * canvas.width + x) * 4
				);
			}
		},
	};
	return Object.assign(state, methods);
};

let contexts = new Map<HTMLCanvasElement, FakeContext>();

const fakeOf = (canvas: HTMLCanvasElement): FakeContext => {
	const found = contexts.get(canvas);
	if (found !== undefined) return found;
	const made = createFakeContext(canvas);
	contexts.set(canvas, made);
	return made;
};

/** How long each `toBlob` takes, in order; 0 once they run out. `null` gives no blob. */
let blobDelays: (number | null)[] = [];
let encoded = 0;
const FALLBACK_HREF = 'data:image/png;base64,ZmFsbGJhY2s=';

/** What `img.decode()` does: a picture that decodes, or one that will not. */
let decodes = true;

let getContext: MockInstance<HTMLCanvasElement['getContext']> | undefined;

const installCanvas = (): void => {
	contexts = new Map();
	blobDelays = [];
	encoded = 0;
	decodes = true;
	tainted = false;
	const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
	spy.mockImplementation(() => fakeOf(spy.mock.contexts.at(-1) as HTMLCanvasElement) as never);
	getContext = spy;
	vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
		encoded += 1;
		const [delay = 0, ...rest] = blobDelays;
		blobDelays = rest;
		const blob = delay === null ? null : new Blob([`png-${encoded}`], { type: 'image/png' });
		setTimeout(() => callback(blob), delay ?? 0);
	});
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(FALLBACK_HREF);
	Object.defineProperty(HTMLImageElement.prototype, 'decode', {
		configurable: true,
		writable: true,
		value: () => (decodes ? Promise.resolve() : Promise.reject(new Error('not a picture'))),
	});
};

beforeEach(installCanvas);

afterEach(() => {
	vi.restoreAllMocks();
	Reflect.deleteProperty(HTMLImageElement.prototype, 'decode');
});

/** What a blob of `png-n` reads back as. */
const hrefOfBlob = (n: number): string => `data:image/png;base64,${btoa(`png-${n}`)}`;

// ---- A fake editor -----------------------------------------------------------

const noop = (): undefined => undefined;

const layerInfo = (overrides: Partial<LayerInfo> = {}): LayerInfo => ({
	id: 'layer-2',
	kind: 'raster',
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

type Fake = Readonly<{
	context: ToolContext;
	root: SVGSVGElement;
	/** `layer-2`, the raster layer. */
	layer: Element;
	labels: string[];
	/** The layer's `href` after each command executed. */
	hrefs: (string | null)[];
	notices: string[];
	colours: [string, string][];
	pending: Promise<unknown>[];
	/** Called by `execute` before the command applies. */
	onExecute: { current: (() => void) | undefined };
	undo: () => void;
	screen: HTMLCanvasElement;
}>;

type Setup = Readonly<{
	/** The active layer, as the panel sees it; `null` for none. */
	active?: Partial<LayerInfo> | null;
	options?: Partial<ToolOptions>;
	size?: DrawingSize;
	viewBox?: string;
	/** An `<image>` the layer already holds. */
	image?: Readonly<Record<string, string>>;
	scale?: number;
}>;

const imageOf = (layer: Element): Element | undefined =>
	Array.from(layer.children).find((child) => child.localName === 'image');

const createFake = (setup: Setup = {}): Fake => {
	const size = setup.size ?? DEFAULT_DRAWING_SIZE;
	const parsed = new DOMParser().parseFromString(
		emptyDrawing({ id: 'd-1', size }),
		'image/svg+xml'
	);
	const root = parsed.documentElement as unknown as SVGSVGElement;
	if (setup.viewBox !== undefined) root.setAttribute('viewBox', setup.viewBox);
	const layer = parsed.createElementNS(SVG_NAMESPACE, 'g');
	layer.setAttribute('id', 'layer-2');
	layer.setAttributeNS(DRAWING_NAMESPACE, 'draw:kind', 'raster');
	root.appendChild(layer);
	if (setup.image !== undefined) {
		const image = parsed.createElementNS(SVG_NAMESPACE, 'image');
		Object.entries(setup.image).forEach(([name, value]) => image.setAttribute(name, value));
		layer.appendChild(image);
	}
	const active = setup.active === null ? undefined : layerInfo(setup.active ?? {});
	const layers = [layerInfo({ id: 'layer-1', kind: 'vector' }), layerInfo(setup.active ?? {})];
	const labels: string[] = [];
	const hrefs: (string | null)[] = [];
	const notices: string[] = [];
	const colours: [string, string][] = [];
	const pending: Promise<unknown>[] = [];
	const done: Command[] = [];
	const onExecute: Fake['onExecute'] = { current: undefined };
	const editor: EditorDocument = {
		root,
		prolog: '',
		size,
		snapshot: () => ({
			layers,
			size,
			canUndo: done.length > 0,
			canRedo: false,
			dirty: done.length > 0,
			version: done.length,
		}),
		text: () => new XMLSerializer().serializeToString(root),
		layer: (id) =>
			(root.ownerDocument.getElementById(id) as unknown as SVGGraphicsElement | null) ??
			undefined,
		execute: (command) => {
			labels.push(command.label);
			onExecute.current?.();
			command.apply(root);
			done.push(command);
			const image = imageOf(layer);
			hrefs.push(image === undefined ? null : image.getAttribute('href'));
		},
		undo: () => done.pop()?.revert(root),
		redo: noop,
		subscribe: () => noop,
		pending: (work) => {
			pending.push(work);
		},
		settle: () => Promise.all(pending).then(noop),
	};
	const screen = document.createElement('canvas');
	const context: ToolContext = {
		document: editor,
		layer: active,
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: {
			scale: setup.scale ?? 1,
			zoomBy: noop,
			panBy: noop,
			fit: noop,
			actualSize: noop,
		},
		selection: { elements: [], set: noop, clear: noop },
		setColour: (which, value) => colours.push([which, value]),
		notify: (message) => notices.push(message),
	};
	return {
		context,
		root,
		layer,
		labels,
		hrefs,
		notices,
		colours,
		pending,
		onExecute,
		undo: editor.undo,
		screen,
	};
};

const at = (x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
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
	...extra,
});

type Point = Readonly<{ x: number; y: number }>;

/** A whole stroke: begin at the first point, move through the rest, end at the last. */
const stroke = (
	behaviour: ToolBehaviour,
	context: ToolContext,
	points: readonly Point[],
	extra: Partial<PointerSample> = {}
): void => {
	const [first, ...rest] = points;
	if (first === undefined) return;
	behaviour.begin(context, at(first.x, first.y, extra));
	rest.forEach((p) => behaviour.move(context, at(p.x, p.y, extra)));
	const last = rest.at(-1) ?? first;
	behaviour.end(context, at(last.x, last.y, extra));
};

const tool = (name: ToolId): ToolBehaviour => {
	const behaviour = rasterBehaviours[name];
	if (behaviour === undefined) throw new Error(`no raster ${name}`);
	return behaviour;
};

/** The surface the tools paint on, as they find it. */
const surfaceOf = (fake: Fake): RasterSurface => {
	const surface = surfaceFor(fake.context);
	if (surface === undefined) throw new Error('no surface for layer-2');
	return surface;
};

/** A macrotask: what lies between two pointer events. */
const tick = (): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, 0);
	});

const geometryOf = (image: Element | undefined) => ({
	x: image?.getAttribute('x'),
	y: image?.getAttribute('y'),
	width: image?.getAttribute('width'),
	height: image?.getAttribute('height'),
});

const LINE: Point[] = [
	{ x: 10, y: 10 },
	{ x: 40, y: 10 },
	{ x: 80, y: 30 },
];

/** The drawing's whole canvas, as an empty raster layer covers it. */
const WHOLE = { x: '0', y: '0', width: '1600', height: '1000' };

// ---- The tests ----------------------------------------------------------------

describe('the brush', () => {
	it('writes a stroke into the layer’s <image> once, as a PNG over the canvas, and a save waits for it', async () => {
		const fake = createFake();
		stroke(tool('brush'), fake.context, LINE);
		expect(fake.labels).toEqual([]);
		expect(fake.pending).toHaveLength(1);
		await Promise.all(fake.pending);

		expect(fake.labels).toEqual(['tools.brush']);
		const image = imageOf(fake.layer);
		expect(image?.getAttribute('href')).toBe(hrefOfBlob(1));
		expect(image?.getAttribute('href')).toMatch(/^data:image\/png;base64,/);
		expect(image?.getAttribute('preserveAspectRatio')).toBe('none');
		expect(geometryOf(image)).toEqual(WHOLE);
	});

	it('paints its stamps at alpha 1 and composites the stroke once, at the stroke’s opacity', async () => {
		const fake = createFake({ options: { opacity: 0.4 } });
		const surface = surfaceOf(fake);
		stroke(tool('brush'), fake.context, LINE);
		const strokeCtx = fakeOf(surface.stroke);
		const fills = strokeCtx.named('fill');
		expect(fills.length).toBeGreaterThan(3);
		expect(fills.every((call) => call.alpha === 1)).toBe(true);
		// The first stamp is under the pointer, half the pressured width across.
		expect(strokeCtx.named('arc')[0]?.args.slice(0, 3)).toEqual([10, 10, 2.5]);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('0.4');

		await Promise.all(fake.pending);
		const composites = fakeOf(surface.canvas).named('drawImage');
		expect(composites).toHaveLength(1);
		expect(composites[0]?.args[0]).toBe(surface.stroke);
		expect(composites[0]?.alpha).toBe(0.4);
		expect(composites[0]?.composite).toBe('source-over');
		expect(strokeCtx.named('clearRect').length).toBeGreaterThan(0);
	});

	it('clears the screen canvas once the stroke has landed', async () => {
		const fake = createFake({ options: { opacity: 0.4 } });
		stroke(tool('brush'), fake.context, LINE);
		const screenCtx = fakeOf(fake.screen);
		expect(screenCtx.named('fill').length).toBeGreaterThan(0);
		expect(screenCtx.named('clearRect')).toHaveLength(0);
		await Promise.all(fake.pending);
		expect(screenCtx.named('clearRect')).toHaveLength(1);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('');
	});

	it('leaves the screen to a later stroke under way when an earlier one lands', async () => {
		const fake = createFake();
		blobDelays = [20];
		stroke(tool('brush'), fake.context, LINE);
		await tick();
		tool('brush').begin(fake.context, at(10, 60));
		await Promise.all(fake.pending);
		expect(fakeOf(fake.screen).named('clearRect')).toHaveLength(0);
		tool('brush').end(fake.context, at(30, 60));
		await Promise.all(fake.pending);
		expect(fakeOf(fake.screen).named('clearRect')).toHaveLength(1);
	});

	it('follows pressure, and is soft at a hardness under 1', () => {
		const fake = createFake({ options: { hardness: 0.5, size: 8 } });
		const surface = surfaceOf(fake);
		tool('brush').begin(fake.context, at(10, 10, { pressure: 0 }));
		tool('brush').cancel(fake.context);
		tool('brush').begin(fake.context, at(10, 10, { pressure: 1 }));
		tool('brush').cancel(fake.context);
		const radii = fakeOf(surface.stroke)
			.named('arc')
			.map((call) => call.args[2]);
		expect(radii).toEqual([1, 4]);
		expect(fakeOf(surface.stroke).named('createRadialGradient')).toHaveLength(2);
	});

	it('lags the pointer by its smoothing, and catches up where the pointer lifts', async () => {
		const fake = createFake({ options: { smoothing: 1 } });
		const surface = surfaceOf(fake);
		const brush = tool('brush');
		brush.begin(fake.context, at(0, 0));
		brush.move(fake.context, at(10, 0));
		const xs = () =>
			fakeOf(surface.stroke)
				.named('arc')
				.map((call) => call.args[0]);
		// Inside the string's length: the stroke has not moved.
		expect(xs()).toEqual([0]);
		brush.end(fake.context, at(10, 0));
		expect(xs().at(-1)).toBeCloseTo(10);
		expect(fake.pending).toHaveLength(1);
		await Promise.all(fake.pending);
	});

	it('lands two strokes in the order they were made, whichever encoding finishes first', async () => {
		const fake = createFake();
		blobDelays = [30, 0];
		stroke(tool('brush'), fake.context, LINE);
		await tick();
		stroke(tool('brush'), fake.context, [
			{ x: 10, y: 60 },
			{ x: 50, y: 60 },
		]);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.brush', 'tools.brush']);
		expect(fake.hrefs).toEqual([hrefOfBlob(1), hrefOfBlob(2)]);
	});
});

describe('the pencil and the eraser', () => {
	it('draws the pencil hard, in the stroke colour, at one width whatever the pressure', () => {
		const fake = createFake({
			options: { hardness: 0.2, stroke: '#ff0000', fill: '#00ff00', size: 6 },
		});
		const surface = surfaceOf(fake);
		tool('pencil').begin(fake.context, at(10, 10, { pressure: 0.1 }));
		tool('pencil').cancel(fake.context);
		tool('pencil').begin(fake.context, at(10, 10, { pressure: 1 }));
		tool('pencil').cancel(fake.context);
		const strokeCtx = fakeOf(surface.stroke);
		expect(strokeCtx.named('createRadialGradient')).toHaveLength(0);
		expect(strokeCtx.named('arc').map((call) => call.args[2])).toEqual([3, 3]);
		expect(strokeCtx.named('fill').map((call) => call.fillStyle)).toEqual([
			'#ff0000',
			'#ff0000',
		]);
	});

	it('commits the pencil as tools.pencil', async () => {
		const fake = createFake();
		stroke(tool('pencil'), fake.context, LINE);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.pencil']);
	});

	it('takes the eraser’s stroke away, as destination-out, fully whatever the brush’s opacity', async () => {
		const fake = createFake({ options: { opacity: 0.3 } });
		const surface = surfaceOf(fake);
		stroke(tool('eraser'), fake.context, LINE);
		await Promise.all(fake.pending);
		const composites = fakeOf(surface.canvas).named('drawImage');
		expect(composites).toHaveLength(1);
		expect(composites[0]?.composite).toBe('destination-out');
		expect(composites[0]?.alpha).toBe(1);
		expect(fake.labels).toEqual(['tools.eraser']);
	});
});

describe('the fill', () => {
	it('floods the layer’s own pixels, puts them back and commits them', async () => {
		const fake = createFake({ options: { fill: '#ff0000' } });
		const surface = surfaceOf(fake);
		tool('fill').begin(fake.context, at(100, 100));
		expect(fake.pending).toHaveLength(1);
		await Promise.all(fake.pending);
		const layerCtx = fakeOf(surface.canvas);
		expect(layerCtx.named('putImageData')).toHaveLength(1);
		expect(Array.from(layerCtx.pixels().slice(0, 4))).toEqual([255, 0, 0, 255]);
		expect(fakeOf(surface.stroke).named('drawImage')).toHaveLength(0);
		expect(fake.labels).toEqual(['tools.fill']);
		expect(geometryOf(imageOf(fake.layer))).toEqual(WHOLE);
	});

	it('writes nothing where no pixel changed', async () => {
		const fake = createFake({ options: { fill: '#ff0000' } });
		tool('fill').begin(fake.context, at(100, 100));
		await Promise.all(fake.pending);
		tool('fill').begin(fake.context, at(5, 5));
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.fill']);
	});
});

describe('the eyedropper', () => {
	it('takes a pixel’s colour as the fill, and as the stroke with Alt', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		const pixels = fakeOf(surface.canvas).pixels();
		pixels.set([255, 128, 0, 255], (6 * 1600 + 5) * 4);
		tool('eyedropper').begin(fake.context, at(5.5, 6.5));
		tool('eyedropper').begin(fake.context, at(5.2, 6.9, { altKey: true }));
		await vi.waitFor(() =>
			expect(fake.colours).toEqual([
				['fill', '#ff8000'],
				['stroke', '#ff8000'],
			])
		);
		expect(fake.labels).toEqual([]);
	});

	it('takes nothing from a transparent pixel, or from outside the layer', async () => {
		const fake = createFake();
		tool('eyedropper').begin(fake.context, at(20, 20));
		tool('eyedropper').begin(fake.context, at(-5, 20));
		await tick();
		expect(fake.colours).toEqual([]);
	});
});

describe('the shapes', () => {
	it('keeps a rectangle square with Shift, previews it, and draws it onto the stroke canvas', async () => {
		const fake = createFake();
		const surface = surfaceOf(fake);
		const rectangle = tool('rectangle');
		rectangle.begin(fake.context, at(10, 10, { shiftKey: true }));
		rectangle.move(fake.context, at(50, 30, { shiftKey: true }));
		const preview = fake.context.overlay.firstElementChild;
		expect(preview?.localName).toBe('rect');
		expect(preview?.getAttribute('width')).toBe('40');
		expect(preview?.getAttribute('height')).toBe('40');
		rectangle.end(fake.context, at(50, 30, { shiftKey: true }));

		const strokeCtx = fakeOf(surface.stroke);
		expect(strokeCtx.named('moveTo')[0]?.args).toEqual([10, 10]);
		expect(strokeCtx.named('arcTo').map((call) => call.args)).toEqual([
			[50, 10, 50, 50, 0],
			[50, 50, 10, 50, 0],
			[10, 50, 10, 10, 0],
			[10, 10, 50, 10, 0],
		]);
		expect(strokeCtx.named('fill')[0]?.fillStyle).toBe(DEFAULT_TOOL_OPTIONS.fill);
		expect(fake.context.overlay.childElementCount).toBe(1);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual(['tools.rectangle']);
		expect(fake.context.overlay.childElementCount).toBe(0);
	});

	it('rounds a rectangle’s corners by the corner radius, never past half a side', async () => {
		const fake = createFake({ options: { cornerRadius: 100 } });
		const surface = surfaceOf(fake);
		stroke(tool('rectangle'), fake.context, [
			{ x: 0, y: 0 },
			{ x: 40, y: 20 },
		]);
		expect(fakeOf(surface.stroke).named('arcTo')[0]?.args[4]).toBe(10);
		expect(fake.context.overlay.firstElementChild?.getAttribute('rx')).toBe('10');
		await Promise.all(fake.pending);
	});

	it('makes nothing from a click, or from a shape with neither fill nor stroke', async () => {
		const fake = createFake();
		stroke(tool('ellipse'), fake.context, [{ x: 10, y: 10 }]);
		const bare = createFake({ options: { fill: 'none', stroke: 'none' } });
		stroke(tool('rectangle'), bare.context, LINE);
		await tick();
		expect([fake.labels, bare.labels, fake.pending, bare.pending]).toEqual([[], [], [], []]);
		expect(
			fake.context.overlay.childElementCount + bare.context.overlay.childElementCount
		).toBe(0);
	});

	it('draws a line in the stroke colour, the fill where there is none', async () => {
		const fake = createFake({ options: { stroke: 'none', fill: '#00ff00' } });
		const surface = surfaceOf(fake);
		stroke(tool('line'), fake.context, LINE);
		await Promise.all(fake.pending);
		const strokes = fakeOf(surface.stroke).named('stroke');
		expect(strokes.map((call) => call.strokeStyle)).toEqual(['#00ff00']);
		expect(fakeOf(surface.stroke).named('lineTo')[0]?.args).toEqual([80, 30]);
		expect(fake.labels).toEqual(['tools.line']);
	});
});

describe('select', () => {
	it('moves the layer by its transform live, and puts it back before the command runs', () => {
		const fake = createFake();
		const seen: (string | null)[] = [];
		fake.onExecute.current = () => seen.push(fake.layer.getAttribute('transform'));
		const select = tool('select');
		select.begin(fake.context, at(0, 0));
		select.move(fake.context, at(30, 40));
		expect(fake.layer.getAttribute('transform')).toBe('translate(30 40)');
		select.end(fake.context, at(30, 40));
		expect(seen).toEqual([null]);
		expect(fake.labels).toEqual(['tools.select']);
		expect(fake.layer.getAttribute('transform')).toBe('translate(30 40)');
	});

	it('puts the move before a transform the layer had, and does nothing for a click', () => {
		const fake = createFake();
		fake.layer.setAttribute('transform', 'scale(2)');
		stroke(tool('select'), fake.context, [
			{ x: 5, y: 5 },
			{ x: 15, y: 0 },
		]);
		expect(fake.layer.getAttribute('transform')).toBe('translate(10 -5) scale(2)');
		stroke(tool('select'), fake.context, [{ x: 5, y: 5 }]);
		expect(fake.labels).toEqual(['tools.select']);
	});
});

describe('what may not be drawn on', () => {
	const DRAWING_TOOLS: ToolId[] = ['brush', 'pencil', 'eraser', 'fill', 'rectangle', 'select'];

	it.each([
		['a locked layer', { locked: true }, t('layers.locked', { name: 'Layer 2' })],
		['a hidden layer', { hidden: true }, t('layers.hidden', { name: 'Layer 2' })],
	])('says so on %s, and commits nothing', async (_, active, message) => {
		const fake = createFake({ active });
		DRAWING_TOOLS.forEach((id) => stroke(tool(id), fake.context, LINE));
		await tick();
		expect(fake.notices).toEqual(DRAWING_TOOLS.map(() => message));
		expect([fake.labels, fake.pending]).toEqual([[], []]);
		expect(fake.context.overlay.childElementCount).toBe(0);
		expect(fake.layer.attributes.getNamedItem('transform')).toBeNull();
		expect(imageOf(fake.layer)).toBeUndefined();
	});

	it('says so with no layer active', async () => {
		const fake = createFake({ active: null });
		[...DRAWING_TOOLS, 'eyedropper' as const].forEach((id) =>
			stroke(tool(id), fake.context, LINE)
		);
		await tick();
		expect(new Set(fake.notices)).toEqual(new Set([t('layers.noneActive')]));
		expect(fake.notices).toHaveLength(DRAWING_TOOLS.length + 1);
		expect([fake.labels, fake.pending]).toEqual([[], []]);
	});
});

describe('cancel', () => {
	it('clears a brush stroke from both canvases and commits nothing', async () => {
		const fake = createFake({ options: { opacity: 0.5 } });
		const surface = surfaceOf(fake);
		const brush = tool('brush');
		brush.begin(fake.context, at(10, 10));
		brush.move(fake.context, at(60, 10));
		brush.cancel(fake.context);
		brush.end(fake.context, at(60, 10));
		await tick();
		expect([fake.labels, fake.pending]).toEqual([[], []]);
		expect(fakeOf(surface.stroke).named('clearRect')).toHaveLength(1);
		expect(fakeOf(fake.screen).named('clearRect')).toHaveLength(1);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('');
	});

	it('takes a shape’s preview away, and puts a moved layer back', async () => {
		const fake = createFake();
		const rectangle = tool('rectangle');
		rectangle.begin(fake.context, at(10, 10));
		rectangle.move(fake.context, at(50, 50));
		rectangle.cancel(fake.context);
		const select = tool('select');
		select.begin(fake.context, at(0, 0));
		select.move(fake.context, at(30, 30));
		select.cancel(fake.context);
		await tick();
		expect(fake.context.overlay.childElementCount).toBe(0);
		expect(fake.layer.getAttribute('transform')).toBeNull();
		expect([fake.labels, fake.pending]).toEqual([[], []]);
	});
});

describe('the surface', () => {
	it('is kept while the file’s href is its own, and rebuilt from the file when it moves', async () => {
		const fake = createFake();
		const first = surfaceOf(fake);
		expect(surfaceOf(fake)).toBe(first);
		stroke(tool('brush'), fake.context, LINE);
		await Promise.all(fake.pending);
		expect(surfaceOf(fake)).toBe(first);
		expect(first.source()).toBe(hrefOfBlob(1));

		fake.undo();
		expect(imageOf(fake.layer)).toBeUndefined();
		const undone = surfaceOf(fake);
		expect(undone).not.toBe(first);
		expect(undone.source()).toBeUndefined();

		const other = 'data:image/png;base64,b3RoZXI=';
		const image = fake.root.ownerDocument.createElementNS(SVG_NAMESPACE, 'image');
		Object.entries({ ...WHOLE, href: other }).forEach(([name, value]) =>
			image.setAttribute(name, value)
		);
		fake.layer.appendChild(image);
		const rebuilt = surfaceOf(fake);
		expect(rebuilt).not.toBe(undone);
		await rebuilt.ready;
		const decoded = fakeOf(rebuilt.canvas).named('drawImage')[0]?.args;
		expect((decoded?.[0] as Element | undefined)?.getAttribute('src')).toBe(other);
		expect(decoded?.slice(1)).toEqual([0, 0, 1600, 1000]);
	});

	it('is rebuilt when the geometry an empty layer covers changes', () => {
		const fake = createFake();
		const first = surfaceOf(fake);
		fake.root.setAttribute('viewBox', '10 10 1600 1000');
		expect(surfaceOf(fake)).not.toBe(first);
	});

	it('covers the canvas from the viewBox’s origin', async () => {
		const fake = createFake({ viewBox: '-100 -50 1600 1000' });
		const surface = surfaceOf(fake);
		expect(surface.toPixel(-100, -50)).toEqual([0, 0]);
		stroke(tool('pencil'), fake.context, [
			{ x: -90, y: -40 },
			{ x: -60, y: -40 },
		]);
		expect(fakeOf(surface.stroke).named('arc')[0]?.args.slice(0, 2)).toEqual([10, 10]);
		await Promise.all(fake.pending);
		expect(geometryOf(imageOf(fake.layer))).toEqual({
			x: '-100',
			y: '-50',
			width: '1600',
			height: '1000',
		});
	});

	it('has fewer pixels than units past RASTER_MAX_SIDE, and keeps the units in the file', async () => {
		const fake = createFake({ size: { width: 8192, height: 4096 } });
		const surface = surfaceOf(fake);
		expect([surface.ppu, surface.canvas.width, surface.canvas.height]).toEqual([
			0.5, 4096, 2048,
		]);
		stroke(tool('pencil'), fake.context, [
			{ x: 100, y: 100 },
			{ x: 100, y: 100 },
		]);
		expect(fakeOf(surface.stroke).named('arc')[0]?.args.slice(0, 3)).toEqual([50, 50, 2]);
		await Promise.all(fake.pending);
		expect(geometryOf(imageOf(fake.layer))).toEqual({
			x: '0',
			y: '0',
			width: '8192',
			height: '4096',
		});
	});

	it('decodes a picture from elsewhere where its preserveAspectRatio showed it', async () => {
		vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(50);
		vi.spyOn(HTMLImageElement.prototype, 'naturalHeight', 'get').mockReturnValue(50);
		const fake = createFake({
			image: {
				x: '0',
				y: '0',
				width: '200',
				height: '100',
				href: 'data:image/png;base64,AAAA',
			},
		});
		const surface = surfaceOf(fake);
		await surface.ready;
		expect(fakeOf(surface.canvas).named('drawImage')[0]?.args.slice(1)).toEqual([
			50, 0, 100, 100,
		]);
	});

	it('falls back to toDataURL where toBlob gives nothing', async () => {
		const fake = createFake();
		blobDelays = [null];
		stroke(tool('brush'), fake.context, LINE);
		await Promise.all(fake.pending);
		expect(imageOf(fake.layer)?.getAttribute('href')).toBe(FALLBACK_HREF);
	});

	it('writes nothing into a layer deleted while its pixels were encoded', async () => {
		const fake = createFake();
		stroke(tool('brush'), fake.context, LINE);
		fake.layer.remove();
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual([]);
	});

	it.each([
		[
			'will not decode',
			() => {
				decodes = false;
			},
		],
		[
			'is from another origin',
			() => {
				tainted = true;
			},
		],
	])('paints nothing on a picture that %s, and says so', async (_, spoil) => {
		spoil();
		const href = 'data:image/png;base64,AAAA';
		const fake = createFake({ image: { ...WHOLE, href } });
		stroke(tool('brush'), fake.context, LINE);
		tool('fill').begin(fake.context, at(5, 5));
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('raster.unreadable'), t('raster.unreadable')]);
		expect(imageOf(fake.layer)?.getAttribute('href')).toBe(href);
	});

	it('is inert where the browser gives no 2D context, as jsdom does', async () => {
		getContext?.mockReturnValue(null);
		const fake = createFake();
		stroke(tool('brush'), fake.context, LINE);
		tool('fill').begin(fake.context, at(5, 5));
		stroke(tool('rectangle'), fake.context, LINE);
		await Promise.all(fake.pending);
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([]);
		expect(imageOf(fake.layer)).toBeUndefined();
	});
});
