import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renameLayer } from '../../src/drawing/document/commands.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { HOLE_MARK } from '../../src/drawing/tools/raster/hole.js';
import { clearArea, nudgeArea, rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import { surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type Region,
	type ToolBehavior,
	type ToolContext,
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
 * The move tool over an area on a raster layer (docs/ARCHITECTURE.md §7,
 * "Tools"): the area's pixels moved by the drag, by their coverage, with the
 * marching ants, in one command, and afloat while nothing else changes the
 * layer or the area. Against a real document and its real commands, so that
 * undo to the bytes is the document's own, and the compositing fake canvas
 * (`fakeCanvas.ts`), so the pixels each move leaves are read back from the
 * layer's `href`. jsdom has no SVG geometry, so every layer is in the root's
 * units here, one pixel to a unit.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

const RED = [255, 0, 0, 255];
const BLUE = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

/** A square from (5, 5) to (15, 15), as the marquee writes it: in the red half of the picture. */
const SQUARE = 'M 5 5 L 15 5 L 15 15 L 5 15 Z';

/** Red where x < 20, blue elsewhere, over the whole 40 × 30 canvas. */
const halves = (): string =>
	registerPicture(40, 30, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 255, 255]));

/** Red where x < 20, and nothing elsewhere. */
const redLeft = (): string =>
	registerPicture(40, 30, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 0, 0, 0]));

const drawingText = (picture: string, attributes: string): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster" draw:name="Sky"${attributes}><image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/></g>`,
		`  <g id="layer-3" draw:kind="raster" draw:name="Sea"><image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

const noop = (): undefined => undefined;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	/** The area now. */
	region: () => Region | undefined;
	/** The area replaced, as another tool would. */
	setRegion: (region: Region | undefined) => void;
	/** Every outline the area was given, in turn. */
	outlines: string[];
	/** The markup of the whole drawing now, as the DOM has it. */
	markup: () => string;
	hrefOf: (id?: string) => string | null | undefined;
	/** The tools' context, on another layer. */
	on: (id: string) => ToolContext;
}>;

type Setup = Readonly<{
	picture?: string;
	region?: Region | null;
	/** Attributes for `layer-2`. */
	attributes?: string;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const opened = openDocument(drawingText(setup.picture ?? halves(), setup.attributes ?? ''));
	if (opened === undefined) throw new Error('the drawing opens');
	const labels: string[] = [];
	const notices: string[] = [];
	const outlines: string[] = [];
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
	let region: Region | undefined =
		setup.region === null
			? undefined
			: (setup.region ?? { path: SQUARE, inverted: false, feather: 0 });
	const screen = document.createElement('canvas');
	screen.width = 40;
	screen.height = 30;
	const layerOf = (id: string) => editor.snapshot().layers.find((each) => each.id === id);
	const contextOn = (id: string): ToolContext => ({
		document: editor,
		layer: layerOf(id),
		options: DEFAULT_TOOL_OPTIONS,
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
				if (region === undefined) return;
				region = { ...region, ...change };
				if (change.path !== undefined) outlines.push(change.path);
			},
		},
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	});
	const hrefOf = (id = 'layer-2') =>
		Array.from(editor.layer(id)?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return {
		context: contextOn('layer-2'),
		document: editor,
		labels,
		notices,
		region: () => region,
		setRegion: (next) => {
			region = next;
		},
		outlines,
		markup: () => new XMLSerializer().serializeToString(editor.root),
		hrefOf,
		on: contextOn,
	};
};

const at = (x: number, y: number, extra: Partial<PointerSample> = {}): PointerSample => ({
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
	...extra,
});

type Step = Readonly<{ x: number; y: number }> & Partial<PointerSample>;

const select = (): ToolBehavior => {
	const behavior = rasterBehaviors.select;
	if (behavior === undefined) throw new Error('no raster select');
	return behavior;
};

/** A drag with the move tool: begin at the first step, move through the rest, end at the last. */
const drag = (context: ToolContext, steps: readonly Step[]): void => {
	const [first, ...rest] = steps;
	if (first === undefined) return;
	select().begin(context, at(first.x, first.y, first));
	rest.forEach((step) => select().move(context, at(step.x, step.y, step)));
	const last = rest.at(-1) ?? first;
	select().end(context, at(last.x, last.y, last));
};

/** The layer's picture decoded, as it is once any tool has touched it. */
const decoded = async (context: ToolContext): Promise<void> => {
	await surfaceFor(context)?.ready;
};

/** A drag on a decoded layer, landed. */
const moved = async (fake: Fake, steps: readonly Step[], context = fake.context) => {
	await decoded(context);
	drag(context, steps);
	await fake.document.settle();
};

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => installFakeCanvas());
afterEach(uninstallFakeCanvas);

describe('the move tool over an area', () => {
	it('moves the area’s pixels, leaves the place they left transparent, and takes the ants along, by one command', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 14, y: 11 },
			{ x: 20, y: 12 },
		]);
		expect(fake.labels).toEqual(['regions.move']);
		const href = fake.hrefOf();
		expect(pictureAt(href, 10, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 22, 10)).toEqual(RED);
		expect(pictureAt(href, 22, 16)).toEqual(RED);
		expect(pictureAt(href, 22, 18)).toEqual(BLUE);
		expect(pictureAt(href, 17, 6)).toEqual(RED);
		expect(pictureAt(href, 2, 2)).toEqual(RED);
		expect(fake.region()).toEqual({
			path: 'M 15 7 L 25 7 L 25 17 L 15 17 Z',
			inverted: false,
			feather: 0,
		});
		// Live, as the pointer went.
		expect(fake.outlines).toEqual([
			'M 9 6 L 19 6 L 19 16 L 9 16 Z',
			'M 15 7 L 25 7 L 25 17 L 15 17 Z',
		]);
		expect(fake.hrefOf('layer-3')).not.toBe(href);
		expect(fake.document.layer('layer-2')?.getAttribute('transform')).toBeNull();
	});

	it('undoes to the bytes, and redoes to the same', async () => {
		const fake = createFake();
		// A step first, so the undo is not only the history back at its origin.
		fake.document.execute(renameLayer('layer-1', 'Ink'));
		const before = fake.markup();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		const after = fake.markup();
		expect(after).not.toBe(before);
		fake.document.undo();
		expect(fake.markup()).toBe(before);
		fake.document.redo();
		expect(fake.markup()).toBe(after);
	});

	it('moves a feathered edge’s share of each pixel and leaves the rest', async () => {
		const fake = createFake({
			picture: redLeft(),
			region: { path: SQUARE, inverted: false, feather: 4 },
		});
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 30, y: 10 },
		]);
		const href = fake.hrefOf();
		const taken = pictureAt(href, 25, 10)[3] ?? 0;
		const left = pictureAt(href, 5, 10)[3] ?? 0;
		expect(taken).toBeGreaterThan(0);
		expect(left).toBeGreaterThan(0);
		expect(Math.abs(taken + left - 255)).toBeLessThanOrEqual(1);
		// The middle, five units in from an edge feathered by four, nearly all of it.
		expect(pictureAt(href, 30, 10)[3]).toBeGreaterThan(240);
		expect(fake.region()?.feather).toBe(4);
	});

	it('moves a copy with Alt held as the drag begins, and leaves the pixels', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10, altKey: true },
			{ x: 30, y: 10 },
		]);
		const href = fake.hrefOf();
		expect(pictureAt(href, 10, 10)).toEqual(RED);
		expect(pictureAt(href, 30, 10)).toEqual(RED);
		expect(pictureAt(href, 22, 10)).toEqual(BLUE);
		expect(fake.region()?.path).toBe('M 25 5 L 35 5 L 35 15 L 25 15 Z');
	});

	it('holds the move across, down or at 45° with Shift, in whole pixels', async () => {
		const across = createFake();
		await moved(across, [
			{ x: 10, y: 10 },
			{ x: 20.4, y: 13, shiftKey: true },
		]);
		expect(across.region()?.path).toBe('M 15 5 L 25 5 L 25 15 L 15 15 Z');

		const diagonal = createFake();
		await moved(diagonal, [
			{ x: 10, y: 10 },
			{ x: 19, y: 19.6, shiftKey: true },
		]);
		const path = diagonal.region()?.path ?? '';
		const [x = 0, y = 0] = path.split(' ').slice(1, 3).map(Number);
		expect(x - 5).toBe(y - 5);
		expect(Number.isInteger(x)).toBe(true);
		expect(pictureAt(diagonal.hrefOf(), x + 2, y + 2)).toEqual(RED);
	});

	it('moves nothing for a click, or a drag back to where it began', async () => {
		const fake = createFake();
		await moved(fake, [{ x: 10, y: 10 }]);
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 30, y: 10 },
			{ x: 10.3, y: 9.8 },
		]);
		expect(fake.labels).toEqual([]);
		expect(fake.region()?.path).toBe(SQUARE);
		expect(fake.document.layer('layer-2')?.getAttribute('transform')).toBeNull();
	});

	it('moves everything an inverse selects, and keeps it an inverse', async () => {
		const fake = createFake({ region: { path: SQUARE, inverted: true, feather: 0 } });
		await moved(fake, [
			{ x: 30, y: 25 },
			{ x: 35, y: 25 },
		]);
		const href = fake.hrefOf();
		// The strip the move left at the canvas's edge, selected and empty.
		expect(pictureAt(href, 2, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 2, 20)).toEqual(CLEAR);
		// The outline's inside stays where it was.
		expect(pictureAt(href, 10, 10)).toEqual(RED);
		// What moved in from the hole is nothing; what moved from beside it is the picture.
		expect(pictureAt(href, 17, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 22, 10)).toEqual(RED);
		expect(pictureAt(href, 27, 10)).toEqual(BLUE);
		expect(pictureAt(href, 7, 20)).toEqual(RED);
		expect(fake.region()).toEqual({
			path: 'M 10 5 L 20 5 L 20 15 L 10 15 Z',
			inverted: true,
			feather: 0,
		});
	});
});

describe('the pixels afloat', () => {
	/** Two moves right, of ten each: the second over the place the first covered. */
	const twice = async (fake: Fake, between: () => void | Promise<void> = noop) => {
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		await between();
		await moved(fake, [
			{ x: 20, y: 10 },
			{ x: 30, y: 10 },
		]);
	};

	it('give back what they covered when they move on, from what lay beneath them', async () => {
		const fake = createFake();
		await twice(fake);
		const href = fake.hrefOf();
		expect(pictureAt(href, 22, 10)).toEqual(BLUE);
		expect(pictureAt(href, 17, 10)).toEqual(RED);
		expect(pictureAt(href, 10, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 30, 10)).toEqual(RED);
		expect(fake.labels).toEqual(['regions.move', 'regions.move']);
		expect(fake.region()?.path).toBe('M 25 5 L 35 5 L 35 15 L 25 15 Z');
	});

	it('are written to the file after every drag, which undoes one drag at a time', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		const first = fake.markup();
		await moved(fake, [
			{ x: 20, y: 10 },
			{ x: 30, y: 10 },
		]);
		fake.document.undo();
		expect(fake.markup()).toBe(first);
	});

	it('are the pixels as they were when moved back to where they were lifted', async () => {
		const fake = createFake({ region: { path: SQUARE, inverted: false, feather: 3 } });
		const original = fake.hrefOf();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 30, y: 10 },
		]);
		await moved(fake, [
			{ x: 30, y: 10 },
			{ x: 10, y: 10 },
		]);
		const href = fake.hrefOf();
		[
			[4, 10],
			[5, 10],
			[6, 10],
			[10, 10],
			[14, 14],
			[15, 15],
			[25, 10],
		].forEach(([x = 0, y = 0]) => {
			const now = pictureAt(href, x, y);
			pictureAt(original, x, y).forEach((value, channel) =>
				expect(Math.abs((now[channel] ?? 0) - value)).toBeLessThanOrEqual(1)
			);
		});
		expect(fake.region()?.path).toBe(SQUARE);
	});

	it('end when another tool replaces the area, even by the same outline', async () => {
		const fake = createFake();
		await twice(fake, () => {
			const now = fake.region();
			if (now !== undefined) fake.setRegion({ ...now });
		});
		const href = fake.hrefOf();
		expect(pictureAt(href, 22, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 17, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 30, 10)).toEqual(RED);
	});

	it('end with an undo, and the next drag takes up the pixels the file has', async () => {
		const fake = createFake();
		await twice(fake, () => fake.document.undo());
		const href = fake.hrefOf();
		// The undo put the square back; the ants stayed where the move took them.
		expect(pictureAt(href, 10, 10)).toEqual(RED);
		expect(pictureAt(href, 17, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 22, 10)).toEqual(CLEAR);
		expect(pictureAt(href, 27, 10)).toEqual(RED);
		expect(pictureAt(href, 32, 10)).toEqual(BLUE);
	});

	it('end with another tool’s write to the layer', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		expect(clearArea(fake.context)).toBe(true);
		await fake.document.settle();
		await moved(fake, [
			{ x: 20, y: 10 },
			{ x: 30, y: 10 },
		]);
		expect(fake.notices).toEqual([t('regions.empty', { name: 'Sky' })]);
		expect(fake.labels).toEqual(['regions.move', 'regions.clear']);
	});

	it('end when another layer is moved on', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		await moved(
			fake,
			[
				{ x: 10, y: 10 },
				{ x: 10, y: 20 },
			],
			fake.on('layer-3')
		);
		await moved(fake, [
			{ x: 10, y: 20 },
			{ x: 20, y: 20 },
		]);
		const href = fake.hrefOf();
		expect(pictureAt(href, 22, 10)).toEqual(RED);
		expect(pictureAt(href, 22, 18)).toEqual(CLEAR);
		expect(fake.labels).toEqual(['regions.move', 'regions.move', 'regions.move']);
	});

	it('are taken up afresh by Alt, which leaves a copy where they were', async () => {
		const fake = createFake();
		await twice(fake);
		await moved(fake, [
			{ x: 30, y: 10, altKey: true },
			{ x: 30, y: 25 },
		]);
		const href = fake.hrefOf();
		expect(pictureAt(href, 30, 10)).toEqual(RED);
		expect(pictureAt(href, 30, 22)).toEqual(RED);
	});
});

describe('what the move tool over an area does not do', () => {
	it('moves the layer as before with no area, or one that misses the layer', async () => {
		const none = createFake({ region: null });
		await moved(none, [
			{ x: 10, y: 10 },
			{ x: 20, y: 15 },
		]);
		expect(none.labels).toEqual(['tools.select']);
		expect(none.document.layer('layer-2')?.getAttribute('transform')).toBe('translate(10 5)');

		const away = createFake({
			region: {
				path: 'M 100 100 L 120 100 L 120 120 L 100 120 Z',
				inverted: false,
				feather: 0,
			},
		});
		await moved(away, [
			{ x: 10, y: 10 },
			{ x: 20, y: 15 },
		]);
		expect(away.labels).toEqual(['tools.select']);
		expect(away.region()?.path).toBe('M 100 100 L 120 100 L 120 120 L 100 120 Z');
	});

	it('says so for an area that holds no color, and moves nothing', async () => {
		const fake = createFake({
			picture: redLeft(),
			region: { path: 'M 25 5 L 35 5 L 35 15 L 25 15 Z', inverted: false, feather: 0 },
		});
		await moved(fake, [
			{ x: 30, y: 10 },
			{ x: 35, y: 10 },
		]);
		expect(fake.notices).toEqual([t('regions.empty', { name: 'Sky' })]);
		expect(fake.labels).toEqual([]);
		expect(fake.region()?.path).toBe('M 25 5 L 35 5 L 35 15 L 25 15 Z');
		expect(fake.document.layer('layer-2')?.getAttribute('transform')).toBeNull();
	});

	it.each([
		['locked', ' draw:locked="true"', 'layers.locked'],
		['hidden', ' display="none"', 'layers.hidden'],
	] as const)('says so on a %s layer, and moves nothing', async (_, attributes, key) => {
		const fake = createFake({ attributes });
		drag(fake.context, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		await fake.document.settle();
		expect(fake.notices).toEqual([t(key, { name: 'Sky' })]);
		expect(fake.labels).toEqual([]);
		expect(fake.region()?.path).toBe(SQUARE);
	});

	it('puts the pixels, the ants and the screen back when canceled, and writes nothing', async () => {
		const fake = createFake();
		await decoded(fake.context);
		const before = fake.markup();
		select().begin(fake.context, at(10, 10));
		select().move(fake.context, at(20, 10));
		expect(fake.region()?.path).toBe('M 15 5 L 25 5 L 25 15 L 15 15 Z');
		select().cancel(fake.context);
		select().end(fake.context, at(20, 10));
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.region()?.path).toBe(SQUARE);
		expect(fake.markup()).toBe(before);
		expect(fakeOf(fake.context.screen.canvas).at(20, 10)).toEqual(CLEAR);
	});

	it('writes nothing where an undo moved the picture while it was encoded, and says so', async () => {
		const fake = createFake();
		await decoded(fake.context);
		drag(fake.context, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		// The move is encoding; the picture is put back by hand, as an undo would.
		fake.document
			.layer('layer-2')
			?.querySelector('image')
			?.setAttribute(
				'href',
				registerPicture(40, 30, () => [0, 0, 255, 255])
			);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		expect(fake.notices).toEqual([t('raster.failed')]);
		// The ants go back to where the pixels still are.
		expect(fake.region()?.path).toBe(SQUARE);
	});

	it('moves the pixels of a picture still decoding as the drag ends', async () => {
		const fake = createFake();
		drag(fake.context, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.move']);
		expect(pictureAt(fake.hrefOf(), 10, 10)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf(), 22, 10)).toEqual(RED);
	});
});

describe('the move’s live preview', () => {
	it('shows the pixels on the screen canvas where the drag has them, at the layer’s opacity, until they land', async () => {
		const fake = createFake({ attributes: ' opacity="0.5"' });
		await decoded(fake.context);
		const screen = fakeOf(fake.context.screen.canvas);
		select().begin(fake.context, at(10, 10));
		select().move(fake.context, at(20, 10));
		expect(screen.at(22, 10)).toEqual(RED);
		expect(screen.at(10, 10)).toEqual(CLEAR);
		expect(fake.context.screen.canvas.style.getPropertyValue('opacity')).toBe('0.5');
		select().move(fake.context, at(25, 10));
		expect(screen.at(17, 10)).toEqual(CLEAR);
		expect(screen.at(27, 10)).toEqual(RED);
		select().end(fake.context, at(25, 10));
		expect(screen.at(27, 10)).toEqual(RED);
		await fake.document.settle();
		expect(screen.at(27, 10)).toEqual(CLEAR);
		expect(fake.context.screen.canvas.style.getPropertyValue('opacity')).toBe('');
	});

	it('clears what a drag still landing left on the screen as the next one shows its own', async () => {
		const fake = createFake({ picture: redLeft() });
		await decoded(fake.context);
		const screen = fakeOf(fake.context.screen.canvas);
		drag(fake.context, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		expect(screen.at(22, 6)).toEqual(RED);
		// Afloat at once, before the first has landed.
		select().begin(fake.context, at(20, 10));
		select().move(fake.context, at(20, 13));
		expect(screen.at(22, 6)).toEqual(CLEAR);
		expect(screen.at(22, 16)).toEqual(RED);
		select().end(fake.context, at(20, 13));
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.move', 'regions.move']);
		expect(pictureAt(fake.hrefOf(), 22, 6)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf(), 22, 16)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 10, 10)).toEqual(CLEAR);
		expect(screen.at(22, 16)).toEqual(CLEAR);
	});

	it('shows the pixels once a picture still decoding as the drag began can be read', async () => {
		const fake = createFake();
		const screen = fakeOf(fake.context.screen.canvas);
		select().begin(fake.context, at(10, 10));
		select().move(fake.context, at(20, 10));
		expect(screen.at(22, 10)).toEqual(CLEAR);
		await tick();
		expect(screen.at(22, 10)).toEqual(RED);
		select().end(fake.context, at(20, 10));
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.move']);
	});

	it('shows the hole through a mask beside the drawing, which the file never holds', async () => {
		const fake = createFake();
		const host = document.createElement('div');
		const shadow = host.attachShadow({ mode: 'open' });
		shadow.appendChild(fake.document.root);
		const made = vi.spyOn(URL, 'createObjectURL');
		const revoked = vi.spyOn(URL, 'revokeObjectURL');
		await decoded(fake.context);
		select().begin(fake.context, at(10, 10));
		select().move(fake.context, at(20, 10));
		await tick();
		const hole = shadow.querySelector(`[${HOLE_MARK}]`);
		expect(hole?.nextSibling).toBe(fake.document.root);
		expect(hole?.querySelector('style')?.textContent).toMatch(
			/^\[id="layer-2"\] > image \{ mask: url\(#draw-move-hole-\d+\) !important; \}$/
		);
		const image = hole?.querySelector('mask image');
		const url = made.mock.results[0]?.value as string;
		expect(image?.getAttribute('href')).toBe(url);
		expect(['x', 'y', 'width', 'height'].map((name) => image?.getAttribute(name))).toEqual([
			'5',
			'5',
			'10',
			'10',
		]);
		expect(fake.markup()).not.toMatch(/blob:|draw-move-hole|mask/);
		select().end(fake.context, at(20, 10));
		await fake.document.settle();
		expect(shadow.querySelector(`[${HOLE_MARK}]`)).toBeNull();
		expect(revoked).toHaveBeenCalledWith(url);
		expect(fake.markup()).not.toMatch(/blob:|draw-move-hole/);
	});

	it('shows no hole for a copy, and takes a hole away when canceled', async () => {
		const fake = createFake();
		const shadow = document.createElement('div').attachShadow({ mode: 'open' });
		shadow.appendChild(fake.document.root);
		await decoded(fake.context);
		select().begin(fake.context, at(10, 10, { altKey: true }));
		select().move(fake.context, at(20, 10));
		await tick();
		expect(shadow.querySelector(`[${HOLE_MARK}]`)).toBeNull();
		select().cancel(fake.context);

		select().begin(fake.context, at(10, 10));
		select().move(fake.context, at(20, 10));
		await tick();
		expect(shadow.querySelector(`[${HOLE_MARK}]`)).not.toBeNull();
		select().cancel(fake.context);
		expect(shadow.querySelector(`[${HOLE_MARK}]`)).toBeNull();
	});
});

describe('the arrow keys’ nudge', () => {
	/** The x of the area's left edge now. */
	const leftOf = (fake: Fake): number => Number(fake.region()?.path.split(' ')[1]);

	it('moves the area’s pixels by the layer’s pixels it is given, with the ants, by one command each', async () => {
		const fake = createFake();
		await decoded(fake.context);
		expect(nudgeArea(fake.context, 1, 0)).toBe(true);
		await fake.document.settle();
		expect(fake.region()?.path).toBe('M 6 5 L 16 5 L 16 15 L 6 15 Z');
		expect(pictureAt(fake.hrefOf(), 5, 10)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf(), 15, 10)).toEqual(RED);
		expect(nudgeArea(fake.context, 0, 10)).toBe(true);
		await fake.document.settle();
		expect(fake.region()?.path).toBe('M 6 15 L 16 15 L 16 25 L 6 25 Z');
		expect(pictureAt(fake.hrefOf(), 10, 20)).toEqual(RED);
		expect(fake.labels).toEqual(['regions.move', 'regions.move']);
	});

	it('moves by the layer’s pixels whatever the zoom', async () => {
		const fake = createFake();
		const zoomed: ToolContext = {
			...fake.context,
			viewport: { ...fake.context.viewport, scale: 8 },
		};
		await decoded(zoomed);
		nudgeArea(zoomed, -1, 0);
		await fake.document.settle();
		expect(fake.region()?.path).toBe('M 4 5 L 14 5 L 14 15 L 4 15 Z');
	});

	it('shares the float with the drags, so what the pixels covered comes back', async () => {
		const fake = createFake();
		await moved(fake, [
			{ x: 10, y: 10 },
			{ x: 20, y: 10 },
		]);
		nudgeArea(fake.context, 10, 0);
		await fake.document.settle();
		expect(pictureAt(fake.hrefOf(), 22, 10)).toEqual(BLUE);
		expect(pictureAt(fake.hrefOf(), 30, 10)).toEqual(RED);
		// And a drag after the nudges goes on from where they left the pixels.
		nudgeArea(fake.context, 0, 10);
		await moved(fake, [
			{ x: 30, y: 20 },
			{ x: 30, y: 10 },
		]);
		expect(pictureAt(fake.hrefOf(), 30, 10)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 30, 18)).toEqual(BLUE);
		expect(fake.region()?.path).toBe('M 25 5 L 35 5 L 35 15 L 25 15 Z');
	});

	it('lands a burst in the order it was made, whichever encoding finishes first, and undoes a nudge at a time', async () => {
		const fake = createFake();
		await decoded(fake.context);
		// The fake's own spy, given back by a second `spyOn`.
		const toBlob = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob');
		const encode = toBlob.getMockImplementation();
		const delays = [40, 30, 20, 10, 0];
		toBlob.mockImplementation((callback, ...rest) => {
			const delay = delays.shift() ?? 0;
			encode?.((blob) => setTimeout(() => callback(blob), delay), ...rest);
		});
		const before = fake.markup();
		const steps = [1, 2, 3, 4, 5].map(() => nudgeArea(fake.context, 1, 0));
		expect(steps).toEqual([true, true, true, true, true]);
		expect(leftOf(fake)).toBe(10);
		await fake.document.settle();
		expect(fake.labels).toEqual(Array.from({ length: 5 }, () => 'regions.move'));
		expect(pictureAt(fake.hrefOf(), 14, 10)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 19, 10)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 9, 10)).toEqual(CLEAR);
		fake.document.undo();
		expect(pictureAt(fake.hrefOf(), 19, 10)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 9, 10)).toEqual(RED);
		expect(pictureAt(fake.hrefOf(), 8, 10)).toEqual(CLEAR);
		[1, 2, 3, 4].forEach(() => fake.document.undo());
		expect(fake.markup()).toBe(before);
	});

	it('moves the pixels of a picture still decoding, in turn', async () => {
		const fake = createFake();
		nudgeArea(fake.context, 1, 0);
		nudgeArea(fake.context, 1, 0);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.move', 'regions.move']);
		expect(leftOf(fake)).toBe(7);
		expect(pictureAt(fake.hrefOf(), 6, 10)).toEqual(CLEAR);
		expect(pictureAt(fake.hrefOf(), 16, 10)).toEqual(RED);
	});

	it('is not the area’s with no area, on a vector layer, or with an area that misses the layer', async () => {
		const none = createFake({ region: null });
		expect(nudgeArea(none.context, 1, 0)).toBe(false);
		const vector = createFake();
		expect(nudgeArea(vector.on('layer-1'), 1, 0)).toBe(false);
		const away = createFake({
			region: {
				path: 'M 100 100 L 120 100 L 120 120 L 100 120 Z',
				inverted: false,
				feather: 0,
			},
		});
		expect(nudgeArea(away.context, 1, 0)).toBe(false);
		await Promise.all([none, vector, away].map((fake) => fake.document.settle()));
		[none, vector, away].forEach((fake) => {
			expect(fake.labels).toEqual([]);
			expect(fake.notices).toEqual([]);
		});
	});

	it.each([
		['locked', ' draw:locked="true"', 'layers.locked'],
		['hidden', ' display="none"', 'layers.hidden'],
	] as const)(
		'is the area’s on a %s layer, says so, and moves nothing',
		async (_, attributes, key) => {
			const fake = createFake({ attributes });
			expect(nudgeArea(fake.context, 1, 0)).toBe(true);
			await fake.document.settle();
			expect(fake.notices).toEqual([t(key, { name: 'Sky' })]);
			expect(fake.labels).toEqual([]);
			expect(fake.region()?.path).toBe(SQUARE);
		}
	);

	it('is the area’s for one that holds no color, which it says, and during a drag, when it does nothing', async () => {
		const empty = createFake({
			picture: redLeft(),
			region: { path: 'M 25 5 L 35 5 L 35 15 L 25 15 Z', inverted: false, feather: 0 },
		});
		await decoded(empty.context);
		expect(nudgeArea(empty.context, 1, 0)).toBe(true);
		expect(empty.notices).toEqual([t('regions.empty', { name: 'Sky' })]);

		const dragging = createFake();
		await decoded(dragging.context);
		select().begin(dragging.context, at(10, 10));
		expect(nudgeArea(dragging.context, 1, 0)).toBe(true);
		select().cancel(dragging.context);
		await dragging.document.settle();
		expect(dragging.labels).toEqual([]);
		expect(dragging.region()?.path).toBe(SQUARE);
	});
});
