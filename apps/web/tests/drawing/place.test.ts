import { emptyDrawing, imageInfo, SVG_NAMESPACE } from '@skysa/draw-core';
import { describe, expect, it } from 'vitest';

import type { EditorDocument } from '../../src/drawing/document/model.js';
import { openDocument } from '../../src/drawing/document/openDocument.js';
import { placePicture } from '../../src/drawing/export/place.js';

/**
 * A picture placed from a file (docs/ARCHITECTURE.md §3, "Layers"), into a
 * real document: a new raster layer holding the file's own bytes, fitted to
 * the canvas and named after the file, as one step of the history. A new
 * drawing is 1600 × 1000 with one vector layer, `layer-1`.
 *
 * The PNGs are real files, made for these tests, so `imageInfo` reads their
 * size from their header as it would any other: a red 2 × 2, and a black
 * 3200 × 1000 at one bit a pixel. What this cannot show is the browser
 * drawing them.
 */

const DRAWING_ID = '11111111-2222-4333-8444-555555555555';

/** A 2 × 2 RGBA PNG, every pixel red. */
const SMALL_PNG =
	'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP4z8DwH4QZYAwAR8oH+Rq28akAAAAASUVORK5CYII=';

/** A 3200 × 1000 one-bit gray PNG, every pixel black: twice as wide as the canvas. */
const WIDE_PNG = `iVBORw0KGgoAAAANSUhEUgAADIAAAAPoAQAAAAA0EFkLAAABm0lEQVR42u3BMQEAAADCoPVPbQhfoA${'A'.repeat(516)}DgNx7CAAEQWxL/AAAAAElFTkSuQmCC`;

/**
 * The start of a JPEG as far as its data, a 200 × 100 frame: all `imageInfo`
 * reads of one, and no picture a browser would draw.
 */
const JPEG_HEADER = new Uint8Array([
	0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0x01, 0x22, 0x00, 0x02,
	0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xda,
]);

const bytesOf = (base64: string): Uint8Array<ArrayBuffer> =>
	Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

const open = (text = emptyDrawing({ id: DRAWING_ID })): EditorDocument => {
	const document = openDocument(text);
	if (document === undefined) throw new Error('a drawing opens');
	return document;
};

const imageIn = (document: EditorDocument, id: string): Element | undefined => {
	const layer = document.layer(id);
	return layer === undefined
		? undefined
		: [...layer.children].find(
				(child) => child.namespaceURI === SVG_NAMESPACE && child.localName === 'image'
			);
};

const geometryOf = (image: Element | undefined) =>
	Object.fromEntries(
		['x', 'y', 'width', 'height'].map((name) => [name, Number(image?.getAttribute(name))])
	);

const placed = async (document: EditorDocument, file: Blob, above?: string) => {
	const command = await placePicture(document, file, above);
	if (command === undefined) throw new Error('the picture is placed');
	document.execute(command);
	return command;
};

describe('the fixtures', () => {
	it('are what imageInfo says they are', () => {
		expect(imageInfo(bytesOf(SMALL_PNG))).toMatchObject({ format: 'png', width: 2, height: 2 });
		expect(imageInfo(bytesOf(WIDE_PNG))).toMatchObject({
			format: 'png',
			width: 3200,
			height: 1000,
		});
		expect(imageInfo(JPEG_HEADER)).toMatchObject({ format: 'jpeg', width: 200, height: 100 });
	});
});

describe('placePicture', () => {
	it('refuses a file that is not a picture, and changes nothing', async () => {
		const document = open();
		const before = document.text();
		const text = new File(['hello'], 'notes.txt', { type: 'text/plain' });
		await expect(placePicture(document, text, undefined)).resolves.toBeUndefined();
		const misnamed = new File(['hello'], 'photo.png', { type: 'image/png' });
		await expect(placePicture(document, misnamed, undefined)).resolves.toBeUndefined();
		expect(document.text()).toBe(before);
		expect(document.snapshot().layers).toHaveLength(1);
	});

	it('refuses a picture it does not place: a BMP, and an SVG that is not one', async () => {
		const document = open();
		const bmp = new Uint8Array(54);
		bmp.set([0x42, 0x4d]);
		new DataView(bmp.buffer).setUint32(14, 40, true);
		new DataView(bmp.buffer).setInt32(18, 4, true);
		new DataView(bmp.buffer).setInt32(22, 4, true);
		new DataView(bmp.buffer).setUint16(28, 24, true);
		expect(imageInfo(bmp)?.format).toBe('bmp');
		await expect(
			placePicture(document, new File([bmp], 'old.bmp', { type: 'image/bmp' }), undefined)
		).resolves.toBeUndefined();
		const notSvg = new File(['<html></html>'], 'page.svg', { type: 'image/svg+xml' });
		await expect(placePicture(document, notSvg, undefined)).resolves.toBeUndefined();
	});

	it('places a PNG as a new raster layer, its bytes kept as they came', async () => {
		const document = open();
		const command = await placed(
			document,
			new File([bytesOf(SMALL_PNG)], 'Red dot.png', { type: 'image/png' })
		);
		expect(command.id).toBe('layer-2');
		expect(command.label).toBe('exporting.place');
		const layer = document.snapshot().layers.find((each) => each.id === 'layer-2');
		expect(layer).toMatchObject({ kind: 'raster', name: 'Red dot', depth: 0 });
		const image = imageIn(document, 'layer-2');
		expect(image?.getAttribute('href')).toBe(`data:image/png;base64,${SMALL_PNG}`);
		expect(image?.getAttribute('preserveAspectRatio')).toBe('none');
		expect(document.text()).toContain(`href="data:image/png;base64,${SMALL_PNG}"`);
	});

	it('centers a picture smaller than the canvas, at one pixel a unit, never made larger', async () => {
		const document = open();
		await placed(document, new File([bytesOf(SMALL_PNG)], 'dot.png', { type: 'image/png' }));
		expect(geometryOf(imageIn(document, 'layer-2'))).toEqual({
			x: 799,
			y: 499,
			width: 2,
			height: 2,
		});
	});

	it('makes a picture larger than the canvas smaller to fit, and centers it', async () => {
		const document = open();
		await placed(document, new File([bytesOf(WIDE_PNG)], 'wide.png', { type: 'image/png' }));
		expect(geometryOf(imageIn(document, 'layer-2'))).toEqual({
			x: 0,
			y: 250,
			width: 1600,
			height: 500,
		});
		// The bytes are the file's still, all 3200 pixels across.
		expect(imageIn(document, 'layer-2')?.getAttribute('href')).toBe(
			`data:image/png;base64,${WIDE_PNG}`
		);
	});

	it('fits within a canvas whose viewBox does not start at the origin', async () => {
		const document = open();
		document.root.setAttribute('viewBox', '-800 -500 1600 1000');
		await placed(document, new File([bytesOf(WIDE_PNG)], 'wide.png', { type: 'image/png' }));
		expect(geometryOf(imageIn(document, 'layer-2'))).toEqual({
			x: -800,
			y: -250,
			width: 1600,
			height: 500,
		});
	});

	it('undoes in one step, back to the very text it opened with, and redoes the same', async () => {
		const original = emptyDrawing({ id: DRAWING_ID });
		const document = open(original);
		await placed(document, new File([bytesOf(SMALL_PNG)], 'dot.png', { type: 'image/png' }));
		const after = document.text();
		expect(document.snapshot().canUndo).toBe(true);
		document.undo();
		expect(document.text()).toBe(original);
		expect(document.snapshot().layers.map((layer) => layer.id)).toEqual(['layer-1']);
		expect(document.snapshot().canUndo).toBe(false);
		document.redo();
		expect(document.text()).toBe(after);
	});

	it('places it above the layer named, and on top of everything without one', async () => {
		const document = open();
		await placed(document, new File([bytesOf(SMALL_PNG)], 'top.png', { type: 'image/png' }));
		await placed(
			document,
			new File([bytesOf(SMALL_PNG)], 'middle.png', { type: 'image/png' }),
			'layer-1'
		);
		expect(document.snapshot().layers.map((layer) => [layer.id, layer.name])).toEqual([
			['layer-1', undefined],
			['layer-3', 'middle'],
			['layer-2', 'top'],
		]);
	});

	it('leaves a pasted picture, a blob with no name, unnamed', async () => {
		const document = open();
		const command = await placed(
			document,
			new Blob([bytesOf(SMALL_PNG)], { type: 'image/png' })
		);
		expect(document.snapshot().layers.find((layer) => layer.id === command.id)?.name).toBe(
			undefined
		);
	});

	it('places the bytes as the type they are, whatever the file says', async () => {
		const document = open();
		await placed(document, new File([JPEG_HEADER], 'photo.png', { type: 'image/png' }));
		const href = imageIn(document, 'layer-2')?.getAttribute('href') ?? '';
		expect(href.startsWith('data:image/jpeg;base64,')).toBe(true);
		expect(bytesOf(href.slice('data:image/jpeg;base64,'.length))).toEqual(JPEG_HEADER);
		expect(geometryOf(imageIn(document, 'layer-2'))).toEqual({
			x: 700,
			y: 450,
			width: 200,
			height: 100,
		});
	});

	it('places an SVG as a picture, its bytes kept, at the size its root gives', async () => {
		const document = open();
		const svg =
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><script>alert(1)</script><rect width="400" height="200"/></svg>';
		await placed(document, new File([svg], 'logo.svg', { type: 'image/svg+xml' }));
		const image = imageIn(document, 'layer-2');
		const href = image?.getAttribute('href') ?? '';
		expect(href.startsWith('data:image/svg+xml;base64,')).toBe(true);
		expect(atob(href.slice('data:image/svg+xml;base64,'.length))).toBe(svg);
		expect(geometryOf(image)).toEqual({ x: 600, y: 400, width: 400, height: 200 });
		// Nothing of it is in the drawing's own tree: it is a picture, not markup.
		expect(document.root.querySelector('script')).toBeNull();
	});

	it('takes a file with no type as what its extension names', async () => {
		const document = open();
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"/>';
		await placed(document, new File([svg], 'mark.svg'));
		expect(imageIn(document, 'layer-2')?.getAttribute('href')).toMatch(
			/^data:image\/svg\+xml;base64,/
		);
		expect(geometryOf(imageIn(document, 'layer-2'))).toMatchObject({ width: 100, height: 50 });
	});

	it('gives an SVG with no size in user units the app’s own, fitted', async () => {
		const document = open();
		const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10cm" height="5cm"/>';
		await placed(document, new File([svg], 'sized.svg', { type: 'image/svg+xml' }));
		expect(geometryOf(imageIn(document, 'layer-2'))).toEqual({
			x: 0,
			y: 0,
			width: 1600,
			height: 1000,
		});
	});
});
