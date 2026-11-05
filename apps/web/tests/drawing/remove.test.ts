import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import type { Pixels } from '../../src/drawing/inpaint/index.js';
import { rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import type { Rgba } from '../../src/drawing/tools/raster/pixels.js';
import { removeBehavior } from '../../src/drawing/tools/raster/remove.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
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
 * The Remove tool on a raster layer (docs/decisions/0004-the-interface.md):
 * a stroke of a round, hard brush over what goes, shown live on the screen
 * canvas, and made again from the rest of the layer when it ends, by one
 * command undone to the bytes. Against a real document and the compositing
 * fake canvas (`fakeCanvas.ts`), which samples each pixel at its center, so
 * the footprint is the pixels whose centers the swept disk covers. The
 * content-aware engine is a double whose answer each test sets, as in
 * `areaFill.test.ts`, so what is checked is the hole it is given and what is
 * done with what it makes. The layer's `transform` is read through the SVG
 * DOM, which jsdom has not, so `space.ts` is a double here that scales the
 * layer when a test asks. What this cannot show is a real canvas's
 * anti-aliased edge, how the highlight looks, or the engine itself.
 */

const engine = vi.hoisted(() => ({
	inpaint:
		vi.fn<
			(image: Pixels, mask: Uint8Array, signal?: AbortSignal) => Promise<Uint8ClampedArray>
		>(),
}));
vi.mock('../../src/drawing/inpaint/index.js', () => ({ inpaint: engine.inpaint }));

/** How much larger the layer's `transform` makes it, read by the double of `space.ts`. */
const space = vi.hoisted(() => ({ scale: 1 }));
vi.mock('../../src/drawing/tools/raster/space.js', () => ({
	toLocal: (_layer: unknown, _root: unknown, x: number, y: number) => [
		x / space.scale,
		y / space.scale,
	],
	moveInParent: (_layer: unknown, _root: unknown, dx: number, dy: number) => [dx, dy],
}));

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The whole canvas, 40 × 30. */
const WHOLE = 'x="0" y="0" width="40" height="30"';

/** The canvas is 40 × 30; `layer-2` is a raster layer with a picture where `image` says. */
const drawingText = (picture: string, layerAttributes = '', image = WHOLE): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster"${layerAttributes}><image href="${picture}" ${image} preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

const RED: Rgba = [255, 0, 0, 255];
const GREEN: Rgba = [0, 255, 0, 255];
const CLEAR = [0, 0, 0, 0];

/** The highlight, `#ff2d95`, opaque on the screen canvas, which is made half transparent. */
const HIGHLIGHT = [255, 45, 149, 255];

/** A square from (10, 5) to (30, 25), as the marquee writes it. */
const SQUARE = 'M 10 5 L 30 5 L 30 25 L 10 25 Z';

const noop = (): undefined => undefined;

const filled = (rgba: Rgba, width = 40, height = 30): string =>
	registerPicture(width, height, () => rgba);

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	host: HTMLElement;
	overlay: SVGSVGElement;
	screen: HTMLCanvasElement;
	at: (point: readonly [number, number]) => number[];
	markup: () => string;
}>;

type Setup = Readonly<{
	picture?: string;
	layerAttributes?: string;
	image?: string;
	region?: Region;
	options?: Partial<ToolOptions>;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const opened = openDocument(
		drawingText(setup.picture ?? filled(RED), setup.layerAttributes, setup.image)
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
	const overlay = document.createElementNS(SVG_NAMESPACE, 'svg');
	// The screen canvas the canvas's size, one of its pixels a user unit.
	const screen = document.createElement('canvas');
	screen.width = 40;
	screen.height = 30;
	const region = setup.region;
	const context: ToolContext = {
		document: editor,
		layer: editor.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, size: 6, ...setup.options },
		overlay,
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: { path: region?.path, region, set: noop, update: noop },
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
		overlay,
		screen,
		at: ([x, y]) => pictureAt(href(), x, y),
		markup: () => new XMLSerializer().serializeToString(editor.root),
	};
};

const sampleAt = (
	x: number,
	y: number,
	pointerType: PointerSample['pointerType'] = 'mouse'
): PointerSample => ({
	x,
	y,
	pressure: 0.5,
	tiltX: 0,
	tiltY: 0,
	pointerType,
	time: 0,
	shiftKey: false,
	altKey: false,
	primaryKey: false,
});

/** A stroke through `points`, begun at the first and ended at the last; one point is a click. */
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

/** An engine that makes the hole `rgba` and keeps the rest. */
const makesHole =
	(rgba: Rgba) =>
	(image: Pixels, mask: Uint8Array): Promise<Uint8ClampedArray> =>
		Promise.resolve(
			new Uint8ClampedArray(image.data).map((value, i) =>
				(mask[Math.floor(i / 4)] ?? 0) > 0 ? (rgba[i % 4] ?? 0) : value
			)
		);

/** An engine that waits until it is let go, making the hole green then, or is aborted, as the real one is. */
const waiting = () => {
	const release = { current: noop as () => void };
	engine.inpaint.mockImplementation(
		(image, mask, signal) =>
			new Promise((resolve, reject) => {
				release.current = () => {
					void makesHole(GREEN)(image, mask).then(resolve);
				};
				signal?.addEventListener('abort', () =>
					reject(new DOMException('Remove was stopped.', 'AbortError'))
				);
			})
	);
	return release;
};

/** Until the engine has been asked `times`, which is after the picture decoded. */
const asked = async (times = 1): Promise<void> => {
	await vi.waitFor(() => expect(engine.inpaint).toHaveBeenCalledTimes(times));
};

/** Whether the hole the engine was given, on a layer `width` pixels across, holds a pixel. */
const holeOf =
	(call = 0, width = 40) =>
	(x: number, y: number): number | undefined =>
		engine.inpaint.mock.calls[call]?.[1][y * width + x];

const progressIn = (host: HTMLElement) => host.querySelector('.fill-progress');

/** The brush's outline's parts, the tool's pointer (`tools/common/brushOutline.ts`). */
const outlineIn = (overlay: SVGSVGElement) =>
	Array.from(overlay.querySelector('[data-brush-outline]')?.children ?? []);

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
	engine.inpaint.mockReset();
	space.scale = 1;
});
afterEach(() => {
	// A test that failed with the engine still at work leaves it stopped, so the next test may stroke.
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
	uninstallFakeCanvas();
	document.body.replaceChildren();
});

describe('the Remove tool', () => {
	it('is the raster layer’s Remove', () => {
		expect(rasterBehaviors.remove).toBeDefined();
	});

	it('makes the stroke’s footprint again from the rest of the layer, by one command undone to the bytes', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		const before = fake.markup();
		stroke(removeBehavior(), fake.context, [
			[10, 15],
			[20, 15],
			[30, 15],
		]);
		await fake.document.settle();
		expect(engine.inpaint).toHaveBeenCalledTimes(1);
		const [image, , signal] = engine.inpaint.mock.calls[0] ?? [];
		expect(image?.width).toBe(40);
		expect(image?.height).toBe(30);
		expect(Array.from(image?.data.subarray(0, 4) ?? [])).toEqual([...RED]);
		expect(signal).toBeInstanceOf(AbortSignal);
		// A disk 6 across dragged from (10, 15) to (30, 15): every pixel whose center it covers.
		const hole = holeOf();
		expect([hole(7, 15), hole(20, 12), hole(20, 17), hole(32, 15)]).toEqual([1, 1, 1, 1]);
		expect([hole(6, 15), hole(20, 11), hole(20, 18), hole(33, 15)]).toEqual([0, 0, 0, 0]);
		expect(fake.labels).toEqual(['remove.command']);
		expect(t('remove.command')).toBe('Remove');
		expect(fake.at([20, 15])).toEqual([...GREEN]);
		expect(fake.at([20, 5])).toEqual([...RED]);
		const after = fake.markup();
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('joins its samples, so a fast stroke has no gap', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		stroke(removeBehavior(), fake.context, [
			[5, 5],
			[35, 25],
		]);
		await fake.document.settle();
		const hole = holeOf();
		// On the line from (5, 5) to (35, 25), between the two samples, and off it.
		[
			[11, 9],
			[17, 13],
			[20, 15],
			[26, 19],
			[31, 22],
		].forEach(([x = 0, y = 0]) => expect(hole(x, y)).toBe(1));
		expect(hole(20, 22)).toBe(0);
		expect(hole(26, 10)).toBe(0);
	});

	it('makes a click without moving one dab', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		stroke(removeBehavior(), fake.context, [[20, 15]]);
		await fake.document.settle();
		const hole = holeOf();
		expect([hole(20, 15), hole(22, 15), hole(17, 15), hole(20, 12), hole(20, 17)]).toEqual([
			1, 1, 1, 1, 1,
		]);
		expect([hole(23, 15), hole(16, 15), hole(20, 11), hole(20, 18)]).toEqual([0, 0, 0, 0]);
		expect(fake.labels).toEqual(['remove.command']);
	});

	it('lands in the layer’s own pixels, through its place and its transform', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		// A picture of 20 × 20 placed at (10, 5): its pixel (0, 0) is the canvas's (10, 5).
		const placed = createFake({
			picture: filled(RED, 20, 20),
			image: 'x="10" y="5" width="20" height="20"',
		});
		stroke(removeBehavior(), placed.context, [[20, 15]]);
		await placed.document.settle();
		const inPlace = holeOf(0, 20);
		expect(engine.inpaint.mock.calls[0]?.[1]).toHaveLength(400);
		expect([inPlace(10, 10), inPlace(12, 10), inPlace(13, 10)]).toEqual([1, 1, 0]);

		// Scaled by 2, a unit of the canvas is half a pixel: the disk is 3 pixels across.
		space.scale = 2;
		const scaled = createFake();
		stroke(removeBehavior(), scaled.context, [[40, 30]]);
		await scaled.document.settle();
		const halved = holeOf(1);
		expect([halved(19, 14), halved(20, 15), halved(19, 15)]).toEqual([1, 1, 1]);
		expect([halved(21, 15), halved(18, 15), halved(20, 17)]).toEqual([0, 0, 0]);
	});

	it('writes nothing where what was made is what was there', async () => {
		engine.inpaint.mockImplementation((image) =>
			Promise.resolve(new Uint8ClampedArray(image.data))
		);
		const fake = createFake();
		stroke(removeBehavior(), fake.context, [[20, 15]]);
		await fake.document.settle();
		expect(engine.inpaint).toHaveBeenCalledTimes(1);
		expect(fake.labels).toEqual([]);
	});
});

describe('what the Remove tool shows', () => {
	it('shows the footprint live on the screen canvas, translucent, until the result lands', async () => {
		const release = waiting();
		const fake = createFake();
		const behavior = removeBehavior();
		const screen = fakeOf(fake.screen);
		behavior.begin(fake.context, sampleAt(10, 15));
		expect(screen.at(10, 15)).toEqual(HIGHLIGHT);
		expect(screen.at(20, 15)).toEqual(CLEAR);
		behavior.move(fake.context, sampleAt(30, 15));
		expect(screen.at(20, 15)).toEqual(HIGHLIGHT);
		expect(screen.at(20, 12)).toEqual(HIGHLIGHT);
		expect(screen.at(20, 19)).toEqual(CLEAR);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('0.5');
		behavior.end(fake.context, sampleAt(30, 15));
		await asked();
		expect(screen.at(20, 15)).toEqual(HIGHLIGHT);
		release.current();
		await fake.document.settle();
		expect(screen.at(20, 15)).toEqual(CLEAR);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('');
		expect(fake.at([20, 15])).toEqual([...GREEN]);
	});

	it('has the brush’s outline as its pointer, the brush’s size, following the strip', () => {
		const fake = createFake();
		const behavior = removeBehavior();
		behavior.hover?.(fake.context, sampleAt(12, 8));
		const circles = outlineIn(fake.overlay).filter((part) => part.localName === 'circle');
		expect(circles).toHaveLength(2);
		circles.forEach((circle) => {
			expect([circle.getAttribute('cx'), circle.getAttribute('cy')]).toEqual(['12', '8']);
			expect(circle.getAttribute('r')).toBe('3');
		});
		behavior.optionsChanged?.({
			...fake.context,
			options: { ...fake.context.options, size: 10 },
		});
		outlineIn(fake.overlay)
			.filter((part) => part.localName === 'circle')
			.forEach((circle) => expect(circle.getAttribute('r')).toBe('5'));
		behavior.leave?.(fake.context);
		expect(outlineIn(fake.overlay)).toEqual([]);
	});

	it('moves the outline with a pen’s stroke, and shows none for a finger', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		const behavior = removeBehavior();
		behavior.begin(fake.context, sampleAt(10, 15, 'pen'));
		behavior.move(fake.context, sampleAt(18, 15, 'pen'));
		expect(outlineIn(fake.overlay)[0]?.getAttribute('cx')).toBe('18');
		behavior.end(fake.context, sampleAt(18, 15, 'pen'));
		expect(outlineIn(fake.overlay)[0]?.getAttribute('cx')).toBe('18');
		await fake.document.settle();
		behavior.begin(fake.context, sampleAt(10, 15, 'touch'));
		expect(outlineIn(fake.overlay)).toEqual([]);
		behavior.move(fake.context, sampleAt(18, 15, 'touch'));
		behavior.end(fake.context, sampleAt(18, 15, 'touch'));
		expect(outlineIn(fake.overlay)).toEqual([]);
		await fake.document.settle();
	});
});

describe('the Remove tool in an area', () => {
	it('keeps the footprint to the area, and the highlight to its outline', async () => {
		const release = waiting();
		const fake = createFake({ region: { path: SQUARE, inverted: false, feather: 0 } });
		stroke(removeBehavior(), fake.context, [
			[2, 15],
			[38, 15],
		]);
		await asked();
		const screen = fakeOf(fake.screen);
		expect(screen.at(20, 15)).toEqual(HIGHLIGHT);
		expect(screen.at(5, 15)).toEqual(CLEAR);
		const hole = holeOf();
		expect([hole(10, 15), hole(20, 15), hole(29, 15)]).toEqual([1, 1, 1]);
		expect([hole(5, 15), hole(9, 15), hole(30, 15), hole(35, 15)]).toEqual([0, 0, 0, 0]);
		release.current();
		await fake.document.settle();
		expect(fake.at([20, 15])).toEqual([...GREEN]);
		expect(fake.at([5, 15])).toEqual([...RED]);
	});

	it('keeps it outside the outline of an inverse, and fades it over a feather', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const inverse = createFake({ region: { path: SQUARE, inverted: true, feather: 0 } });
		const behavior = removeBehavior();
		behavior.begin(inverse.context, sampleAt(2, 15));
		behavior.move(inverse.context, sampleAt(38, 15));
		const screen = fakeOf(inverse.screen);
		expect(screen.at(5, 15)).toEqual(HIGHLIGHT);
		expect(screen.at(20, 15)).toEqual(CLEAR);
		behavior.end(inverse.context, sampleAt(38, 15));
		await inverse.document.settle();
		const hole = holeOf();
		expect([hole(5, 15), hole(9, 15), hole(30, 15), hole(35, 15)]).toEqual([1, 1, 1, 1]);
		expect([hole(10, 15), hole(20, 15)]).toEqual([0, 0]);
		expect(inverse.at([20, 15])).toEqual([...RED]);
		expect(inverse.at([5, 15])).toEqual([...GREEN]);

		const feathered = createFake({ region: { path: SQUARE, inverted: false, feather: 4 } });
		stroke(removeBehavior(), feathered.context, [
			[2, 15],
			[38, 15],
		]);
		await feathered.document.settle();
		// Past the outline, where the feather still reaches, made again too, and mixed back by it.
		expect(holeOf(1)(8, 15)).toBe(1);
		expect(feathered.at([20, 15])).toEqual([...GREEN]);
		const edge = feathered.at([10, 15]);
		expect(edge[0]).toBeGreaterThan(0);
		expect(edge[1]).toBeGreaterThan(0);
		expect(feathered.at([2, 15])).toEqual([...RED]);
	});

	it('does nothing, and asks nothing of the engine, for a stroke that misses the area or the layer', async () => {
		const outside = createFake({ region: { path: SQUARE, inverted: false, feather: 0 } });
		stroke(removeBehavior(), outside.context, [
			[2, 2],
			[6, 2],
		]);
		const off = createFake();
		stroke(removeBehavior(), off.context, [
			[-20, -20],
			[-10, -20],
		]);
		await Promise.all([outside.document.settle(), off.document.settle()]);
		expect(engine.inpaint).not.toHaveBeenCalled();
		expect(outside.labels).toEqual([]);
		expect(off.labels).toEqual([]);
		expect(outside.notices).toEqual([]);
		expect(progressIn(outside.host)).toBeNull();
		expect(fakeOf(outside.screen).at(4, 2)).toEqual(CLEAR);
		expect(outside.screen.style.getPropertyValue('opacity')).toBe('');
	});
});

describe('when the Remove tool paints nothing', () => {
	it('refuses a locked or a hidden layer, saying why', async () => {
		const locked = createFake({ layerAttributes: ' draw:locked="true"' });
		stroke(removeBehavior(), locked.context, [
			[10, 15],
			[30, 15],
		]);
		const hidden = createFake({ layerAttributes: ' display="none"' });
		stroke(removeBehavior(), hidden.context, [[20, 15]]);
		await Promise.all([locked.document.settle(), hidden.document.settle()]);
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect(hidden.notices).toEqual([t('layers.hidden', { name: 'Layer 2' })]);
		expect(locked.labels).toEqual([]);
		expect(engine.inpaint).not.toHaveBeenCalled();
		expect(fakeOf(locked.screen).at(20, 15)).toEqual(CLEAR);
		expect(locked.screen.style.getPropertyValue('opacity')).toBe('');
	});

	it('leaves nothing of a stroke canceled while it lasts, as Escape cancels it', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		const before = fake.markup();
		const behavior = removeBehavior();
		behavior.begin(fake.context, sampleAt(10, 15));
		behavior.move(fake.context, sampleAt(30, 15));
		behavior.cancel(fake.context);
		await fake.document.settle();
		expect(engine.inpaint).not.toHaveBeenCalled();
		expect(fake.labels).toEqual([]);
		expect(fake.markup()).toBe(before);
		expect(fakeOf(fake.screen).at(20, 15)).toEqual(CLEAR);
		expect(fake.screen.style.getPropertyValue('opacity')).toBe('');
		// The pointer that lifts after a cancel ends nothing, and the next stroke is the tool's.
		behavior.end(fake.context, sampleAt(30, 15));
		stroke(behavior, fake.context, [[20, 15]]);
		await fake.document.settle();
		expect(fake.labels).toEqual(['remove.command']);
	});

	it('says so when the picture will not decode, and asks nothing of the engine', async () => {
		const fake = createFake({ picture: 'data:image/png;base64,bm90IGEgcGljdHVyZQ==' });
		stroke(removeBehavior(), fake.context, [[20, 15]]);
		await fake.document.settle();
		expect(engine.inpaint).not.toHaveBeenCalled();
		expect(fake.notices).toEqual([t('raster.unreadable')]);
		expect(progressIn(fake.host)).toBeNull();
		expect(fakeOf(fake.screen).at(20, 15)).toEqual(CLEAR);
	});
});

describe('while the engine makes the pixels again', () => {
	it('shows its progress in Remove’s words, and a save waits for it', async () => {
		const release = waiting();
		const fake = createFake();
		stroke(removeBehavior(), fake.context, [
			[10, 15],
			[30, 15],
		]);
		const saved = vi.fn();
		void fake.document.settle().then(saved);
		await asked();
		const progress = progressIn(fake.host);
		expect(progress?.getAttribute('role')).toBe('status');
		expect(progress?.textContent).toContain(t('remove.working'));
		expect(progress?.querySelector('button')?.textContent).toBe(t('remove.stop'));
		expect(saved).not.toHaveBeenCalled();
		release.current();
		await vi.waitFor(() => expect(saved).toHaveBeenCalled());
		expect(progressIn(fake.host)).toBeNull();
		expect(fake.labels).toEqual(['remove.command']);
	});

	it('refuses a stroke begun meanwhile, saying so and painting nothing, and takes the next once it is done', async () => {
		const release = waiting();
		const fake = createFake();
		const behavior = removeBehavior();
		stroke(behavior, fake.context, [
			[10, 15],
			[30, 15],
		]);
		await asked();
		stroke(behavior, fake.context, [
			[10, 5],
			[30, 5],
		]);
		expect(fake.notices).toEqual([t('remove.busy')]);
		expect(fakeOf(fake.screen).at(20, 5)).toEqual(CLEAR);
		expect(fakeOf(fake.screen).at(20, 15)).toEqual(HIGHLIGHT);
		release.current();
		await fake.document.settle();
		expect(engine.inpaint).toHaveBeenCalledTimes(1);
		expect(fake.labels).toEqual(['remove.command']);
		expect(fake.at([20, 5])).toEqual([...RED]);

		engine.inpaint.mockImplementation(makesHole(GREEN));
		stroke(behavior, fake.context, [
			[10, 5],
			[30, 5],
		]);
		await fake.document.settle();
		expect(fake.labels).toEqual(['remove.command', 'remove.command']);
		expect(fake.at([20, 5])).toEqual([...GREEN]);
	});

	it('stops on Escape, keeping the key from the canvas, and leaves the layer as it was', async () => {
		waiting();
		const fake = createFake();
		const before = fake.markup();
		stroke(removeBehavior(), fake.context, [
			[10, 15],
			[30, 15],
		]);
		await asked();
		const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
		window.dispatchEvent(escape);
		expect(escape.defaultPrevented).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.markup()).toBe(before);
		expect(fake.notices).toEqual([t('remove.stopped')]);
		expect(progressIn(fake.host)).toBeNull();
		expect(fakeOf(fake.screen).at(20, 15)).toEqual(CLEAR);
	});

	it('stops when the layer changes under it, an undo among them, since what it made is of the old pixels', async () => {
		engine.inpaint.mockImplementation(makesHole(GREEN));
		const fake = createFake();
		const behavior = removeBehavior();
		stroke(behavior, fake.context, [[20, 15]]);
		await fake.document.settle();
		const release = waiting();
		stroke(behavior, fake.context, [[20, 5]]);
		await asked(2);
		fake.document.undo();
		release.current();
		await fake.document.settle();
		expect(fake.labels).toEqual(['remove.command']);
		expect(fake.notices).toEqual([t('remove.changed')]);
		expect(fake.at([20, 15])).toEqual([...RED]);
		expect(fake.at([20, 5])).toEqual([...RED]);
	});

	it('says so when the engine fails, and writes nothing', async () => {
		engine.inpaint.mockRejectedValue(new Error('out of memory'));
		const fake = createFake();
		stroke(removeBehavior(), fake.context, [[20, 15]]);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('remove.failed')]);
		expect(progressIn(fake.host)).toBeNull();
		expect(fakeOf(fake.screen).at(20, 15)).toEqual(CLEAR);
	});
});
