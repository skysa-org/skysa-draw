import { DRAWING_NAMESPACE, SVG_NAMESPACE } from '@skysa/draw-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { styleValue } from '../../src/drawing/document/layers.js';
import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { surfaceFor } from '../../src/drawing/tools/raster/surface.js';
import { DEFAULT_TOOL_OPTIONS, type Region } from '../../src/drawing/tools/types.js';
import type { Box } from '../../src/drawing/tools/vector/geometry.js';
import { attributeBox } from '../../src/drawing/tools/vector/measure.js';
import { createToolContext } from '../../src/drawing/viewport/context.js';
import {
	type ExtentReaders,
	inkBox,
	layerExtentIn,
	type Paint,
	type Pixels,
	type ReadPixels,
} from '../../src/drawing/viewport/layerExtent.js';
import { observable } from '../../src/drawing/viewport/observable.js';
import { IDENTITY_VIEW } from '../../src/drawing/viewport/transform.js';
import { fakeOf, installFakeCanvas, registerPicture, uninstallFakeCanvas } from './fakeCanvas.js';

/**
 * What each layer paints, for the move tool's alignment: the box of it in
 * the root's user units, through its own `transform` and its groups'. Against
 * a real document. jsdom has no `getBBox`, no computed style for SVG and no
 * 2D canvas, so an element's box is read from its attributes, how it paints
 * from its attributes and `style`, inherited as CSS inherits them, and a
 * picture's pixels from a fake that says which are painted; the browser's
 * own readers of pixels are driven on the compositing fake canvas
 * (`fakeCanvas.ts`).
 */

const DRAWING_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';

/** A picture's bytes, never decoded but by the fake canvas: the tests say what its pixels are. */
const PICTURE = 'data:image/png;base64,cGljdHVyZQ==';

type Rgba = readonly [number, number, number, number];

const RED: Rgba = [255, 0, 0, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

const open = (layers: string): EditorDocument => {
	const opened = openDocument(
		[
			'<?xml version="1.0" encoding="UTF-8"?>',
			`<svg xmlns="${SVG_NAMESPACE}" xmlns:draw="${DRAWING_NAMESPACE}" draw:id="${DRAWING_ID}" viewBox="0 0 200 100" width="200" height="100">`,
			layers,
			'</svg>',
			'',
		].join('\n')
	);
	if (opened === undefined) throw new Error('the drawing opens');
	return opened;
};

/**
 * A property as the file says it, in `style` before the attribute: on the
 * element, or, where it is `inherited`, on the nearest element above that says.
 */
const said = (
	element: Element | null,
	property: string,
	inherited: boolean
): string | undefined => {
	if (element === null) return undefined;
	const own = styleValue(element, property) ?? element.getAttribute(property) ?? undefined;
	return own ?? (inherited ? said(element.parentElement, property, true) : undefined);
};

/** How an element paints, read from the file as a browser computes it. */
const attributePaint = (element: Element): Paint => {
	const stroke = said(element, 'stroke', true) ?? 'none';
	return {
		displayed: said(element, 'display', false) !== 'none',
		visible: (said(element, 'visibility', true) ?? 'visible') === 'visible',
		filled: (said(element, 'fill', true) ?? 'black') !== 'none',
		stroke: stroke === 'none' ? 0 : Number(said(element, 'stroke-width', true) ?? '1'),
	};
};

/** A picture's pixels, alpha where `alphaAt` says and clear elsewhere, read a box at a time; every box read is kept. */
const fakePixels = (
	alphaAt: (x: number, y: number) => number
): Readonly<{ read: ReadPixels; reads: Box[] }> => {
	const reads: Box[] = [];
	const read: ReadPixels = (box) => {
		reads.push(box);
		const data = new Uint8ClampedArray(box.width * box.height * 4);
		for (let i = 0; i < box.width * box.height; i += 1) {
			data[i * 4 + 3] = alphaAt(box.x + (i % box.width), box.y + Math.floor(i / box.width));
		}
		return data;
	};
	return { read, reads };
};

/** Opaque inside `box`, clear outside it. */
const inside =
	(box: Box) =>
	(x: number, y: number): number =>
		x >= box.x && y >= box.y && x < box.x + box.width && y < box.y + box.height ? 255 : 0;

/** No surface: every raster layer is read from its picture, whose pixels `alphaAt` gives. */
const fromPicture = (alphaAt: (x: number, y: number) => number): Partial<ExtentReaders> => ({
	surface: () => Promise.resolve(undefined),
	picture: () => Promise.resolve(fakePixels(alphaAt).read),
});

const extentOf = (
	editor: EditorDocument,
	id: string,
	given: Partial<ExtentReaders> = {}
): Promise<Box | undefined> =>
	layerExtentIn(editor, { measure: attributeBox, paint: attributePaint, ...given })(id);

describe('inkBox', () => {
	it('is the box around every pixel with any alpha, the faintest too', () => {
		const { read } = fakePixels((x, y) => {
			if (x === 30 && y === 12) return 255;
			return x === 45 && y === 70 ? 1 : 0;
		});
		expect(inkBox(100, 80, read)).toEqual({ x: 30, y: 12, width: 16, height: 59 });
	});

	it('is none for a picture with every pixel clear, read once through', () => {
		const { read, reads } = fakePixels(() => 0);
		expect(inkBox(100, 80, read, 1000)).toBeUndefined();
		expect(reads.map((box) => [box.y, box.height])).toEqual(
			Array.from({ length: 8 }, (_, band) => [band * 10, 10])
		);
	});

	it('reads a picture with paint at its edges only that far: a band from each side', () => {
		const { read, reads } = fakePixels((x, y) =>
			(x === 0 && y === 40) || (x === 99 && y === 41) || (x === 50 && (y === 0 || y === 79))
				? 255
				: 0
		);
		expect(inkBox(100, 80, read, 1000)).toEqual({ x: 0, y: 0, width: 100, height: 80 });
		expect(reads).toEqual([
			{ x: 0, y: 0, width: 100, height: 10 },
			{ x: 0, y: 70, width: 100, height: 10 },
			{ x: 0, y: 0, width: 12, height: 80 },
			{ x: 88, y: 0, width: 12, height: 80 },
		]);
	});

	it('reads the columns between the rows that have paint, and from the bottom no higher than the top', () => {
		const { read, reads } = fakePixels((x, y) => (x === 5 && y === 35 ? 255 : 0));
		expect(inkBox(100, 80, read, 1000)).toEqual({ x: 5, y: 35, width: 1, height: 1 });
		expect(reads.slice(4)).toEqual([
			{ x: 0, y: 70, width: 100, height: 10 },
			{ x: 0, y: 60, width: 100, height: 10 },
			{ x: 0, y: 50, width: 100, height: 10 },
			{ x: 0, y: 40, width: 100, height: 10 },
			{ x: 0, y: 35, width: 100, height: 5 },
			{ x: 0, y: 35, width: 100, height: 1 },
			{ x: 5, y: 35, width: 95, height: 1 },
		]);
	});
});

describe('the extent of a vector layer', () => {
	it('is the box around every element in it', async () => {
		const editor = open(
			'<g id="layer-1" draw:kind="vector"><rect x="10" y="10" width="20" height="20"/><circle cx="100" cy="50" r="10"/></g>'
		);
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: 10, y: 10, width: 100, height: 50 });
	});

	it('is larger by half a stroke where one is drawn, the stroke scaled with the element', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector" transform="scale(2)"><rect x="10" y="10" width="20" height="20" stroke="black" stroke-width="4"/></g>',
				'<g id="layer-2" draw:kind="vector" stroke="black" stroke-width="6"><path d="M 50 50 L 50 50" stroke-linecap="round"/></g>',
			].join('\n')
		);
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: 16, y: 16, width: 48, height: 48 });
		// A dot is a line of no length that its round cap draws.
		expect(await extentOf(editor, 'layer-2')).toEqual({ x: 47, y: 47, width: 6, height: 6 });
	});

	it('is placed by the element’s own transform, the groups’ inside the layer, the layer’s and its groups’', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="group" transform="translate(100 0)">',
				'<g id="layer-2" draw:kind="vector" transform="scale(2)">',
				'<g transform="translate(0 3)"><rect x="5" y="5" width="10" height="10" transform="translate(1 -1)"/></g>',
				'</g>',
				'</g>',
			].join('\n')
		);
		expect(await extentOf(editor, 'layer-2')).toEqual({ x: 112, y: 14, width: 20, height: 20 });
	});

	it('is the box around a turned box’s corners, with no noise of the turn in it', async () => {
		const editor = open(
			'<g id="layer-1" draw:kind="vector" transform="rotate(90)"><rect x="0" y="0" width="10" height="20"/></g>'
		);
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: -20, y: 0, width: 20, height: 10 });
	});

	it('passes over what draws nothing, and counts what is made visible inside what is hidden', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector">',
				'<title>Far out</title>',
				'<defs><rect x="-500" y="-500" width="10" height="10"/></defs>',
				'<mask id="cut"><rect x="500" y="500" width="10" height="10" fill="white"/></mask>',
				'<rect x="-100" y="0" width="10" height="10" display="none"/>',
				'<rect x="300" y="0" width="10" height="10" style="display:none"/>',
				'<rect x="0" y="-100" width="10" height="10" visibility="hidden"/>',
				'<rect x="0" y="300" width="10" height="10" fill="none"/>',
				'<line x1="0" y1="0" x2="400" y2="400"/>',
				'<g display="none"><rect x="-300" y="-300" width="10" height="10"/></g>',
				'<g visibility="hidden">',
				'<rect x="-40" y="-40" width="10" height="10"/>',
				'<rect x="40" y="40" width="10" height="10" visibility="visible"/>',
				'</g>',
				'<rect x="20" y="20" width="10" height="10"/>',
				'</g>',
			].join('\n')
		);
		expect(editor.root.querySelector('mask rect')).not.toBeNull();
		expect(editor.root.querySelector('defs rect')).not.toBeNull();
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: 20, y: 20, width: 30, height: 30 });
	});

	it('is none for a layer with nothing in it, or nothing that draws', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector"></g>',
				'<g id="layer-2" draw:kind="vector"><title>Empty</title><defs><rect width="10" height="10"/></defs><rect width="10" height="10" fill="none"/></g>',
			].join('\n')
		);
		expect(await extentOf(editor, 'layer-1')).toBeUndefined();
		expect(await extentOf(editor, 'layer-2')).toBeUndefined();
	});

	it('is the box of a loose element at the root, which is a layer of its own', async () => {
		const editor = open(
			'<rect id="layer-1" x="5" y="6" width="7" height="8" transform="translate(10 10)"/>'
		);
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: 15, y: 16, width: 7, height: 8 });
	});
});

describe('the extent of a raster layer', () => {
	const layer = (attributes = 'x="5" y="5" width="50" height="40"', href = PICTURE): string =>
		`<g id="layer-1" draw:kind="raster" transform="translate(10 20)"><image href="${href}" ${attributes} preserveAspectRatio="none"/></g>`;

	it('is the box around its pixels with any alpha, placed by its picture’s box and the layer’s transform', async () => {
		const editor = open(layer());
		const grids: unknown[] = [];
		const read = fakePixels(inside({ x: 10, y: 4, width: 10, height: 4 })).read;
		const box = await extentOf(editor, 'layer-1', {
			surface: () => Promise.resolve(undefined),
			picture: (_image, grid) => {
				grids.push(grid);
				return Promise.resolve(read);
			},
		});
		expect(box).toEqual({ x: 25, y: 29, width: 10, height: 4 });
		expect(grids).toEqual([{ ppu: 1, width: 50, height: 40 }]);
	});

	it('maps its pixels onto its picture’s box as they are stretched to it, however many pixels that is', async () => {
		// Past 4096 units the grid has half a pixel to a unit; 100.5 units are 101 pixels.
		const wide = open(layer('x="0" y="0" width="8192" height="100"'));
		expect(
			await extentOf(
				wide,
				'layer-1',
				fromPicture(inside({ x: 100, y: 10, width: 2, height: 10 }))
			)
		).toEqual({ x: 210, y: 40, width: 4, height: 20 });
		const odd = open(layer('x="0" y="0" width="100.5" height="10"'));
		expect(
			await extentOf(
				odd,
				'layer-1',
				fromPicture(() => 255)
			)
		).toEqual({
			x: 10,
			y: 20,
			width: 100.5,
			height: 10,
		});
	});

	it('is none for a layer whose pixels are all clear, or that has no picture yet', async () => {
		expect(
			await extentOf(
				open(layer()),
				'layer-1',
				fromPicture(() => 0)
			)
		).toBeUndefined();
		const picture = vi.fn(() => Promise.resolve(fakePixels(() => 255).read));
		const empty = open('<g id="layer-1" draw:kind="raster"></g>');
		expect(
			await extentOf(empty, 'layer-1', { surface: () => Promise.resolve(undefined), picture })
		).toBeUndefined();
		expect(picture).not.toHaveBeenCalled();
	});

	it('is the picture’s whole box where it will not decode, or its pixels will not be read', async () => {
		const whole = { x: 15, y: 25, width: 50, height: 40 };
		expect(
			await extentOf(open(layer()), 'layer-1', {
				surface: () => Promise.resolve(undefined),
				picture: () => Promise.reject(new Error('not a picture')),
			})
		).toEqual(whole);
		const tainted = (): Uint8ClampedArray => {
			throw new DOMException('the canvas is tainted', 'SecurityError');
		};
		expect(
			await extentOf(open(layer()), 'layer-1', {
				surface: () => Promise.resolve(undefined),
				picture: () => Promise.resolve(tainted),
			})
		).toEqual(whole);
	});

	/** A surface of 10 × 10 pixels at two units each, inked at (3, 4), as it is after `writes` writes. */
	const surfaceOf = (
		holder: object,
		writes: number,
		pixels = fakePixels(inside({ x: 3, y: 4, width: 1, height: 1 }))
	): Pixels => ({
		width: 10,
		height: 10,
		read: pixels.read,
		toRoot: [2, 0, 0, 2, 1, 1],
		holder,
		writes,
	});

	it('reads the surface a tool decoded already, by its own map, and not the picture', async () => {
		const editor = open(layer());
		const surface = surfaceOf({}, 0);
		const picture = vi.fn(() => Promise.resolve(fakePixels(() => 255).read));
		expect(
			await extentOf(editor, 'layer-1', { surface: () => Promise.resolve(surface), picture })
		).toEqual({ x: 7, y: 9, width: 2, height: 2 });
		expect(picture).not.toHaveBeenCalled();
	});

	it('measures a picture once, and only places it again where its layer moved or its box did', async () => {
		const editor = open(layer());
		const pixels = fakePixels(inside({ x: 10, y: 4, width: 10, height: 4 }));
		const picture = vi.fn(() => Promise.resolve(pixels.read));
		const given = { surface: () => Promise.resolve(undefined), picture };
		expect(await extentOf(editor, 'layer-1', given)).toEqual({
			x: 25,
			y: 29,
			width: 10,
			height: 4,
		});
		const read = pixels.reads.length;
		editor.layer('layer-1')?.setAttribute('transform', 'translate(110 20) scale(2)');
		editor.root.querySelector('image')?.setAttribute('x', '0');
		expect(await extentOf(editor, 'layer-1', given)).toEqual({
			x: 130,
			y: 38,
			width: 20,
			height: 8,
		});
		expect(picture).toHaveBeenCalledTimes(1);
		expect(pixels.reads).toHaveLength(read);
	});

	it('measures a picture again once its href changes, or the grid it is drawn on', async () => {
		const editor = open(layer());
		const picture = vi.fn(() => Promise.resolve(fakePixels(() => 255).read));
		const given = { surface: () => Promise.resolve(undefined), picture };
		const image = editor.root.querySelector('image');
		expect(await extentOf(editor, 'layer-1', given)).toEqual({
			x: 15,
			y: 25,
			width: 50,
			height: 40,
		});
		image?.setAttribute('href', 'data:image/png;base64,b3RoZXI=');
		await extentOf(editor, 'layer-1', given);
		expect(picture).toHaveBeenCalledTimes(2);
		image?.setAttribute('width', '60');
		expect(await extentOf(editor, 'layer-1', given)).toEqual({
			x: 15,
			y: 25,
			width: 60,
			height: 40,
		});
		expect(picture).toHaveBeenCalledTimes(3);
	});

	it('reads a surface again only once it was asked to write, or another surface holds the layer', async () => {
		const editor = open(layer());
		const holder = {};
		const pixels = fakePixels(inside({ x: 3, y: 4, width: 1, height: 1 }));
		const measure = (surface: Pixels): Promise<Box | undefined> =>
			extentOf(editor, 'layer-1', { surface: () => Promise.resolve(surface) });
		await measure(surfaceOf(holder, 0, pixels));
		const once = pixels.reads.length;
		await measure(surfaceOf(holder, 0, pixels));
		expect(pixels.reads).toHaveLength(once);
		await measure(surfaceOf(holder, 1, pixels));
		expect(pixels.reads).toHaveLength(2 * once);
		await measure(surfaceOf({}, 1, pixels));
		expect(pixels.reads).toHaveLength(3 * once);
	});

	it('reads one picture at a time, the next once the one before it is measured', async () => {
		const editor = open(
			[
				`<g id="layer-1" draw:kind="raster"><image href="data:image/png;base64,b25l" x="0" y="0" width="10" height="10"/></g>`,
				`<g id="layer-2" draw:kind="raster"><image href="data:image/png;base64,dHdv" x="0" y="0" width="10" height="10"/></g>`,
			].join('\n')
		);
		const started: string[] = [];
		const gates = new Map<string, () => void>();
		const extent = layerExtentIn(editor, {
			measure: attributeBox,
			paint: attributePaint,
			surface: () => Promise.resolve(undefined),
			picture: (image) => {
				const href = image.getAttribute('href') ?? '';
				started.push(href);
				return new Promise<ReadPixels>((resolve) => {
					gates.set(href, () => resolve(fakePixels(() => 255).read));
				});
			},
		});
		const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
		const first = extent('layer-1');
		const second = extent('layer-2');
		await settled();
		expect(started).toEqual(['data:image/png;base64,b25l']);
		gates.get('data:image/png;base64,b25l')?.();
		expect(await first).toEqual({ x: 0, y: 0, width: 10, height: 10 });
		await settled();
		expect(started).toEqual(['data:image/png;base64,b25l', 'data:image/png;base64,dHdv']);
		gates.get('data:image/png;base64,dHdv')?.();
		expect(await second).toEqual({ x: 0, y: 0, width: 10, height: 10 });
	});
});

describe('the browser’s readers of a raster layer’s pixels, on the fake canvas', () => {
	beforeEach(() => {
		installFakeCanvas();
	});

	afterEach(() => {
		uninstallFakeCanvas();
	});

	/** A picture of 50 × 40, opaque red in the 10 × 4 at (10, 4) and clear elsewhere. */
	const picture = (): string =>
		registerPicture(50, 40, (x, y) =>
			inside({ x: 10, y: 4, width: 10, height: 4 })(x, y) > 0 ? RED : CLEAR
		);

	const layer = (href: string): string =>
		`<g id="layer-1" draw:kind="raster"><image href="${href}" x="5" y="5" width="50" height="40" preserveAspectRatio="none"/></g>`;

	const contextFor = (editor: EditorDocument) =>
		createToolContext({
			document: editor,
			layer: editor.snapshot().layers.find((each) => each.id === 'layer-1'),
			options: DEFAULT_TOOL_OPTIONS,
			overlay: document.createElementNS(SVG_NAMESPACE, 'svg'),
			canvas: document.createElement('canvas'),
			pixelRatio: () => 1,
			view: observable(IDENTITY_VIEW),
			selection: observable<readonly Element[]>([]),
			region: observable<Region | undefined>(undefined),
			host: document.createElement('div'),
			fit: () => undefined,
			actualSize: () => undefined,
			setColor: () => undefined,
			notify: () => undefined,
		});

	it('decodes the picture and reads it a band at a time, once for the same picture', async () => {
		const editor = open(layer(picture()));
		const ink = { x: 15, y: 9, width: 10, height: 4 };
		const decode = vi.spyOn(HTMLImageElement.prototype, 'decode');
		expect(await extentOf(editor, 'layer-1')).toEqual(ink);
		expect(await extentOf(editor, 'layer-1')).toEqual(ink);
		expect(decode).toHaveBeenCalledTimes(1);
	});

	it('reads a surface decoded already, with a stroke on it the file does not hold yet', async () => {
		const editor = open(layer(picture()));
		const surface = surfaceFor(contextFor(editor));
		if (surface === undefined) throw new Error('a raster layer has a surface');
		await surface.ready;
		fakeOf(surface.canvas)
			.pixels()
			.set(RED, (30 * 50 + 40) * 4);
		expect(await extentOf(editor, 'layer-1')).toEqual({ x: 15, y: 9, width: 31, height: 27 });
	});

	it('takes the picture’s whole box where it will not decode, or there is no 2D canvas to read it on', async () => {
		const whole = { x: 5, y: 5, width: 50, height: 40 };
		expect(await extentOf(open(layer(PICTURE)), 'layer-1')).toEqual(whole);
		const editor = open(layer(picture()));
		vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null);
		expect(await extentOf(editor, 'layer-1')).toEqual(whole);
	});
});

describe('the extent of a group', () => {
	it('is the box around the layers in it that are displayed, each placed by its own', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="group" transform="translate(0 10)">',
				'<g id="layer-2" draw:kind="vector"><rect x="0" y="0" width="10" height="10"/></g>',
				`<g id="layer-3" draw:kind="raster"><image href="${PICTURE}" x="50" y="50" width="20" height="20" preserveAspectRatio="none"/></g>`,
				'<g id="layer-4" draw:kind="vector" display="none"><rect x="-100" y="-100" width="10" height="10"/></g>',
				'<g id="layer-5" draw:kind="group" transform="translate(100 0)">',
				'<g id="layer-6" draw:kind="vector"><rect x="0" y="0" width="5" height="5"/></g>',
				'</g>',
				'</g>',
			].join('\n')
		);
		expect(
			await extentOf(
				editor,
				'layer-1',
				fromPicture(() => 255)
			)
		).toEqual({
			x: 0,
			y: 10,
			width: 105,
			height: 70,
		});
		expect(await extentOf(editor, 'layer-5')).toEqual({ x: 100, y: 10, width: 5, height: 5 });
	});

	it('is none where no layer in it paints', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="group">',
				'<g id="layer-2" draw:kind="vector" display="none"><rect width="10" height="10"/></g>',
				'<g id="layer-3" draw:kind="vector"></g>',
				'</g>',
				'<g id="layer-4" draw:kind="group"></g>',
			].join('\n')
		);
		expect(await extentOf(editor, 'layer-1')).toBeUndefined();
		expect(await extentOf(editor, 'layer-4')).toBeUndefined();
	});
});

describe('a layer that paints nothing to be measured', () => {
	it('is none when hidden, or in a hidden group', async () => {
		const editor = open(
			[
				'<g id="layer-1" draw:kind="vector" style="display:none"><rect width="10" height="10"/></g>',
				'<g id="layer-2" draw:kind="group" display="none">',
				'<g id="layer-3" draw:kind="vector"><rect width="10" height="10"/></g>',
				'</g>',
			].join('\n')
		);
		expect(await extentOf(editor, 'layer-1')).toBeUndefined();
		expect(await extentOf(editor, 'layer-2')).toBeUndefined();
		expect(await extentOf(editor, 'layer-3')).toBeUndefined();
	});

	it('is none for an id that is no layer’s, an element’s inside a layer among them', async () => {
		const editor = open(
			'<g id="layer-1" draw:kind="vector"><rect id="card" width="10" height="10"/></g>'
		);
		expect(await extentOf(editor, 'layer-9')).toBeUndefined();
		expect(await extentOf(editor, 'card')).toBeUndefined();
	});
});
