import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
import type { Rgba } from '../../src/drawing/tools/raster/pixels.js';
import {
	DEFAULT_TOOL_OPTIONS,
	type PointerSample,
	type ToolBehavior,
	type ToolContext,
	type ToolId,
	type ToolOptions,
} from '../../src/drawing/tools/types.js';
import {
	fakeOf,
	installFakeCanvas,
	pictureAt,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * What a raster tool with a size paints on a layer its `transform` scales
 * (docs/ARCHITECTURE.md §7, "Tools"): the size is in the drawing's user
 * units, as the brush's outline shows it (`tools/common/brushOutline.ts`),
 * so on a layer drawn twice as large a dab covers half as many of the
 * layer's own pixels, and what lands is as big on the screen as the outline
 * and the live stroke were. Against a real document and the compositing fake
 * canvas (`fakeCanvas.ts`), which samples each pixel at its center. The
 * layer's `transform` is read through the SVG DOM, which jsdom has not, so
 * `space.ts` is a double that scales the layer by `space.scale`, as in
 * `remove.test.ts`. What this cannot show is a turned or a skewed layer,
 * whose disk is an ellipse on its pixels: the fake reads a transform for a
 * point and a scale, not for a turn.
 */

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

/**
 * The canvas is 80 × 60; `layer-2` is a raster layer whose picture is 40 × 30
 * of its own units, one pixel a unit, drawn twice as large by its transform.
 */
const drawingText = (picture: string): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 80 60" width="80" height="60">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster" transform="scale(2)"><image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/></g>`,
		'</svg>',
		'',
	].join('\n');

const RED: Rgba = [255, 0, 0, 255];
const BLUE: Rgba = [0, 0, 255, 255];
const CLEAR = [0, 0, 0, 0];

const noop = (): undefined => undefined;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	/** A pixel of the layer's picture as written, `[r, g, b, a]`. */
	at: (x: number, y: number) => number[];
}>;

const createFake = (picture: string, options: Partial<ToolOptions> = {}): Fake => {
	const opened = openDocument(drawingText(picture));
	if (opened === undefined) throw new Error('the drawing opens');
	const screen = document.createElement('canvas');
	screen.width = 80;
	screen.height = 60;
	const context: ToolContext = {
		document: opened,
		layer: opened.snapshot().layers.find((each) => each.id === 'layer-2'),
		options: { ...DEFAULT_TOOL_OPTIONS, ...options },
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: { path: undefined, region: undefined, set: noop, update: noop },
		host: document.createElement('div'),
		setColor: noop,
		notify: noop,
	};
	const href = () =>
		Array.from(opened.layer('layer-2')?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return { context, document: opened, at: (x, y) => pictureAt(href(), x, y) };
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

/** A click at a point in the drawing's units: one dab. */
const click = (behavior: ToolBehavior, context: ToolContext, x: number, y: number): void => {
	behavior.begin(context, sampleAt(x, y));
	behavior.end(context, sampleAt(x, y));
};

/** Ten units across in the drawing, so five on the layer: a radius of 2.5 of its pixels. */
const HARD = { size: 10, hardness: 1, opacity: 1, pressure: false } as const;

beforeEach(() => {
	installFakeCanvas();
	space.scale = 2;
});
afterEach(() => {
	uninstallFakeCanvas();
});

describe('a size on a scaled layer', () => {
	it.each(['brush', 'pencil'] as const)(
		'is the %s’s in the drawing’s units: a dab covers half as many of the layer’s pixels',
		async (id) => {
			const fake = createFake(
				registerPicture(40, 30, () => [0, 0, 0, 0]),
				{
					...HARD,
					fill: '#0000ff',
					stroke: '#0000ff',
				}
			);
			// At (40, 30) in the drawing: (20, 15) on the layer's pixels.
			click(tool(id), fake.context, 40, 30);
			await fake.document.settle();
			// 1.6 pixels from the center, inside the radius of 2.5.
			expect(fake.at(21, 15)).toEqual([...BLUE]);
			expect(fake.at(18, 15)).toEqual([...BLUE]);
			// 3.5 pixels from it: outside, as it would not be for a radius of 5, the size in the layer's own units.
			expect(fake.at(23, 15)).toEqual(CLEAR);
			expect(fake.at(16, 15)).toEqual(CLEAR);
			expect(fake.at(20, 12)).toEqual(CLEAR);
		}
	);

	it('is the eraser’s in the drawing’s units', async () => {
		const fake = createFake(
			registerPicture(40, 30, () => RED),
			HARD
		);
		click(tool('eraser'), fake.context, 40, 30);
		await fake.document.settle();
		expect(fake.at(21, 15)).toEqual(CLEAR);
		expect(fake.at(23, 15)).toEqual([...RED]);
		expect(fake.at(20, 12)).toEqual([...RED]);
	});

	it('shows the live stroke on the screen as it will land', () => {
		const fake = createFake(
			registerPicture(40, 30, () => [0, 0, 0, 0]),
			{
				...HARD,
				stroke: '#0000ff',
			}
		);
		tool('pencil').begin(fake.context, sampleAt(40, 30));
		const screen = fakeOf(fake.context.screen.canvas);
		// The screen is the drawing's units here: a radius of 5 about (40, 30).
		expect(screen.at(44, 30)).toEqual([...BLUE]);
		expect(screen.at(46, 30)).toEqual(CLEAR);
		tool('pencil').cancel(fake.context);
	});

	it('is the smudge’s in the drawing’s units: a dab reaches half as many of the layer’s rows', async () => {
		const fake = createFake(
			registerPicture(40, 30, (x) => (x < 20 ? RED : BLUE)),
			{ size: 8, hardness: 1, strength: 0.8 }
		);
		const smudge = tool('smudge');
		// Along row 15 of the layer's pixels, from the red into the blue.
		smudge.begin(fake.context, sampleAt(32, 31));
		[36, 40, 44, 48].forEach((x) => smudge.move(fake.context, sampleAt(x, 31)));
		smudge.end(fake.context, sampleAt(48, 31));
		await fake.document.settle();
		// The red is pushed into the blue along the row.
		expect(fake.at(21, 15)).not.toEqual([...BLUE]);
		// A radius of 2 of the layer's pixels about row 15.5 does not reach row 12, as one of 4 would.
		expect(fake.at(21, 12)).toEqual([...BLUE]);
		expect(fake.at(22, 18)).toEqual([...BLUE]);
	});
});
