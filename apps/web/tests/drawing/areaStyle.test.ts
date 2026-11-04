import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { areaMask, areaOf } from '../../src/drawing/tools/raster/area.js';
import { clearArea, fillArea, rasterBehaviors } from '../../src/drawing/tools/raster/index.js';
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
import { t } from '../../src/i18n/t.js';
import {
	fakeOf,
	installFakeCanvas,
	pictureAt,
	registerPicture,
	uninstallFakeCanvas,
} from './fakeCanvas.js';

/**
 * The area's inverse and feather (docs/decisions/0004-the-interface.md, "The
 * context menu"; docs/ARCHITECTURE.md §7, "Tools") through every raster
 * write: the brush's commit and its live preview, Delete, Fill, the fill
 * tool's flood. Against a real document and a fake canvas that composites
 * (`fakeCanvas.ts`), so what is checked is the pixels written into the
 * layer's `<image>`, read back from its `href`. The fake samples a pixel at
 * its center, so a hard edge has no anti-aliasing here, and its blur is an
 * exact Gaussian, which a browser's need not be.
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** The canvas is 40 × 30; `layer-2` is a raster layer, with a picture where given. */
const drawingText = (picture?: string, layerAttributes = ''): string =>
	[
		'<?xml version="1.0" encoding="UTF-8"?>',
		`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 40 30" width="40" height="30">`,
		'  <g id="layer-1" draw:kind="vector"/>',
		`  <g id="layer-2" draw:kind="raster"${layerAttributes}>${
			picture === undefined
				? ''
				: `<image href="${picture}" x="0" y="0" width="40" height="30" preserveAspectRatio="none"/>`
		}</g>`,
		'</svg>',
		'',
	].join('\n');

const RED = [255, 0, 0, 255];
const CLEAR = [0, 0, 0, 0];

/** A picture the canvas's size, red where `inside` says, transparent elsewhere. */
const redWhere = (inside: (x: number, y: number) => boolean = () => true): string =>
	registerPicture(40, 30, (x, y) => (inside(x, y) ? [255, 0, 0, 255] : [0, 0, 0, 0]));

/** A square hole from (10, 5) to (30, 25), as the marquee writes it. */
const SQUARE = 'M 10 5 L 30 5 L 30 25 L 10 25 Z';

const noop = (): undefined => undefined;

type Fake = Readonly<{
	context: ToolContext;
	document: EditorDocument;
	labels: string[];
	notices: string[];
	screen: HTMLCanvasElement;
	/** The `href` of `layer-2`'s picture now. */
	href: () => string | null | undefined;
}>;

type Setup = Readonly<{
	picture?: string;
	layerAttributes?: string;
	region?: Region;
	options?: Partial<ToolOptions>;
}>;

const createFake = (setup: Setup = {}): Fake => {
	const opened = openDocument(drawingText(setup.picture, setup.layerAttributes));
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
	const layer = editor.snapshot().layers.find((each) => each.id === 'layer-2');
	const screen = document.createElement('canvas');
	screen.width = 40;
	screen.height = 30;
	const context: ToolContext = {
		document: editor,
		layer,
		options: {
			...DEFAULT_TOOL_OPTIONS,
			hardness: 1,
			pressure: false,
			smoothing: 0,
			fill: '#ff0000',
			...setup.options,
		},
		overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
		screen: { canvas: screen, toScreen: (x, y) => [x, y], pixelRatio: 1 },
		viewport: { scale: 1, zoomBy: noop, panBy: noop, fit: noop, actualSize: noop },
		selection: { elements: [], set: noop, clear: noop },
		region: {
			path: setup.region?.path,
			region: setup.region,
			set: noop,
			update: noop,
		},
		host: document.createElement('div'),
		setColor: noop,
		notify: (message) => notices.push(message),
	};
	const href = () =>
		Array.from(editor.layer('layer-2')?.children ?? [])
			.find((child) => child.localName === 'image')
			?.getAttribute('href');
	return { context, document: editor, labels, notices, screen, href };
};

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

const tool = (name: ToolId): ToolBehavior => {
	const behavior = rasterBehaviors[name];
	if (behavior === undefined) throw new Error(`no raster ${name}`);
	return behavior;
};

/** A stroke from the first point to the last, through the rest. */
const stroke = (
	behavior: ToolBehavior,
	context: ToolContext,
	points: readonly (readonly [number, number])[]
): void => {
	const [first, ...rest] = points;
	if (first === undefined) return;
	behavior.begin(context, at(...first));
	rest.forEach((p) => behavior.move(context, at(...p)));
	behavior.end(context, at(...(rest.at(-1) ?? first)));
};

const plain = (path = SQUARE): Region => ({ path, inverted: false, feather: 0 });
const inverse = (path = SQUARE): Region => ({ path, inverted: true, feather: 0 });

beforeEach(() => installFakeCanvas());
afterEach(uninstallFakeCanvas);

describe('the area’s mask', () => {
	const maskOf = (fake: Fake): ReturnType<typeof fakeOf> => {
		const area = areaOf(fake.context);
		const surface = surfaceFor(fake.context);
		if (area === undefined || surface === undefined)
			throw new Error('an area on a raster layer');
		const mask = areaMask(surface, area);
		if (mask === undefined) throw new Error('a mask');
		return fakeOf(mask);
	};

	it('covers the outline’s inside for a plain area, and nothing else', () => {
		const mask = maskOf(createFake({ region: plain() }));
		expect(mask.at(20, 15)[3]).toBe(255);
		expect(mask.at(5, 15)[3]).toBe(0);
	});

	it('covers the canvas outside the outline for an inverse, overlapping subpaths and all', () => {
		// Two squares that overlap, where `nonzero` winds twice: a clip of the
		// canvas with them reversed would leave the overlap selected.
		const overlapping = `${SQUARE} M 20 10 L 35 10 L 35 20 L 20 20 Z`;
		const mask = maskOf(createFake({ region: inverse(overlapping) }));
		expect(mask.at(5, 15)[3]).toBe(255);
		expect(mask.at(15, 15)[3]).toBe(0);
		expect(mask.at(25, 15)[3]).toBe(0);
		expect(mask.at(33, 15)[3]).toBe(0);
		expect(mask.at(37, 2)[3]).toBe(255);
		expect(mask.calls.map((call) => call.composite)).toContain('destination-out');
	});

	it('is bounded by the canvas for an inverse, on a layer larger than it', () => {
		const picture = registerPicture(60, 30, () => [255, 0, 0, 255]);
		const fake = createFake({ region: inverse() });
		const layer = fake.document.layer('layer-2');
		layer?.insertAdjacentHTML(
			'beforeend',
			`<image xmlns="${SVG_NAMESPACE}" href="${picture}" x="-10" y="0" width="60" height="30" preserveAspectRatio="none"/>`
		);
		const mask = maskOf(fake);
		// Pixel 5 is user unit -5, left of the canvas; 15 is unit 5, on it.
		expect(mask.at(5, 15)[3]).toBe(0);
		expect(mask.at(15, 15)[3]).toBe(255);
		expect(mask.at(55, 15)[3]).toBe(0);
	});

	it('fades over the feather either side of the outline, by a blur of half the feather', () => {
		const mask = maskOf(createFake({ region: { ...plain(), feather: 4 } }));
		expect(mask.named('fill')[0]?.filter).toBe('blur(2px)');
		const alphaAt = (x: number): number => mask.at(x, 15)[3] ?? 0;
		expect(alphaAt(20)).toBe(255);
		// The outline is at 10; pixel 10's center is half a unit inside it.
		expect(alphaAt(10)).toBeGreaterThan(128);
		expect(alphaAt(10)).toBeLessThan(180);
		expect(alphaAt(9)).toBeLessThan(128);
		expect(alphaAt(13)).toBeGreaterThan(240);
		expect(alphaAt(5)).toBeLessThan(10);
		expect(mask.filter).toBe('none');
	});

	it('takes the blurred outline out of the canvas for a feathered inverse', () => {
		const mask = maskOf(createFake({ region: { ...inverse(), feather: 4 } }));
		const alphaAt = (x: number): number => mask.at(x, 15)[3] ?? 0;
		expect(alphaAt(20)).toBe(0);
		expect(alphaAt(9)).toBeGreaterThan(128);
		expect(alphaAt(10)).toBeLessThan(128);
		expect(alphaAt(2)).toBe(255);
	});

	it('has a hard edge where the canvas cannot blur', () => {
		uninstallFakeCanvas();
		installFakeCanvas({ filters: false });
		const mask = maskOf(createFake({ region: { ...plain(), feather: 4 } }));
		expect(mask.named('fill')[0]?.filter).toBeUndefined();
		expect(mask.at(10, 15)[3]).toBe(255);
		expect(mask.at(9, 15)[3]).toBe(0);
	});
});

describe('a brush stroke through the area', () => {
	const ACROSS: readonly (readonly [number, number])[] = [
		[2, 15],
		[38, 15],
	];

	it('paints only the canvas outside the outline of an inverse', async () => {
		const fake = createFake({ region: inverse(), options: { size: 4 } });
		stroke(tool('brush'), fake.context, ACROSS);
		await fake.document.settle();
		expect(fake.labels).toEqual(['tools.brush']);
		expect(pictureAt(fake.href(), 5, 15)).toEqual(RED);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(CLEAR);
		expect(pictureAt(fake.href(), 35, 15)).toEqual(RED);
	});

	it('writes nothing for a stroke wholly in an inverse’s hole', async () => {
		const fake = createFake({ region: inverse(), options: { size: 4 } });
		stroke(tool('brush'), fake.context, [
			[15, 15],
			[25, 15],
		]);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
	});

	it('fades at a feathered edge', async () => {
		const fake = createFake({ region: { ...plain(), feather: 4 }, options: { size: 4 } });
		stroke(tool('brush'), fake.context, ACROSS);
		await fake.document.settle();
		const alphaAt = (x: number): number => pictureAt(fake.href(), x, 15)[3] ?? 0;
		expect(alphaAt(20)).toBe(255);
		expect(alphaAt(10)).toBeGreaterThan(128);
		expect(alphaAt(10)).toBeLessThan(255);
		expect(alphaAt(4)).toBeLessThan(10);
	});

	it('erases only outside the outline of an inverse', async () => {
		const fake = createFake({ picture: redWhere(), region: inverse(), options: { size: 4 } });
		stroke(tool('eraser'), fake.context, ACROSS);
		await fake.document.settle();
		expect(pictureAt(fake.href(), 5, 15)).toEqual(CLEAR);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(RED);
		expect(pictureAt(fake.href(), 5, 5)).toEqual(RED);
	});

	it('previews an inverse exactly: the stamps in the hole taken out, near each stamp alone', () => {
		const fake = createFake({ region: inverse(), options: { size: 4 } });
		const brush = tool('brush');
		brush.begin(fake.context, at(20, 15));
		brush.move(fake.context, at(5, 15));
		const screen = fakeOf(fake.screen);
		expect(screen.at(20, 15)[3]).toBe(0);
		expect(screen.at(12, 15)[3]).toBe(0);
		expect(screen.at(5, 15)).toEqual(RED);
		const takenOut = screen
			.named('fill')
			.filter((call) => call.composite === 'destination-out');
		expect(takenOut.length).toBe(screen.named('arc').length);
		brush.cancel(fake.context);
	});
});

describe('Delete through the area', () => {
	it('clears the canvas outside the outline of an inverse, by one command', async () => {
		const fake = createFake({ picture: redWhere(), region: inverse() });
		expect(clearArea(fake.context)).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.clear']);
		expect(pictureAt(fake.href(), 5, 15)).toEqual(CLEAR);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(RED);
	});

	it('fades a feathered clear', async () => {
		const fake = createFake({ picture: redWhere(), region: { ...plain(), feather: 4 } });
		clearArea(fake.context);
		await fake.document.settle();
		const alphaAt = (x: number): number => pictureAt(fake.href(), x, 15)[3] ?? 0;
		expect(alphaAt(20)).toBe(0);
		expect(alphaAt(10)).toBeGreaterThan(0);
		expect(alphaAt(10)).toBeLessThan(128);
		expect(alphaAt(2)).toBe(255);
	});

	it('writes nothing where all the color is in an inverse’s hole', async () => {
		const inHole = redWhere((x, y) => x >= 12 && x < 28 && y >= 7 && y < 23);
		const fake = createFake({ picture: inHole, region: inverse() });
		expect(clearArea(fake.context)).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
	});
});

describe('Fill', () => {
	it('fills the outline’s inside with the fill color, by one command', async () => {
		const fake = createFake({ region: plain() });
		expect(fillArea(fake.context)).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual(['regions.fill']);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(RED);
		expect(pictureAt(fake.href(), 5, 15)).toEqual(CLEAR);
	});

	it('fills the canvas outside the outline of an inverse', async () => {
		const fake = createFake({ region: inverse() });
		fillArea(fake.context);
		await fake.document.settle();
		expect(pictureAt(fake.href(), 5, 15)).toEqual(RED);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(CLEAR);
	});

	it('fades at a feathered edge, over what is there', async () => {
		const blue = registerPicture(40, 30, () => [0, 0, 255, 255]);
		const fake = createFake({ picture: blue, region: { ...plain(), feather: 4 } });
		fillArea(fake.context);
		await fake.document.settle();
		expect(pictureAt(fake.href(), 20, 15)).toEqual(RED);
		const [red = 0, , bluePart = 0, alpha] = pictureAt(fake.href(), 10, 15);
		expect(alpha).toBe(255);
		expect(red).toBeGreaterThan(0);
		expect(bluePart).toBeGreaterThan(0);
		expect(pictureAt(fake.href(), 2, 15)).toEqual([0, 0, 255, 255]);
	});

	it('pours what the fill tool pours where the fill is none: the stroke color', async () => {
		const fake = createFake({ region: plain(), options: { fill: 'none', stroke: '#00ff00' } });
		fillArea(fake.context);
		await fake.document.settle();
		expect(pictureAt(fake.href(), 20, 15)).toEqual([0, 255, 0, 255]);
	});

	it('writes nothing where it changes no pixel', async () => {
		const fake = createFake({ picture: redWhere(), region: plain() });
		expect(fillArea(fake.context)).toBe(true);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
	});

	it('says so on a locked layer and keeps its pixels, and is not its to do with no area', async () => {
		const locked = createFake({ region: plain(), layerAttributes: ' draw:locked="true"' });
		expect(fillArea(locked.context)).toBe(true);
		await locked.document.settle();
		expect(locked.notices).toEqual([t('layers.locked', { name: 'Layer 2' })]);
		expect(locked.labels).toEqual([]);
		expect(fillArea(createFake().context)).toBe(false);
	});
});

describe('the fill tool through the area', () => {
	it('floods the canvas outside an inverse’s outline, and nothing from inside it', async () => {
		const fake = createFake({ region: inverse() });
		tool('fill').begin(fake.context, at(20, 15));
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
		tool('fill').begin(fake.context, at(5, 15));
		await fake.document.settle();
		expect(fake.labels).toEqual(['tools.fill']);
		expect(pictureAt(fake.href(), 5, 15)).toEqual(RED);
		expect(pictureAt(fake.href(), 35, 28)).toEqual(RED);
		expect(pictureAt(fake.href(), 20, 15)).toEqual(CLEAR);
	});

	it('lays its color down by the coverage over a feathered edge', async () => {
		const fake = createFake({ region: { ...plain(), feather: 4 } });
		tool('fill').begin(fake.context, at(20, 15));
		await fake.document.settle();
		expect(pictureAt(fake.href(), 20, 15)).toEqual(RED);
		const alpha = pictureAt(fake.href(), 9, 15)[3] ?? 0;
		expect(alpha).toBeGreaterThan(0);
		expect(alpha).toBeLessThan(128);
	});
});

describe('the smudge through the area', () => {
	it('drags no color into an inverse’s hole', async () => {
		const leftHalf = redWhere((x) => x < 20);
		const options = { size: 6, strength: 1 };
		const control = createFake({ picture: leftHalf, options });
		stroke(tool('smudge'), control.context, [
			[5, 15],
			[26, 15],
		]);
		await control.document.settle();
		expect(pictureAt(control.href(), 22, 15)[3]).toBeGreaterThan(0);

		const fake = createFake({ picture: leftHalf, region: inverse(), options });
		stroke(tool('smudge'), fake.context, [
			[5, 15],
			[26, 15],
		]);
		await fake.document.settle();
		expect(fake.labels).toEqual([]);
	});
});
