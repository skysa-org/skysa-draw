import { BLEND_MODES, DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { Pixels } from '../../src/drawing/inpaint/index.js';
import {
	canFillArea,
	fillAreaWith,
	type FillSpec,
} from '../../src/drawing/tools/raster/areaFill.js';
import { fillArea } from '../../src/drawing/tools/raster/index.js';
import type { Rgba } from '../../src/drawing/tools/raster/pixels.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type Region,
	type ToolContext,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import { t } from '../../src/i18n/t.js';
import {
	fakeOf,
	installFakeCanvas,
	pictureAt,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * Fill… on a raster layer (docs/decisions/0004-the-interface.md, "The
 * context menu"; docs/ARCHITECTURE.md §7, "Tools"): the area filled with the
 * fill color, the stroke color, a color of its own or the picture around it
 * made again, in a blend mode, at an opacity, keeping transparency or not, by
 * one command undone to the bytes. Against a real document and the
 * compositing fake canvas (`fakeCanvas.ts`), so what is checked is the pixels
 * written into the layer's picture. The fake composites Porter–Duff's
 * operators; the two a fill adds, `source-atop` and `multiply`, are composited
 * here, by the spec's formulas, for the one way a fill draws them: a whole
 * canvas of the same size at the origin. The content-aware engine is a double
 * whose answer each test sets, so what is checked is what it is given and
 * what is done with what it makes; the engine has tests of its own.
 */

const engine = vi.hoisted(() => ({
	inpaint:
		vi.fn<
			(image: Pixels, mask: Uint8Array, signal?: AbortSignal) => Promise<Uint8ClampedArray>
		>(),
}));
vi.mock('../../src/drawing/inpaint/index.js', () => ({ inpaint: engine.inpaint }));

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The canvas is 40 × 30; `layer-2` is a raster layer with a picture the canvas's size. */
const drawingText = (picture: string, layerAttributes = '', kind = 'raster'): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="${kind}"${layerAttributes}><image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

const WHITE: Rgba = [255, 255, 255, 255];
const GRAY: Rgba = [128, 128, 128, 255];
const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

/** The default fill color, `#111827`. */
const INK: Rgba = [17, 24, 39, 255];

/** A square from (10, 5) to (30, 25), as the marquee writes it. */
const SQUARE = 'M 10 5 L 30 5 L 30 25 L 10 25 Z';
const PLAIN: Region = { path: SQUARE, inverted: false, feather: 0 };

/** Inside the square, and outside it. */
const IN = [20, 15] as const;
const OUT = [5, 15] as const;

const noop = (): undefined => undefined;

const picture = (paint: (x: number, y: number) => Rgba): string => registerPicture(40, 30, paint);
const filled = (rgba: Rgba): string => picture(() => rgba);

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	host: HTMLElement;
	href: () => string | null | undefined;
	at: (point: readonly [number, number]) => number[];
	markup: () => string;
}>;

type Setup = Readonly<{
	picture?: string;
	layerAttributes?: string;
	kind?: string;
	region?: Region;
	options?: Partial<ToolOptions>;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const opened = openDocument(
		drawingText(setup.picture ?? filled(WHITE), setup.layerAttributes, setup.kind)
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
	const host = document.createElement('div');
	document.body.append(host);
	const region = setup.region ?? PLAIN;
	const context: ToolContext = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...setup.options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: {
			canvas: document.createElement('canvas'),
			toScreen: (x, y) => [x, y],
			pixelRatio: 1,
		},
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: { path: region.path, region, set: noop, update: noop },
		host,
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	const href = () =>
		Array.from(editor.layer('layer-2')?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return {
		context,
		document: editor,
		labels,
		notices,
		host,
		href,
		at: ([x, y]) => pictureAt(href(), x, y),
		markup: () => new XMLSerializer().serializeToString(editor.root),
	};
};

const spec = (change: Partial<FillSpec> = {}): FillSpec => ({
	contents: 'fill',
	mode: 'normal',
	opacity: 1,
	preserveTransparency: false,
	...change,
});

/** Each channel within one of the other's, for a mix the canvas rounds. */
const near = (actual: readonly number[], expected: readonly number[]): void => {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((value, i) =>
		expect(Math.abs(value - (expected[i] ?? 0))).toBeLessThanOrEqual(1)
	);
};

// ---- What the fake does not composite, composited here ---------------------

type Px = readonly [number, number, number, number];

/** `source-atop`, unpremultiplied: the destination's alpha, the source's color by as much as it has. */
const atop = (s: Px, as: number, d: Px): Px => {
	const ad = d[3] / 255;
	if (ad === 0) return [0, 0, 0, 0];
	const mix = (k: 0 | 1 | 2) => s[k] * as + d[k] * (1 - as);
	return [mix(0), mix(1), mix(2), ad * 255];
};

/** `multiply`, composited `source-over` with the backdrop blended in by its alpha (Compositing and Blending 1, §5). */
const multiply = (s: Px, as: number, d: Px): Px => {
	const ad = d[3] / 255;
	const alpha = as + ad * (1 - as);
	if (alpha === 0) return [0, 0, 0, 0];
	const channel = (k: 0 | 1 | 2) => {
		const blended = (1 - ad) * s[k] + ad * ((s[k] * d[k]) / 255);
		return (blended * as + d[k] * ad * (1 - as)) / alpha;
	};
	return [channel(0), channel(1), channel(2), alpha * 255];
};

const EXTRA: Readonly<Record<string, (s: Px, as: number, d: Px) => Px>> = {
	'source-atop': atop,
	multiply,
};

/** Every composite a fill drew a whole canvas with, in order. */
let composites: string[] = [];

/** The fake's context, with `drawImage` composited here for the operators it lacks. */
const contexts = new WeakMap<HTMLCanvasElement, unknown>();
const extended = (canvas: HTMLCanvasElement): unknown => {
	const found = contexts.get(canvas);
	if (found !== undefined) return found;
	const fake = fakeOf(canvas);
	// The fake's type names its state and what it adds; its methods are a 2D context's.
	const own = fake as unknown as CanvasRenderingContext2D;
	const drawImage = (image: HTMLCanvasElement, x: number, y: number) => {
		const op = fake.globalCompositeOperation;
		composites.push(op);
		const blend = EXTRA[op];
		// A blend mode the fake does not composite is laid over as `source-over`: what is checked of it is its name.
		if (blend === undefined) {
			if ((BLEND_MODES as readonly string[]).includes(op))
				fake.globalCompositeOperation = 'source-over';
			own.drawImage(image, x, y);
			fake.globalCompositeOperation = op;
			return;
		}
		const source = fakeOf(image).pixels();
		const target = fake.pixels();
		for (let o = 0; o < target.length; o += 4) {
			const s: Px = [
				source[o] ?? 0,
				source[o + 1] ?? 0,
				source[o + 2] ?? 0,
				source[o + 3] ?? 0,
			];
			const d: Px = [
				target[o] ?? 0,
				target[o + 1] ?? 0,
				target[o + 2] ?? 0,
				target[o + 3] ?? 0,
			];
			const out = blend(s, (s[3] / 255) * fake.globalAlpha, d);
			const alpha = Math.round(out[3]);
			target.set(alpha === 0 ? [0, 0, 0, 0] : [...out.slice(0, 3).map(Math.round), alpha], o);
		}
	};
	const made = new Proxy(fake, {
		get: (on, key): unknown =>
			key === 'drawImage' ? drawImage : (Reflect.get(on, key) as unknown),
	});
	contexts.set(canvas, made);
	return made;
};

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
	composites = [];
	const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
	spy.mockImplementation(() => extended(spy.mock.contexts.at(-1) as HTMLCanvasElement) as never);
	vi.stubGlobal('ImageData', FakeImageData);
	engine.inpaint.mockReset();
});
afterEach(() => {
	uninstallFakeCanvas();
	document.body.replaceChildren();
});

// ---- Colors -----------------------------------------------------------------

describe('fill with a color', () => {
	it('fills the area with the fill color, by one command undone to the bytes', async () => {
		const fake = createFake();
		const before = fake.markup();
		expect(fillAreaWith(fake.context, spec())).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.fill']);
		expect(fake.at(IN)).toEqual([...INK]);
		expect(fake.at(OUT)).toEqual([...WHITE]);
		const after = fake.markup();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('is what fillArea does, so the two cannot drift', async () => {
		const one = createFake({ region: { path: SQUARE, inverted: false, feather: 3 } });
		const other = createFake({ region: { path: SQUARE, inverted: false, feather: 3 } });
		fillArea(one.context);
		fillAreaWith(other.context, spec());
		await Promise.all([one.document.settle(), other.document.settle()]);
		[IN, OUT, [10, 15], [9, 15], [30, 5]].forEach((point) => {
			expect(other.at(point as readonly [number, number])).toEqual(
				one.at(point as readonly [number, number])
			);
		});
		expect(other.labels).toEqual(one.labels);
	});

	it('fills with the stroke color, which falls back to the fill color where it is none', async () => {
		const stroke = createFake({ options: { stroke: '#ff0000' } });
		fillAreaWith(stroke.context, spec({ contents: 'stroke' }));
		await stroke.document.settle();
		expect(stroke.at(IN)).toEqual([...RED]);

		const none = createFake({ options: { stroke: 'none' } });
		fillAreaWith(none.context, spec({ contents: 'stroke' }));
		await none.document.settle();
		expect(none.at(IN)).toEqual([...INK]);
	});

	it('fills with a color of its own, or the fill color where it is none or cannot be read', async () => {
		const own = createFake();
		fillAreaWith(own.context, spec({ contents: 'color', color: '#00ff00' }));
		await own.document.settle();
		expect(own.at(IN)).toEqual([...GREEN]);

		await Promise.all(
			['none', 'not a color', undefined].map(async (color) => {
				const fake = createFake();
				fillAreaWith(fake.context, spec({ contents: 'color', color }));
				await fake.document.settle();
				expect(fake.at(IN)).toEqual([...INK]);
			})
		);
	});

	it('fills by the coverage: a feather fades, an inverse fills outside the outline', async () => {
		const feathered = createFake({ region: { path: SQUARE, inverted: false, feather: 4 } });
		fillAreaWith(feathered.context, spec({ contents: 'color', color: '#ff0000' }));
		await feathered.document.settle();
		expect(feathered.at(IN)).toEqual([...RED]);
		const edge = feathered.at([10, 15]);
		expect(edge[1]).toBeGreaterThan(0);
		expect(edge[1]).toBeLessThan(255);

		const inverted = createFake({ region: { path: SQUARE, inverted: true, feather: 0 } });
		fillAreaWith(inverted.context, spec({ contents: 'color', color: '#ff0000' }));
		await inverted.document.settle();
		expect(inverted.at(OUT)).toEqual([...RED]);
		expect(inverted.at(IN)).toEqual([...WHITE]);
	});

	it('lays the color over at the opacity', async () => {
		const fake = createFake();
		fillAreaWith(fake.context, spec({ contents: 'color', color: '#ff0000', opacity: 0.5 }));
		await fake.document.settle();
		near(fake.at(IN), [255, 128, 128, 255]);
	});

	it('blends in the mode, which is the canvas’s composite of the same name', async () => {
		const fake = createFake({ picture: filled(GRAY) });
		fillAreaWith(fake.context, spec({ contents: 'color', color: '#ff0000', mode: 'multiply' }));
		await fake.document.settle();
		near(fake.at(IN), [128, 0, 0, 255]);
		near(fake.at(OUT), [...GRAY]);
	});

	it.each(BLEND_MODES)('draws %s as the canvas composite of that name', async (mode) => {
		const fake = createFake({ picture: filled(GRAY) });
		fillAreaWith(fake.context, spec({ contents: 'color', color: '#ff0000', mode }));
		await fake.document.settle();
		expect(composites).toContain(mode === 'normal' ? 'source-over' : mode);
	});

	it('keeps each pixel’s alpha with preserve transparency', async () => {
		// Transparent on the left, opaque white on the right, half there in a column of its own.
		const layer = picture((x) => {
			if (x < 20) return CLEAR;
			return x === 25 ? [255, 255, 255, 128] : WHITE;
		});
		const fake = createFake({ picture: layer });
		fillAreaWith(
			fake.context,
			spec({ contents: 'color', color: '#ff0000', preserveTransparency: true })
		);
		await fake.document.settle();
		expect(fake.at([15, 15])).toEqual([...CLEAR]);
		expect(fake.at([22, 15])).toEqual([...RED]);
		expect(fake.at([25, 15])).toEqual([255, 0, 0, 128]);
		expect(fake.at([35, 15])).toEqual([...WHITE]);
	});

	it('keeps each pixel’s alpha in a blend mode too', async () => {
		const layer = picture((x) => (x < 20 ? CLEAR : GRAY));
		const fake = createFake({ picture: layer });
		fillAreaWith(
			fake.context,
			spec({
				contents: 'color',
				color: '#ff0000',
				mode: 'multiply',
				preserveTransparency: true,
			})
		);
		await fake.document.settle();
		expect(fake.at([15, 15])).toEqual([...CLEAR]);
		near(fake.at([22, 15]), [128, 0, 0, 255]);
	});

	it('writes nothing where nothing changes: no opacity, or the color already there', async () => {
		const none = createFake();
		expect(fillAreaWith(none.context, spec({ opacity: 0 }))).toBe(true);
		await none.document.settle();
		expect(none.labels).toEqual([]);

		const same = createFake({ picture: filled(WHITE) });
		fillAreaWith(same.context, spec({ contents: 'color', color: '#ffffff' }));
		await same.document.settle();
		expect(same.labels).toEqual([]);
	});

	it('refuses a locked or a hidden layer, saying why, and is not a vector layer’s', async () => {
		const locked = createFake({ layerAttributes: ' draw:locked="true"' });
		expect(fillAreaWith(locked.context, spec())).toBe(true);
		const hidden = createFake({ layerAttributes: ' display="none"' });
		expect(fillAreaWith(hidden.context, spec())).toBe(true);
		await Promise.all([locked.document.settle(), hidden.document.settle()]);
		expect(locked.labels).toEqual([]);
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect(hidden.notices).toEqual([t('layers.hidden', { name: 'Layer 2' })]);

		const vector = createFake({ kind: 'vector' });
		(['fill', 'stroke', 'color', 'contentAware'] as const).forEach((contents) => {
			expect(fillAreaWith(vector.context, spec({ contents }))).toBe(false);
		});
		expect(vector.notices).toEqual([]);
		expect(engine.inpaint).not.toHaveBeenCalled();
	});

	it('is not the area’s to do with no area', () => {
		const fake = createFake();
		const context = {
			...fake.context,
			region: { ...fake.context.region, path: undefined, region: undefined },
		};
		expect(fillAreaWith(context, spec())).toBe(false);
	});
});

describe('canFillArea', () => {
	it('says whether Fill… may open: an area on a raster layer that is neither locked nor hidden', () => {
		expect(canFillArea(createFake().context)).toBe(true);
		const locked = createFake({ layerAttributes: ' draw:locked="true"' });
		expect(canFillArea(locked.context)).toBe(false);
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect(canFillArea(createFake({ kind: 'vector' }).context)).toBe(false);
	});
});

// ---- Content-aware -----------------------------------------------------------

/** An engine that makes the hole `rgba`, as told, and keeps the rest. */
const makesHole =
	(rgba: Rgba) =>
	(image: Pixels, mask: Uint8Array): Promise<Uint8ClampedArray> =>
		Promise.resolve(
			new Uint8ClampedArray(image.data).map((value, i) =>
				(mask[Math.floor(i / 4)] ?? 0) > 0 ? (rgba[i % 4] ?? 0) : value
			)
		);

/** An engine that waits until it is let go, or aborted, as the real one is. */
const waiting = () => {
	const release = { current: noop as (data: Uint8ClampedArray) => void };
	engine.inpaint.mockImplementation(
		(_image, _mask, signal) =>
			new Promise((resolve, reject) => {
				release.current = resolve;
				signal?.addEventListener('abort', () =>
					reject(new DOMException('The fill was stopped.', 'AbortError'))
				);
			})
	);
	return release;
};

/** Until the engine has been asked, which is after the picture decoded. */
const asked = async (): Promise<void> => {
	await vi.waitFor(() => expect(engine.inpaint).toHaveBeenCalled());
};

const progressIn = (host: HTMLElement) => host.querySelector('.fill-progress');

describe('content-aware fill', () => {
	it('gives the engine the layer and a hole of every pixel the coverage reaches, a feather’s edge too', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake({
			picture: filled(RED),
			region: { path: SQUARE, inverted: false, feather: 4 },
		});
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await fake.document.settle();
		const [image, mask, signal] = engine.inpaint.mock.calls[0] ?? [];
		expect(image?.width).toBe(40);
		expect(image?.height).toBe(30);
		expect(Array.from(image?.data.subarray(0, 4) ?? [])).toEqual([...RED]);
		expect(signal).toBeInstanceOf(AbortSignal);
		const holeAt = (x: number, y: number) => mask?.[y * 40 + x];
		expect(holeAt(20, 15)).toBe(1);
		// Outside the outline, where the feather still reaches: made again too.
		expect(holeAt(8, 15)).toBe(1);
		expect(holeAt(1, 15)).toBe(0);
		// Mixed back by the coverage: all of it inside, part of it at the edge, none far out.
		expect(fake.at(IN)).toEqual([...GREEN]);
		const edge = fake.at([10, 15]);
		expect(edge[0]).toBeGreaterThan(0);
		expect(edge[1]).toBeGreaterThan(0);
		expect(fake.at([1, 15])).toEqual([...RED]);
	});

	it('is one command, undone to the bytes', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake({ picture: filled(RED) });
		const before = fake.markup();
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.fill']);
		const after = fake.markup();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('takes the pixels’ place in normal, transparency and all, so an object on nothing goes', async () => {
		engine.inpaint.mockImplementation(makesHole(CLEAR));
		const object = picture((x, y) => (x >= 15 && x < 25 && y >= 10 && y < 20 ? RED : CLEAR));
		const fake = createFake({ picture: object });
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await fake.document.settle();
		expect(fake.at(IN)).toEqual([...CLEAR]);
	});

	it('mixes in proportion at an opacity, and blends in another mode', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const half = createFake({ picture: filled(RED) });
		fillAreaWith(half.context, spec({ contents: 'contentAware', opacity: 0.5 }));
		await half.document.settle();
		near(half.at(IN), [128, 128, 0, 255]);

		const multiplied = createFake({ picture: filled(GRAY) });
		fillAreaWith(multiplied.context, spec({ contents: 'contentAware', mode: 'multiply' }));
		await multiplied.document.settle();
		near(multiplied.at(IN), [0, 128, 0, 255]);
	});

	it('keeps each pixel’s alpha with preserve transparency', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const layer = picture((x) => (x < 20 ? CLEAR : RED));
		const fake = createFake({ picture: layer });
		fillAreaWith(fake.context, spec({ contents: 'contentAware', preserveTransparency: true }));
		await fake.document.settle();
		expect(fake.at([15, 15])).toEqual([...CLEAR]);
		expect(fake.at([22, 15])).toEqual([...GREEN]);
	});

	it('shows its progress over the canvas while the engine works, and a save waits for it', async () => {
		const release = waiting();
		const fake = createFake({ picture: filled(RED) });
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		const saved = vi.fn();
		void fake.document.settle().then(saved);
		await asked();
		const progress = progressIn(fake.host);
		expect(progress?.getAttribute('role')).toBe('status');
		expect(progress?.textContent).toContain(t('selection.fill.working'));
		expect(progress?.querySelector('progress')).not.toBeNull();
		expect(saved).not.toHaveBeenCalled();
		release.current(
			new Uint8ClampedArray(40 * 30 * 4).fill(0).map((_, i) => GREEN[i % 4] ?? 0)
		);
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
		expect(progressIn(fake.host)).toBeNull();
		expect(fake.at(IN)).toEqual([...GREEN]);
	});

	it('stops on Escape, keeping the key from the canvas, and leaves the layer as it was', async () => {
		waiting();
		const fake = createFake({ picture: filled(RED) });
		const before = fake.markup();
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await asked();
		const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(escape);
		expect(escape.defaultPrevented).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.markup()).toBe(before);
		expect(fake.notices).toEqual([t('selection.fill.stopped')]);
		expect(progressIn(fake.host)).toBeNull();
		// Once it has stopped, Escape is the canvas's again.
		const later = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(later);
		expect(later.defaultPrevented).toBe(false);
	});

	it('stops on its Stop button, which starts no stroke on the canvas under it', async () => {
		waiting();
		const fake = createFake({ picture: filled(RED) });
		const pressed = vi.fn();
		fake.host.addEventListener('pointerdown', pressed);
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await asked();
		const stop = progressIn(fake.host)?.querySelector('button');
		expect(stop?.textContent).toBe(t('selection.fill.stop'));
		stop?.dispatchEvent(new Event('pointerdown', { bubbles: true }));
		expect(pressed).not.toHaveBeenCalled();
		stop?.click();
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('selection.fill.stopped')]);
	});

	it('stops when the layer changes under it, an undo among them, since what it made is of the old pixels', async () => {
		const fake = createFake({ picture: filled(RED) });
		fillAreaWith(fake.context, spec({ contents: 'color', color: '#ffffff' }));
		await fake.document.settle();
		const release = waiting();
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await asked();
		fake.document.undo();
		release.current(new Uint8ClampedArray(40 * 30 * 4));
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.fill']);
		expect(fake.notices).toEqual([t('selection.fill.changed')]);
		expect(fake.at(IN)).toEqual([...RED]);
	});

	it('says so when the engine fails, and writes nothing', async () => {
		engine.inpaint.mockRejectedValue(new Error('out of memory'));
		const fake = createFake({ picture: filled(RED) });
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('selection.fill.failed')]);
		expect(progressIn(fake.host)).toBeNull();
	});

	it('says so when what the engine made is not the picture’s size', async () => {
		engine.inpaint.mockResolvedValue(new Uint8ClampedArray(4));
		const fake = createFake({ picture: filled(RED) });
		fillAreaWith(fake.context, spec({ contents: 'contentAware' }));
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('selection.fill.failed')]);
	});

	it('asks nothing of the engine at no opacity, or on a picture that will not decode', async () => {
		const none = createFake({ picture: filled(RED) });
		fillAreaWith(none.context, spec({ contents: 'contentAware', opacity: 0 }));
		const broken = createFake({ picture: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' });
		fillAreaWith(broken.context, spec({ contents: 'contentAware' }));
		await Promise.all([none.document.settle(), broken.document.settle()]);
		expect(engine.inpaint).not.toHaveBeenCalled();
		expect(broken.notices).toEqual([t('raster.unreadable')]);
		expect(progressIn(broken.host)).toBeNull();
	});
});
